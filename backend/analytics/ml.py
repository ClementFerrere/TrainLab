"""Machine-learning predictions on the athlete's own data.

Protocol (for every target):
  - features use only information available BEFORE the predicted value
    (evening of day D for the night ending D+1; morning signals + training state
    for a session's feel);
  - chronological split: the last 25 % of the timeline is the test set, with a
    7-day gap so rolling features can't straddle train and test;
  - model selection by expanding-window time-series CV on the TRAIN part only;
  - one final score on the untouched test set, compared with naive baselines
    (persistence, 7-day mean, majority class...);
  - permutation importance on the test set to say what drives the prediction.
"""
from __future__ import annotations

import math
import warnings
from datetime import date, timedelta

import numpy as np
import pandas as pd
from sklearn.ensemble import (HistGradientBoostingClassifier, HistGradientBoostingRegressor, RandomForestClassifier,
                              RandomForestRegressor, VotingRegressor)
from sklearn.impute import SimpleImputer
from sklearn.inspection import permutation_importance
from sklearn.linear_model import LogisticRegression, Ridge
from sklearn.metrics import (balanced_accuracy_score, confusion_matrix, f1_score, mean_absolute_error,
                             mean_squared_error, r2_score, roc_auc_score)
from sklearn.model_selection import TimeSeriesSplit
from sklearn.pipeline import make_pipeline
from sklearn.base import BaseEstimator, TransformerMixin
from sklearn.preprocessing import StandardScaler

from .. import db
from . import lab

warnings.filterwarnings("ignore", category=UserWarning)

TEST_FRAC = 0.25
GAP_DAYS = 7
FEEL_LABELS = {0: "Très faible", 25: "Faible", 50: "Normal", 75: "Fort", 100: "Très fort"}
FEEL3 = {0: "En dessous", 1: "Normal", 2: "Au-dessus"}  # 0-25 / 50 / 75-100

LABELS = {  # feature key -> French label (lab variables + ML-specific ones)
    **{k: v[0] for k, v in lab.VARIABLES.items()},
    "dow": "Jour de la semaine", "weekend_night": "Nuit de week-end", "doy_sin": "Saison (sin)", "doy_cos": "Saison (cos)",
    "last_end_hour": "Heure de fin du dernier entraînement", "n_sessions": "Nombre de séances", "te_max": "Training effect max",
    "ana_te_max": "Training effect anaérobie max", "hard_day": "Journée dure (TE ≥ 3,5)", "load_lag1": "Charge de la veille",
    "load_lag2": "Charge J-2", "load_3d": "Charge 3 derniers jours", "hrv_lag1": "HRV de la nuit précédente",
    "hrv_7d": "HRV moyenne 7 nuits", "hrv_7d_sd": "Variabilité de la HRV (7 nuits)", "sleep_7d": "Score sommeil moyen 7 nuits",
    "rhr_7d": "FC repos moyenne 7 j", "target_7d": "Moyenne 7 j de la cible", "target_lag1": "Valeur de la veille",
    "sport_run": "Course à pied", "sport_bike": "Vélo", "sport_swim": "Natation", "duration_min": "Durée (min)",
    "distance_km": "Distance (km)", "avg_hr": "FC moyenne", "hr_frac": "FC moyenne / FC max", "max_hr": "FC max",
    "session_load": "Charge de la séance", "session_intensity": "Intensité (charge/h)", "aerobic_te_s": "Training effect aérobie",
    "anaerobic_te_s": "Training effect anaérobie", "is_race": "Course officielle", "is_interval": "Séance de fractionné",
    "start_hour": "Heure de départ", "temp": "Température", "elev_gain": "Dénivelé +", "engine_resid_s": "Écart moteur de la séance",
    "feel_prev5": "Ressenti moyen des 5 séances précédentes", "feel_prev_same": "Ressenti de la dernière séance du même sport",
    "days_since_hard": "Jours depuis la dernière séance dure", "ctl_prev": "Fitness (CTL) la veille", "atl_prev": "Fatigue (ATL) la veille",
    "tsb_morning": "Fraîcheur (TSB) du matin", "acwr_prev": "Ratio aigu/chronique la veille", "pace_vs_usual": "Allure vs habitude (course)",
}


# --------------------------------------------------------------------------- datasets

def _activities() -> pd.DataFrame:
    with db.session() as c:
        a = pd.read_sql(
            "SELECT a.id, a.date, a.start_local, a.sport, a.distance, a.moving_time, a.avg_hr, a.max_hr, a.avg_speed, "
            "a.aerobic_te, a.anaerobic_te, a.is_race, a.avg_temp, a.elev_gain, a.rpe, a.feel, a.garmin_load, "
            "m.load, m.intensity, ri.engine_resid, (i.activity_id IS NOT NULL) AS is_interval "
            "FROM activities a LEFT JOIN activity_metrics m ON m.activity_id = a.id "
            "LEFT JOIN run_insights ri ON ri.activity_id = a.id LEFT JOIN interval_sessions i ON i.activity_id = a.id "
            "WHERE a.is_parent = 0 ORDER BY a.start_local", c)
        hr_max = db.get_settings(c)["hr_max"]
    a["date"] = pd.to_datetime(a["date"])
    a["start"] = pd.to_datetime(a["start_local"], errors="coerce")
    a["end_hour"] = a["start"].dt.hour + a["start"].dt.minute / 60 + a["moving_time"].fillna(0) / 3600
    a["hr_max_setting"] = hr_max
    return a


def daily_dataset() -> pd.DataFrame:
    """One row per day D with everything known on the evening of D."""
    df = lab.daily_features().copy()
    if df.empty:
        return df
    acts = _activities()
    g = acts.groupby("date")
    df["n_sessions"] = g.size().reindex(df.index).fillna(0)
    df["te_max"] = g["aerobic_te"].max().reindex(df.index)
    df["ana_te_max"] = g["anaerobic_te"].max().reindex(df.index)
    df["hard_day"] = (df["te_max"].fillna(0) >= 3.5).astype(float)
    df["last_end_hour"] = g["end_hour"].max().reindex(df.index)
    df["load_lag1"] = df["load"].shift(1)
    df["load_lag2"] = df["load"].shift(2)
    df["load_3d"] = df["load"].rolling(3, min_periods=1).sum()
    df["hrv_lag1"] = df["hrv"].shift(1)
    df["hrv_7d"] = df["hrv"].rolling(7, min_periods=4).mean()
    df["hrv_7d_sd"] = df["hrv"].rolling(7, min_periods=4).std()
    df["sleep_7d"] = df["sleep_score"].rolling(7, min_periods=4).mean()
    df["rhr_7d"] = df["resting_hr"].rolling(7, min_periods=4).mean()
    df["dow"] = df.index.dayofweek
    df["weekend_night"] = df.index.dayofweek.isin([4, 5]).astype(float)  # the night after Friday / Saturday
    doy = df.index.dayofyear
    df["doy_sin"] = np.sin(2 * np.pi * doy / 365.25)
    df["doy_cos"] = np.cos(2 * np.pi * doy / 365.25)
    return df


DAILY_TARGETS = {
    "hrv": ("HRV de la nuit", "ms", "hrv"),
    "sleep_score": ("Score de sommeil de la nuit", "", "sleep_score"),
    "resting_hr": ("FC de repos du lendemain", "bpm", "resting_hr"),
}


# Known by the evening of D and NOT overlapping the predicted night. Garmin's daily
# summary signals of day D (all-day stress, Body Battery charge, respiration...) run
# until midnight, i.e. they contain the start of the night being predicted (stress is
# itself derived from HRV): including them inflates the HRV "skill" — an ablation with
# lagged versions brought the model back to the level of the 7-night mean. A compact
# set also overfits less on a few hundred nights.
NIGHT_FEATURES = ["load", "te_max", "ana_te_max", "hard_day", "last_end_hour", "load_lag1", "load_3d", "atl", "tsb", "acwr",
                  "weekend_night", "dow", "hrv_dev", "sleep_debt_3d", "sleep_hours", "target_lag1", "target_7d", "hrv_7d_sd",
                  "n_sessions", "lag_dev"]
LABELS["lag_dev"] = "Écart de la nuit dernière à sa moyenne 7 j"


def night_frame(target: str) -> tuple[pd.DataFrame, pd.Series, list[str]]:
    """X(D) -> y(D+1) for a wellness target."""
    df = daily_dataset()
    col = DAILY_TARGETS[target][2]
    y = df[col].shift(-1).rename("y")
    data = df.assign(target_7d=df[col].rolling(7, min_periods=4).mean(), target_lag1=df[col])
    data["lag_dev"] = data["target_lag1"] - data["target_7d"]
    feats = [c for c in NIGHT_FEATURES if c in data.columns]
    ok = y.notna() & data["target_7d"].notna()
    return data.loc[ok, feats], y[ok], feats


def session_frame(variant: str = "before") -> tuple[pd.DataFrame, pd.Series, list[str], pd.Series]:
    """One row per rated session. variant 'before' = what you know before starting
    (morning signals, training state, sport & planned duration); 'after' adds the
    session's objective metrics (HR, TE, engine residual...) but never its RPE."""
    acts = _activities()
    acts = acts[acts["sport"].isin(["run", "bike", "swim"])].copy()
    daily = daily_dataset()
    acts = acts.sort_values("start").reset_index(drop=True)
    rated = acts["feel"].notna()
    f = acts["feel"]
    # rating history (strictly previous sessions)
    acts["feel_prev5"] = f.shift(1).rolling(5, min_periods=2).mean()
    acts["feel_prev_same"] = acts.groupby("sport")["feel"].shift(1)
    hard = (acts["aerobic_te"].fillna(0) >= 3.5)
    last_hard = acts["start"].where(hard).ffill().shift(1)
    acts["days_since_hard"] = (acts["start"] - last_hard).dt.total_seconds() / 86400
    day = acts["date"]
    prev = day - pd.Timedelta(days=1)
    for src, dst, idx in (("ctl", "ctl_prev", prev), ("atl", "atl_prev", prev), ("acwr", "acwr_prev", prev), ("tsb", "tsb_morning", day)):
        acts[dst] = daily[src].reindex(idx).to_numpy()
    for col in ("hrv", "hrv_dev", "resting_hr", "sleep_score", "sleep_hours", "body_battery_high", "sleep_stress", "readiness", "sleep_debt_3d"):
        if col in daily:
            acts[col] = daily[col].reindex(day).to_numpy()
    acts["load_lag1"] = daily["load"].reindex(prev).to_numpy()
    for sp in ("run", "bike", "swim"):
        acts[f"sport_{sp}"] = (acts["sport"] == sp).astype(float)
    acts["duration_min"] = acts["moving_time"] / 60
    acts["distance_km"] = acts["distance"] / 1000
    acts["start_hour"] = acts["start"].dt.hour + acts["start"].dt.minute / 60
    acts["dow"] = acts["start"].dt.dayofweek
    before = ["feel_prev5", "feel_prev_same", "days_since_hard", "ctl_prev", "atl_prev", "acwr_prev", "tsb_morning", "hrv", "hrv_dev",
              "resting_hr", "sleep_score", "sleep_hours", "body_battery_high", "sleep_stress", "readiness", "sleep_debt_3d", "load_lag1",
              "sport_run", "sport_bike", "sport_swim", "duration_min", "start_hour", "dow"]
    after = before + ["distance_km", "avg_hr", "hr_frac", "max_hr", "session_load", "session_intensity", "aerobic_te_s", "anaerobic_te_s",
                      "is_race", "is_interval", "temp", "elev_gain", "engine_resid_s", "pace_vs_usual"]
    acts["hr_frac"] = acts["avg_hr"] / acts["hr_max_setting"]
    acts["session_load"] = acts["load"]
    acts["session_intensity"] = acts["intensity"]
    acts["aerobic_te_s"] = acts["aerobic_te"]
    acts["anaerobic_te_s"] = acts["anaerobic_te"]
    acts["temp"] = acts["avg_temp"]
    acts["engine_resid_s"] = acts["engine_resid"]
    acts["is_interval"] = acts["is_interval"].astype(float)
    run_speed = acts["avg_speed"].where(acts["sport"] == "run")
    acts["pace_vs_usual"] = run_speed / run_speed.shift(1).rolling(20, min_periods=5).median()
    feats = before if variant == "before" else after
    data = acts.loc[rated].reset_index(drop=True)
    return data[feats], data["feel"], feats, data["start"]


# --------------------------------------------------------------------------- evaluation helpers

def _split(times: pd.Series, gap_days: int = GAP_DAYS) -> tuple[np.ndarray, np.ndarray]:
    t = pd.to_datetime(pd.Series(times).reset_index(drop=True))
    cut = t.iloc[int(len(t) * (1 - TEST_FRAC))]
    train = (t < cut - pd.Timedelta(days=gap_days)).to_numpy()
    test = (t >= cut).to_numpy()
    return train, test


class DropEmpty(BaseEstimator, TransformerMixin):
    """Drop columns that are empty or constant in the data being fitted (features that
    only exist since 2025 are all-NaN in early CV folds)."""

    def fit(self, X, y=None):
        X = np.asarray(X, dtype=float)
        self.keep_ = [j for j in range(X.shape[1]) if len(np.unique(X[~np.isnan(X[:, j]), j])) >= 2]
        return self

    def transform(self, X):
        return np.asarray(X, dtype=float)[:, self.keep_]


def _reg_models():
    base = _reg_base()
    return {**base, "ens": ("Ensemble Ridge + forest", lambda: VotingRegressor([("ridge", base["ridge"][1]()), ("rf", base["rf"][1]())]))}


def _reg_base():
    return {
        "ridge": ("Régression Ridge", lambda: make_pipeline(DropEmpty(), SimpleImputer(strategy="median"), StandardScaler(), Ridge(alpha=300.0))),
        "rf": ("Random forest", lambda: make_pipeline(DropEmpty(), SimpleImputer(strategy="median"),
                                                       RandomForestRegressor(n_estimators=400, min_samples_leaf=20, max_features=0.4, random_state=0, n_jobs=1))),
        "gbm": ("Gradient boosting", lambda: make_pipeline(DropEmpty(), HistGradientBoostingRegressor(max_depth=3, learning_rate=0.05, max_iter=300,
                                                                          min_samples_leaf=15, l2_regularization=1.0, random_state=0))),
    }


def _clf_models():
    return {
        "logit": ("Régression logistique", lambda: make_pipeline(DropEmpty(), SimpleImputer(strategy="median"), StandardScaler(),
                                                                LogisticRegression(C=0.3, max_iter=2000, class_weight="balanced"))),
        "rf": ("Random forest", lambda: make_pipeline(DropEmpty(), SimpleImputer(strategy="median"),
                                                       RandomForestClassifier(n_estimators=400, min_samples_leaf=4, max_features=0.5,
                                                                              class_weight="balanced_subsample", random_state=0, n_jobs=1))),
        "gbm": ("Gradient boosting", lambda: make_pipeline(DropEmpty(), HistGradientBoostingClassifier(max_depth=3, learning_rate=0.05, max_iter=250, min_samples_leaf=12,
                                                                           l2_regularization=1.0, class_weight="balanced", random_state=0))),
    }


def _cv_score(make, X: pd.DataFrame, y: pd.Series, kind: str) -> float:
    """Expanding-window CV on the training part (lower = better)."""
    scores = []
    for tr, va in TimeSeriesSplit(n_splits=4).split(X):
        if len(tr) < 60:
            continue
        m = make().fit(X.iloc[tr], y.iloc[tr])
        p = m.predict(X.iloc[va])
        scores.append(mean_absolute_error(y.iloc[va], p) if kind == "reg" else -balanced_accuracy_score(y.iloc[va], p))
    return float(np.mean(scores)) if scores else math.inf


def _importance(model, X: pd.DataFrame, y: pd.Series, kind: str, top: int = 10) -> list[dict]:
    scoring = "neg_mean_absolute_error" if kind == "reg" else "balanced_accuracy"
    # n_jobs=1: process-based parallelism deadlocks on Windows (and inside the web server)
    r = permutation_importance(model, X, y, scoring=scoring, n_repeats=5, random_state=0, n_jobs=1)
    order = np.argsort(-r.importances_mean)[:top]
    return [{"key": X.columns[i], "label": LABELS.get(X.columns[i], X.columns[i]),
             "importance": float(r.importances_mean[i]), "sd": float(r.importances_std[i])} for i in order]


def _sanitize(X: pd.DataFrame) -> pd.DataFrame:
    return X.astype(float).replace([np.inf, -np.inf], np.nan)


# --------------------------------------------------------------------------- experiments

def evaluate_night(target: str) -> dict:
    X, y, feats = night_frame(target)
    X = _sanitize(X)
    tr, te = _split(pd.Series(X.index))
    Xtr, ytr, Xte, yte = X[tr], y[tr], X[te], y[te]
    base = {
        "persistence": ("Comme la nuit précédente", X.loc[te, "target_lag1"]),
        "mean7": ("Moyenne des 7 dernières nuits", X.loc[te, "target_7d"]),
    }
    baselines = []
    for k, (lab_, pred) in base.items():
        ok = pred.notna()
        baselines.append({"key": k, "label": lab_, "mae": float(mean_absolute_error(yte[ok], pred[ok]))})
    # Model the deviation from the 7-night mean, not the level: the level drifts over
    # months and trees cannot extrapolate beyond levels seen in training.
    # Prediction = 7-night mean + predicted deviation.
    base_tr = X.loc[tr, "target_7d"]
    base_te = X.loc[te, "target_7d"]
    ok_tr = base_tr.notna()
    models = []
    for k, (lab_, make) in _reg_models().items():
        cv = _cv_score(make, Xtr[ok_tr], (ytr - base_tr)[ok_tr], "reg")
        m = make().fit(Xtr[ok_tr], (ytr - base_tr)[ok_tr])
        p = base_te.fillna(ytr.mean()).to_numpy() + m.predict(Xte)
        models.append({"key": k, "label": lab_, "cv_mae": cv, "mae": float(mean_absolute_error(yte, p)),
                       "rmse": float(math.sqrt(mean_squared_error(yte, p))), "r2": float(r2_score(yte, p)),
                       "corr": float(np.corrcoef(yte, p)[0, 1]),
                       "dev_corr": float(np.corrcoef((yte - base_te).fillna(0), p - base_te.fillna(ytr.mean()))[0, 1]),
                       "_model": m, "_pred": p})
    best = min(models, key=lambda m: m["cv_mae"])  # chosen on CV, never on the test set
    ref = min(b["mae"] for b in baselines)
    imp = _importance(best["_model"], Xte, (yte - base_te).fillna(0), "reg")
    # residual spread for prediction intervals (test residuals of the chosen model)
    resid = yte.to_numpy() - best["_pred"]
    out = {
        "target": target, "label": DAILY_TARGETS[target][0], "unit": DAILY_TARGETS[target][1], "kind": "reg",
        "n_train": int(tr.sum()), "n_test": int(te.sum()), "test_from": str(X.index[te][0].date()), "test_to": str(X.index[te][-1].date()),
        "baselines": baselines, "models": [{k: v for k, v in m.items() if not k.startswith("_")} for m in models],
        "chosen": best["key"], "skill": 1 - best["mae"] / ref, "importance": imp,
        "interval": [float(np.quantile(resid, 0.1)), float(np.quantile(resid, 0.9))],
        "test_series": [{"date": str((d + pd.Timedelta(days=1)).date()), "actual": float(a), "pred": float(p),
                         "baseline": None if pd.isna(b) else float(b)}
                        for d, a, p, b in zip(X.index[te], yte, best["_pred"], X.loc[te, "target_7d"])],
    }
    return out


def _feel3(v: pd.Series) -> pd.Series:
    return pd.cut(v, [-1, 30, 60, 101], labels=[0, 1, 2]).astype(int)


def evaluate_feel(variant: str) -> dict:
    X, y5, feats, times = session_frame(variant)
    X = _sanitize(X)
    y = _feel3(y5)
    tr, te = _split(times, gap_days=3)
    Xtr, ytr, Xte, yte = X[tr], y[tr], X[te], y[te]
    maj = int(ytr.mode()[0])
    prev = _feel3(X["feel_prev_same"].fillna(50))
    baselines = [
        {"key": "majority", "label": "Toujours la classe la plus fréquente", "bacc": float(balanced_accuracy_score(yte, np.full(len(yte), maj))),
         "acc": float((yte == maj).mean())},
        {"key": "previous", "label": "Comme ta dernière séance du même sport", "bacc": float(balanced_accuracy_score(yte, prev[te])),
         "acc": float((yte == prev[te]).mean())},
    ]
    models = []
    for k, (lab_, make) in _clf_models().items():
        cv = _cv_score(make, Xtr, ytr, "clf")
        m = make().fit(Xtr, ytr)
        p = m.predict(Xte)
        proba = m.predict_proba(Xte)
        models.append({"key": k, "label": lab_, "cv_bacc": -cv, "bacc": float(balanced_accuracy_score(yte, p)),
                       "acc": float((yte == p).mean()), "f1": float(f1_score(yte, p, average="macro")),
                       "mae_steps": float(np.mean(np.abs(yte.to_numpy() - p))), "_model": m, "_pred": p, "_proba": proba})
    best = max(models, key=lambda m: m["cv_bacc"])
    cm = confusion_matrix(yte, best["_pred"], labels=[0, 1, 2])
    imp = _importance(best["_model"], Xte, yte, "clf")
    return {
        "target": f"feel_{variant}", "label": "Ressenti de la séance" + (" (avant de partir)" if variant == "before" else " (après la séance)"),
        "kind": "clf", "classes": FEEL3, "n_train": int(tr.sum()), "n_test": int(te.sum()),
        "test_from": str(pd.Series(times)[te].iloc[0].date()), "test_to": str(pd.Series(times)[te].iloc[-1].date()),
        "class_counts": {FEEL_LABELS[k]: int((y5 == k).sum()) for k in FEEL_LABELS},
        "baselines": baselines, "models": [{k: v for k, v in m.items() if not k.startswith("_")} for m in models],
        "chosen": best["key"], "skill": best["bacc"] - max(b["bacc"] for b in baselines),
        "confusion": cm.tolist(), "importance": imp,
    }


def evaluate_hrv_low() -> dict:
    """Binary early warning: will tonight's HRV fall below your 'balanced' range?"""
    X, y, feats = night_frame("hrv")
    with db.session() as c:
        w = pd.read_sql("SELECT date, hrv_baseline_low FROM daily_wellness", c)
    w["date"] = pd.to_datetime(w["date"])
    w = w.set_index("date")["hrv_baseline_low"]
    low = w.shift(-1).reindex(X.index)          # tonight's floor (the label)
    X = X.assign(low_now=w.reindex(X.index))     # last night's floor: known in advance, moves slowly
    X["gap_low"] = X["target_lag1"] - X["low_now"]
    LABELS["low_now"], LABELS["gap_low"] = "Bas de ta plage HRV", "Marge de la nuit dernière au-dessus de ta plage"
    ok = low.notna()
    X, yb = _sanitize(X[ok]), (y[ok] < low[ok]).astype(int)
    tr, te = _split(pd.Series(X.index))
    models = []
    for k, (lab_, make) in _clf_models().items():
        m = make().fit(X[tr], yb[tr])
        pr = m.predict_proba(X[te])[:, 1]
        models.append({"key": k, "label": lab_, "auc": float(roc_auc_score(yb[te], pr)) if yb[te].nunique() > 1 else None})
    # naive scores: last night already low relative to tonight's range / its 7-night mean
    low_te = low[ok][te]
    naive_gap = (low_te - X.loc[te, "target_lag1"]).fillna(0)
    naive_dev = -(X.loc[te, "target_lag1"] - X.loc[te, "target_7d"]).fillna(0)
    auc = lambda sc: float(roc_auc_score(yb[te], sc)) if yb[te].nunique() > 1 else None  # noqa: E731
    best = max(models, key=lambda m: m["auc"] or 0)
    return {"target": "hrv_low", "label": "Nuit avec HRV sous ta plage équilibrée", "kind": "binary",
            "rate": float(yb.mean()), "n_test": int(te.sum()), "chosen": best["key"],
            "baselines": [{"key": "gap", "label": "Écart de la nuit précédente au bas de ta plage", "auc": auc(naive_gap)},
                          {"key": "dev", "label": "Écart de la nuit précédente à sa moyenne 7 j", "auc": auc(naive_dev)}],
            "models": models}


CONDITIONS = {
    "hard_day": ("Journée dure (training effect ≥ 3,5)", lambda d: d["hard_day"] == 1),
    "late": ("Entraînement fini après 20 h", lambda d: d["last_end_hour"] >= 20),
    "double": ("Deux séances ou plus", lambda d: d["n_sessions"] >= 2),
    "rest": ("Jour de repos", lambda d: d["n_sessions"] == 0),
    "weekend": ("Nuit de vendredi ou samedi", lambda d: d["weekend_night"] == 1),
    "debt": ("Dette de sommeil > 2 h sur 3 nuits", lambda d: d["sleep_debt_3d"] > 2),
}


def effects() -> list[dict]:
    """Mean shift of tonight's value vs its 7-night mean, condition vs the other nights
    (Welch t-test, 95 % CI). Descriptive: a hard day is often planned after good nights."""
    from scipy import stats
    out = []
    for target, (lab_, unit, col) in DAILY_TARGETS.items():
        X, y, _ = night_frame(target)
        dev = y - X["target_7d"]
        for key, (clab, cond) in CONDITIONS.items():
            m = cond(X).fillna(False)
            a, b = dev[m].dropna(), dev[~m].dropna()
            if len(a) < 15 or len(b) < 15:
                continue
            t, pv = stats.ttest_ind(a, b, equal_var=False)
            diff = a.mean() - b.mean()
            se = math.sqrt(a.var() / len(a) + b.var() / len(b))
            out.append({"target": target, "target_label": lab_, "unit": unit, "condition": key, "label": clab,
                        "shift": float(diff), "ci": [float(diff - 1.96 * se), float(diff + 1.96 * se)], "p": float(pv), "n": int(len(a))})
    return out


@db.cached_by_signature
def _all() -> pd.DataFrame:
    res = {t: evaluate_night(t) for t in DAILY_TARGETS}
    res["feel_before"] = evaluate_feel("before")
    res["feel_after"] = evaluate_feel("after")
    res["hrv_low"] = evaluate_hrv_low()
    res["effects"] = effects()
    return pd.DataFrame([{"r": res}])


def experiments() -> dict:
    return _all().iloc[0]["r"]


# --------------------------------------------------------------------------- live predictions

def _fit_full_night(target: str, key: str):
    X, y, feats = night_frame(target)
    X = _sanitize(X)
    ok = X["target_7d"].notna()
    return _reg_models()[key][1]().fit(X[ok], (y - X["target_7d"])[ok]), feats


def tonight() -> dict:
    """Predictions for the coming night from today's data so far (evening of today)."""
    exp = experiments()
    df = daily_dataset()
    if df.empty:
        return {}
    today = pd.Timestamp(date.today())
    if today not in df.index:
        return {}
    out = {}
    for target in DAILY_TARGETS:
        e = exp[target]
        model, feats = _fit_full_night(target, e["chosen"])
        col = DAILY_TARGETS[target][2]
        full = df.assign(target_7d=df[col].rolling(7, min_periods=4).mean(), target_lag1=df[col])
        full["lag_dev"] = full["target_lag1"] - full["target_7d"]
        row = full.loc[[today], feats]
        row = _sanitize(row)
        base7 = float(row["target_7d"].iloc[0])
        pred = base7 + float(model.predict(row)[0])
        # local "what pushes it": replace each top feature by its 28-day median, one at a time
        recent = _sanitize(full[feats].loc[today - pd.Timedelta(days=28):today])
        drivers = []
        for imp in e["importance"][:6]:
            k = imp["key"]
            alt = row.copy()
            alt[k] = recent[k].median()
            delta = pred - (base7 + float(model.predict(alt)[0]))
            if not pd.isna(row[k].iloc[0]):
                drivers.append({"key": k, "label": imp["label"], "value": float(row[k].iloc[0]),
                                "typical": None if pd.isna(recent[k].median()) else float(recent[k].median()), "effect": delta})
        lo, hi = e["interval"]
        out[target] = {"label": e["label"], "unit": e["unit"], "pred": pred, "range": [pred + lo, pred + hi],
                       "baseline": None if pd.isna(row["target_7d"].iloc[0]) else float(row["target_7d"].iloc[0]),
                       "skill": e["skill"], "model": e["chosen"], "drivers": sorted(drivers, key=lambda d: -abs(d["effect"]))}
    out["for_night"] = str((today + timedelta(days=1)).date())
    out["partial_day"] = True
    return out


def next_session_feel() -> dict:
    """Probability of each feel class for a session started now (run, 60 min default)."""
    exp = experiments()
    e = exp["feel_before"]
    X, y5, feats, times = session_frame("before")
    X = _sanitize(X)
    model = _clf_models()[e["chosen"]][1]().fit(X, _feel3(y5))
    last = X.iloc[[-1]].copy()
    daily = daily_dataset()
    today = pd.Timestamp(date.today())
    for col in ("hrv", "hrv_dev", "resting_hr", "sleep_score", "sleep_hours", "body_battery_high", "sleep_stress", "readiness", "sleep_debt_3d"):
        if col in daily and today in daily.index:
            last[col] = daily.at[today, col]
    prev = today - pd.Timedelta(days=1)
    for src, dst in (("ctl", "ctl_prev"), ("atl", "atl_prev"), ("acwr", "acwr_prev")):
        if prev in daily.index:
            last[dst] = daily.at[prev, src]
    if today in daily.index:
        last["tsb_morning"] = daily.at[today, "tsb"]
        last["load_lag1"] = daily.at[prev, "load"] if prev in daily.index else np.nan
    y_all = y5.to_numpy()
    last["feel_prev5"] = float(np.mean(y_all[-5:]))
    last["feel_prev_same"] = float(y5[X["sport_run"] == 1].iloc[-1]) if (X["sport_run"] == 1).any() else 50.0
    last[["sport_run", "sport_bike", "sport_swim"]] = [1.0, 0.0, 0.0]
    last["duration_min"] = 60.0
    now = pd.Timestamp.now()
    last["start_hour"] = now.hour + now.minute / 60
    last["dow"] = now.dayofweek
    proba = model.predict_proba(_sanitize(last))[0]
    # the model is trained with balanced class weights (so rare classes get predicted);
    # multiplying by the real class frequencies turns its scores back into usable probabilities
    prior = _feel3(y5).value_counts(normalize=True).reindex(model.classes_).to_numpy()
    cal = proba * prior
    cal = cal / cal.sum()
    return {"proba": {FEEL3[int(c)]: float(p) for c, p in zip(model.classes_, cal)}, "skill": e["skill"], "model": e["chosen"],
            "assumed": {"sport": "course", "duration_min": 60, "start_hour": float(last["start_hour"].iloc[0])}}
