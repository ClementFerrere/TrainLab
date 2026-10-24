"""Personal "Runner Matrix": six axes scored 0-100 as percentiles of your own
history (100 = your best level since the data starts), today vs 6 months ago.

  vitesse       best 5-min grade-adjusted speed (90-day monotone envelope)
  endurance     best 60-min grade-adjusted speed (180-day envelope)
  resilience    median cardiac drift at constant speed (bpm/h) on long runs, last 90 days
  physiologie   Garmin VO2max (FIT) and engine speed at 160 bpm (42-day fit)
  economie      speed per W/kg of running power on steady windows, last 42 days
  recuperation  28-day mean ln(HRV), resting HR (inverted) and sleep score
"""
from __future__ import annotations

from datetime import date

import numpy as np
import pandas as pd

from .. import db
from . import profile

AXES = {
    "vitesse": ("Vitesse", "Meilleure vitesse tenue 5 min (ajustée à la pente, 90 j)", "km/h"),
    "endurance": ("Endurance", "Meilleure vitesse tenue 60 min (ajustée à la pente, 180 j)", "km/h"),
    "resilience": ("Résilience", "Dérive cardiaque à allure égale sur tes sorties longues (90 j) — plus bas = plus durable", "bpm/h"),
    "physiologie": ("Physiologie", "VO2max Garmin et allure à 160 bpm (moteur des 42 derniers jours)", ""),
    "economie": ("Économie", "Vitesse par W/kg de puissance de course (fenêtres stables, 42 j)", "m/s par W/kg"),
    "recuperation": ("Récupération", "HRV, FC de repos et score de sommeil moyens sur 28 j", ""),
}
ARCHETYPES = {"vitesse": "Fusée", "endurance": "Diesel", "resilience": "Roc", "physiologie": "Gros moteur",
              "economie": "Gazelle", "recuperation": "Phénix"}


def _raw_series() -> pd.DataFrame:
    """Raw axis values sampled weekly over the whole history."""
    curves = profile.curve_frame(0)
    samples = profile.samples_frame()
    with db.session() as c:
        weight = db.get_settings(c).get("weight") or 70
        ins = pd.read_sql("SELECT ri.drift_hr, a.date, a.moving_time FROM run_insights ri JOIN activities a ON a.id = ri.activity_id "
                          "WHERE ri.drift_hr IS NOT NULL", c)
        vo2 = pd.read_sql("SELECT date, vo2max FROM activities WHERE sport='run' AND vo2max IS NOT NULL", c)
        well = pd.read_sql("SELECT date, hrv_overnight, resting_hr, sleep_score FROM daily_wellness", c)
    for df in (ins, vo2, well):
        if not df.empty:
            df["date"] = pd.to_datetime(df["date"])
    if curves.empty:
        return pd.DataFrame()
    start = curves["date"].min() + pd.Timedelta(days=42)
    rows = []
    # weekly grid plus today; unique() because today can fall exactly on the grid
    for d in pd.date_range(start, pd.Timestamp(date.today()), freq="7D").append(pd.DatetimeIndex([pd.Timestamp(date.today())])).unique():
        r = {"date": d}
        e90 = profile.envelope(curves, d, 90)
        r["vitesse"] = float(e90.get(300, np.nan)) * 3.6 if len(e90) else np.nan
        e180 = profile.envelope(curves, d, 180)
        r["endurance"] = float(e180.get(3600, np.nan)) * 3.6 if len(e180) else np.nan
        if not ins.empty:
            sub = ins[(ins["date"] > d - pd.Timedelta(days=90)) & (ins["date"] <= d) & (ins["moving_time"] >= 3600)]
            r["resilience"] = float(sub["drift_hr"].median()) if len(sub) >= 2 else np.nan
        m = profile.engine_fit(samples, d) if not samples.empty else None
        r["engine160"] = profile.engine_speed(m, 160) * 3.6 if m else np.nan
        if not vo2.empty:
            sub = vo2[(vo2["date"] > d - pd.Timedelta(days=30)) & (vo2["date"] <= d)]
            r["vo2max"] = float(sub["vo2max"].iloc[-1]) if len(sub) else np.nan
        if not samples.empty:
            sub = samples[(samples["date"] > d - pd.Timedelta(days=42)) & (samples["date"] <= d) & (samples["watts"] > 50)]
            r["economie"] = float((sub["gap_speed"] / (sub["watts"] / weight)).median()) if len(sub) >= 15 else np.nan
        if not well.empty:
            sub = well[(well["date"] > d - pd.Timedelta(days=28)) & (well["date"] <= d)]
            r["hrv"] = float(np.log(sub["hrv_overnight"].where(sub["hrv_overnight"] > 0)).mean()) if len(sub) >= 10 else np.nan
            r["rhr"] = float(sub["resting_hr"].mean()) if len(sub) >= 10 else np.nan
            r["sleep"] = float(sub["sleep_score"].mean()) if len(sub) >= 10 else np.nan
        rows.append(r)
    return pd.DataFrame(rows).set_index("date")


def _pct(series: pd.Series, value: float, higher_is_better: bool = True) -> float | None:
    v = series.dropna()
    if pd.isna(value) or len(v) < 4:
        return None
    p = (v < value).mean() + 0.5 * (v == value).mean()
    return float((p if higher_is_better else 1 - p) * 100)


@db.cached_by_signature
def _matrix_frame() -> pd.DataFrame:
    raw = _raw_series()
    if raw.empty:
        return pd.DataFrame()

    def scores_at(d: pd.Timestamp) -> dict:
        pos = int((raw.index <= d).sum()) - 1
        if pos < 0:
            return {}
        row = raw.iloc[pos]
        s = {
            "vitesse": _pct(raw["vitesse"], row["vitesse"]),
            "endurance": _pct(raw["endurance"], row["endurance"]),
            "resilience": _pct(raw.get("resilience", pd.Series(dtype=float)), row.get("resilience", np.nan), higher_is_better=False),
            "economie": _pct(raw.get("economie", pd.Series(dtype=float)), row.get("economie", np.nan)),
        }
        phys = [x for x in (_pct(raw.get("vo2max", pd.Series(dtype=float)), row.get("vo2max", np.nan)),
                            _pct(raw["engine160"], row["engine160"])) if x is not None]
        s["physiologie"] = float(np.mean(phys)) if phys else None
        rec = [x for x in (_pct(raw.get("hrv", pd.Series(dtype=float)), row.get("hrv", np.nan)),
                           _pct(raw.get("rhr", pd.Series(dtype=float)), row.get("rhr", np.nan), higher_is_better=False),
                           _pct(raw.get("sleep", pd.Series(dtype=float)), row.get("sleep", np.nan))) if x is not None]
        s["recuperation"] = float(np.mean(rec)) if rec else None
        return {"scores": s, "raw": {k: (None if pd.isna(v) else float(v)) for k, v in row.items()}, "date": row.name.date().isoformat()}

    now = pd.Timestamp(date.today())
    cur, past = scores_at(now), scores_at(now - pd.Timedelta(days=182))
    axes = []
    for k, (lab, desc, unit) in AXES.items():
        raw_now = (cur.get("raw") or {}).get({"physiologie": "vo2max", "recuperation": "hrv"}.get(k, k))
        raw_past = (past.get("raw") or {}).get({"physiologie": "vo2max", "recuperation": "hrv"}.get(k, k))
        if k == "recuperation":  # show HRV in ms rather than its log
            raw_now = float(np.exp(raw_now)) if raw_now is not None else None
            raw_past = float(np.exp(raw_past)) if raw_past is not None else None
        axes.append({"key": k, "label": lab, "desc": desc, "unit": unit,
                     "score": (cur.get("scores") or {}).get(k), "score_6m": (past.get("scores") or {}).get(k),
                     "value": raw_now, "value_6m": raw_past})
    scored = [a for a in axes if a["score"] is not None]
    archetype = None
    if len(scored) >= 3:
        top = max(scored, key=lambda a: a["score"])
        low = min(scored, key=lambda a: a["score"])
        archetype = {"name": ARCHETYPES[top["key"]], "strength": top["label"], "weakness": low["label"]}
    hist = raw.reset_index()
    hist["date"] = hist["date"].dt.strftime("%Y-%m-%d")
    return pd.DataFrame([{"m": {"axes": axes, "archetype": archetype, "as_of": cur.get("date"), "past": past.get("date"),
                                "history": hist.to_dict(orient="records")}}])


def matrix() -> dict:
    df = _matrix_frame()
    return df.iloc[0]["m"] if not df.empty else {"axes": [], "archetype": None, "history": []}
