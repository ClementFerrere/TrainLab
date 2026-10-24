"""SQLite storage. One file (data/sport.db) that is also meant to be opened
from Jupyter / pandas: `pd.read_sql("select * from activities", sqlite3.connect(path))`."""
from __future__ import annotations

import json
import sqlite3
import zlib
from contextlib import contextmanager
from typing import Any, Iterator

from .config import DB_PATH

SCHEMA = """
-- Activities come from Garmin Connect (Personal API): summary + original FIT file.
CREATE TABLE IF NOT EXISTS activities (
    id                 INTEGER PRIMARY KEY,   -- Garmin activityId
    name               TEXT,
    description        TEXT,
    type_key           TEXT,                  -- Garmin activityType.typeKey (running, padel...)
    sport              TEXT,                  -- normalized: run/bike/swim/strength/racket/other
    is_race            INTEGER DEFAULT 0,     -- effective flag: user override, else Garmin or auto-detected
    race_garmin        INTEGER DEFAULT 0,     -- Garmin eventType = race
    race_auto          INTEGER DEFAULT 0,     -- detected (standard distance + race intensity + continuous)
    race_user          INTEGER,               -- manual override (1 / 0), NULL = no opinion
    is_parent          INTEGER DEFAULT 0,     -- multisport container (legs are separate rows)
    start_utc          TEXT,                  -- ISO, UTC
    start_local        TEXT,                  -- ISO, local wall clock
    date               TEXT,                  -- local date YYYY-MM-DD
    location_name      TEXT,
    distance           REAL,                  -- m
    moving_time        REAL,                  -- s
    elapsed_time       REAL,                  -- s
    elev_gain          REAL,                  -- m
    elev_loss          REAL,
    avg_speed          REAL,                  -- m/s
    max_speed          REAL,
    avg_hr             REAL,
    max_hr             REAL,
    avg_power          REAL,
    norm_power         REAL,
    avg_cadence        REAL,                  -- spm (run) / rpm (bike) / strokes (swim)
    calories           REAL,
    steps              INTEGER,
    aerobic_te         REAL,                  -- Garmin training effect
    anaerobic_te       REAL,
    te_label           TEXT,
    garmin_load        REAL,                  -- Garmin activityTrainingLoad (EPOC based)
    vo2max             REAL,                  -- Garmin VO2max estimate attached to the activity
    lthr               REAL,                  -- lactate threshold HR detected by Garmin
    rpe                REAL,                  -- 1-10, from the watch prompt
    feel               REAL,                  -- 0-100 (very weak .. very strong)
    avg_vert_osc       REAL,                  -- cm
    avg_gct            REAL,                  -- ms
    avg_stride         REAL,                  -- m
    avg_vert_ratio     REAL,                  -- %
    avg_resp           REAL,                  -- breaths/min
    avg_temp           REAL,
    start_lat          REAL,
    start_lng          REAL,
    has_polyline       INTEGER,
    route              TEXT,                  -- json [[lat,lng],...] simplified from FIT
    pool_length        REAL,
    avg_swolf          REAL,
    max_power_curve    TEXT,                  -- json {seconds: watts}
    fit_status         INTEGER DEFAULT 0,     -- 0 todo, 1 parsed, -1 no file / failed
    updated_at         TEXT
);
CREATE INDEX IF NOT EXISTS idx_act_date ON activities(date);
CREATE INDEX IF NOT EXISTS idx_act_sport ON activities(sport, date);

CREATE TABLE IF NOT EXISTS activity_raw (
    id      INTEGER PRIMARY KEY,
    summary BLOB                              -- zlib(json) Garmin summary
);

CREATE TABLE IF NOT EXISTS streams (
    activity_id INTEGER PRIMARY KEY,
    data        BLOB                          -- zlib(json {key: [values]}) parsed from FIT
);

-- Strava enrichment, kept <= 7 days to comply with Strava API Policy §6.2 / §5.5.
-- Never joined into persistent tables; purged on every sync.
CREATE TABLE IF NOT EXISTS strava_cache (
    strava_id   INTEGER PRIMARY KEY,
    fetched_at  TEXT,
    start_utc   TEXT,
    sport_type  TEXT,
    payload     BLOB
);
CREATE TABLE IF NOT EXISTS strava_gear_cache (
    id         TEXT PRIMARY KEY,
    fetched_at TEXT,
    payload    BLOB
);

CREATE TABLE IF NOT EXISTS laps (
    activity_id  INTEGER,
    lap_index    INTEGER,
    intensity    TEXT,                        -- active / rest / warmup / cooldown
    start_offset REAL,                        -- s from activity start
    distance     REAL,
    elapsed_time REAL,
    moving_time  REAL,
    avg_speed    REAL,
    max_speed    REAL,
    avg_hr       REAL,
    max_hr       REAL,
    avg_cadence  REAL,
    avg_power    REAL,
    elev_gain    REAL,
    start_index  INTEGER,
    end_index    INTEGER,
    PRIMARY KEY (activity_id, lap_index)
);

-- Fastest segments inside each run, computed from the distance stream.
CREATE TABLE IF NOT EXISTS best_efforts (
    activity_id  INTEGER,
    name         TEXT,                        -- 400m, 1k, 5k, ...
    distance     REAL,
    elapsed_time REAL,
    start_index  INTEGER,
    end_index    INTEGER,
    date         TEXT,
    PRIMARY KEY (activity_id, name)
);
CREATE INDEX IF NOT EXISTS idx_be_name ON best_efforts(name, elapsed_time);

-- Mean-maximal speed per run and duration (the running "power-duration" curve).
-- after = 0 (fresh), 3600 or 5400: best window starting after that many seconds (durability).
CREATE TABLE IF NOT EXISTS speed_curve (
    activity_id INTEGER,
    after       INTEGER,
    duration    INTEGER,                      -- s
    speed       REAL,                         -- m/s, raw
    gap_speed   REAL,                         -- m/s, grade adjusted
    hr          REAL,                         -- mean HR over that best window
    start       INTEGER,                      -- s from activity start
    PRIMARY KEY (activity_id, after, duration)
);

-- 2-min steady-state windows (stable pace, flat, HR settled) for speed <-> HR models.
CREATE TABLE IF NOT EXISTS steady_samples (
    activity_id INTEGER,
    t0          INTEGER,                      -- s from activity start
    hr          REAL,
    speed       REAL,
    gap_speed   REAL,
    cadence     REAL,
    watts       REAL,
    temp        REAL,
    gct         REAL,
    vosc        REAL,
    stride      REAL,
    PRIMARY KEY (activity_id, t0)
);

-- Per-run derived indicators (engine residual, drift on long runs).
CREATE TABLE IF NOT EXISTS run_insights (
    activity_id  INTEGER PRIMARY KEY,
    n_steady     INTEGER,
    engine_resid REAL,                        -- bpm vs the engine model of the previous 42 days (+ = costlier)
    drift_hr     REAL,                        -- bpm/h cardiac drift at constant speed (long steady runs)
    drift_gct    REAL,                        -- ms/h ground contact time at constant speed
    drift_cad    REAL                         -- spm/h
);

-- One row per detected interval session (structured laps or speed-based detection).
CREATE TABLE IF NOT EXISTS interval_sessions (
    activity_id  INTEGER PRIMARY KEY,
    date         TEXT,
    source       TEXT,                        -- laps / speed
    n            INTEGER,
    rep_distance REAL,
    rep_time     REAL,
    speed        REAL,                        -- mean rep speed m/s
    best         REAL,
    cv           REAL,                        -- % variation between reps
    trend        REAL,                        -- % per rep
    fade         REAL,                        -- % within-rep (2nd half vs 1st half)
    hrr60        REAL,                        -- bpm drop 60 s after reps
    rest_ratio   REAL,
    avg_hr       REAL,
    verdict      TEXT
);
CREATE TABLE IF NOT EXISTS interval_checked (activity_id INTEGER PRIMARY KEY);

CREATE TABLE IF NOT EXISTS activity_metrics (
    activity_id   INTEGER PRIMARY KEY,
    load          REAL,                       -- hrTSS-like training load
    trimp         REAL,                       -- Banister TRIMP
    load_method   TEXT,                       -- stream / avg_hr / estimate
    z1 REAL, z2 REAL, z3 REAL, z4 REAL, z5 REAL,  -- seconds in HR zones
    ef            REAL,                       -- efficiency factor (m/min per bpm)
    decoupling    REAL,                       -- Pa:HR %, steady runs > 50 min
    gap_speed     REAL,                       -- grade adjusted speed m/s
    intensity     REAL                        -- load per hour / 100
);

-- One row per calendar day (Garmin calendarDate: sleep is dated by the morning it ends).
CREATE TABLE IF NOT EXISTS daily_wellness (
    date              TEXT PRIMARY KEY,
    sleep_start       TEXT,                   -- local ISO
    sleep_end         TEXT,
    sleep_seconds     INTEGER,
    deep_seconds      INTEGER,
    light_seconds     INTEGER,
    rem_seconds       INTEGER,
    awake_seconds     INTEGER,
    nap_seconds       INTEGER,
    awake_count       INTEGER,
    sleep_score       REAL,
    sleep_quality     TEXT,
    sleep_need_min    REAL,
    sleep_hr          REAL,
    sleep_stress      REAL,
    sleep_resp        REAL,
    sleep_spo2        REAL,
    hrv_overnight     REAL,                   -- ms, last night average
    hrv_5min_high     REAL,
    hrv_weekly        REAL,
    hrv_baseline_low  REAL,
    hrv_baseline_high REAL,
    hrv_status        TEXT,
    resting_hr        REAL,
    min_hr            REAL,
    max_hr            REAL,
    body_battery_high REAL,
    body_battery_low  REAL,
    body_battery_charged REAL,
    body_battery_drained REAL,
    stress_avg        REAL,
    stress_high_pct   REAL,
    respiration       REAL,
    spo2              REAL,
    steps             INTEGER,
    intensity_min     REAL,                   -- moderate + 2 x vigorous
    weight            REAL,
    raw_sleep         BLOB,
    raw_summary       BLOB,
    updated_at        TEXT
);

CREATE TABLE IF NOT EXISTS goals (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT,
    date        TEXT,
    sport       TEXT,
    distance    REAL,                         -- m (null for triathlon)
    target_time INTEGER,                      -- s
    priority    TEXT,                         -- A / B / C
    notes       TEXT
);

-- Activities deleted by the user (e.g. corrupted recordings); the sync never re-imports them.
CREATE TABLE IF NOT EXISTS hidden_activities (
    id         INTEGER PRIMARY KEY,
    deleted_at TEXT,
    label      TEXT
);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT                                -- json
);

CREATE TABLE IF NOT EXISTS sync_log (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    ts      TEXT,
    source  TEXT,
    level   TEXT,
    message TEXT
);
"""

DEFAULT_SETTINGS: dict[str, Any] = {
    # Generic starting values for the load model. With "auto_hr" on (default) they are
    # replaced by the athlete's own Garmin values (zones, max HR, LTHR, resting HR)
    # at the first sync; all of them can be edited in Réglages.
    "hr_max": 190,
    "hr_rest": 55,
    "lthr": 170,
    "hr_zones": [114, 133, 152, 171],   # lower bounds of Z2..Z5 (60/70/80/90 % of HR max)
    "auto_hr": True,
    "weight": 70,
    "ctl_days": 42,
    "atl_days": 7,
}

DEFAULT_GOALS: list[tuple] = []  # goals are added by the athlete in Réglages


def connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


@contextmanager
def session() -> Iterator[sqlite3.Connection]:
    conn = connect()
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


MIGRATIONS = [  # (table, column, ddl) — additive columns for databases created earlier
    ("activities", "race_garmin", "INTEGER DEFAULT 0"),
    ("activities", "race_auto", "INTEGER DEFAULT 0"),
    ("activities", "race_user", "INTEGER"),
]


def _migrate(c: sqlite3.Connection) -> None:
    for table, col, ddl in MIGRATIONS:
        cols = {r[1] for r in c.execute(f"PRAGMA table_info({table})")}
        if cols and col not in cols:
            c.execute(f"ALTER TABLE {table} ADD COLUMN {col} {ddl}")
            if (table, col) == ("activities", "race_garmin"):
                c.execute("UPDATE activities SET race_garmin = is_race")
    # derived tables whose shape changed: drop, they are recomputed from streams
    if "after" not in {r[1] for r in c.execute("PRAGMA table_info(speed_curve)")}:
        c.execute("DROP TABLE IF EXISTS speed_curve")
    if "gct" not in {r[1] for r in c.execute("PRAGMA table_info(steady_samples)")}:
        c.execute("DROP TABLE IF EXISTS steady_samples")
    if "drift_eff" in {r[1] for r in c.execute("PRAGMA table_info(run_insights)")}:
        c.execute("DROP TABLE IF EXISTS run_insights")


def init_db() -> None:
    with session() as c:
        _migrate(c)
        c.executescript(SCHEMA)
        for k, v in DEFAULT_SETTINGS.items():
            c.execute("INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)", (k, json.dumps(v)))
        # migration: lap intensities parsed before normalization
        c.execute("UPDATE laps SET intensity='rest' WHERE intensity='recovery'")
        c.execute("UPDATE laps SET intensity='active' WHERE intensity IN ('interval', 'other')")
        if c.execute("SELECT COUNT(*) FROM goals").fetchone()[0] == 0:
            c.executemany(
                "INSERT INTO goals(name, date, sport, distance, target_time, priority, notes) VALUES (?,?,?,?,?,?,?)",
                DEFAULT_GOALS,
            )


def get_settings(c: sqlite3.Connection | None = None) -> dict[str, Any]:
    own = c is None
    c = c or connect()
    try:
        out = dict(DEFAULT_SETTINGS)
        out.update({r["key"]: json.loads(r["value"]) for r in c.execute("SELECT key, value FROM settings")})
        return out
    finally:
        if own:
            c.close()


def set_setting(c: sqlite3.Connection, key: str, value: Any) -> None:
    c.execute(
        "INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (key, json.dumps(value)),
    )


def signature() -> tuple:
    """Cheap fingerprint of everything derived frames depend on (cache key)."""
    with session() as c:
        return tuple(c.execute(
            "SELECT (SELECT COUNT(*) || '|' || IFNULL(MAX(updated_at), '') FROM activities),"
            " (SELECT COUNT(*) || '|' || TOTAL(load) FROM activity_metrics),"
            " (SELECT COUNT(*) || '|' || IFNULL(MAX(updated_at), '') FROM daily_wellness),"
            " (SELECT group_concat(key || '=' || value) FROM settings), date('now', 'localtime')"
        ).fetchone())


def cached_by_signature(fn):
    """Memoize a zero-argument frame builder until the database changes."""
    state: dict[str, Any] = {"sig": None, "val": None}

    def wrapper():
        sig = signature()
        if sig != state["sig"]:
            state["val"], state["sig"] = fn(), sig
        return state["val"].copy()

    wrapper.__wrapped__ = fn
    return wrapper


def pack(obj: Any) -> bytes:
    return zlib.compress(json.dumps(obj, separators=(",", ":")).encode(), 6)


def unpack(blob: bytes | None) -> Any:
    if blob is None:
        return None
    return json.loads(zlib.decompress(blob).decode())


def log(source: str, message: str, level: str = "info") -> None:
    from datetime import datetime

    with session() as c:
        c.execute(
            "INSERT INTO sync_log(ts, source, level, message) VALUES (?,?,?,?)",
            (datetime.now().isoformat(timespec="seconds"), source, level, message),
        )
