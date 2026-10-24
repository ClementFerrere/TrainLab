"""Race-time prediction: four estimators, backtested on the athlete's own races,
combined into an ensemble weighted by measured accuracy.

Every estimator is computed "as of" a date using only data strictly before it,
so the backtest replays what each model would have said the day before a race.

  vdot    Daniels VDOT of the best efforts (>= 1 mile) of the last 90 days
  riegel  best race-like effort of the last 180 days, personal Riegel exponent
  cs      critical speed / D' from the 90-day speed-duration envelope (2-20 min),
          personal endurance decay beyond 30 min
  engine  speed the speed<->HR engine gives at the HR you hold in races of that
          duration, calibrated by how your past races compared to the engine
  workout best session of 800-3200 m reps in the 6 weeks before, times your
          personal race/rep speed ratio for that distance
"""
from __future__ import annotations

import math
from datetime import date

import numpy as np
import pandas as pd

from .. import db
from . import performance as perf
from . import intervals, profile

MODELS = {
    "vdot": "VDOT (Daniels)",
    "riegel": "Riegel personnel",
    "cs": "Vitesse critique",
    "engine": "Moteur cardiaque",
    "workout": "Séances clés",
}
TARGETS = {"5 km": 5000, "10 km": 10000, "Semi": 21097.5, "Marathon": 42195}
DEFAULT_EXP = 1.06
# avg HR / HRmax typically held in a race lasting t seconds (used until 3+ own races exist)
DEFAULT_RACE_HR = [(17 * 60, 0.945), (38 * 60, 0.925), (85 * 60, 0.895), (210 * 60, 0.84)]


class Data:
    """All frames the estimators need, loaded once."""

    def __init__(self) -> None:
        with db.session() as c:
            self.s = db.get_settings(c)
            self.races = pd.read_sql(
                "SELECT id, date, name, distance, elapsed_time, moving_time, avg_hr FROM activities "
                "WHERE sport='run' AND is_race=1 AND distance >= 3000 ORDER BY date", c)
        self.efforts = perf.efforts_frame()
        self.sessions = intervals.sessions_frame()
        self.curves = profile.curve_frame(0)
        self.samples = profile.samples_frame()
        if not self.races.empty:
            self.races["date"] = pd.to_datetime(self.races["date"])
            self.races["time"] = self.races["elapsed_time"].fillna(self.races["moving_time"])


def _before(df: pd.DataFrame, day: pd.Timestamp, days: int | None = None) -> pd.DataFrame:
    if df.empty:
        return df
    m = df["date"] < day
    if days:
        m &= df["date"] >= day - pd.Timedelta(days=days)
    return df[m]


def personal_exponent(races: pd.DataFrame) -> float:
    """Riegel exponent fitted on own races up to the half (marathons often break the law)."""
    r = races[races["distance"] <= 21700]
    if len(r) < 3 or r["distance"].max() / r["distance"].min() < 1.8:
        return DEFAULT_EXP
    # use the best time per distance bucket so a bad day doesn't steepen the curve
    r = r.assign(bucket=(np.log(r["distance"]) * 4).round()).sort_values("time").groupby("bucket").first()
    if len(r) < 2:
        return DEFAULT_EXP
    k = np.polyfit(np.log(r["distance"]), np.log(r["time"]), 1)[0]
    return float(np.clip(k, 1.02, 1.15))


def race_hr_fraction(races: pd.DataFrame, hr_max: float):
    """f(t) = avg HR / HRmax you hold for a race lasting t seconds."""
    r = races.dropna(subset=["avg_hr"])
    if len(r) >= 3 and r["time"].max() / r["time"].min() >= 2:
        b, a = np.polyfit(np.log(r["time"]), r["avg_hr"] / hr_max, 1)
        return lambda t: float(np.clip(a + b * math.log(t), 0.75, 0.98))
    xs = [math.log(t) for t, _ in DEFAULT_RACE_HR]
    ys = [f for _, f in DEFAULT_RACE_HR]
    return lambda t: float(np.interp(math.log(t), xs, ys))


# --------------------------------------------------------------------------- estimators

def est_vdot(D: Data, day: pd.Timestamp, dist: float) -> float | None:
    e = _before(D.efforts, day, 90)
    e = e[e["distance"] >= 1600] if not e.empty else e
    if e.empty:
        return None
    return perf.predict_time(float(e["vdot"].max()), dist)


def est_riegel(D: Data, day: pd.Timestamp, dist: float, k: float) -> float | None:
    e = _before(D.efforts, day, 180)
    if e.empty:
        return None
    e = e[(e["distance"] >= max(3000, dist / 3)) & (e["distance"] <= min(dist * 3, 42195))]
    if e.empty:
        return None
    return float((e["elapsed_time"] * (dist / e["distance"]) ** k).min())


def est_cs(D: Data, day: pd.Timestamp, dist: float, k: float) -> float | None:
    env = profile.envelope(_before(D.curves, day), day, 90)
    cs = profile.critical_speed(env)
    if not cs:
        return None
    t = (dist - cs["d_prime"]) / cs["cs"]
    if t > 1800:
        # beyond ~30 min speed decays like a power law: v = CS * (t/1800)^-e, e from the Riegel exponent
        e = 1 - 1 / k
        t = (dist / (cs["cs"] * 1800 ** e)) ** (1 / (1 - e))
    return float(t)


def est_engine(D: Data, day: pd.Timestamp, dist: float, frac, calib: float) -> float | None:
    m = profile.engine_fit(D.samples, day - pd.Timedelta(days=1))
    if not m:
        return None
    hr_max = D.s["hr_max"]
    t = dist / 4.0
    for _ in range(6):  # fixed point: race HR depends on race duration
        v = profile.engine_speed(m, frac(t) * hr_max) * calib
        if v <= 0.5:
            return None
        t = dist / v
    return float(t)


def engine_calibration(D: Data, day: pd.Timestamp) -> float:
    """Median ratio (actual race speed) / (engine speed at the race's own avg HR) over past races."""
    ratios = []
    for _, r in _before(D.races, day).iterrows():
        m = profile.engine_fit(D.samples, r["date"] - pd.Timedelta(days=1))
        if m and r["avg_hr"]:
            ratios.append((r["distance"] / r["time"]) / profile.engine_speed(m, r["avg_hr"]))
    return float(np.median(ratios)) if ratios else 1.0


# race speed / best-session rep speed ~ alpha + beta * ln(d / 10 km); prior from typical runners
WORKOUT_PRIOR = (0.963, -0.066)


def _best_session(D: Data, day: pd.Timestamp) -> float | None:
    s = _before(D.sessions, day - pd.Timedelta(days=2), 40)
    if s.empty:
        return None
    s = s[(s["rep_distance"] >= 800) & (s["rep_distance"] <= 3200) & (s["n"] >= 3)
          & ((s["rest_ratio"].isna()) | (s["rest_ratio"] <= 0.8))]
    return float(s["speed"].max()) if not s.empty else None


def workout_ratio(D: Data, day: pd.Timestamp) -> tuple[float, float, int]:
    """Personal (alpha, beta) from past races, shrunk towards the prior (pseudo-count 3)."""
    xs, ys = [], []
    for _, r in _before(D.races, day).iterrows():
        b = _best_session(D, r["date"])
        if b:
            xs.append(math.log(r["distance"] / 10000))
            ys.append((r["distance"] / r["time"]) / b)
    a0, b0 = WORKOUT_PRIOR
    n = len(xs)
    if n >= 2 and np.ptp(xs) > 0.3:
        b_fit, a_fit = np.polyfit(xs, ys, 1)
    elif n:
        b_fit, a_fit = b0, float(np.mean(np.array(ys) - b0 * np.array(xs)))
    else:
        return a0, b0, 0
    w = n / (n + 3)
    return w * a_fit + (1 - w) * a0, w * b_fit + (1 - w) * b0, n


def est_workout(D: Data, day: pd.Timestamp, dist: float, ratio: tuple[float, float, int]) -> float | None:
    best = _best_session(D, day)
    if not best:
        return None
    a, b, _ = ratio
    return dist / (best * (a + b * math.log(dist / 10000)))


def predict_as_of(D: Data, day: pd.Timestamp, dist: float) -> dict[str, float | None]:
    past = _before(D.races, day)
    k = personal_exponent(past)
    frac = race_hr_fraction(past, D.s["hr_max"])
    return {
        "vdot": est_vdot(D, day, dist),
        "riegel": est_riegel(D, day, dist, k),
        "cs": est_cs(D, day, dist, k),
        "engine": est_engine(D, day, dist, frac, engine_calibration(D, day)),
        "workout": est_workout(D, day, dist, workout_ratio(D, day)),
    }


# --------------------------------------------------------------------------- backtest & ensemble

def backtest(D: Data) -> list[dict]:
    rows = []
    for _, r in D.races.iterrows():
        preds = predict_as_of(D, r["date"], r["distance"])
        rows.append({"id": int(r["id"]), "date": r["date"].date().isoformat(), "name": r["name"],
                     "distance": float(r["distance"]), "actual": float(r["time"]), "avg_hr": r["avg_hr"],
                     "preds": preds,
                     "errors": {m: (p / r["time"] - 1) * 100 if p else None for m, p in preds.items()}})
    return rows


def _weights(bt: list[dict], dist: float, exclude: int | None = None) -> dict[str, float]:
    """Inverse squared error, where the error is averaged over past races with a
    kernel on log-distance (sigma 0.5): a 10 km is judged mostly on 5-16 km races.
    Equal weights while fewer than 3 races are scored."""
    w = {}
    for m in MODELS:
        pts = [(abs(r["errors"][m]), math.exp(-(math.log(dist / r["distance"])) ** 2 / (2 * 0.5 ** 2)))
               for r in bt if r["id"] != exclude and r["errors"][m] is not None]
        if len(pts) < 3 or sum(k for _, k in pts) < 1e-3:
            w[m] = 1.0
            continue
        mae = sum(e * k for e, k in pts) / sum(k for _, k in pts)
        w[m] = 1 / (mae ** 2 + 0.25)
    return w


def ensemble(preds: dict[str, float | None], w: dict[str, float]) -> float | None:
    """Weighted mean in log-time (errors are multiplicative)."""
    num = den = 0.0
    for m, p in preds.items():
        if p:
            num += w[m] * math.log(p)
            den += w[m]
    return math.exp(num / den) if den else None


def leaderboard(bt: list[dict]) -> list[dict]:
    out = []
    for m in list(MODELS) + ["ensemble"]:
        errs = [r["errors"][m] for r in bt if r["errors"].get(m) is not None]
        out.append({"model": m, "label": MODELS.get(m, "Ensemble (pondéré)"), "n": len(errs),
                    "mape": float(np.mean(np.abs(errs))) if errs else None,
                    "bias": float(np.mean(errs)) if errs else None})
    return out


@db.cached_by_signature
def _report() -> pd.DataFrame:
    """Everything the UI needs, cached until the data changes (wrapped in a frame
    only so the generic cache can copy it)."""
    D = Data()
    bt = backtest(D)
    for r in bt:  # leave-one-out ensemble: weights learnt without the race being scored
        e = ensemble(r["preds"], _weights(bt, r["distance"], exclude=r["id"]))
        r["preds"]["ensemble"] = e
        r["errors"]["ensemble"] = (e / r["actual"] - 1) * 100 if e else None
    today = pd.Timestamp(date.today()) + pd.Timedelta(days=1)  # include today's sessions
    lb = leaderboard(bt)
    ens_err = next((x["mape"] for x in lb if x["model"] == "ensemble"), None)
    dists = {}
    for name, d in TARGETS.items():
        p = predict_as_of(D, today, d)
        w = _weights(bt, d)
        e = ensemble(p, w)
        tot = sum(w[m] for m in w if p.get(m))
        dists[name] = {"distance": d, "preds": p, "ensemble": e,
                       "weights": {m: (w[m] / tot if p.get(m) and tot else 0.0) for m in MODELS},
                       "range": [e * (1 - (ens_err or 3) / 100), e * (1 + (ens_err or 3) / 100)] if e else None}
    past = D.races
    env = profile.envelope(D.curves, today, 90)
    report = {
        "backtest": bt, "leaderboard": lb, "distances": dists,
        "exponent": personal_exponent(past), "race_hr": [
            {"duration": t, "frac": race_hr_fraction(past, D.s["hr_max"])(t)} for t in (900, 1800, 2400, 3600, 5400, 7200, 10800, 12600)],
        "engine_calibration": engine_calibration(D, today),
        "workout_ratio": dict(zip(("alpha", "beta", "n"), workout_ratio(D, today))),
        "best_session": _best_session(D, today),
        "cs": profile.critical_speed(env), "hr_max": D.s["hr_max"],
    }
    return pd.DataFrame([{"report": report}])


def report() -> dict:
    return _report().iloc[0]["report"]


def predict_distance(dist: float) -> dict:
    """Ensemble prediction for an arbitrary distance (goals)."""
    rep = report()
    D = Data()
    p = predict_as_of(D, pd.Timestamp(date.today()) + pd.Timedelta(days=1), dist)
    w = _weights(rep["backtest"], dist)
    e = ensemble(p, w)
    err = next((x["mape"] for x in rep["leaderboard"] if x["model"] == "ensemble"), None) or 3
    tot = sum(w[m] for m in w if p.get(m))
    return {"preds": p, "ensemble": e, "range": [e * (1 - err / 100), e * (1 + err / 100)] if e else None,
            "weights": {m: (w[m] / tot if p.get(m) and tot else 0.0) for m in MODELS}}
