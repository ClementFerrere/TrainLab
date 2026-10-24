"""Interval sessions: rep detection, per-rep execution metrics, session summary.

Reps come from the watch's structured laps (active / rest) when the session was a
workout; otherwise from the speed stream (sustained fast segments separated by
slower recoveries).
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .. import db
from .load import minetti_cost

MIN_REP_S = 40


def _smooth(x: np.ndarray, w: int) -> np.ndarray:
    k = np.ones(w) / w
    return np.convolve(np.nan_to_num(x), k, mode="same")


def _reps_from_laps(laps: list) -> list[tuple[int, int]] | None:
    active = [l for l in laps if l["intensity"] == "active" and (l["elapsed_time"] or 0) >= MIN_REP_S]
    rests = [l for l in laps if l["intensity"] == "rest"]
    if len(active) < 2 or not rests:
        return None
    return [(int(l["start_index"]), int(l["end_index"])) for l in active]


def _reps_from_speed(t: np.ndarray, v: np.ndarray, hr: np.ndarray, hr_max: float) -> list[tuple[int, int]] | None:
    """Fallback: fast segments = smoothed speed above the midpoint between the easy
    (median) and fast (95th pct) running speed, lasting >= 40 s, at least 3 of them,
    clearly faster than the recoveries and hard enough (HR) to be a real workout."""
    if len(v) < 300:
        return None
    vs = _smooth(v, 15)
    run = vs[vs > 1.8]
    if len(run) < 200:
        return None
    lo, hi = np.median(run), np.percentile(run, 95)
    if hi / lo < 1.12:
        return None  # steady run: no clear fast/slow alternation
    fast = vs > (lo + hi) / 2
    reps, i = [], 0
    while i < len(fast):
        if fast[i]:
            j = i
            while j + 1 < len(fast) and fast[j + 1]:
                j += 1
            if t[j] - t[i] >= MIN_REP_S:
                reps.append((i, j))
            i = j + 1
        else:
            i += 1
    if len(reps) < 3 or np.median([t[j] - t[i] for i, j in reps]) < 60:
        return None  # strides or traffic-light surges, not a workout
    in_rep = np.zeros(len(v), dtype=bool)
    for i, j in reps:
        in_rep[i:j + 1] = True
    between = vs[(~in_rep) & (vs > 1.8)]
    if len(between) and vs[in_rep].mean() / np.median(between) < 1.15:
        return None
    rep_hr = hr[in_rep]
    if np.isfinite(rep_hr).any() and np.nanmean(rep_hr) < 0.78 * hr_max:
        return None
    return reps


def analyse(aid: int) -> dict | None:
    with db.session() as c:
        a = c.execute("SELECT id, sport, date FROM activities WHERE id=?", (aid,)).fetchone()
        hr_max = db.get_settings(c)["hr_max"]
        if not a or a["sport"] != "run":
            return None
        laps = [dict(r) for r in c.execute("SELECT * FROM laps WHERE activity_id=? ORDER BY lap_index", (aid,))]
        row = c.execute("SELECT data FROM streams WHERE activity_id=?", (aid,)).fetchone()
    if not row:
        return None
    st = db.unpack(row["data"])
    t = np.asarray(st.get("time") or [], dtype=float)
    if len(t) < 120 or not st.get("velocity_smooth"):
        return None
    v = np.asarray([np.nan if x is None else x for x in st["velocity_smooth"]], dtype=float)
    d = np.asarray(st.get("distance") or np.zeros(len(t)), dtype=float)
    hr = np.asarray([np.nan if x is None else x for x in (st.get("heartrate") or [None] * len(t))], dtype=float)
    g = np.asarray(st.get("grade_smooth") or [0] * len(t), dtype=float) / 100
    gapf = minetti_cost(np.nan_to_num(g)) / minetti_cost(0)

    source = "laps"
    reps = _reps_from_laps(laps)
    if not reps:
        source = "speed"
        reps = _reps_from_speed(t, v, hr, hr_max)
    if not reps:
        return None

    def mean(arr, i, j):
        x = arr[i:j + 1]
        x = x[np.isfinite(x)]
        return float(x.mean()) if len(x) else None

    def opt(key, i, j, scale=1.0):
        a = st.get(key)
        if not a or len(a) != len(t):
            return None
        m = mean(np.asarray([np.nan if x is None else x for x in a], dtype=float), i, j)
        return m * scale if m is not None else None

    out = []
    for k, (i, j) in enumerate(reps):
        dur = float(t[j] - t[i])
        dist = float(d[j] - d[i])
        if dur < MIN_REP_S or dist <= 0:
            continue
        spd = dist / dur
        # fade: second half vs first half of the rep, skipping the first 10 s of acceleration
        i2 = int(np.searchsorted(t, t[i] + 10))
        mid = int(np.searchsorted(t, (t[i2] + t[j]) / 2))
        v1, v2 = mean(v, i2, mid), mean(v, mid, j)
        hr_rep = hr[i:j + 1]
        hr_ok = np.isfinite(hr_rep).any()
        hr_max = float(np.nanmax(hr_rep)) if hr_ok else None
        t90 = None
        if hr_ok and hr_max:
            idx = np.where(hr_rep >= 0.9 * hr_max)[0]
            t90 = float(t[i + idx[0]] - t[i]) if len(idx) else None
        # recovery: HR drop over the 60 s following the rep
        hrr = None
        j60 = int(np.searchsorted(t, t[j] + 60))
        if j60 < len(t) and np.isfinite(hr[j]) and np.isfinite(hr[j60]) and (k + 1 < len(reps) and reps[k + 1][0] > j60 or k + 1 == len(reps)):
            hrr = float(hr[j] - hr[j60])
        rest_s = float(t[reps[k + 1][0]] - t[j]) if k + 1 < len(reps) else None
        out.append({
            "index": len(out) + 1, "start": float(t[i]), "duration": dur, "distance": dist, "speed": spd,
            "gap_speed": float(np.nansum((v * gapf)[i:j + 1]) / max(1, np.isfinite(v[i:j + 1]).sum())),
            "avg_hr": mean(hr, i, j), "max_hr": hr_max, "end_hr": float(hr[j]) if np.isfinite(hr[j]) else None,
            "t90": t90, "fade": (v2 / v1 - 1) * 100 if v1 and v2 else None, "hrr60": hrr, "rest": rest_s,
            "cadence": opt("cadence", i, j), "gct": opt("gct", i, j), "stride": opt("stride", i, j), "power": opt("watts", i, j),
        })
    if len(out) < 2:
        return None
    sp = np.array([r["speed"] for r in out])
    idx = np.arange(len(out))
    cost = np.array([(r["avg_hr"] or np.nan) / r["speed"] for r in out])
    cv = float(sp.std() / sp.mean() * 100)
    trend = float(np.polyfit(idx, sp, 1)[0] / sp.mean() * 100) if len(out) >= 3 else 0.0
    cost_trend = float(np.polyfit(idx[np.isfinite(cost)], cost[np.isfinite(cost)], 1)[0] / np.nanmean(cost) * 100) if np.isfinite(cost).sum() >= 3 else None
    fades = [r["fade"] for r in out if r["fade"] is not None]
    last_vs_first = (sp[-1] / sp[0] - 1) * 100
    rests = [r["rest"] for r in out if r["rest"]]
    rep_t = float(np.median([r["duration"] for r in out]))
    verdict, why = _verdict(cv, trend, last_vs_first, float(np.mean(fades)) if fades else 0.0)
    return {
        "activity_id": aid, "date": a["date"], "source": source, "reps": out,
        "summary": {
            "n": len(out), "rep_distance": float(np.median([r["distance"] for r in out])), "rep_time": rep_t,
            "speed": float(sp.mean()), "best": float(sp.max()), "cv": cv, "trend": trend, "last_vs_first": last_vs_first,
            "fade": float(np.mean(fades)) if fades else None, "cost_trend": cost_trend,
            "hrr60": float(np.mean([r["hrr60"] for r in out if r["hrr60"] is not None])) if any(r["hrr60"] is not None for r in out) else None,
            "rest_ratio": float(np.median(rests) / rep_t) if rests else None,
            "avg_hr": float(np.nanmean([r["avg_hr"] or np.nan for r in out])),
            "verdict": verdict, "why": why,
        },
    }


def _verdict(cv: float, trend: float, last_vs_first: float, fade: float) -> tuple[str, str]:
    if last_vs_first <= -4 or fade <= -5:
        return "craque", "La vitesse chute nettement sur les dernières répétitions" if last_vs_first <= -4 else "Tu perds de la vitesse à l'intérieur des répétitions"
    if trend >= 0.8 and cv < 4:
        return "progressif", "Chaque répétition un peu plus vite que la précédente"
    if cv <= 2.5:
        return "regulier", "Répétitions très homogènes"
    if cv <= 4.5:
        return "correct", "Quelques écarts entre répétitions"
    return "irregulier", "Allure très variable d'une répétition à l'autre"


# --------------------------------------------------------------------------- session index

def refresh_index() -> int:
    """(Re)build the per-session summary table used for comparisons and predictions."""
    with db.session() as c:
        done = {r[0] for r in c.execute("SELECT activity_id FROM interval_sessions")}
        ids = [r[0] for r in c.execute(
            "SELECT a.id FROM activities a JOIN streams s ON s.activity_id = a.id WHERE a.sport='run' AND a.is_race=0")]
        checked = {r[0] for r in c.execute("SELECT activity_id FROM interval_checked")}
    n = 0
    for aid in ids:
        if aid in done or aid in checked:
            continue
        res = analyse(aid)
        with db.session() as c:
            c.execute("INSERT OR IGNORE INTO interval_checked VALUES (?)", (aid,))
            if res:
                s = res["summary"]
                c.execute("INSERT OR REPLACE INTO interval_sessions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                          (aid, res["date"], res["source"], s["n"], s["rep_distance"], s["rep_time"], s["speed"], s["best"],
                           s["cv"], s["trend"], s["fade"], s["hrr60"], s["rest_ratio"], s["avg_hr"], s["verdict"]))
                n += 1
    return n


def sessions_frame() -> pd.DataFrame:
    with db.session() as c:
        df = pd.read_sql("SELECT i.*, a.name FROM interval_sessions i JOIN activities a ON a.id = i.activity_id", c)
    if not df.empty:
        df["date"] = pd.to_datetime(df["date"])
    return df


def similar(aid: int, summary: dict, limit: int = 12) -> list[dict]:
    df = sessions_frame()
    if df.empty:
        return []
    m = (df["activity_id"] != aid) & ((df["n"] - summary["n"]).abs() <= 1) & \
        ((df["rep_distance"] / summary["rep_distance"] - 1).abs() <= 0.15)
    sub = df[m].sort_values("date", ascending=False).head(limit)
    return [{"id": int(r.activity_id), "date": r.date.date().isoformat(), "name": r.name, "n": int(r.n),
             "rep_distance": r.rep_distance, "speed": r.speed, "avg_hr": r.avg_hr, "cv": r.cv, "hrr60": r.hrr60,
             "verdict": r.verdict} for r in sub.itertuples()]
