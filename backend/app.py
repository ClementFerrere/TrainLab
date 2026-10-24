"""FastAPI app: JSON API under /api, static frontend at /."""
from __future__ import annotations

import json
import math
import threading
from contextlib import asynccontextmanager
from datetime import date, timedelta
from typing import Any

import pandas as pd
from fastapi import Body, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from . import config, db, garmin, strava
from .analytics import intervals, lab, matrix, ml, performance, predict, profile, readiness
from .analytics import load as load_model


@asynccontextmanager
async def lifespan(_app: FastAPI):
    config.lock_down_secrets()
    db.init_db()
    if not (config.DEMO or config.QA):
        garmin.sync.start()
        strava.sync.start()
    threading.Thread(target=garmin.warm_caches, name="warm", daemon=True).start()
    yield


app = FastAPI(title="TrainLab", lifespan=lifespan, docs_url="/api/docs", openapi_url="/api/openapi.json")

ALLOWED_HOSTS = {f"127.0.0.1:{config.PORT}", f"localhost:{config.PORT}"}


@app.middleware("http")
async def local_only(request: Request, call_next):
    # Host check defeats DNS rebinding; the custom header on writes forces a CORS
    # preflight that we never answer, so other websites can't drive the API.
    if request.headers.get("host") not in ALLOWED_HOSTS:
        return JSONResponse({"detail": "forbidden host"}, status_code=403)
    if request.method in ("POST", "PUT", "DELETE") and request.headers.get("x-sport-platform") != "1":
        return JSONResponse({"detail": "missing header"}, status_code=403)
    return await call_next(request)


def clean(obj: Any) -> Any:
    """Make pandas/numpy output JSON-safe (NaN -> null)."""
    if isinstance(obj, float):
        return None if math.isnan(obj) or math.isinf(obj) else obj
    if isinstance(obj, dict):
        return {k: clean(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [clean(v) for v in obj]
    if isinstance(obj, bytes):
        return None
    if hasattr(obj, "item"):
        return clean(obj.item())
    return obj


def frame_records(df: pd.DataFrame, cols: list[str] | None = None) -> list[dict]:
    if df.empty:
        return []
    d = df.reset_index()
    d["date"] = d["date"].dt.strftime("%Y-%m-%d")
    if cols:
        d = d[["date"] + [c for c in cols if c in d.columns]]
    return clean(d.to_dict(orient="records"))


def with_strava(rows: list[dict]) -> list[dict]:
    """Attach the (≤7 day) Strava enrichment to recent activities, display only."""
    if config.QA:
        return rows
    recent =[r for r in rows if r.get("date") and r["date"] >= (date.today() - timedelta(days=10)).isoformat()]
    if recent:
        enr = strava.enrichment_for(recent)
        for r in rows:
            if r["id"] in enr:
                r["strava"] = enr[r["id"]]
    return rows


# --------------------------------------------------------------------------- status & settings

@app.get("/api/status")
def status():
    st = strava.status()
    if config.QA:
        st["athlete"] = None
    return clean({"demo": config.DEMO, "qa": config.QA, "garmin": garmin.status(), "strava": st})


@app.get("/api/settings")
def get_settings():
    s = db.get_settings()
    return clean(s)


@app.put("/api/settings")
def put_settings(payload: dict = Body(...)):
    allowed = {"hr_max", "hr_rest", "lthr", "hr_zones", "auto_hr", "weight", "ctl_days", "atl_days"}
    with db.session() as c:
        for k, v in payload.items():
            if k in allowed:
                db.set_setting(c, k, v)
    load_model.recompute_all(force=True)
    return get_settings()


GOAL_COLS = ["name", "date", "sport", "distance", "target_time", "priority", "notes"]


@app.get("/api/goals")
def goals():
    with db.session() as c:
        return [dict(r) for r in c.execute("SELECT * FROM goals ORDER BY date")]


@app.put("/api/goals/{gid}")
def put_goal(gid: int, payload: dict = Body(...)):
    with db.session() as c:
        c.execute(f"UPDATE goals SET {', '.join(f'{k}=?' for k in GOAL_COLS)} WHERE id=?", [payload.get(k) for k in GOAL_COLS] + [gid])
    return goals()


@app.post("/api/goals")
def add_goal(payload: dict = Body(...)):
    with db.session() as c:
        c.execute(f"INSERT INTO goals({', '.join(GOAL_COLS)}) VALUES ({', '.join('?' * len(GOAL_COLS))})", [payload.get(k) for k in GOAL_COLS])
    return goals()


@app.delete("/api/goals/{gid}")
def del_goal(gid: int):
    with db.session() as c:
        c.execute("DELETE FROM goals WHERE id=?", (gid,))
    return goals()


# --------------------------------------------------------------------------- garmin

@app.post("/api/garmin/key")
def garmin_key(payload: dict = Body(...)):
    try:
        garmin.client.save_key(str(payload.get("key") or ""))
    except garmin.AuthError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(502, f"Échange avec Garmin impossible : {type(e).__name__}")
    garmin.sync.trigger()
    return {"ok": True}


@app.delete("/api/garmin/key")
def garmin_key_delete():
    garmin.client.delete_key()
    return {"ok": True}


@app.post("/api/garmin/sync")
def garmin_sync():
    garmin.sync.trigger()
    return {"ok": True}


# --------------------------------------------------------------------------- strava

@app.get("/api/strava/connect")
def strava_connect():
    if not config.strava_configured():
        raise HTTPException(400, "STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET manquants dans .env")
    return RedirectResponse(strava.authorize_url())


@app.get("/api/strava/callback")
def strava_callback(code: str = "", state: str = "", scope: str = "", error: str = ""):
    if error or not code:
        return RedirectResponse("/#/settings?strava=denied")
    try:
        strava.exchange_code(code, state, scope)
    except Exception as e:
        db.log("strava", f"oauth: {type(e).__name__}", "error")
        return RedirectResponse("/#/settings?strava=error")
    strava.sync.trigger()
    return RedirectResponse("/#/settings?strava=ok")


@app.post("/api/strava/sync")
def strava_sync():
    strava.sync.trigger()
    return {"ok": True}


@app.post("/api/strava/disconnect")
def strava_disconnect():
    strava.disconnect()
    return {"ok": True}


# --------------------------------------------------------------------------- activities

ACT_COLS = ("a.id, a.name, a.description, a.sport, a.type_key, a.is_race, a.date, a.start_local, a.start_utc, "
            "a.location_name, a.distance, a.moving_time, a.elapsed_time, a.elev_gain, a.avg_speed, a.max_speed, "
            "a.avg_hr, a.max_hr, a.avg_power, a.norm_power, a.avg_cadence, a.calories, a.aerobic_te, a.anaerobic_te, "
            "a.te_label, a.garmin_load, a.vo2max, a.rpe, a.feel, a.avg_vert_osc, a.avg_gct, a.avg_stride, a.avg_vert_ratio, "
            "a.avg_resp, a.avg_temp, a.avg_swolf, a.fit_status, a.race_user, a.race_auto, a.race_garmin, "
            "m.load, m.load_method, m.ef, m.decoupling, m.gap_speed, m.intensity, m.z1, m.z2, m.z3, m.z4, m.z5")
ACT_FROM = "FROM activities a LEFT JOIN activity_metrics m ON m.activity_id=a.id"


@app.get("/api/activities")
def activities(start: str | None = None, end: str | None = None, sport: str | None = None,
               q: str | None = None, limit: int = 1000, offset: int = 0):
    where, args = ["a.is_parent = 0"], []
    if start:
        where.append("a.date >= ?"); args.append(start)
    if end:
        where.append("a.date <= ?"); args.append(end)
    if sport:
        where.append("a.sport = ?"); args.append(sport)
    if q:
        where.append("(a.name LIKE ? OR a.description LIKE ? OR a.location_name LIKE ?)"); args += [f"%{q}%"] * 3
    sql = f"SELECT {ACT_COLS} {ACT_FROM} WHERE {' AND '.join(where)} ORDER BY a.start_local DESC LIMIT ? OFFSET ?"
    with db.session() as c:
        rows = [dict(r) for r in c.execute(sql, args + [limit, offset])]
    return clean(with_strava(rows))


def _downsample(data: dict[str, list], target: int = 1600) -> tuple[dict[str, list], int]:
    """Keep every step-th sample; the step lets the UI map full-resolution indices (laps, efforts)."""
    n = max((len(v) for v in data.values() if isinstance(v, list)), default=0)
    if n <= target:
        return data, 1
    step = math.ceil(n / target)
    return {k: v[::step] for k, v in data.items() if isinstance(v, list)}, step


@app.get("/api/activities/{aid}")
def activity(aid: int):
    with db.session() as c:
        a = c.execute(f"SELECT {ACT_COLS}, a.max_power_curve, a.pool_length {ACT_FROM} WHERE a.id=?", (aid,)).fetchone()
        if a is None:
            raise HTTPException(404)
        a = dict(a)
        laps = [dict(r) for r in c.execute("SELECT * FROM laps WHERE activity_id=? ORDER BY lap_index", (aid,))]
        efforts = [dict(r) for r in c.execute("SELECT * FROM best_efforts WHERE activity_id=? ORDER BY distance", (aid,))]
        # rank of each effort among all runs (1 = all-time best)
        for e in efforts:
            e["rank"] = c.execute("SELECT 1 + COUNT(*) FROM best_efforts WHERE name=? AND elapsed_time < ?",
                                  (e["name"], e["elapsed_time"])).fetchone()[0]
        st = c.execute("SELECT data FROM streams WHERE activity_id=?", (aid,)).fetchone()
        s = db.get_settings(c)
        similar = []
        if a["distance"]:
            similar = [dict(r) for r in c.execute(
                f"SELECT {ACT_COLS} {ACT_FROM} WHERE a.sport=? AND a.distance BETWEEN ? AND ? AND a.id != ? "
                "AND a.is_parent=0 ORDER BY a.date DESC LIMIT 40",
                (a["sport"], a["distance"] * 0.85, a["distance"] * 1.15, aid))]
    streams, step = _downsample(db.unpack(st["data"])) if st else ({}, 1)
    a["max_power_curve"] = json.loads(a["max_power_curve"]) if a.get("max_power_curve") else None
    with_strava([a])
    return clean({"activity": a, "laps": laps, "best_efforts": efforts, "streams": streams, "stream_step": step,
                  "hr_zones": s["hr_zones"], "similar": similar})


@app.get("/api/calendar")
def calendar(start: str, end: str):
    with db.session() as c:
        rows = [dict(r) for r in c.execute(
            "SELECT a.id, a.date, a.sport, a.name, a.distance, a.moving_time, a.is_race, a.start_utc, a.start_local, m.load "
            "FROM activities a LEFT JOIN activity_metrics m ON m.activity_id=a.id "
            "WHERE a.date BETWEEN ? AND ? AND a.is_parent=0 ORDER BY a.start_local", (start, end))]
    return clean(with_strava(rows))


@app.get("/api/weekly")
def weekly(weeks: int = 52):
    start = (date.today() - timedelta(weeks=weeks)).isoformat()
    with db.session() as c:
        df = pd.read_sql(
            "SELECT a.date, a.sport, a.distance, a.moving_time, a.elev_gain, m.load FROM activities a "
            "LEFT JOIN activity_metrics m ON m.activity_id=a.id WHERE a.date >= ? AND a.is_parent=0", c, params=(start,))
    if df.empty:
        return []
    df["date"] = pd.to_datetime(df["date"])
    df["week"] = (df["date"] - pd.to_timedelta(df["date"].dt.weekday, unit="D")).dt.strftime("%Y-%m-%d")
    g = df.groupby(["week", "sport"]).agg(km=("distance", lambda x: x.fillna(0).sum() / 1000),
                                           hours=("moving_time", lambda x: x.fillna(0).sum() / 3600),
                                           load=("load", "sum"), n=("date", "count"),
                                           elev=("elev_gain", "sum")).reset_index()
    return clean(g.to_dict(orient="records"))


@app.get("/api/load")
def load(start: str | None = None, end: str | None = None):
    df = load_model.daily_frame()
    if df.empty:
        return []
    if start:
        df = df[df.index >= pd.Timestamp(start)]
    if end:
        df = df[df.index <= pd.Timestamp(end)]
    return frame_records(df)


@app.get("/api/performance")
def perf(window: int = 90):
    with db.session() as c:
        vo2 = [dict(r) for r in c.execute(
            "SELECT date, MAX(vo2max) vo2max FROM activities WHERE vo2max IS NOT NULL AND sport='run' GROUP BY date ORDER BY date")]
    return clean({
        "predictions": performance.predictions(window),
        "records": performance.all_time_records(),
        "progression": performance.progression(),
        "vdot_trend": performance.vdot_trend(),
        "ef": performance.ef_trend(),
        "garmin_vo2max": vo2,
    })


@app.get("/api/gear")
def gear():
    return [] if config.QA else clean(strava.gear_list())


@app.get("/api/routes")
def routes(sport: str | None = None, limit: int = 500):
    sql = "SELECT id, date, sport, name, distance, route FROM activities WHERE route IS NOT NULL"
    args: list = []
    if sport:
        sql += " AND sport=?"; args.append(sport)
    sql += " ORDER BY date DESC LIMIT ?"
    with db.session() as c:
        rows = [dict(r) for r in c.execute(sql, args + [limit])]
    for r in rows:
        r["route"] = json.loads(r["route"])
    return clean(rows)


@app.get("/api/punchcard")
def punchcard(days: int = 365):
    start = (date.today() - timedelta(days=days)).isoformat()
    with db.session() as c:
        rows = c.execute("SELECT start_local, sport, moving_time FROM activities WHERE date >= ? AND is_parent=0", (start,)).fetchall()
    return [{"t": r["start_local"], "sport": r["sport"], "dur": r["moving_time"]} for r in rows]


# --------------------------------------------------------------------------- wellness

WELL_COLS = ("date, sleep_start, sleep_end, sleep_seconds, deep_seconds, light_seconds, rem_seconds, awake_seconds, "
             "nap_seconds, awake_count, sleep_score, sleep_quality, sleep_need_min, sleep_hr, sleep_stress, sleep_resp, "
             "sleep_spo2, hrv_overnight, hrv_5min_high, hrv_weekly, hrv_baseline_low, hrv_baseline_high, hrv_status, "
             "resting_hr, min_hr, max_hr, body_battery_high, body_battery_low, body_battery_charged, body_battery_drained, "
             "stress_avg, stress_high_pct, respiration, spo2, steps, intensity_min, weight")


@app.get("/api/wellness")
def wellness(start: str | None = None, end: str | None = None):
    where, args = [], []
    if start:
        where.append("date >= ?"); args.append(start)
    if end:
        where.append("date <= ?"); args.append(end)
    sql = f"SELECT {WELL_COLS} FROM daily_wellness"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY date"
    with db.session() as c:
        return clean([dict(r) for r in c.execute(sql, args)])


@app.get("/api/wellness/{day}/sleep")
def sleep_detail(day: str):
    """Sleep levels timeline for one night (from the raw Garmin payload)."""
    with db.session() as c:
        r = c.execute("SELECT raw_sleep FROM daily_wellness WHERE date=?", (day,)).fetchone()
    raw = db.unpack(r["raw_sleep"]) if r and r["raw_sleep"] else {}
    keep = ("sleepLevels", "sleepMovement", "sleepHeartRate", "sleepStress", "hrvData", "sleepScores", "sleepNeed",
            "sleepScoreFeedback", "sleepScoreInsight", "sleepStartTimestampLocal", "sleepEndTimestampLocal")
    return clean({k: raw.get(k) for k in keep if k in raw})


# --------------------------------------------------------------------------- cockpit

@app.get("/api/cockpit")
def cockpit():
    today = date.today()
    df = load_model.daily_frame()
    out: dict[str, Any] = {"today": today.isoformat()}
    if not df.empty:
        t = df.loc[pd.Timestamp(today)] if pd.Timestamp(today) in df.index else df.iloc[-1]
        out["form"] = {k: t.get(k) for k in ("ctl", "atl", "tsb", "acwr", "ramp", "monotony", "run_ctl")}
        out["pmc"] = frame_records(df.tail(120), ["ctl", "atl", "tsb", "load"])
        out["heat"] = frame_records(df.tail(371), ["load", "run_km"])
    week_start = today - timedelta(days=today.weekday())
    with db.session() as c:
        out["week"] = with_strava([dict(r) for r in c.execute(
            "SELECT a.id, a.date, a.sport, a.name, a.distance, a.moving_time, a.is_race, a.start_utc, m.load "
            "FROM activities a LEFT JOIN activity_metrics m ON m.activity_id=a.id WHERE a.date >= ? AND a.is_parent=0 "
            "ORDER BY a.start_local", ((week_start - timedelta(weeks=8)).isoformat(),))])
        out["week_start"] = week_start.isoformat()
        last = c.execute(f"SELECT {ACT_COLS}, a.route {ACT_FROM} WHERE a.is_parent=0 ORDER BY a.start_local DESC LIMIT 1").fetchone()
        out["last_activity"] = with_strava([dict(last)])[0] if last else None
        if out["last_activity"] and out["last_activity"].get("route"):
            out["last_activity"]["route"] = json.loads(out["last_activity"]["route"])
        out["nights"] = [dict(r) for r in c.execute(f"SELECT {WELL_COLS} FROM daily_wellness ORDER BY date DESC LIMIT 30")]
        out["goals"] = [dict(r) for r in c.execute("SELECT * FROM goals WHERE date >= ? ORDER BY date", (today.isoformat(),))]
        vo2 = c.execute("SELECT vo2max, date FROM activities WHERE vo2max IS NOT NULL AND sport='run' ORDER BY date DESC LIMIT 1").fetchone()
        out["garmin_vo2max"] = dict(vo2) if vo2 else None
    pred = performance.predictions(90)
    out["vdot"] = pred.get("vdot")
    out["vdot_source"] = pred.get("vdot_source")
    for g in out["goals"]:
        g["days_to"] = (date.fromisoformat(g["date"]) - today).days
        if g["sport"] == "run" and g["distance"]:
            p = predict.predict_distance(g["distance"])
            g["predicted"] = p["ensemble"]
            g["predicted_range"] = p["range"]
            g["predicted_by"] = max(p["weights"], key=p["weights"].get) if p["weights"] else None
    out["readiness"] = readiness.today()
    return clean(out)


# --------------------------------------------------------------------------- profile (Enduraw-inspired)

@app.delete("/api/activities/{aid}")
def delete_activity(aid: int):
    """Remove a corrupted session from TrainLab (Garmin keeps it); the sync won't bring it back."""
    with db.session() as c:
        row = c.execute("SELECT date, name FROM activities WHERE id=?", (aid,)).fetchone()
        if row is None:
            raise HTTPException(404)
        c.execute("INSERT OR REPLACE INTO hidden_activities(id, deleted_at, label) VALUES (?, datetime('now'), ?)",
                  (aid, f"{row['date']} {row['name']}"))
        for table, col in (("activities", "id"), ("activity_raw", "id"), ("streams", "activity_id"), ("laps", "activity_id"),
                           ("best_efforts", "activity_id"), ("activity_metrics", "activity_id"), ("speed_curve", "activity_id"),
                           ("steady_samples", "activity_id"), ("run_insights", "activity_id"),
                           ("interval_sessions", "activity_id"), ("interval_checked", "activity_id")):
            c.execute(f"DELETE FROM {table} WHERE {col}=?", (aid,))
    (config.FIT_DIR / f"{aid}.zip").unlink(missing_ok=True)
    return {"ok": True}


@app.put("/api/activities/{aid}/race")
def set_race(aid: int, payload: dict = Body(...)):
    """Manual override of the race flag: true / false / null (back to automatic)."""
    v = payload.get("value")
    with db.session() as c:
        c.execute("UPDATE activities SET race_user=? WHERE id=?", (None if v is None else int(bool(v)), aid))
    garmin.refresh_race_flags()
    return {"ok": True}


@app.get("/api/profile/matrix")
def profile_matrix():
    return clean(matrix.matrix())


@app.get("/api/profile/predictions")
def profile_predictions():
    rep = predict.report()
    with db.session() as c:
        goals = [dict(r) for r in c.execute("SELECT * FROM goals WHERE date >= ? AND sport='run' AND distance > 0 ORDER BY date",
                                           (date.today().isoformat(),))]
    for g in goals:
        g["days_to"] = (date.fromisoformat(g["date"]) - date.today()).days
        g.update(predict.predict_distance(g["distance"]))
    return clean({**rep, "models": predict.MODELS, "goals": goals})


@app.get("/api/profile/curves")
def profile_curves():
    today = pd.Timestamp(date.today()) + pd.Timedelta(days=1)
    fresh = profile.curve_frame(0)
    out: dict[str, Any] = {"envelopes": {}, "fatigued": {}}
    for label, days in (("90 j", 90), ("1 an", 365), ("Tout", None)):
        env = profile.envelope(fresh, today, days)
        out["envelopes"][label] = [{"duration": int(k), "speed": float(v)} for k, v in env.items()]
    env_fresh = profile.envelope(fresh, today, 365)
    for after in (3600, 5400):
        env = profile.envelope(profile.curve_frame(after), today, 365)
        out["fatigued"][str(after)] = [{"duration": int(k), "speed": float(v),
                                        "di": float(v / env_fresh[k]) if k in env_fresh.index and env_fresh[k] else None}
                                       for k, v in env.items()]
    out["cs"] = profile.critical_speed(profile.envelope(fresh, today, 90))
    # which session holds each all-time best (for tooltips and labelled points)
    if not fresh.empty:
        best = fresh.dropna(subset=["gap"]).sort_values("gap").groupby("duration").tail(1)
        with db.session() as c:
            names = {r["id"]: r["name"] for r in c.execute("SELECT id, name FROM activities WHERE sport='run'")}
        out["sources"] = [{"duration": int(r.duration), "speed": float(r.gap), "activity_id": int(r.activity_id),
                           "date": r.date.date().isoformat(), "name": names.get(int(r.activity_id))}
                          for r in best.sort_values("duration").itertuples()]
    out["records"] = performance.all_time_records()
    with db.session() as c:
        out["races"] = [dict(r) for r in c.execute(
            "SELECT id, date, name, distance, elapsed_time, avg_hr FROM activities WHERE is_race=1 AND sport='run' ORDER BY date")]
        out["long_runs"] = [dict(r) for r in c.execute(
            "SELECT a.id, a.date, a.name, a.moving_time, a.distance, a.avg_hr, ri.drift_hr, ri.drift_gct, ri.drift_cad, ri.n_steady "
            "FROM run_insights ri JOIN activities a ON a.id = ri.activity_id WHERE ri.drift_hr IS NOT NULL ORDER BY a.date")]
    return clean(out)


@app.get("/api/profile/engine")
def profile_engine():
    df = profile.samples_frame()
    today = pd.Timestamp(date.today())
    cur = profile.engine_fit(df, today) if not df.empty else None
    recent = df[df["date"] > today - pd.Timedelta(days=42)] if not df.empty else df
    with db.session() as c:
        resid = [dict(r) for r in c.execute(
            "SELECT a.id, a.date, a.name, a.moving_time, ri.engine_resid FROM run_insights ri JOIN activities a ON a.id = ri.activity_id "
            "WHERE ri.engine_resid IS NOT NULL AND a.date >= ? ORDER BY a.date", ((date.today() - timedelta(days=365)).isoformat(),))]
    return clean({
        "current": cur,
        "monthly": profile.engine_monthly(df)[-14:],
        "series": profile.engine_series(df),
        "samples": [[float(h), float(v), d.date().isoformat()] for h, v, d in zip(recent["hr"], recent["gap_speed"], recent["date"])] if len(recent) else [],
        "residuals": resid,
    })


@app.get("/api/activities/{aid}/intervals")
def activity_intervals(aid: int):
    res = intervals.analyse(aid)
    if not res:
        return {"detected": False}
    res["detected"] = True
    res["similar"] = intervals.similar(aid, res["summary"])
    with db.session() as c:
        ri = c.execute("SELECT * FROM run_insights WHERE activity_id=?", (aid,)).fetchone()
    res["insights"] = dict(ri) if ri else None
    return clean(res)


@app.get("/api/activities/{aid}/insights")
def activity_insights(aid: int):
    with db.session() as c:
        ri = c.execute("SELECT * FROM run_insights WHERE activity_id=?", (aid,)).fetchone()
    return clean(dict(ri) if ri else {})


@app.get("/api/readiness")
def readiness_api(start: str | None = None, end: str | None = None):
    df = readiness.readiness_frame()
    if not df.empty:
        if start:
            df = df[df.index >= pd.Timestamp(start)]
        if end:
            df = df[df.index <= pd.Timestamp(end)]
    return clean({"today": readiness.today(), "labels": readiness.LABELS,
                  "days": frame_records(df) if not df.empty else []})


# --------------------------------------------------------------------------- machine learning

@app.get("/api/ml/experiments")
def ml_experiments():
    return clean(ml.experiments())


@app.get("/api/ml/now")
def ml_now():
    return clean({"tonight": ml.tonight(), "next_feel": ml.next_session_feel()})


# --------------------------------------------------------------------------- lab

@app.get("/api/lab/variables")
def lab_variables():
    return lab.variables_meta(lab.daily_features())


@app.get("/api/lab/pair")
def lab_pair(x: str, y: str, lag: int = 0, start: str | None = None, end: str | None = None, active: bool = False):
    return clean(lab.pair(x, y, lag, start, end, active))


@app.get("/api/lab/matrix")
def lab_matrix(keys: str, lag: int = 0, start: str | None = None, end: str | None = None):
    return clean(lab.matrix(keys.split(","), lag, start, end))


@app.get("/api/lab/discover")
def lab_discover(target: str, lag: int = 0, start: str | None = None, end: str | None = None):
    return clean(lab.discover(target, lag, start, end))


@app.get("/api/lab/series")
def lab_series(keys: str, start: str | None = None, end: str | None = None):
    df = lab.daily_features()
    if df.empty:
        return []
    keys_l = [k for k in keys.split(",") if k in df.columns]
    df = lab._slice(df[keys_l], start, end)
    return frame_records(df)


# --------------------------------------------------------------------------- frontend

def asset_version() -> str:
    """Changes whenever a JS/CSS file changes (latest mtime), used to version URLs."""
    files = [*(config.FRONTEND_DIR / "js").rglob("*.js"), *(config.FRONTEND_DIR / "css").rglob("*.css")]
    return format(int(max(f.stat().st_mtime for f in files)), "x")


@app.get("/js/v{ver}/{path:path}")
def versioned_js(ver: str, path: str):
    base = (config.FRONTEND_DIR / "js").resolve()
    target = (base / path).resolve()
    if base not in target.parents or not target.is_file():
        raise HTTPException(404)
    # the version is in the URL, so the file can be cached for good
    return FileResponse(target, media_type="text/javascript", headers={"Cache-Control": "public, max-age=31536000, immutable"})


@app.middleware("http")
async def revalidate_assets(request: Request, call_next):
    response = await call_next(request)
    path = request.url.path
    if (path.startswith("/js/") and not path.startswith("/js/v")) or path.startswith("/css/"):
        response.headers["Cache-Control"] = "no-cache"  # always revalidate (ETag) unversioned assets
    return response


app.mount("/vendor", StaticFiles(directory=config.FRONTEND_DIR / "vendor"), name="vendor")
app.mount("/css", StaticFiles(directory=config.FRONTEND_DIR / "css"), name="css")
app.mount("/js", StaticFiles(directory=config.FRONTEND_DIR / "js"), name="js")


@app.get("/")
def index():
    html = (config.FRONTEND_DIR / "index.html").read_text(encoding="utf-8").replace("__V__", asset_version())
    return HTMLResponse(html, headers={"Cache-Control": "no-cache"})
