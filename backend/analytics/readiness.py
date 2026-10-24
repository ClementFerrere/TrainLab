"""Home-made readiness: morning signals vs your own recent baseline, plus the gap
between how sessions *felt* and what the body signals said.

Objective (morning, night ending on day D): ln HRV, resting HR, sleep score,
Body Battery max, sleep stress -> z-scores vs the previous 28 days (min 10 values).
Subjective (sessions of day D): watch "feel" and RPE relative to what the
session's intensity would predict -> z-scores.
Divergence = subjective - objective; |divergence| > 1.5 is flagged.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .. import db

SIGNALS = {  # column -> (weight, direction, transform)
    "hrv_overnight": (0.35, +1, np.log),
    "resting_hr": (0.25, -1, None),
    "sleep_score": (0.20, +1, None),
    "body_battery_high": (0.10, +1, None),
    "sleep_stress": (0.10, -1, None),
}
LABELS = {"hrv_overnight": "HRV", "resting_hr": "FC repos", "sleep_score": "Sommeil",
          "body_battery_high": "Body Battery", "sleep_stress": "Stress nocturne"}


def _z(series: pd.Series, window: int = 28, min_periods: int = 10) -> pd.Series:
    base = series.shift(1).rolling(window, min_periods=min_periods)
    sd = base.std().replace(0, np.nan)
    return (series - base.mean()) / sd


@db.cached_by_signature
def readiness_frame() -> pd.DataFrame:
    with db.session() as c:
        well = pd.read_sql("SELECT date, " + ", ".join(SIGNALS) + " FROM daily_wellness ORDER BY date", c)
        runs = pd.read_sql(
            "SELECT a.date, a.moving_time, a.rpe, a.feel, m.load, ri.engine_resid FROM activities a "
            "LEFT JOIN activity_metrics m ON m.activity_id = a.id LEFT JOIN run_insights ri ON ri.activity_id = a.id "
            "WHERE a.is_parent = 0 AND a.moving_time >= 900", c)
    if well.empty:
        return pd.DataFrame()
    well["date"] = pd.to_datetime(well["date"])
    idx = pd.date_range(well["date"].min(), pd.Timestamp.today().normalize(), freq="D")
    w = well.set_index("date").reindex(idx)
    out = pd.DataFrame(index=idx)
    num = pd.Series(0.0, index=idx)
    den = pd.Series(0.0, index=idx)
    for col, (weight, sign, fn) in SIGNALS.items():
        x = w[col].astype(float)
        if fn is not None:
            x = fn(x.where(x > 0))
        z = (_z(x) * sign).clip(-3, 3)
        if col == "body_battery_high":
            z[z.index >= pd.Timestamp.today().normalize()] = np.nan  # partial day: max so far, not the morning value
        out[f"z_{col}"] = z
        ok = z.notna()
        num[ok] += weight * z[ok]
        den[ok] += weight
    out["z_obj"] = (num / den.replace(0, np.nan))
    # a morning score needs the night: without HRV or sleep the day's row is partial
    # (e.g. synced just after midnight, Body Battery "max" of a day that has barely started)
    night = out["z_hrv_overnight"].notna() | out["z_sleep_score"].notna()
    out.loc[~night, "z_obj"] = np.nan
    out["score"] = (50 + 20 * out["z_obj"]).clip(0, 100)

    if not runs.empty:
        runs["date"] = pd.to_datetime(runs["date"])
        r = runs.copy()
        r["intensity"] = r["load"] / (r["moving_time"] / 3600)
        r["ldur"] = np.log(r["moving_time"])
        ok = r["rpe"].notna() & r["intensity"].notna()
        r["rpe_resid"] = np.nan
        if ok.sum() >= 20:
            X = np.column_stack([np.ones(ok.sum()), r.loc[ok, "intensity"], r.loc[ok, "ldur"]])
            beta = np.linalg.lstsq(X, r.loc[ok, "rpe"], rcond=None)[0]
            r.loc[ok, "rpe_resid"] = r.loc[ok, "rpe"] - X @ beta
        day = r.groupby("date").agg(feel=("feel", "mean"), rpe_resid=("rpe_resid", "mean"),
                                    engine_resid=("engine_resid", "mean")).reindex(idx)
        out["feel"] = day["feel"]
        out["rpe_resid"] = day["rpe_resid"]
        out["engine_resid"] = day["engine_resid"]

        def zs(s: pd.Series) -> pd.Series:  # z vs the last 60 session days, not calendar days
            v = s.dropna()
            base = v.shift(1).rolling(30, min_periods=8)
            return ((v - base.mean()) / base.std().replace(0, np.nan)).reindex(idx)

        z_feel = zs(day["feel"])
        z_rpe = -zs(day["rpe_resid"])  # harder than expected = feeling worse
        out["z_subj"] = pd.concat([z_feel, z_rpe], axis=1).mean(axis=1).clip(-3, 3)
        out["divergence"] = out["z_subj"] - out["z_obj"]
    out.index.name = "date"
    return out


def label(score: float | None) -> tuple[str, str]:
    if score is None or np.isnan(score):
        return "neutral", "—"
    if score >= 65:
        return "good", "Prêt à charger"
    if score >= 45:
        return "good", "Normal"
    if score >= 30:
        return "warning", "Prudence"
    return "serious", "Récupération prioritaire"


def today() -> dict:
    df = readiness_frame()
    if df.empty:
        return {}
    scored = df[df["score"].notna()]
    if scored.empty:
        return {}
    row = scored.iloc[-1]  # latest night actually synced
    contrib = sorted(
        [{"key": k, "label": LABELS[k], "z": float(row[f"z_{k}"]), "weight": SIGNALS[k][0]}
         for k in SIGNALS if pd.notna(row.get(f"z_{k}"))], key=lambda x: x["z"])
    lvl, lab = label(row["score"])
    div = row.get("divergence")
    note = None
    if div is not None and pd.notna(div) and abs(div) > 1.5:
        note = ("Tu as ressenti la séance plus dure que ce que disaient tes signaux du matin (fatigue nerveuse, début de maladie ?)"
                if div < 0 else "Tu t'es senti mieux que ce que disaient tes signaux du matin : bonne journée, mais n'en profite pas pour surcharger")
    return {"date": row.name.date().isoformat(), "score": None if pd.isna(row["score"]) else float(row["score"]),
            "level": lvl, "label": lab, "contrib": contrib,
            "divergence": None if div is None or pd.isna(div) else float(div), "divergence_note": note,
            "engine_resid": None if pd.isna(row.get("engine_resid", np.nan)) else float(row["engine_resid"])}
