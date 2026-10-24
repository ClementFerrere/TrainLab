"""Correlation lab: a daily feature table joining training, performance and
recovery, plus pairwise / matrix / discovery statistics with lags.

Convention: a wellness row dated D describes the night that ENDS on the morning
of D (Garmin's calendarDate), so lag 0 pairs "sleep before" with "training of D".
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from scipy import stats

from .. import db
from .load import daily_frame

# key -> (label, unit, group)
VARIABLES: dict[str, tuple[str, str, str]] = {
    "load": ("Charge du jour", "hrTSS", "Entraînement"),
    "load_run": ("Charge course", "hrTSS", "Entraînement"),
    "run_km": ("Km courus", "km", "Entraînement"),
    "train_hours": ("Heures d'entraînement", "h", "Entraînement"),
    "ctl": ("Fitness (CTL)", "", "Forme"),
    "atl": ("Fatigue (ATL)", "", "Forme"),
    "tsb": ("Fraîcheur (TSB)", "", "Forme"),
    "acwr": ("Ratio aigu/chronique", "", "Forme"),
    "monotony": ("Monotonie", "", "Forme"),
    "run_ef": ("Efficacité course (EF)", "m/min/bpm", "Performance"),
    "easy_ef": ("EF footing", "m/min/bpm", "Performance"),
    "run_speed": ("Vitesse moyenne course", "km/h", "Performance"),
    "run_hr": ("FC moyenne course", "bpm", "Performance"),
    "run_decoupling": ("Dérive cardiaque", "%", "Performance"),
    "run_rpe": ("RPE (montre)", "/10", "Performance"),
    "run_feel": ("Ressenti (montre)", "/100", "Performance"),
    "run_cadence": ("Cadence course", "spm", "Performance"),
    "run_gct": ("Temps de contact au sol", "ms", "Performance"),
    "run_vosc": ("Oscillation verticale", "cm", "Performance"),
    "run_stride": ("Longueur de foulée", "m", "Performance"),
    "aerobic_te": ("Training effect aérobie (max)", "", "Performance"),
    "garmin_load": ("Charge Garmin du jour", "", "Entraînement"),
    "vo2max": ("VO2max Garmin", "ml/kg/min", "Performance"),
    "sleep_hours": ("Durée de sommeil", "h", "Sommeil"),
    "sleep_score": ("Score de sommeil", "", "Sommeil"),
    "deep_pct": ("Sommeil profond", "%", "Sommeil"),
    "rem_pct": ("Sommeil paradoxal", "%", "Sommeil"),
    "awake_min": ("Éveils", "min", "Sommeil"),
    "sleep_debt_3d": ("Dette de sommeil 3 j (vs 8 h)", "h", "Sommeil"),
    "bedtime_hour": ("Heure du coucher", "h", "Sommeil"),
    "sleep_hr": ("FC pendant le sommeil", "bpm", "Sommeil"),
    "sleep_stress": ("Stress pendant le sommeil", "", "Sommeil"),
    "hrv": ("HRV nocturne", "ms", "Récupération"),
    "hrv_dev": ("HRV vs moyenne 7 j", "%", "Récupération"),
    "resting_hr": ("FC de repos", "bpm", "Récupération"),
    "body_battery_high": ("Body Battery max", "", "Récupération"),
    "body_battery_charged": ("Body Battery rechargé", "", "Récupération"),
    "stress_avg": ("Stress moyen (journée)", "", "Récupération"),
    "respiration": ("Respiration moyenne", "rpm", "Récupération"),
    "steps": ("Pas", "", "Récupération"),
    "readiness": ("Readiness (score du matin)", "/100", "Récupération"),
    "readiness_subj": ("Ressenti vs habitude (z)", "z", "Récupération"),
    "divergence": ("Divergence ressenti − signaux", "z", "Récupération"),
    "engine_resid": ("Écart moteur (FC vs allure habituelle)", "bpm", "Performance"),
    "drift_hr": ("Dérive cardiaque sortie longue", "bpm/h", "Performance"),
}


@db.cached_by_signature
def daily_features() -> pd.DataFrame:
    df = daily_frame()
    if df.empty:
        return df
    hours_cols = [c for c in df.columns if c.startswith("hours_")]
    df["train_hours"] = df[hours_cols].sum(axis=1)
    if "load_run" not in df:
        df["load_run"] = 0.0

    with db.session() as c:
        s = db.get_settings(c)
        runs = pd.read_sql(
            "SELECT a.date, a.moving_time, a.avg_speed, a.avg_hr, a.avg_cadence, a.rpe, a.feel, a.avg_gct, "
            "a.avg_vert_osc, a.avg_stride, m.ef, m.decoupling FROM activities a "
            "JOIN activity_metrics m ON m.activity_id=a.id WHERE a.sport='run' AND a.moving_time >= 900",
            c,
        )
        acts = pd.read_sql("SELECT date, aerobic_te, garmin_load, vo2max FROM activities WHERE is_parent=0", c)
        well = pd.read_sql("SELECT * FROM daily_wellness", c)

    if not acts.empty:
        acts["date"] = pd.to_datetime(acts["date"])
        ga = acts.groupby("date")
        df["aerobic_te"] = ga["aerobic_te"].max().reindex(df.index)
        df["garmin_load"] = ga["garmin_load"].sum(min_count=1).reindex(df.index).fillna(0)
        df["vo2max"] = ga["vo2max"].max().reindex(df.index)

    if not runs.empty:
        runs["date"] = pd.to_datetime(runs["date"])
        w = runs["moving_time"]

        def wmean(col):
            x = runs.assign(_v=runs[col] * w, _w=w.where(runs[col].notna()))
            g = x.groupby("date")
            return (g["_v"].sum(min_count=1) / g["_w"].sum()).reindex(df.index)

        runs["speed_kmh"] = runs["avg_speed"] * 3.6
        df["run_speed"] = wmean("speed_kmh")
        df["run_hr"] = wmean("avg_hr")
        df["run_cadence"] = wmean("avg_cadence")
        df["run_gct"] = wmean("avg_gct")
        df["run_vosc"] = wmean("avg_vert_osc")
        df["run_stride"] = wmean("avg_stride")
        g = runs.groupby("date")
        df["run_ef"] = g["ef"].mean().reindex(df.index)
        df["run_decoupling"] = g["decoupling"].mean().reindex(df.index)
        df["run_rpe"] = g["rpe"].mean().reindex(df.index)
        df["run_feel"] = g["feel"].mean().reindex(df.index)
        easy = runs[runs["avg_hr"] < s["hr_zones"][1]]
        df["easy_ef"] = easy.groupby("date")["ef"].mean().reindex(df.index)

    if not well.empty:
        well["date"] = pd.to_datetime(well["date"])
        well = well.set_index("date").drop(columns=["raw_sleep", "raw_summary"], errors="ignore")
        tot = well["sleep_seconds"].replace(0, np.nan)
        wf = pd.DataFrame(index=well.index)
        wf["sleep_hours"] = tot / 3600
        wf["sleep_score"] = well["sleep_score"]
        wf["deep_pct"] = well["deep_seconds"] / tot * 100
        wf["rem_pct"] = well["rem_seconds"] / tot * 100
        wf["awake_min"] = well["awake_seconds"] / 60
        wf["sleep_hr"] = well["sleep_hr"]
        wf["sleep_stress"] = well["sleep_stress"]
        wf["hrv"] = well["hrv_overnight"]
        wf["resting_hr"] = well["resting_hr"]
        wf["body_battery_high"] = well["body_battery_high"]
        wf["body_battery_charged"] = well["body_battery_charged"]
        wf["stress_avg"] = well["stress_avg"]
        wf["respiration"] = well["respiration"]
        wf["steps"] = well["steps"]
        start = pd.to_datetime(well["sleep_start"], errors="coerce")
        hour = start.dt.hour + start.dt.minute / 60
        wf["bedtime_hour"] = np.where(hour < 12, hour + 24, hour)  # 1 am -> 25
        wf = wf.reindex(df.index.union(wf.index))
        wf["sleep_debt_3d"] = (8 - wf["sleep_hours"]).rolling(3, min_periods=2).sum()
        wf["hrv_dev"] = (wf["hrv"] / wf["hrv"].rolling(7, min_periods=4).mean().shift(1) - 1) * 100
        df = df.join(wf, how="left")

    from . import readiness as rd  # local import: readiness imports nothing from lab
    rf = rd.readiness_frame()
    if not rf.empty:
        df = df.join(rf[["score", "z_subj", "divergence", "engine_resid"]].rename(
            columns={"score": "readiness", "z_subj": "readiness_subj"}), how="left")
    with db.session() as c:
        dr = pd.read_sql("SELECT a.date, ri.drift_hr FROM run_insights ri JOIN activities a ON a.id = ri.activity_id "
                         "WHERE ri.drift_hr IS NOT NULL", c)
    if not dr.empty:
        dr["date"] = pd.to_datetime(dr["date"])
        df["drift_hr"] = dr.groupby("date")["drift_hr"].mean().reindex(df.index)
    return df[[k for k in VARIABLES if k in df.columns]]


def variables_meta(df: pd.DataFrame) -> list[dict]:
    return [
        {"key": k, "label": lab, "unit": unit, "group": grp, "n": int(df[k].notna().sum()) if k in df else 0}
        for k, (lab, unit, grp) in VARIABLES.items()
    ]


def _slice(df: pd.DataFrame, start: str | None, end: str | None) -> pd.DataFrame:
    if start:
        df = df[df.index >= pd.Timestamp(start)]
    if end:
        df = df[df.index <= pd.Timestamp(end)]
    return df


def _pair(df: pd.DataFrame, x: str, y: str, lag: int, active_only: bool) -> pd.DataFrame:
    """x(D) paired with y(D + lag)."""
    p = pd.DataFrame({"x": df[x], "y": df[y].shift(-lag)})
    if active_only:
        p = p[df["load"] > 0]
    return p.dropna()


def _corr(p: pd.DataFrame) -> dict:
    n = len(p)
    if n < 5 or p["x"].nunique() < 3 or p["y"].nunique() < 3:
        return {"n": n, "pearson": None, "spearman": None, "p_pearson": None, "p_spearman": None}
    pr = stats.pearsonr(p["x"], p["y"])
    sr = stats.spearmanr(p["x"], p["y"])
    return {"n": n, "pearson": float(pr[0]), "p_pearson": float(pr[1]),
            "spearman": float(sr.statistic), "p_spearman": float(sr.pvalue)}


def pair(x: str, y: str, lag: int = 0, start=None, end=None, active_only=False) -> dict:
    df = _slice(daily_features(), start, end)
    if x not in df or y not in df:
        return {"points": [], "stats": {"n": 0}}
    p = _pair(df, x, y, lag, active_only)
    out = {"points": [[float(a), float(b), d.date().isoformat()] for d, a, b in zip(p.index, p["x"], p["y"])],
           "stats": _corr(p)}
    if out["stats"].get("pearson") is not None:
        slope, intercept = np.polyfit(p["x"], p["y"], 1)
        out["fit"] = {"slope": float(slope), "intercept": float(intercept)}
        # Binned means (quintiles of x) reveal non-linear shapes the r hides
        try:
            bins = pd.qcut(p["x"], q=min(5, p["x"].nunique()), duplicates="drop")
            gb = p.groupby(bins, observed=True)
            out["bins"] = [{"x": float(g["x"].mean()), "y": float(g["y"].mean()), "n": len(g),
                            "se": float(g["y"].std(ddof=1) / np.sqrt(len(g))) if len(g) > 1 else 0.0} for _, g in gb]
        except ValueError:
            pass
    out["lags"] = []
    for L in range(-3, 4):
        s = _corr(_pair(df, x, y, L, active_only))
        out["lags"].append({"lag": L, "r": s["spearman"], "p": s["p_spearman"], "n": s["n"]})
    return out


def _bh(pvals: list[float]) -> list[float]:
    """Benjamini-Hochberg adjusted q-values."""
    p = np.asarray(pvals, dtype=float)
    n = len(p)
    if n == 0:
        return []
    order = np.argsort(p)
    q = p[order] * n / np.arange(1, n + 1)
    q = np.minimum.accumulate(q[::-1])[::-1]
    out = np.empty(n)
    out[order] = np.clip(q, 0, 1)
    return out.tolist()


def matrix(keys: list[str], lag: int = 0, start=None, end=None) -> dict:
    df = _slice(daily_features(), start, end)
    keys = [k for k in keys if k in df]
    cells = []
    for i, a in enumerate(keys):
        for j, b in enumerate(keys):
            if i == j and lag == 0:
                cells.append({"x": a, "y": b, "r": 1.0, "p": 0.0, "n": int(df[a].notna().sum())})
                continue  # with a lag, the diagonal is the variable's autocorrelation
            s = _corr(_pair(df, a, b, lag, False))
            cells.append({"x": a, "y": b, "r": s["spearman"], "p": s["p_spearman"], "n": s["n"]})
    return {"keys": keys, "cells": cells}


def discover(target: str, lag: int = 0, start=None, end=None) -> list[dict]:
    df = _slice(daily_features(), start, end)
    if target not in df:
        return []
    rows = []
    for k in df.columns:
        if k == target:
            continue
        s = _corr(_pair(df, k, target, lag, False))
        if s["spearman"] is not None:
            rows.append({"key": k, "r": s["spearman"], "p": s["p_spearman"], "n": s["n"]})
    for r, q in zip(rows, _bh([r["p"] for r in rows])):
        r["q"] = q
    return sorted(rows, key=lambda r: -abs(r["r"]))
