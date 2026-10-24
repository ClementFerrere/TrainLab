"""Running performance profile, from 1 Hz streams.

Primitives (stored per run):
  - speed_curve: mean-maximal speed (raw and grade-adjusted) per duration, fresh
    and after 60 / 90 minutes of running (durability);
  - steady_samples: 2-minute windows of steady running (stable pace, flat, HR
    settled) used to model the speed <-> heart-rate "engine".
Models (computed on demand):
  - engine: robust, time-weighted linear fit GAP speed = a + b * HR;
  - envelope: monotone best-speed curve over a window of days;
  - run insights: engine residual (bpm) and within-run drifts on long runs.
"""
from __future__ import annotations

from datetime import date, timedelta

import numpy as np
import pandas as pd

from .. import db
from ..fit import implausible
from .load import minetti_cost

DURATIONS = [15, 30, 60, 120, 180, 300, 420, 600, 720, 900, 1200, 1500, 1800, 2400, 3000, 3600, 4800, 5400, 7200]
AFTER = [0, 3600, 5400]   # fresh, after 60 min, after 90 min
WINDOW = 120              # steady-sample window (s)
WARMUP = 600              # ignore the first 10 min (HR still rising)


# --------------------------------------------------------------------------- primitives

# world-record speed (m/s) by effort duration: anything faster is a recording glitch
_WR = [(15, 10.4), (60, 9.0), (120, 8.0), (300, 7.4), (900, 6.8), (1800, 6.4), (3600, 6.0), (7200, 5.9)]


def world_record_speed(duration: float) -> float:
    xs, ys = zip(*_WR)
    return float(np.interp(np.log(duration), np.log(xs), ys))


def _grid(st: dict) -> dict | None:
    """Resample the streams we need on a 1 s elapsed-time grid."""
    t = np.asarray(st.get("time") or [], dtype=float)
    d = st.get("distance")
    if len(t) < 120 or not d:
        return None
    tg = np.arange(0, int(t[-1]) + 1, 1.0)
    dist = np.interp(tg, t, np.maximum.accumulate(np.nan_to_num(np.asarray(d, dtype=float))))
    # Neutralise physically implausible seconds (GPS jumps, bike/vehicle with the watch
    # in run mode) — same rule as the best efforts, see fit.implausible.
    step = np.diff(dist, prepend=dist[0])
    cad = st.get("cadence")
    cg = None
    if cad and len(cad) == len(t):
        cg = np.interp(tg, t, np.nan_to_num(np.asarray([np.nan if x is None else x for x in cad], dtype=float)))
    bad = implausible(step, cg)
    out = {"t": tg, "stopped": np.concatenate([[0], np.cumsum(step[1:] < 0.8)])}
    step[bad] = 0
    out["dist"] = np.cumsum(step)
    out["bad"] = np.concatenate([[0], np.cumsum(bad[1:])])
    alt = st.get("altitude")
    if alt and len(alt) == len(t):
        a = np.asarray([np.nan if x is None else x for x in alt], dtype=float)
        ok = np.isfinite(a)
        if ok.sum() > 10:
            out["alt"] = np.convolve(np.interp(tg, t[ok], a[ok]), np.ones(31) / 31, mode="same")  # 30 s smoothing
    v = st.get("velocity_smooth")
    if v and len(v) == len(t):
        out["v"] = np.interp(tg, t, np.nan_to_num(np.asarray(v, dtype=float)))
    for key in ("heartrate", "cadence", "watts", "temp", "gct", "vert_osc", "stride"):
        a = st.get(key)
        if a and len(a) == len(t):
            arr = np.asarray([np.nan if x is None else x for x in a], dtype=float)
            ok = np.isfinite(arr)
            if ok.sum() > 10:
                out[key] = np.interp(tg, t[ok], arr[ok])
    return out


def speed_curve(g: dict, after: int = 0) -> list[dict]:
    rows = []
    dist, n = g["dist"], len(g["dist"])
    # a window stopped (or implausible) more than 5 % of the time is not an effort
    stopped, bad = g["stopped"], g["bad"]
    for dur in DURATIONS:
        if after + dur >= n:
            break
        span = dist[after + dur:] - dist[after:-dur]
        lost = (stopped[after + dur:] - stopped[after:-dur]) + (bad[after + dur:] - bad[after:-dur])
        span = np.where(lost <= 0.05 * dur, span, 0.0)
        i = int(np.argmax(span))
        sp = float(span[i] / dur)
        if sp <= 0.5 or sp > world_record_speed(dur):  # faster than the world record = glitch
            continue
        row = {"after": after, "duration": dur, "speed": sp, "start": after + i}
        if "alt" in g:
            # grade-adjust each window by its NET grade: robust to altitude noise, which
            # per-second Minetti factors would inflate through the model's convexity
            # windows steeper than ±3 % net are left out: there the flat-equivalent
            # correction is too uncertain for a performance envelope
            dz = g["alt"][after + dur:] - g["alt"][after:-dur]
            net = dz / np.maximum(span, 1.0)
            adj = np.where(np.abs(net) <= 0.03, span * minetti_cost(net) / minetti_cost(0), -np.inf)
            best_adj = float(adj.max())
            row["gap_speed"] = best_adj / dur if np.isfinite(best_adj) else None
        else:
            row["gap_speed"] = sp  # no altitude: raw speed is the best we have
        if "heartrate" in g:
            row["hr"] = float(np.mean(g["heartrate"][after + i:after + i + dur]))
        rows.append(row)
    return rows


def steady_samples(g: dict) -> list[dict]:
    if "v" not in g or "heartrate" not in g:
        return []
    v, hr, n = g["v"], g["heartrate"], len(g["v"])
    rows = []
    for s in range(WARMUP, n - WINDOW, WINDOW):
        sl = slice(s, s + WINDOW)
        vw, hw = v[sl], hr[sl]
        if vw.min() < 1.8 or hw.min() < 90:
            continue  # walking, stopped or HR dropouts
        seg = g["dist"][s + WINDOW] - g["dist"][s]
        net = (g["alt"][s + WINDOW] - g["alt"][s]) / seg if "alt" in g and seg > 50 else 0.0
        if vw.std() / vw.mean() > 0.06 or abs(net) > 0.03 or np.ptp(hw) > 14:
            continue  # not steady: pace changes, hills, HR swinging
        row = {"t0": s, "hr": float(hw.mean()), "speed": float(vw.mean()),
               "gap_speed": float(vw.mean() * minetti_cost(net) / minetti_cost(0))}
        for key, name in (("cadence", "cadence"), ("watts", "watts"), ("temp", "temp"), ("gct", "gct"),
                          ("vert_osc", "vosc"), ("stride", "stride")):
            if key in g:
                row[name] = float(g[key][sl].mean())
        rows.append(row)
    return rows


def compute_activity(aid: int, c) -> None:
    a = c.execute("SELECT sport FROM activities WHERE id=?", (aid,)).fetchone()
    for table in ("speed_curve", "steady_samples", "run_insights"):
        c.execute(f"DELETE FROM {table} WHERE activity_id=?", (aid,))
    if not a or a["sport"] != "run":
        return
    row = c.execute("SELECT data FROM streams WHERE activity_id=?", (aid,)).fetchone()
    g = _grid(db.unpack(row["data"])) if row else None
    if not g:
        return
    for after in AFTER:
        for r in speed_curve(g, after):
            c.execute("INSERT INTO speed_curve(activity_id, after, duration, speed, gap_speed, hr, start) VALUES (?,?,?,?,?,?,?)",
                      (aid, after, r["duration"], r["speed"], r.get("gap_speed"), r.get("hr"), r["start"]))
    cols = ["t0", "hr", "speed", "gap_speed", "cadence", "watts", "temp", "gct", "vosc", "stride"]
    for r in steady_samples(g):
        c.execute(f"INSERT INTO steady_samples(activity_id, {', '.join(cols)}) VALUES (?{', ?' * len(cols)})",
                  [aid] + [r.get(k) for k in cols])


def backfill() -> int:
    """Compute primitives for runs that have streams but no curve yet, then insights."""
    with db.session() as c:
        ids = [r[0] for r in c.execute(
            "SELECT a.id FROM activities a JOIN streams s ON s.activity_id=a.id WHERE a.sport='run' "
            "AND a.id NOT IN (SELECT DISTINCT activity_id FROM speed_curve)")]
        for aid in ids:
            compute_activity(aid, c)
    refresh_insights()
    return len(ids)


# --------------------------------------------------------------------------- engine (speed <-> HR)

def samples_frame(exclude_intervals: bool = True) -> pd.DataFrame:
    """Steady windows; interval sessions are left out by default because HR lags
    behind pace in short reps, which would make the engine look too fast."""
    sql = "SELECT s.*, a.date FROM steady_samples s JOIN activities a ON a.id = s.activity_id"
    if exclude_intervals:
        sql += " WHERE s.activity_id NOT IN (SELECT activity_id FROM interval_sessions)"
    with db.session() as c:
        df = pd.read_sql(sql, c)
    if not df.empty:
        df["date"] = pd.to_datetime(df["date"])
    return df


def _huber_wls(x: np.ndarray, y: np.ndarray, w: np.ndarray, iters: int = 8) -> tuple[float, float, float]:
    """Weighted linear fit y = a + b x with Huber re-weighting (robust to odd windows)."""
    X = np.column_stack([np.ones_like(x), x])
    ww = w.copy()
    for _ in range(iters):
        W = np.sqrt(ww)
        a, b = np.linalg.lstsq(X * W[:, None], y * W, rcond=None)[0]
        r = y - (a + b * x)
        s = 1.4826 * np.median(np.abs(r - np.median(r))) or 1e-6
        k = 1.345 * s
        ww = w * np.where(np.abs(r) <= k, 1.0, k / np.abs(r))
    r = y - (a + b * x)
    return float(a), float(b), float(np.sqrt(np.average(r * r, weights=w)))


def engine_fit(df: pd.DataFrame, end: pd.Timestamp, window: int = 42, half_life: float = 21) -> dict | None:
    """GAP speed as a function of HR from steady samples in (end - window, end]."""
    sub = df[(df["date"] > end - pd.Timedelta(days=window)) & (df["date"] <= end)]
    if len(sub) < 25 or sub["activity_id"].nunique() < 4 or np.ptp(sub["hr"]) < 15:
        return None
    age = (end - sub["date"]).dt.days.to_numpy(float)
    w = np.power(0.5, age / half_life)
    a, b, sd = _huber_wls(sub["hr"].to_numpy(float), sub["gap_speed"].to_numpy(float), w)
    if b <= 0:
        return None
    return {"a": a, "b": b, "sd": sd, "n": int(len(sub)), "runs": int(sub["activity_id"].nunique()),
            "hr_lo": float(sub["hr"].quantile(0.05)), "hr_hi": float(sub["hr"].quantile(0.95))}


def engine_speed(m: dict, hr: float) -> float:
    return m["a"] + m["b"] * hr


def engine_hr(m: dict, speed: float) -> float:
    return (speed - m["a"]) / m["b"]


def engine_series(df: pd.DataFrame | None = None, hrs: tuple[int, ...] = (150, 165)) -> list[dict]:
    """Weekly speed-at-fixed-HR, from the engine fitted on the preceding 42 days."""
    df = samples_frame() if df is None else df
    if df.empty:
        return []
    out = []
    for d in pd.date_range(df["date"].min() + pd.Timedelta(days=28), pd.Timestamp(date.today()), freq="7D"):
        m = engine_fit(df, d)
        if m:
            out.append({"date": d.date().isoformat(), **{f"v{h}": engine_speed(m, h) for h in hrs}, "n": m["n"]})
    return out


def engine_monthly(df: pd.DataFrame | None = None) -> list[dict]:
    """One engine line per calendar month (the "family of curves")."""
    df = samples_frame() if df is None else df
    out = []
    if df.empty:
        return out
    for month, sub in df.groupby(df["date"].dt.to_period("M")):
        if len(sub) < 20 or np.ptp(sub["hr"]) < 15:
            continue
        a, b, sd = _huber_wls(sub["hr"].to_numpy(float), sub["gap_speed"].to_numpy(float), np.ones(len(sub)))
        if b > 0:
            out.append({"month": str(month), "a": a, "b": b, "sd": sd, "n": int(len(sub)),
                        "hr_lo": float(sub["hr"].quantile(0.05)), "hr_hi": float(sub["hr"].quantile(0.95))})
    return out


# --------------------------------------------------------------------------- speed-duration envelope

def curve_frame(after: int = 0) -> pd.DataFrame:
    with db.session() as c:
        df = pd.read_sql("SELECT sc.*, a.date, a.is_race FROM speed_curve sc JOIN activities a ON a.id = sc.activity_id "
                         "WHERE sc.after = ?", c, params=(after,))
    if not df.empty:
        df["date"] = pd.to_datetime(df["date"])
        df["gap"] = df["gap_speed"]  # NULL = only steep windows: excluded rather than replaced by raw speed
    return df


def envelope(df: pd.DataFrame, end: pd.Timestamp, days: int | None, col: str = "gap") -> pd.Series:
    """Best speed per duration over the window, made monotone (a longer effort can't
    beat a shorter one: the shorter best is at least the longer one)."""
    sub = df[df["date"] <= end] if days is None else df[(df["date"] > end - pd.Timedelta(days=days)) & (df["date"] <= end)]
    if sub.empty:
        return pd.Series(dtype=float)
    best = sub.groupby("duration")[col].max().sort_index()
    return pd.Series(np.maximum.accumulate(best.to_numpy()[::-1])[::-1], index=best.index)


def critical_speed(env: pd.Series, lo: int = 120, hi: int = 420) -> dict | None:
    """CS / D' on 2-7 min bests. Longer windows are rarely maximal in training and
    drag the fit down (a 2-20 min fit backtested clearly worse on real races)."""
    pts = env[(env.index >= lo) & (env.index <= hi)]
    if len(pts) < 3:
        return None
    t = pts.index.to_numpy(float)
    d = (pts.to_numpy() * t)
    cs, dprime = np.polyfit(t, d, 1)
    if cs <= 0:
        return None
    return {"cs": float(cs), "d_prime": float(max(dprime, 0)), "points": [[float(a), float(b)] for a, b in zip(t, d)]}


# --------------------------------------------------------------------------- per-run insights

def refresh_insights() -> None:
    """Engine residual for every run (model fitted on the 42 days before it) and
    within-run drifts for long steady runs."""
    df = samples_frame()
    if df.empty:
        return
    with db.session() as c:
        c.execute("DELETE FROM run_insights")
        cache: dict = {}
        for aid, run in df.groupby("activity_id"):
            day = run["date"].iloc[0]
            if day not in cache:
                cache[day] = engine_fit(df[df["activity_id"] != aid], day - pd.Timedelta(days=1))
            m = cache[day]
            resid = float(np.mean(run["hr"] - engine_hr(m, run["gap_speed"]))) if m and len(run) >= 2 else None
            drift_hr = drift_gct = drift_cad = None
            if len(run) >= 6 and run["t0"].max() - run["t0"].min() >= 2400:
                h = (run["t0"].to_numpy(float)) / 3600
                X = np.column_stack([np.ones(len(run)), run["gap_speed"], h])
                # cardiac drift at constant speed: HR = a + b*speed + c*hours -> c (bpm/h)
                drift_hr = float(np.linalg.lstsq(X, run["hr"].to_numpy(), rcond=None)[0][2])
                if run["gct"].notna().sum() >= 6:
                    ok = run["gct"].notna().to_numpy()
                    drift_gct = float(np.linalg.lstsq(X[ok], run["gct"].to_numpy()[ok], rcond=None)[0][2])
                if run["cadence"].notna().sum() >= 6:
                    ok = run["cadence"].notna().to_numpy()
                    drift_cad = float(np.linalg.lstsq(X[ok], run["cadence"].to_numpy()[ok], rcond=None)[0][2])
            c.execute("INSERT INTO run_insights VALUES (?,?,?,?,?,?)", (int(aid), int(len(run)), resid, drift_hr, drift_gct, drift_cad))


def as_of(days_back: int = 0) -> pd.Timestamp:
    return pd.Timestamp(date.today() - timedelta(days=days_back))
