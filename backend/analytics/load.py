"""Training load model.

Per activity:
  - Banister TRIMP from the heart-rate stream (or the average HR as a fallback),
  - a load in "hrTSS" units: 100 = one hour at lactate-threshold HR,
  - seconds in each HR zone, grade-adjusted speed, efficiency factor and
    aerobic decoupling for runs.
Per day: Performance Management Chart (CTL / ATL / TSB), ACWR, monotony, strain.
"""
from __future__ import annotations

import math
from datetime import date

import numpy as np
import pandas as pd

from .. import db

# Load per hour when an activity has no heart rate at all (rough RPE-free guess).
ESTIMATE_PER_HOUR = {"run": 60, "bike": 45, "swim": 50, "strength": 35, "racket": 50, "other": 30}


def _hrr(hr, s):
    return np.clip((np.asarray(hr, dtype=float) - s["hr_rest"]) / (s["hr_max"] - s["hr_rest"]), 0, 1)


def _trimp_rate(hrr):
    # Banister (male coefficients): load per minute at a given HR reserve fraction
    return hrr * 0.64 * np.exp(1.92 * hrr)


def trimp_hour_at_lthr(s) -> float:
    return 60 * float(_trimp_rate(_hrr(s["lthr"], s)))


def minetti_cost(grade):
    """Energy cost of running (J/kg/m) vs grade (Minetti et al. 2002)."""
    i = np.clip(grade, -0.35, 0.35)
    return 155.4 * i**5 - 30.4 * i**4 - 43.3 * i**3 + 46.3 * i**2 + 19.5 * i + 3.6


def zone_index(hr, bounds):
    return np.searchsorted(np.asarray(bounds), np.asarray(hr, dtype=float), side="right")


def _metrics_from_stream(a, st, s):
    out: dict = {}
    t = np.asarray(st.get("time") or [], dtype=float)
    hr = st.get("heartrate")
    if len(t) < 2:
        return out
    dt = np.clip(np.diff(t, prepend=t[0]), 0, 10)
    moving = np.asarray(st.get("moving") or [], dtype=bool)
    if len(moving) != len(t):
        moving = np.ones(len(t), dtype=bool)
    if hr and len(hr) == len(t):
        hr = np.asarray(hr, dtype=float)
        trimp = float(np.sum(dt / 60 * _trimp_rate(_hrr(hr, s))))
        out["trimp"] = trimp
        out["load_method"] = "stream"
        z = zone_index(hr, s["hr_zones"])
        for k in range(5):
            out[f"z{k + 1}"] = float(np.sum(dt[z == k]))
    v = st.get("velocity_smooth")
    if a["sport"] == "run" and v and len(v) == len(t):
        v = np.asarray(v, dtype=float)
        g = np.asarray(st.get("grade_smooth") or [], dtype=float) / 100
        if len(g) != len(t):
            g = np.zeros(len(t))
        gap = v * minetti_cost(g) / minetti_cost(0)
        m = moving & (v > 1.5)  # ignore walking / stops
        if m.sum() > 120:
            out["gap_speed"] = float(np.average(gap[m], weights=dt[m]))
            if hr is not None and len(hr) == len(t):
                hm = m & (hr > 80)
                if hm.sum() > 120:
                    out["ef"] = float(np.average(gap[hm], weights=dt[hm]) * 60 / np.average(hr[hm], weights=dt[hm]))
                    if np.sum(dt[hm]) >= 50 * 60:
                        idx = np.where(hm)[0]
                        cum = np.cumsum(dt[idx])
                        h1, h2 = idx[cum <= cum[-1] / 2], idx[cum > cum[-1] / 2]
                        ef1 = np.average(gap[h1], weights=dt[h1]) / np.average(hr[h1], weights=dt[h1])
                        ef2 = np.average(gap[h2], weights=dt[h2]) / np.average(hr[h2], weights=dt[h2])
                        out["decoupling"] = float((ef1 - ef2) / ef1 * 100)
    return out


def compute_activity(aid: int, c=None, s=None) -> None:
    own = c is None
    c = c or db.connect()
    try:
        s = s or db.get_settings(c)
        a = c.execute("SELECT * FROM activities WHERE id=?", (aid,)).fetchone()
        if a is None:
            return
        row = c.execute("SELECT data FROM streams WHERE activity_id=?", (aid,)).fetchone()
        m = _metrics_from_stream(a, db.unpack(row["data"]), s) if row else {}
        dur = a["moving_time"] or a["elapsed_time"] or 0
        if "trimp" not in m:
            if a["avg_hr"]:
                m["trimp"] = dur / 60 * float(_trimp_rate(_hrr(a["avg_hr"], s)))
                m["load_method"] = "avg_hr"
                zk = int(zone_index([a["avg_hr"]], s["hr_zones"])[0])
                for k in range(5):
                    m[f"z{k + 1}"] = float(dur if k == zk else 0)
            else:
                m["trimp"] = None
                m["load_method"] = "estimate"
        if m["trimp"] is not None:
            m["load"] = m["trimp"] / trimp_hour_at_lthr(s) * 100
        else:
            m["load"] = dur / 3600 * ESTIMATE_PER_HOUR.get(a["sport"], 30)
        if a["sport"] == "run" and "ef" not in m and a["avg_hr"] and a["avg_speed"] and dur >= 1200:
            m["ef"] = a["avg_speed"] * 60 / a["avg_hr"]
        m["intensity"] = (m["load"] / (dur / 3600) / 100) if dur else None
        cols = ["load", "trimp", "load_method", "z1", "z2", "z3", "z4", "z5", "ef", "decoupling", "gap_speed", "intensity"]
        c.execute(
            f"INSERT OR REPLACE INTO activity_metrics(activity_id, {', '.join(cols)}) VALUES (?{', ?' * len(cols)})",
            [aid] + [m.get(k) for k in cols],
        )
        if own:
            c.commit()
    finally:
        if own:
            c.close()


def recompute_all(force: bool = False) -> int:
    with db.session() as c:
        s = db.get_settings(c)
        q = "SELECT id FROM activities"
        if not force:
            q += " WHERE id NOT IN (SELECT activity_id FROM activity_metrics)"
        ids = [r[0] for r in c.execute(q)]
        for aid in ids:
            compute_activity(aid, c, s)
    return len(ids)


# --------------------------------------------------------------------------- daily series

def daily_frame(end: date | None = None) -> pd.DataFrame:
    """One row per calendar day: load per sport, total, PMC and risk metrics."""
    return _daily_frame_cached() if end is None else _build_daily_frame(end)


def _build_daily_frame(end: date | None = None) -> pd.DataFrame:
    with db.session() as c:
        s = db.get_settings(c)
        df = pd.read_sql(
            "SELECT a.date, a.sport, a.moving_time, a.distance, m.load FROM activities a "
            "LEFT JOIN activity_metrics m ON m.activity_id = a.id WHERE a.is_parent = 0",
            c,
        )
    if df.empty:
        return pd.DataFrame()
    df["date"] = pd.to_datetime(df["date"])
    end = pd.Timestamp(end or date.today())
    idx = pd.date_range(df["date"].min(), max(end, df["date"].max()), freq="D")
    load = df.pivot_table(index="date", columns="sport", values="load", aggfunc="sum").reindex(idx).fillna(0)
    out = pd.DataFrame(index=idx)
    out["load"] = load.sum(axis=1)
    for sp in load.columns:
        out[f"load_{sp}"] = load[sp]
    hours = df.pivot_table(index="date", columns="sport", values="moving_time", aggfunc="sum").reindex(idx).fillna(0) / 3600
    for sp in hours.columns:
        out[f"hours_{sp}"] = hours[sp]
    run_km = df[df.sport == "run"].groupby("date")["distance"].sum().reindex(idx).fillna(0) / 1000
    out["run_km"] = run_km

    k_ctl = 1 - math.exp(-1 / s["ctl_days"])
    k_atl = 1 - math.exp(-1 / s["atl_days"])
    ctl = np.zeros(len(out))
    atl = np.zeros(len(out))
    run_ctl = np.zeros(len(out))
    lv = out["load"].to_numpy()
    rv = out.get("load_run", pd.Series(0, index=idx)).to_numpy()
    for i in range(len(out)):
        pc = ctl[i - 1] if i else 0
        pa = atl[i - 1] if i else 0
        pr = run_ctl[i - 1] if i else 0
        ctl[i] = pc + (lv[i] - pc) * k_ctl
        atl[i] = pa + (lv[i] - pa) * k_atl
        run_ctl[i] = pr + (rv[i] - pr) * k_ctl
    out["ctl"] = ctl
    out["atl"] = atl
    out["run_ctl"] = run_ctl
    # Form is what you bring into the day: yesterday's fitness minus yesterday's fatigue.
    out["tsb"] = (out["ctl"] - out["atl"]).shift(1).fillna(0)
    r7 = out["load"].rolling(7, min_periods=1)
    out["acwr"] = r7.mean() / out["load"].rolling(28, min_periods=7).mean()
    out["monotony"] = r7.mean() / r7.std().replace(0, np.nan)
    out["strain"] = r7.sum() * out["monotony"]
    out["ramp"] = out["ctl"] - out["ctl"].shift(7)
    out.index.name = "date"
    return out


_daily_frame_cached = db.cached_by_signature(lambda: _build_daily_frame(None))
