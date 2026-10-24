"""Generate a realistic synthetic dataset in data/demo.db.

    .venv\\Scripts\\python scripts\\demo_data.py
    set SPORT_DEMO=1 && .venv\\Scripts\\python run.py

A fictional amateur runner-triathlete: a winter marathon, a spring half, a
triathlon block in early summer, a 10K block in autumn. Wellness is causally linked
to training (HRV drops after hard days, sleep debt raises resting HR...), so the lab
and the ML page have real structure to find. Nothing here touches data/sport.db.
"""
from __future__ import annotations

import math
import os
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

os.environ["SPORT_DEMO"] = "1"
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import numpy as np  # noqa: E402

from backend import config, db, garmin  # noqa: E402
from backend.analytics import intervals, profile  # noqa: E402
from backend.analytics import load as load_model  # noqa: E402
from backend.analytics.performance import velocity_at_vo2  # noqa: E402

rng = np.random.default_rng(42)
START = date(2024, 3, 1)
END = date.today()
HR_REST, HR_MAX, WEIGHT = 50, 192, 72
DT = 2.0  # stream sampling (s)

RACES = {  # date: (name, sport, distance m, time s)
    date(2024, 12, 8): ("10 km d'hiver", "run", 10000, 40 * 60 + 10),
    date(2025, 6, 15): ("10 km de printemps", "run", 10000, 39 * 60 + 50),
    date(2025, 7, 10): ("5000 m sur piste", "run", 5000, 18 * 60 + 52),
    date(2026, 2, 22): ("Marathon d'hiver", "run", 42195, 3 * 3600 + 22 * 60),
    date(2026, 4, 12): ("Semi-marathon de printemps", "run", 21097.5, 3600 + 29 * 60 + 40),
    date(2026, 8, 9): ("Kilomètre vertical", "run", 3800, 58 * 60 + 30),
}

LOOPS = [  # (lat, lng, rx m, ry m, wobble, place) — fictional loops in public parks
    (45.7772, 4.8530, 1300, 900, 0.22, "Lyon"),        # Parc de la Tête d'Or
    (44.8443, -0.5690, 1900, 420, 0.18, "Bordeaux"),   # quays
    (45.8992, 6.1294, 1500, 1100, 0.22, "Annecy"),     # lake shore
    (43.2628, 5.3755, 2600, 260, 0.08, "Marseille"),   # seaside, summer
]
BIKE_LOOP = (45.80, 4.70, 9000, 6000, 0.3, "Lyon")


def vdot_on(d: date) -> float:
    """Fitness curve: 49 -> 53.6 with a dip after the summer triathlon block."""
    t = (d - START).days / (END - START).days
    base = 49 + 4.4 * t
    if date(2026, 7, 1) <= d <= date(2026, 8, 31):
        base -= 0.8
    return base


def phase(d: date) -> dict:
    if d < date(2024, 9, 1):
        return {"km": 34, "bike": 0, "swim": 0, "padel": 1, "strength": 2}
    if d < date(2025, 1, 1):
        return {"km": 48, "bike": 0, "swim": 0, "padel": 1, "strength": 1}
    if d < date(2025, 9, 1):
        return {"km": 46, "bike": 0, "swim": 0, "padel": 1, "strength": 1}
    if d < date(2026, 1, 1):
        return {"km": 42, "bike": 1, "swim": 0, "padel": 1, "strength": 1}
    if d < date(2026, 3, 1):
        return {"km": 58, "bike": 0, "swim": 0, "padel": 0, "strength": 1}
    if d < date(2026, 5, 1):
        return {"km": 56, "bike": 1, "swim": 1, "padel": 0, "strength": 1}
    if d < date(2026, 7, 1):
        return {"km": 26, "bike": 4, "swim": 3, "padel": 0, "strength": 0}
    if d < date(2026, 9, 1):
        return {"km": 26, "bike": 2, "swim": 1, "padel": 2, "strength": 1}
    weeks = (d - date(2026, 9, 1)).days // 7
    km = min(40 + weeks * 5, 80) if weeks != 3 else 42
    return {"km": km, "bike": 0, "swim": 0, "padel": 0, "strength": 1}


# --------------------------------------------------------------------------- streams

def speed_profile(kind: str, dist_m: float, v_e: float, v_t: float, v_i: float, v_race: float) -> tuple[np.ndarray, list]:
    """Return per-sample speed (m/s) and lap segments [(intensity, n_samples)]."""
    segs: list[tuple[str, float, float]] = []  # (intensity, metres, speed)
    if kind == "intervals":
        reps = rng.choice([(6, 1000, 400), (5, 1600, 400), (10, 400, 200), (4, 2000, 400)])
        segs.append(("warmup", 2500, v_e))
        for _ in range(int(reps[0])):
            segs.append(("active", float(reps[1]), v_i * (1.0 if reps[1] <= 1000 else 0.97)))
            segs.append(("rest", float(reps[2]), v_e * 0.72))
        segs.append(("cooldown", 2000, v_e * 0.97))
    elif kind == "tempo":
        segs += [("warmup", 2500, v_e), ("active", max(dist_m - 4500, 3000), v_t), ("cooldown", 2000, v_e)]
    elif kind == "race":
        segs.append(("active", dist_m, v_race))
    else:
        segs.append(("active", dist_m, v_e * (0.97 if kind == "long" else 1.0)))
    v, laps = [], []
    for inten, metres, sp in segs:
        n = max(3, math.ceil(metres / sp / DT) + 1)
        noise = np.convolve(rng.normal(0, 0.12, n), np.ones(5) / 5, mode="same")
        v.append(np.clip(sp + noise, 0.8, 7))
        laps.append((inten, n))
    return np.concatenate(v), laps


def hr_response(v: np.ndarray, v_max: float, fatigue: float) -> np.ndarray:
    target = HR_REST + (HR_MAX - HR_REST) * np.clip(0.25 + 0.75 * (v / v_max) ** 2.4, 0.4, 1.0)
    target += np.linspace(0, 6, len(v)) + fatigue * 3  # cardiac drift + fatigue
    hr = np.empty_like(target)
    hr[0] = HR_REST + 30
    a = DT / 28
    for i in range(1, len(v)):
        hr[i] = hr[i - 1] + a * (target[i] - hr[i - 1])
    return np.clip(hr + rng.normal(0, 1.2, len(v)), 60, HR_MAX)


def route_points(dist: np.ndarray, loop) -> list:
    lat0, lng0, rx, ry, wob = loop[:5]
    L = 2 * math.pi * math.sqrt((rx * rx + ry * ry) / 2)
    ang = 2 * math.pi * dist / L
    r = 1 + wob * np.sin(3 * ang) * 0.5
    x = rx * r * np.cos(ang)
    y = ry * r * np.sin(ang)
    lat = lat0 + y / 111_320
    lng = lng0 + x / (111_320 * math.cos(math.radians(lat0)))
    return [[round(a, 6), round(b, 6)] for a, b in zip(lat, lng)]


def build_streams(sport: str, v: np.ndarray, hr: np.ndarray | None, loop, extra: dict | None = None) -> dict:
    n = len(v)
    t = np.arange(n) * DT
    dist = np.cumsum(v * DT)
    alt = 35 + 8 * np.sin(dist / 900) + 3 * np.sin(dist / 230)
    s = {"time": t.round(1).tolist(), "distance": dist.round(1).tolist(),
         "velocity_smooth": v.round(3).tolist(), "altitude": alt.round(1).tolist(),
         "moving": [True] * n, "grade_smooth": (np.gradient(alt, dist + 1e-6) * 100).clip(-20, 20).round(1).tolist()}
    if loop:
        s["latlng"] = route_points(dist, loop)
    if hr is not None:
        s["heartrate"] = hr.round().astype(int).tolist()
    if sport == "run":
        cad = np.clip(158 + 9 * (v - 2.8) + rng.normal(0, 1.5, n), 150, 200)
        s["cadence"] = cad.round(1).tolist()
        s["watts"] = (128 * v + rng.normal(0, 8, n)).round().astype(int).tolist()
        s["gct"] = np.clip(262 - 17 * (v - 3) + rng.normal(0, 5, n), 190, 300).round().tolist()
        s["vert_osc"] = np.clip(8.9 + 0.25 * (v - 3) + rng.normal(0, 0.2, n), 6, 12).round(2).tolist()
        s["stride"] = (v * 60 / cad).round(3).tolist()
    elif sport == "bike":
        s["cadence"] = np.clip(86 + rng.normal(0, 4, n), 60, 110).round().tolist()
        s["watts"] = np.clip(22 * v + rng.normal(0, 25, n), 0, 600).round().astype(int).tolist()
    if extra:
        s.update(extra)
    return s


def laps_from(segs, v, hr, sport, auto_km=True):
    laps, i = [], 0
    if len(segs) == 1 and auto_km:  # auto-lap every km
        dist = np.cumsum(v * DT)
        edges = [0] + [int(np.searchsorted(dist, k * 1000)) for k in range(1, int(dist[-1] // 1000) + 1)] + [len(v)]
        segs = [("active", edges[k + 1] - edges[k]) for k in range(len(edges) - 1) if edges[k + 1] > edges[k]]
    for k, (inten, n) in enumerate(segs):
        sl = slice(i, i + n)
        vv = v[sl]
        laps.append({"lap_index": k, "intensity": inten, "start_offset": i * DT, "distance": float(vv.sum() * DT),
                     "elapsed_time": n * DT, "moving_time": n * DT, "avg_speed": float(vv.mean()), "max_speed": float(vv.max()),
                     "avg_hr": float(hr[sl].mean()) if hr is not None else None, "max_hr": float(hr[sl].max()) if hr is not None else None,
                     "avg_cadence": float(158 + 9 * (vv.mean() - 2.8)) if sport == "run" else None,
                     "avg_power": float(128 * vv.mean()) if sport == "run" else None, "elev_gain": float(rng.uniform(0, 12)),
                     "start_index": i, "end_index": i + n - 1})
        i += n
    return laps


# --------------------------------------------------------------------------- generation

TYPE_KEYS = {"run": "running", "bike": "road_biking", "swim": "lap_swimming", "strength": "strength_training",
             "racket": "padel", "other": "hiking"}
NAMES = {"easy": "Footing", "tempo": "Seuil", "intervals": "VMA", "long": "Sortie longue", "race": "Course",
         "bike": "Vélo route", "swim": "Natation piscine", "strength": "Renfo jambes", "racket": "Padel"}


class Gen:
    def __init__(self) -> None:
        self.next_id = 18_000_000_000
        self.loads: dict[date, float] = {}
        self.fatigue = 0.0

    def emit(self, c, d: date, hour: float, sport: str, kind: str, v: np.ndarray | None, hr, segs, dur_s: float,
             dist_m: float, extra_summary: dict, loop=None, name=None, race=False):
        self.next_id += int(rng.integers(5_000, 90_000))
        aid = self.next_id
        start = datetime(d.year, d.month, d.day) + timedelta(hours=hour)
        rpe = {"easy": 3, "long": 5, "tempo": 6, "intervals": 8, "race": 9}.get(kind, 4) + int(rng.integers(-1, 2))
        summary = {
            "activityId": aid, "activityName": name or f"{NAMES.get(kind, NAMES.get(sport, 'Séance'))}",
            "activityType": {"typeKey": TYPE_KEYS[sport] if not (sport == "run" and kind == "race" and dist_m < 6000 and d.month == 8) else "trail_running"},
            "eventType": {"typeKey": "race" if race else "training"},
            "startTimeLocal": start.strftime("%Y-%m-%d %H:%M:%S"),
            "startTimeGMT": (start - timedelta(hours=1 if d.month in (11, 12, 1, 2, 3) else 2)).strftime("%Y-%m-%d %H:%M:%S"),
            "distance": dist_m, "duration": dur_s, "movingDuration": dur_s, "elapsedDuration": dur_s + rng.uniform(0, 120),
            "averageSpeed": dist_m / dur_s if dur_s else None, "maxSpeed": float(v.max()) if v is not None else None,
            "averageHR": float(hr.mean()) if hr is not None else None, "maxHR": float(hr.max()) if hr is not None else None,
            "calories": dur_s / 60 * (13 if sport in ("run", "racket") else 10), "locationName": loop[5] if loop else None,
            "startLatitude": loop[0] if loop else None, "startLongitude": loop[1] if loop else None, "hasPolyline": bool(loop),
            **extra_summary,
        }
        garmin.upsert_activity(c, summary)
        parsed = None
        if v is not None or hr is not None:
            streams = build_streams(sport, v, hr, loop) if v is not None else {"time": (np.arange(len(hr)) * DT).tolist(),
                                                                                 "heartrate": hr.round().astype(int).tolist()}
            laps = laps_from(segs, v, hr, sport) if v is not None else []
            parsed = {"session": {"rpe": max(1, min(10, rpe)), "feel": float(rng.choice([25, 50, 75, 100]))}, "streams": streams, "laps": laps}
        garmin.store_fit(c, aid, garmin.normalize_sport(summary["activityType"]["typeKey"]), d.isoformat(), parsed)
        load_model.compute_activity(aid, c)
        lm = c.execute("SELECT load FROM activity_metrics WHERE activity_id=?", (aid,)).fetchone()
        self.loads[d] = self.loads.get(d, 0) + (lm[0] or 0)

    def run(self, c, d: date, kind: str, km: float, hour: float, race=None):
        vd = vdot_on(d)
        v_e = velocity_at_vo2(vd * 0.68) / 60
        v_t = velocity_at_vo2(vd * 0.87) / 60
        v_i = velocity_at_vo2(vd * 0.98) / 60
        v_max = velocity_at_vo2(vd) / 60
        v_race = (race[2] / race[3]) if race else v_t
        v, segs = speed_profile(kind, km * 1000, v_e, v_t, v_i, v_race)
        hr = hr_response(v, v_max * 1.05, self.fatigue)
        dist = float(v.sum() * DT)
        loop = LOOPS[3] if d.month in (5, 6, 7, 8) and rng.random() < 0.5 else LOOPS[int(rng.integers(0, 3))]
        intensity = {"easy": 2.9, "long": 3.6, "tempo": 3.8, "intervals": 4.2, "race": 4.6}[kind]
        extra = {"aerobicTrainingEffect": round(min(5, intensity + rng.normal(0, 0.25)), 1),
                 "anaerobicTrainingEffect": round(max(0, (2.6 if kind == "intervals" else 0.6) + rng.normal(0, 0.4)), 1),
                 "trainingEffectLabel": {"easy": "AEROBIC_BASE", "long": "AEROBIC_BASE", "tempo": "TEMPO", "intervals": "VO2MAX", "race": "THRESHOLD"}[kind],
                 "activityTrainingLoad": round(len(v) * DT / 60 * {"easy": 1.0, "long": 1.4, "tempo": 2.0, "intervals": 2.6, "race": 3.0}[kind]),
                 "vO2MaxValue": round(vd * 1.02 + rng.normal(0, 0.4)), "averageRunningCadenceInStepsPerMinute": float(158 + 9 * (v.mean() - 2.8)),
                 "avgPower": float(128 * v.mean()), "avgGroundContactTime": float(262 - 17 * (v.mean() - 3)),
                 "avgVerticalOscillation": 8.9, "avgStrideLength": float(v.mean() * 60 / (158 + 9 * (v.mean() - 2.8)) * 100),
                 "elevationGain": float(rng.uniform(15, 90)), "avgRespirationRate": float(30 + 8 * (v.mean() - 3))}
        name = race[0] if race else None
        self.emit(c, d, hour, "run", kind, v, hr, segs, len(v) * DT, dist, extra, loop, name, bool(race))

    def other(self, c, d: date, sport: str, hour: float, minutes: float):
        n = int(minutes * 60 / DT)
        if sport == "bike":
            v = np.clip(8.4 + np.convolve(rng.normal(0, 0.7, n), np.ones(9) / 9, mode="same"), 3, 16)
            hr = hr_response(v / 2.6, 5.0, self.fatigue) - 8
            extra = {"avgPower": 168.0, "normPower": 182.0, "averageBikingCadenceInRevPerMinute": 86, "elevationGain": float(rng.uniform(150, 900)),
                     "aerobicTrainingEffect": 3.3, "activityTrainingLoad": round(minutes * 1.3)}
            self.emit(c, d, hour, "bike", "bike", v, hr, [("active", n)], n * DT, float(v.sum() * DT), extra,
                      LOOPS[3] if d.month in (5, 6) else BIKE_LOOP)
        elif sport == "swim":
            dist = float(rng.choice([2000, 2500, 3000]))
            extra = {"averageSwolf": 38, "poolLength": 2500, "aerobicTrainingEffect": 2.8, "activityTrainingLoad": round(minutes * 1.1)}
            self.emit(c, d, hour, "swim", "swim", None, None, [], minutes * 60, dist, extra)
        else:
            base = 108 if sport == "strength" else 142
            hr = np.clip(base + 14 * np.sin(np.arange(n) / 25) + rng.normal(0, 6, n), 70, 185)
            extra = {"aerobicTrainingEffect": 1.9 if sport == "strength" else 3.0, "activityTrainingLoad": round(minutes * (0.7 if sport == "strength" else 1.3))}
            self.emit(c, d, hour, sport, sport, None, hr, [], n * DT, 0, extra)


def week_plan(d: date, ph: dict) -> list[tuple]:
    """List of (weekday, kind, share_of_km or minutes) for the week of d."""
    km = ph["km"] * rng.uniform(0.92, 1.08)
    plan = []
    runs = 5 if km >= 45 else 4 if km >= 30 else 3
    shares = {5: [("tempo", 1, .18), ("intervals", 3, .17), ("easy", 2, .15), ("easy", 4, .14), ("long", 6, .36)],
              4: [("intervals", 1, .22), ("easy", 3, .2), ("tempo", 4, .22), ("long", 6, .36)],
              3: [("intervals", 1, .3), ("easy", 3, .3), ("long", 6, .4)]}[runs]
    for kind, wd, sh in shares:
        plan.append((wd, "run", kind, max(5.0, km * sh)))
    if ph["strength"]:
        plan.append((0, "strength", "strength", 60))
    if ph["strength"] > 1:
        plan.append((4, "strength", "strength", 50))
    for k in range(ph["padel"]):
        plan.append((5 - k * 3, "racket", "racket", 90))
    for k in range(ph["bike"]):
        plan.append(([5, 2, 0, 4][k], "bike", "bike", [180, 75, 60, 90][k]))
    for k in range(ph["swim"]):
        plan.append(([1, 3, 5][k], "swim", "swim", 50))
    return plan


def main() -> None:
    config.DB_PATH.unlink(missing_ok=True)
    db.init_db()
    gen = Gen()
    hrv_base, rhr_base = 64.0, 50.0
    with db.session() as c:
        d = START
        plan: list = []
        prev_sleep = 7.2
        while d <= END:
            if d.weekday() == 0 or not plan:
                plan = week_plan(d, phase(d))
            race = RACES.get(d)
            todays = [p for p in plan if p[0] == d.weekday()]
            taper = any(0 < (rd - d).days <= 6 for rd in RACES)
            if race:
                todays = [(d.weekday(), "run", "race", race[2] / 1000)]
            elif d == date(2026, 6, 28):
                gen.other(c, d, "swim", 7.0, 35); gen.other(c, d, "bike", 7.8, 170); gen.run(c, d, "easy", 21.1, 10.8)
                todays = []
            for _wd, sport, kind, amount in todays:
                if rng.random() < 0.06 and not race:
                    continue  # skipped session (life happens)
                if taper and sport == "run":
                    amount *= 0.6
                hour = 7.0 if rng.random() < 0.35 else 12.3 if rng.random() < 0.3 else 18.7
                if sport == "run":
                    gen.run(c, d, kind, amount, 9.0 if race or kind == "long" else hour, race)
                else:
                    gen.other(c, d, sport, hour, amount)

            # ---- wellness for the night ending on d+1 depends on today's load
            load_today = gen.loads.get(d, 0)
            gen.fatigue = 0.85 * gen.fatigue + 0.004 * load_today
            nd = d + timedelta(days=1)
            if nd <= END:
                weekend = nd.weekday() in (5, 6)
                sleep_h = float(np.clip(7.15 + (0.55 if weekend else 0) - 0.35 * (rng.random() < 0.15) + rng.normal(0, 0.55)
                                        + 0.0025 * load_today, 4.6, 9.6))
                bed = 23.4 + (0.6 if nd.weekday() in (5, 6) else 0) + rng.normal(0, 0.45)
                start = datetime(d.year, d.month, d.day) + timedelta(hours=bed)
                awake_m = float(np.clip(rng.normal(24, 9), 4, 70))
                end = start + timedelta(hours=sleep_h, minutes=awake_m)
                deep = float(np.clip(0.16 + 0.00035 * load_today + rng.normal(0, 0.025), 0.07, 0.3))
                rem = float(np.clip(0.22 + 0.012 * (sleep_h - 7) + rng.normal(0, 0.03), 0.1, 0.32))
                hrv_base += (66 + 0.9 * (vdot_on(d) - 49) - hrv_base) * 0.02
                hrv = float(np.clip(hrv_base - 0.075 * load_today + 2.8 * (sleep_h - 7.2) - 4 * gen.fatigue + rng.normal(0, 4.5), 28, 110))
                rhr = float(np.clip(rhr_base - 0.35 * (vdot_on(d) - 49) + 0.022 * load_today + 2.2 * gen.fatigue
                                    - 0.6 * (sleep_h - 7.2) + 0.5 * (prev_sleep < 6.3) + rng.normal(0, 1.1), 38, 62))
                score = float(np.clip(48 + 7.5 * (sleep_h - 6) + 60 * (deep - 0.16) - 0.25 * (awake_m - 20) + rng.normal(0, 4), 35, 98))
                bb = float(np.clip(76 + 6 * (sleep_h - 7) + 0.5 * (hrv - hrv_base) - 5 * gen.fatigue + rng.normal(0, 6), 15, 100))
                w = {
                    "sleep_start": start.isoformat(timespec="seconds"), "sleep_end": end.isoformat(timespec="seconds"),
                    "sleep_seconds": int(sleep_h * 3600), "deep_seconds": int(sleep_h * 3600 * deep), "rem_seconds": int(sleep_h * 3600 * rem),
                    "light_seconds": int(sleep_h * 3600 * (1 - deep - rem)), "awake_seconds": int(awake_m * 60),
                    "awake_count": int(rng.integers(0, 5)), "sleep_score": round(score), "sleep_quality": "GOOD" if score > 75 else "FAIR" if score > 55 else "POOR",
                    "sleep_hr": round(rhr + 4 + rng.normal(0, 1)), "sleep_stress": round(float(np.clip(14 + 6 * gen.fatigue + rng.normal(0, 4), 5, 60))),
                    "sleep_resp": round(float(14 + rng.normal(0, 0.6)), 1), "sleep_spo2": round(float(95.5 + rng.normal(0, 1)), 1),
                    "hrv_overnight": round(hrv), "hrv_5min_high": round(hrv * 1.45), "resting_hr": round(rhr), "min_hr": round(rhr - 3),
                    "max_hr": int(150 + rng.integers(0, 40)), "body_battery_high": round(bb), "body_battery_low": round(max(5, bb - rng.uniform(35, 65))),
                    "body_battery_charged": round(bb * 0.75), "body_battery_drained": round(bb * 0.8),
                    "stress_avg": round(float(np.clip(27 + (6 if nd.weekday() < 5 else -4) + 4 * gen.fatigue + rng.normal(0, 5), 10, 70))),
                    "stress_high_pct": round(float(np.clip(rng.normal(6, 3), 0, 30)), 1), "respiration": round(float(14.5 + rng.normal(0, 0.7)), 1),
                    "spo2": round(float(96 + rng.normal(0, 0.8)), 1), "steps": int(np.clip(rng.normal(9500, 2800), 2500, 26000)),
                    "intensity_min": round(load_today * 0.8),
                }
                garmin._upsert_wellness(c, nd.isoformat(), w)
                prev_sleep = sleep_h
            d += timedelta(days=1)
        # HRV weekly average & balanced range
        rows = c.execute("SELECT date, hrv_overnight FROM daily_wellness ORDER BY date").fetchall()
        vals = [r[1] for r in rows]
        for i, r in enumerate(rows):
            wk = np.mean(vals[max(0, i - 6): i + 1])
            base = np.mean(vals[max(0, i - 27): i + 1])
            status = "BALANCED" if base - 7 <= wk <= base + 9 else ("UNBALANCED" if wk < base - 7 else "BALANCED")
            if wk < base - 12:
                status = "LOW"
            c.execute("UPDATE daily_wellness SET hrv_weekly=?, hrv_baseline_low=?, hrv_baseline_high=?, hrv_status=? WHERE date=?",
                      (round(wk), round(base - 7), round(base + 9), status, r[0]))
    garmin.refresh_race_flags()
    n = load_model.recompute_all(force=True)
    profile.backfill()
    intervals.refresh_index()
    print(f"demo.db ready — {n} activities, {len(vals)} nights ({START} -> {END})")


if __name__ == "__main__":
    main()
