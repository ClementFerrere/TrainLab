"""Garmin Connect Personal API (official, launched 2026-10-21).

Security model:
  - the user creates a revocable, expiring API key on Garmin Connect Web;
  - the key lives only in data/secrets/garmin_personal_api_key (ACL: current user);
  - the 24 h bearer token is kept in memory only, never written to disk;
  - traffic goes exclusively to personal.connectapi.garmin.com.
"""
from __future__ import annotations

import base64
import json
import threading
import time
import zipfile
from datetime import date, datetime, timedelta
from typing import Any

import httpx

from . import config, db, fit
from .analytics import load as load_model
from .analytics import intervals, profile

TOKEN_PATH = "/personalapitoken-service/personal-api/personal-api-key/token"
HISTORY_START = date.today() - timedelta(days=int(365.25 * config.HISTORY_YEARS))  # first wellness backfill
MIN_INTERVAL_S = 0.4               # polite pacing; limits are not published yet

TYPE_GROUPS = {
    "run": ("running", "run", "track", "treadmill", "trail_running", "ultra_run", "obstacle"),
    "bike": ("cycling", "biking", "ride", "bmx", "cyclocross", "e_bike", "mountain", "gravel", "indoor_cycling"),
    "swim": ("swim",),
    "strength": ("strength", "cardio", "hiit", "yoga", "pilates", "fitness_equipment", "training", "elliptical",
                 "stair", "rowing"),
    # Garmin spells padel "paddelball"
    "racket": ("padel", "paddel", "tennis", "squash", "badminton", "pickleball", "racquet", "table_tennis"),
}


def normalize_sport(type_key: str | None) -> str:
    k = (type_key or "").lower()
    if "swim" in k:
        return "swim"
    for sport in ("racket", "run", "bike", "strength"):
        if any(tok in k for tok in TYPE_GROUPS[sport]):
            return sport
    return "other"


class RateLimited(Exception):
    def __init__(self, wait_s: float):
        super().__init__(f"rate limited, retry in {wait_s:.0f}s")
        self.wait_s = wait_s


class AuthError(Exception):
    pass


# --------------------------------------------------------------------------- client

class GarminClient:
    def __init__(self) -> None:
        self._token: str | None = None
        self._exp = 0.0
        self._last = 0.0
        self._lock = threading.Lock()
        self._http = httpx.Client(base_url=config.GARMIN_API, timeout=60, headers={"User-Agent": "trainlab-local/1.0"})

    # -- key management
    @staticmethod
    def has_key() -> bool:
        return config.GARMIN_KEY_FILE.exists() and bool(config.GARMIN_KEY_FILE.read_text().strip())

    def save_key(self, key: str) -> None:
        key = key.strip()
        if not key or len(key) > 4096 or any(c.isspace() for c in key):
            raise AuthError("Clé vide ou invalide.")
        self._exchange(key)  # validate before persisting
        config.lock_down_secrets()
        config.GARMIN_KEY_FILE.write_text(key)
        config.lock_down_secrets()

    def delete_key(self) -> None:
        config.GARMIN_KEY_FILE.unlink(missing_ok=True)
        self._token, self._exp = None, 0.0

    # -- token
    def _exchange(self, key: str) -> None:
        r = self._http.post(TOKEN_PATH, headers={"Accept": "*/*", "Authorization": f"ApiKey {key}"})
        if r.status_code in (401, 403):
            raise AuthError("Clé refusée par Garmin (expirée, supprimée ou mal copiée).")
        r.raise_for_status()
        tok = r.text.strip()
        payload = tok.split(".")[1]
        exp = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))["exp"]
        self._token, self._exp = tok, float(exp)

    def _bearer(self) -> str:
        if not self._token or self._exp - time.time() < 3600:
            if not self.has_key():
                raise AuthError("Aucune clé Garmin enregistrée.")
            self._exchange(config.GARMIN_KEY_FILE.read_text().strip())
        return self._token  # type: ignore[return-value]

    # -- requests
    def _request(self, path: str, params: dict | None = None, accept: str = "application/json") -> httpx.Response:
        with self._lock:
            wait = MIN_INTERVAL_S - (time.time() - self._last)
            if wait > 0:
                time.sleep(wait)
            for attempt in range(2):
                r = self._http.get(path, params=params, headers={"Accept": accept, "Authorization": f"Bearer {self._bearer()}"})
                self._last = time.time()
                if r.status_code == 401 and attempt == 0:
                    self._token = None  # token revoked/expired early: exchange once more
                    continue
                break
        if r.status_code in (429, 502, 503, 504):
            # 429 = explicit throttle; 502-504 show up after long download bursts. Back off and resume.
            retry = r.headers.get("retry-after")
            raise RateLimited(float(retry) if retry and retry.isdigit() else (900 if r.status_code == 429 else 600))
        if r.status_code in (401, 403):
            raise AuthError(f"Accès refusé ({r.status_code}) — la clé a peut-être expiré.")
        return r

    def get(self, path: str, params: dict | None = None) -> Any:
        r = self._request(path, params)
        if r.status_code in (204, 404):
            return None
        r.raise_for_status()  # before the empty-body check: Garmin answers some errors with 500 + empty body
        return r.json() if r.content else None

    def download(self, activity_id: int) -> bytes | None:
        r = self._request(f"/download-service/files/activity/{int(activity_id)}",
                          accept="application/zip, application/x-zip-compressed, application/octet-stream")
        if r.status_code in (204, 404):
            return None
        r.raise_for_status()
        return r.content or None


client = GarminClient()


# --------------------------------------------------------------------------- mapping

def _iso_local(s: str | None) -> str | None:
    return s.replace(" ", "T") if s else None


def _moving_time(a: dict[str, Any]) -> float | None:
    """movingDuration, unless Garmin reports more moving time than elapsed time
    (seen in practice on pool swims: tens of hours of "moving" time) -> timer duration instead."""
    mv, el, du = a.get("movingDuration"), a.get("elapsedDuration"), a.get("duration")
    if mv and el and mv > el * 1.02:
        return min(x for x in (du, el) if x)
    return mv or du


def _activity_row(a: dict[str, Any]) -> dict[str, Any]:
    tk = (a.get("activityType") or {}).get("typeKey")
    ev = (a.get("eventType") or {}).get("typeKey")
    sport = normalize_sport(tk)
    start_local = _iso_local(a.get("startTimeLocal")) or ""
    start_utc = _iso_local(a.get("startTimeGMT"))
    cad = a.get("averageRunningCadenceInStepsPerMinute") if sport == "run" else (
        a.get("averageBikingCadenceInRevPerMinute") or a.get("averageSwimCadenceInStrokesPerMinute"))
    curve = {k.split("_")[1]: v for k, v in a.items() if k.startswith("maxAvgPower_") and v}
    return {
        "id": a["activityId"],
        "name": a.get("activityName"),
        "description": a.get("description"),
        "type_key": tk,
        "sport": sport,
        "race_garmin": int(ev == "race"),
        "is_parent": int(bool(a.get("isParent"))),
        "start_utc": (start_utc + "Z") if start_utc else None,
        "start_local": start_local,
        "date": start_local[:10],
        "location_name": a.get("locationName"),
        "distance": a.get("distance"),
        "moving_time": _moving_time(a),
        "elapsed_time": a.get("elapsedDuration") or a.get("duration"),
        "elev_gain": a.get("elevationGain"),
        "elev_loss": a.get("elevationLoss"),
        "avg_speed": a.get("averageSpeed"),
        "max_speed": a.get("maxSpeed"),
        "avg_hr": a.get("averageHR"),
        "max_hr": a.get("maxHR"),
        "avg_power": a.get("avgPower"),
        "norm_power": a.get("normPower"),
        "avg_cadence": cad,
        "calories": a.get("calories"),
        "steps": a.get("steps"),
        "aerobic_te": a.get("aerobicTrainingEffect"),
        "anaerobic_te": a.get("anaerobicTrainingEffect"),
        "te_label": a.get("trainingEffectLabel"),
        "garmin_load": a.get("activityTrainingLoad"),
        "vo2max": a.get("vO2MaxValue"),
        "lthr": a.get("lactateThresholdBpm"),
        "avg_vert_osc": a.get("avgVerticalOscillation"),
        "avg_gct": a.get("avgGroundContactTime"),
        "avg_stride": (a.get("avgStrideLength") or 0) / 100 or None,
        "avg_vert_ratio": a.get("avgVerticalRatio"),
        "avg_resp": a.get("avgRespirationRate"),
        "start_lat": a.get("startLatitude"),
        "start_lng": a.get("startLongitude"),
        "has_polyline": int(bool(a.get("hasPolyline"))),
        "pool_length": (a.get("poolLength") or 0) / 100 or None,
        "avg_swolf": a.get("averageSwolf"),
        "max_power_curve": json.dumps(curve) if curve else None,
        "updated_at": datetime.now().isoformat(timespec="seconds"),
    }


def upsert_activity(c, a: dict[str, Any]) -> None:
    if c.execute("SELECT 1 FROM hidden_activities WHERE id=?", (a["activityId"],)).fetchone():
        return  # deleted by the user in TrainLab: never re-imported
    row = _activity_row(a)
    cols = list(row)
    updates = ", ".join(f"{k}=excluded.{k}" for k in cols if k != "id")
    c.execute(
        f"INSERT INTO activities({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))}) "
        f"ON CONFLICT(id) DO UPDATE SET {updates}",
        [row[k] for k in cols],
    )
    c.execute("INSERT INTO activity_raw(id, summary) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET summary=excluded.summary",
              (a["activityId"], db.pack(a)))


def store_fit(c, aid: int, sport: str, date_str: str, parsed: dict | None) -> None:
    if not parsed:
        c.execute("UPDATE activities SET fit_status=-1 WHERE id=?", (aid,))
        return
    sess = parsed["session"]
    c.execute("UPDATE activities SET rpe=COALESCE(?, rpe), feel=COALESCE(?, feel), avg_temp=COALESCE(?, avg_temp), "
              "vo2max=COALESCE(?, vo2max), fit_status=1 WHERE id=?",
              (sess.get("rpe"), sess.get("feel"), sess.get("avg_temp"), sess.get("vo2max"), aid))
    st = parsed["streams"]
    if st:
        c.execute("INSERT INTO streams(activity_id, data) VALUES (?, ?) ON CONFLICT(activity_id) DO UPDATE SET data=excluded.data",
                  (aid, db.pack(st)))
        pts = [p for p in st.get("latlng") or [] if p]
        if len(pts) > 1:
            step = max(1, len(pts) // 160)
            route = pts[::step] + ([pts[-1]] if (len(pts) - 1) % step else [])
            c.execute("UPDATE activities SET route=? WHERE id=?", (json.dumps([[round(a, 5), round(b, 5)] for a, b in route]), aid))
    c.execute("DELETE FROM laps WHERE activity_id=?", (aid,))
    for lap in parsed["laps"]:
        cols = list(lap)
        c.execute(f"INSERT INTO laps(activity_id, {', '.join(cols)}) VALUES (?{', ?' * len(cols)})",
                  [aid] + [lap[k] for k in cols])
    c.execute("DELETE FROM best_efforts WHERE activity_id=?", (aid,))
    if sport == "run" and st.get("distance") and st.get("time"):
        for e in fit.best_efforts(st["time"], st["distance"], st.get("cadence")):
            c.execute("INSERT INTO best_efforts(activity_id, name, distance, elapsed_time, start_index, end_index, date) "
                      "VALUES (?,?,?,?,?,?,?)", (aid, e["name"], e["distance"], e["elapsed_time"], e["start_index"], e["end_index"], date_str))
    profile.compute_activity(aid, c)
    c.execute("DELETE FROM interval_sessions WHERE activity_id=?", (aid,))
    c.execute("DELETE FROM interval_checked WHERE activity_id=?", (aid,))


def _ms_to_local_iso(v: Any) -> str | None:
    if v in (None, ""):
        return None
    try:
        return datetime.utcfromtimestamp(float(v) / 1000).isoformat(timespec="seconds")
    except (TypeError, ValueError):
        return str(v)[:19]


def _upsert_wellness(c, day: str, fields: dict[str, Any]) -> None:
    fields = {k: v for k, v in fields.items() if v is not None}
    if not fields:
        return
    fields["updated_at"] = datetime.now().isoformat(timespec="seconds")
    cols = list(fields)
    c.execute(
        f"INSERT INTO daily_wellness(date, {', '.join(cols)}) VALUES (?{', ?' * len(cols)}) "
        f"ON CONFLICT(date) DO UPDATE SET {', '.join(f'{k}=excluded.{k}' for k in cols)}",
        [day] + [fields[k] for k in cols],
    )


def store_sleep(c, s: dict[str, Any]) -> None:
    day = s.get("calendarDate")
    if not day or not s.get("sleepTimeSeconds"):
        return
    scores = s.get("sleepScores") or {}
    overall = (scores.get("overall") or {}).get("value") if isinstance(scores, dict) else None
    need = s.get("sleepNeed") or {}
    _upsert_wellness(c, day, {
        "sleep_start": _ms_to_local_iso(s.get("sleepStartTimestampLocal")),
        "sleep_end": _ms_to_local_iso(s.get("sleepEndTimestampLocal")),
        "sleep_seconds": s.get("sleepTimeSeconds"),
        "deep_seconds": s.get("deepSleepSeconds"),
        "light_seconds": s.get("lightSleepSeconds"),
        "rem_seconds": s.get("remSleepSeconds"),
        "awake_seconds": s.get("awakeSleepSeconds"),
        "nap_seconds": s.get("napTimeSeconds"),
        "awake_count": s.get("awakeCount"),
        "sleep_score": overall,
        "sleep_quality": (scores.get("overall") or {}).get("qualifierKey") if isinstance(scores, dict) else None,
        "sleep_need_min": need.get("actual") if isinstance(need, dict) else None,
        "sleep_hr": s.get("avgHeartRate"),
        "sleep_stress": s.get("avgSleepStress"),
        "sleep_resp": s.get("averageRespirationValue"),
        "sleep_spo2": s.get("averageSpO2Value"),
        "raw_sleep": db.pack(s),
    })


def store_hrv(c, h: dict[str, Any]) -> None:
    day = h.get("calendarDate")
    if not day:
        return
    b = h.get("baseline") or {}
    _upsert_wellness(c, day, {
        "hrv_overnight": h.get("lastNightAvg"),
        "hrv_5min_high": h.get("lastNight5MinHigh"),
        "hrv_weekly": h.get("weeklyAvg"),
        "hrv_baseline_low": b.get("balancedLow"),
        "hrv_baseline_high": b.get("balancedUpper"),
        "hrv_status": h.get("status"),
    })


def store_summary(c, d: dict[str, Any]) -> None:
    day = d.get("calendarDate")
    if not day:
        return
    hr = d.get("heartRate") or {}
    st = d.get("stress") or {}
    bb = d.get("bodyBattery") or {}
    resp = d.get("respiration") or {}
    ox = d.get("pulseOx") or {}
    steps = ((d.get("movement") or {}).get("steps") or {}).get("value")
    im = d.get("intensityMinutes") or {}
    _upsert_wellness(c, day, {
        "resting_hr": hr.get("restingValue"),
        "min_hr": hr.get("minValue"),
        "max_hr": hr.get("maxValue"),
        "stress_avg": st.get("avgLevel") if (st.get("avgLevel") or -1) >= 0 else None,
        "stress_high_pct": (st.get("highStressProportion") * 100) if st.get("highStressProportion") is not None else None,
        "body_battery_high": bb.get("maxValue"),
        "body_battery_low": bb.get("minValue"),
        "body_battery_charged": bb.get("chargedValue"),
        "body_battery_drained": bb.get("drainedValue"),
        "respiration": resp.get("avgValue"),
        "spo2": ox.get("avgValue"),
        "steps": steps,
        "intensity_min": ((im.get("moderate") or 0) + 2 * (im.get("vigorous") or 0)) if im else None,
        "raw_summary": db.pack(d),
    })


def store_weight(c, w: dict[str, Any]) -> None:
    for d in w.get("dailyWeightSummaries") or []:
        latest = d.get("latestWeight") or {}
        grams = latest.get("weight") if isinstance(latest, dict) else None
        if d.get("summaryDate") and grams:
            _upsert_wellness(c, d["summaryDate"], {"weight": grams / 1000})


# --------------------------------------------------------------------------- sync worker

def _safe_get(path: str, params: dict | None = None) -> Any:
    """GET that tolerates per-endpoint client errors (unknown range limits, missing
    feature on the device) so one failing endpoint never blocks the whole sync.
    Auth, rate-limit and server errors still propagate."""
    try:
        return client.get(path, params)
    except httpx.HTTPStatusError as e:
        if 400 <= e.response.status_code < 500:
            db.log("garmin", f"{e.response.status_code} on {path} {params or ''}", "warning")
            return None
        raise


def _chunks(start: date, end: date, days: int):
    cur = start
    while cur <= end:
        nxt = min(cur + timedelta(days=days - 1), end)
        yield cur, nxt
        cur = nxt + timedelta(days=1)


class GarminSync:
    INTERVAL_S = 30 * 60

    def __init__(self) -> None:
        self.state: dict[str, Any] = {"running": False, "phase": "idle", "message": "", "done": 0, "todo": 0,
                                      "last_sync": None, "waiting_until": None, "error": None}
        self._wake = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        if self._thread is None:
            self._thread = threading.Thread(target=self._loop, name="garmin-sync", daemon=True)
            self._thread.start()

    def trigger(self) -> None:
        self._wake.set()

    def _loop(self) -> None:
        time.sleep(2)
        while True:
            wait_s = self.INTERVAL_S
            if client.has_key():
                try:
                    self.state.update(running=True, error=None, waiting_until=None)
                    self._cycle()
                    self.state.update(phase="ok", message="À jour", last_sync=datetime.now().isoformat(timespec="minutes"))
                except RateLimited as e:
                    wait_s = e.wait_s
                    until = datetime.now() + timedelta(seconds=wait_s)
                    self.state.update(phase="paused", message="Garmin demande une pause — reprise automatique",
                                      waiting_until=until.isoformat(timespec="minutes"))
                except AuthError as e:
                    self.state.update(phase="error", message=str(e), error=str(e))
                except Exception as e:  # keep the worker alive, surface the error
                    db.log("garmin", f"{type(e).__name__}: {e}", "error")
                    self.state.update(phase="error", message=f"{type(e).__name__}: {e}", error=str(e))
                    wait_s = 300
                finally:
                    self.state["running"] = False
            self._wake.wait(timeout=wait_s)
            self._wake.clear()

    # -- phases
    def _cycle(self) -> None:
        self._sync_zones()
        self._sync_activity_list()
        self._renormalize_sports()
        refresh_race_flags()
        load_model.recompute_all()
        self._sync_wellness()
        self._sync_fit_backlog()
        self._calibrate_hr()
        load_model.recompute_all()
        profile.backfill()
        intervals.refresh_index()
        warm_caches()

    def _sync_zones(self) -> None:
        self.state.update(phase="profil", message="Zones cardio")
        zones = _safe_get("/biometric-service/heartRateZones/v2") or []
        if not isinstance(zones, list):
            zones = [zones]
        z = next((x for x in zones if (x.get("sport") or "").upper() in ("RUNNING", "DEFAULT")), zones[0] if zones else None)
        if not z:
            return
        with db.session() as c:
            db.set_setting(c, "garmin_zones", z)
            if db.get_settings(c).get("auto_hr"):
                if z.get("zone2Floor"):
                    db.set_setting(c, "hr_zones", [z["zone2Floor"], z["zone3Floor"], z["zone4Floor"], z["zone5Floor"]])
                if z.get("maxHeartRateUsed"):
                    db.set_setting(c, "hr_max", z["maxHeartRateUsed"])
                if z.get("lactateThresholdHeartRateUsed"):
                    db.set_setting(c, "lthr", z["lactateThresholdHeartRateUsed"])

    def _sync_activity_list(self) -> None:
        with db.session() as c:
            last = c.execute("SELECT MAX(date) FROM activities").fetchone()[0]
        # The spec says limit defaults to 99, but the live API returns 500 for limit >= ~48.
        params: dict[str, Any] = {"limit": 40, "excludeChildren": "false"}
        if last:
            params["startDate"] = (date.fromisoformat(last) - timedelta(days=3)).isoformat()
        start, seen = 0, 0
        while True:
            self.state.update(phase="activités", message=f"Liste des activités ({seen})")
            batch = client.get("/activitylist-service/activities/search/activities", {**params, "start": start})
            if not batch:
                break
            with db.session() as c:
                for a in batch:
                    upsert_activity(c, a)
            seen += len(batch)
            if len(batch) < params["limit"]:
                break
            start += len(batch)

    def _sync_wellness(self) -> None:
        with db.session() as c:
            last = c.execute("SELECT MAX(date) FROM daily_wellness WHERE sleep_seconds IS NOT NULL OR resting_hr IS NOT NULL").fetchone()[0]
        today = date.today()
        start = (date.fromisoformat(last) - timedelta(days=3)) if last else HISTORY_START
        chunks = list(_chunks(start, today, 31))
        for k, (a, b) in enumerate(reversed(chunks)):  # newest first: the cockpit fills up quickly
            self.state.update(phase="bien-être", message=f"Sommeil, HRV & récup — {a.isoformat()[:7]} ({k + 1}/{len(chunks)})",
                              done=k, todo=len(chunks))
            sleeps = _safe_get("/sleep-service/sleep/dailySleepSummariesByDate", {"startDate": a.isoformat(), "endDate": b.isoformat()}) or []
            hrv = _safe_get(f"/hrv-service/hrv/daily/{a.isoformat()}/{b.isoformat()}") or {}
            summ = _safe_get("/usersummary-service/v2/dailysummaries", {"startDate": a.isoformat(), "endDate": b.isoformat()}) or {}
            weight = _safe_get(f"/weight-service/weight/range/{a.isoformat()}/{b.isoformat()}") or {}
            with db.session() as c:
                for s in sleeps if isinstance(sleeps, list) else [sleeps]:
                    store_sleep(c, s)
                for h in (hrv.get("hrvSummaries") or []) if isinstance(hrv, dict) else []:
                    store_hrv(c, h)
                for d in (summ.get("data") or []) if isinstance(summ, dict) else []:
                    store_summary(c, d)
                if isinstance(weight, dict):
                    store_weight(c, weight)

    def _sync_fit_backlog(self) -> None:
        with db.session() as c:
            if (db.get_settings(c).get("fit_parser_version") or 1) < fit.PARSER_VERSION:
                # parser improved: re-parse every archived file (local, no download)
                c.execute("UPDATE activities SET fit_status=0 WHERE fit_status=1")
                db.set_setting(c, "fit_parser_version", fit.PARSER_VERSION)
            todo = c.execute("SELECT id, sport, date FROM activities WHERE fit_status=0 AND is_parent=0 "
                             "ORDER BY start_local DESC").fetchall()
        for i, a in enumerate(todo):
            self.state.update(phase="fichiers FIT", message=f"Fichiers FIT {i + 1}/{len(todo)}", done=i, todo=len(todo))
            local = config.FIT_DIR / f"{a['id']}.zip"
            blob = local.read_bytes() if local.exists() and local.stat().st_size > 0 else None
            if blob is None:
                try:
                    blob = client.download(a["id"])
                except httpx.HTTPStatusError as e:
                    if e.response.status_code >= 500:
                        raise  # Garmin hiccup: retry this activity next cycle
                    db.log("garmin", f"FIT {a['id']}: HTTP {e.response.status_code}", "warning")
                    blob = None
                if blob:
                    tmp = local.with_suffix(".part")
                    tmp.write_bytes(blob)
                    tmp.replace(local)  # atomic: an interrupted write never leaves a truncated archive
            parsed = None
            if blob:
                try:
                    raw = fit.fit_from_zip(blob)
                except zipfile.BadZipFile:
                    local.unlink(missing_ok=True)  # corrupt archive: fetch it again next cycle
                    continue
                if raw:
                    try:
                        parsed = fit.parse_fit(raw, a["sport"])
                    except Exception as e:  # a corrupt file must not stop the backlog
                        db.log("garmin", f"FIT {a['id']}: {e}", "warning")
            with db.session() as c:
                store_fit(c, a["id"], a["sport"], a["date"], parsed)
                load_model.compute_activity(a["id"], c)
        self.state.update(done=len(todo))

    def _renormalize_sports(self) -> None:
        """Re-apply the type -> sport mapping to stored rows (the mapping evolves)."""
        with db.session() as c:
            rows = c.execute("SELECT id, type_key, sport FROM activities").fetchall()
            for r in rows:
                sp = normalize_sport(r["type_key"])
                if sp != r["sport"]:
                    c.execute("UPDATE activities SET sport=? WHERE id=?", (sp, r["id"]))

    def _calibrate_hr(self) -> None:
        """Use Garmin's resting HR (30-day median) for the load model."""
        with db.session() as c:
            if not db.get_settings(c).get("auto_hr"):
                return
            rows = [r[0] for r in c.execute("SELECT resting_hr FROM daily_wellness WHERE resting_hr > 25 ORDER BY date DESC LIMIT 30")]
            if len(rows) >= 7:
                rows.sort()
                db.set_setting(c, "hr_rest", rows[len(rows) // 2])


def warm_caches() -> None:
    """Pre-compute the heavy, data-dependent reports (ML ~1 min) so pages open instantly."""
    from .analytics import matrix, ml, predict
    for fn in (predict.report, matrix.matrix, ml.experiments):
        try:
            fn()
        except Exception as e:  # never break the sync for a report
            db.log("warm", f"{fn.__module__}: {type(e).__name__}: {e}", "warning")


# Standard race distances (m) incl. the 7.195 km Ekiden anchor leg; tolerance ±2.5 %.
RACE_DISTANCES = [5000, 7195, 10000, 15000, 16093, 20000, 21097.5, 25000, 30000, 42195]


def refresh_race_flags() -> None:
    """Flag races Garmin doesn't know about: a run at a standard distance, run
    continuously (no long stops) at race intensity for its duration."""
    with db.session() as c:
        hr_max = db.get_settings(c)["hr_max"]
        rows = c.execute("SELECT id, distance, moving_time, elapsed_time, avg_hr FROM activities WHERE sport='run'").fetchall()
        for r in rows:
            auto = 0
            d, mt, et, hr = r["distance"] or 0, r["moving_time"] or 0, r["elapsed_time"] or 0, r["avg_hr"] or 0
            if d and mt and hr and any(abs(d / x - 1) <= 0.025 for x in RACE_DISTANCES):
                need = 0.89 if d <= 10600 else 0.86 if d <= 21700 else 0.82  # avg HR / HRmax
                if hr >= need * hr_max and et / mt <= 1.05:
                    auto = 1
            c.execute("UPDATE activities SET race_auto=? WHERE id=?", (auto, r["id"]))
        c.execute("UPDATE activities SET is_race = CASE WHEN race_user IS NOT NULL THEN race_user "
                  "ELSE MAX(COALESCE(race_garmin, 0), COALESCE(race_auto, 0)) END")


sync = GarminSync()


def status() -> dict[str, Any]:
    with db.session() as c:
        a = c.execute("SELECT COUNT(*) n, SUM(fit_status=1) f, MIN(date) first, MAX(date) last FROM activities").fetchone()
        w = c.execute("SELECT COUNT(*) n, MIN(date) first, MAX(date) last FROM daily_wellness WHERE sleep_seconds IS NOT NULL").fetchone()
    return {"connected": client.has_key(), "sync": sync.state, "activities": a["n"], "with_fit": a["f"] or 0,
            "first": a["first"], "last": a["last"], "nights": w["n"], "nights_first": w["first"], "nights_last": w["last"]}
