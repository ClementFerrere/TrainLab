"""Running performance: Daniels VDOT, Riegel, critical speed, PR progression."""
from __future__ import annotations

import math
from datetime import date, timedelta

import numpy as np
import pandas as pd

from .. import db

# Strava best-effort names, in distance order
EFFORTS = ["400m", "1/2 mile", "1k", "1 mile", "2 mile", "5k", "10k", "15k", "10 mile", "20k", "Half-Marathon", "30k", "Marathon"]
RACE_DISTANCES = {"5 km": 5000, "10 km": 10000, "Semi": 21097.5, "Marathon": 42195}


# --------------------------------------------------------------------------- Daniels

def _vo2(v):  # v in m/min
    return -4.60 + 0.182258 * v + 0.000104 * v * v


def _pct_max(t_min):
    return 0.8 + 0.1894393 * math.exp(-0.012778 * t_min) + 0.2989558 * math.exp(-0.1932605 * t_min)


def vdot(distance_m: float, time_s: float) -> float:
    t = time_s / 60
    return _vo2(distance_m / t) / _pct_max(t)


def predict_time(v: float, distance_m: float) -> float:
    """Time (s) at which the given VDOT covers distance_m (bisection)."""
    lo, hi = distance_m / 500 * 60, distance_m / 50 * 60  # 30 km/h .. 3 km/h
    for _ in range(60):
        mid = (lo + hi) / 2
        if vdot(distance_m, mid) > v:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2


def velocity_at_vo2(vo2: float) -> float:
    """m/min for a given VO2 (inverse of _vo2)."""
    a, b, c = 0.000104, 0.182258, -4.60 - vo2
    return (-b + math.sqrt(b * b - 4 * a * c)) / (2 * a)


def training_paces(v: float) -> list[dict]:
    """Daniels-style training paces (s/km) from a VDOT."""
    m_pace = predict_time(v, 42195) / 42.195
    zones = [
        ("E", "Endurance", 0.62, 0.74),
        ("T", "Seuil", 0.86, 0.88),
        ("I", "Intervalles (VMA)", 0.97, 1.0),
        ("R", "Répétitions", 1.05, 1.08),
    ]
    out = []
    for code, label, lo, hi in zones:
        p_slow = 60000 / velocity_at_vo2(v * lo)
        p_fast = 60000 / velocity_at_vo2(v * hi)
        out.append({"code": code, "label": label, "slow": p_slow, "fast": p_fast})
    out.insert(1, {"code": "M", "label": "Marathon", "slow": m_pace, "fast": m_pace})
    return out


def riegel(t1: float, d1: float, d2: float, k: float = 1.06) -> float:
    return t1 * (d2 / d1) ** k


# --------------------------------------------------------------------------- data

def efforts_frame() -> pd.DataFrame:
    with db.session() as c:
        df = pd.read_sql(
            "SELECT b.activity_id, b.name, b.distance, b.elapsed_time, b.date, a.name AS activity_name, a.is_race "
            "FROM best_efforts b JOIN activities a ON a.id = b.activity_id WHERE a.sport='run'",
            c,
        )
    if df.empty:
        return df
    df["date"] = pd.to_datetime(df["date"])
    df["vdot"] = [vdot(d, t) for d, t in zip(df["distance"], df["elapsed_time"])]
    # GPS glitches produce impossible efforts; drop anything beyond elite level.
    return df[(df["vdot"] > 20) & (df["vdot"] < 80)]


def critical_speed(best: pd.DataFrame) -> dict | None:
    """Fit distance = CS * t + D' on best efforts lasting 2-25 min."""
    pts = best[(best["elapsed_time"] >= 120) & (best["elapsed_time"] <= 1500)]
    if len(pts) < 3:
        return None
    t = pts["elapsed_time"].to_numpy(float)
    d = pts["distance"].to_numpy(float)
    cs, dprime = np.polyfit(t, d, 1)
    if cs <= 0:
        return None
    resid = d - (cs * t + dprime)
    r2 = 1 - resid.var() / d.var() if d.var() else None
    return {"cs": cs, "d_prime": dprime, "r2": r2, "points": [[float(a), float(b)] for a, b in zip(t, d)]}


def window_best(df: pd.DataFrame, end: pd.Timestamp, days: int) -> pd.DataFrame:
    w = df[(df["date"] > end - pd.Timedelta(days=days)) & (df["date"] <= end)]
    if w.empty:
        return w
    return w.loc[w.groupby("name")["elapsed_time"].idxmin()]


def predictions(days: int = 90, end: date | None = None) -> dict:
    df = efforts_frame()
    if df.empty:
        return {"window_days": days, "best": [], "models": {}}
    end_ts = pd.Timestamp(end or date.today())
    best = window_best(df, end_ts, days)
    out: dict = {"window_days": days, "best": [], "models": {}}
    for _, r in best.sort_values("distance").iterrows():
        out["best"].append({
            "name": r["name"], "distance": r["distance"], "time": int(r["elapsed_time"]),
            "date": r["date"].date().isoformat(), "activity_id": int(r["activity_id"]),
            "activity_name": r["activity_name"], "vdot": round(r["vdot"], 1),
        })
    long_enough = best[best["distance"] >= 1600]
    if not long_enough.empty:
        top = long_enough.loc[long_enough["vdot"].idxmax()]
        v = float(top["vdot"])
        out["vdot"] = round(v, 1)
        out["vdot_source"] = f"{top['name']} le {top['date'].date().isoformat()}"
        out["models"]["vdot"] = {k: predict_time(v, d) for k, d in RACE_DISTANCES.items()}
        out["paces"] = training_paces(v)
    ref = best[best["distance"] >= 5000].sort_values("distance")
    if not ref.empty:
        # Riegel from the longest-distance effort that is also the strongest (max VDOT among >= 5k)
        r = ref.loc[ref["vdot"].idxmax()]
        out["models"]["riegel"] = {k: riegel(r["elapsed_time"], r["distance"], d) for k, d in RACE_DISTANCES.items()}
        out["riegel_source"] = r["name"]
    cs = critical_speed(best)
    if cs:
        out["cs"] = cs
        out["models"]["cs"] = {k: (d - cs["d_prime"]) / cs["cs"] for k, d in RACE_DISTANCES.items() if d <= 10000}
    return out


def vdot_trend(window: int = 60) -> list[dict]:
    """Rolling best VDOT (efforts >= 1 mile) sampled weekly — a fitness curve."""
    df = efforts_frame()
    if df.empty:
        return []
    df = df[df["distance"] >= 1600]
    start, end = df["date"].min(), pd.Timestamp(date.today())
    out = []
    for d in pd.date_range(start + pd.Timedelta(days=14), end, freq="7D"):
        w = df[(df["date"] > d - pd.Timedelta(days=window)) & (df["date"] <= d)]
        if not w.empty:
            out.append({"date": d.date().isoformat(), "vdot": round(float(w["vdot"].max()), 2)})
    return out


def progression(names: list[str] | None = None) -> dict:
    df = efforts_frame()
    names = names or ["1k", "5k", "10k", "Half-Marathon"]
    out = {}
    for n in names:
        sub = df[df["name"] == n].sort_values("date")
        if sub.empty:
            continue
        pts = []
        best = math.inf
        for _, r in sub.iterrows():
            best = min(best, r["elapsed_time"])
            pts.append({"date": r["date"].date().isoformat(), "time": int(r["elapsed_time"]), "pr": int(best),
                        "activity_id": int(r["activity_id"]), "activity_name": r["activity_name"],
                        "race": int(r["is_race"] or 0)})
        out[n] = pts
    return out


def all_time_records() -> list[dict]:
    df = efforts_frame()
    if df.empty:
        return []
    best = df.loc[df.groupby("name")["elapsed_time"].idxmin()]
    best = best.assign(order=best["name"].map({n: i for i, n in enumerate(EFFORTS)})).sort_values("order")
    return [
        {"name": r["name"], "distance": r["distance"], "time": int(r["elapsed_time"]), "date": r["date"].date().isoformat(),
         "activity_id": int(r["activity_id"]), "activity_name": r["activity_name"], "vdot": round(r["vdot"], 1)}
        for _, r in best.iterrows()
    ]


def ef_trend() -> list[dict]:
    """Efficiency factor of easy runs (grade-adjusted m/min per bpm)."""
    with db.session() as c:
        s = db.get_settings(c)
        rows = c.execute(
            "SELECT a.id, a.date, a.name, a.avg_hr, a.moving_time, m.ef, m.decoupling FROM activities a "
            "JOIN activity_metrics m ON m.activity_id=a.id WHERE a.sport='run' AND m.ef IS NOT NULL "
            "AND a.moving_time >= 1500 ORDER BY a.date"
        ).fetchall()
    z3 = s["hr_zones"][1]
    return [
        {"id": r["id"], "date": r["date"], "name": r["name"], "ef": r["ef"], "avg_hr": r["avg_hr"],
         "decoupling": r["decoupling"], "easy": int((r["avg_hr"] or 999) < z3)}
        for r in rows
    ]
