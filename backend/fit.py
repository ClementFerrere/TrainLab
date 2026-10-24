"""Parse original Garmin FIT files (official garmin-fit-sdk) into streams, laps
and session metadata, and compute best efforts from the distance stream."""
from __future__ import annotations

import io
import zipfile
from datetime import datetime

import numpy as np
from garmin_fit_sdk import Decoder, Stream

PARSER_VERSION = 4  # bump to re-parse the local FIT archive (no re-download)
SEMICIRCLE = 180 / 2**31
# Garmin tags auto-laps "interval" and workout recoveries "recovery"; collapse to 4 kinds.
LAP_INTENSITY = {"active": "active", "interval": "active", "other": "active", "rest": "rest", "recovery": "rest",
                 "warmup": "warmup", "cooldown": "cooldown"}
MAX_FIT_BYTES = 60 * 1024 * 1024

# Strava-style names so effort tables read naturally
EFFORT_DISTANCES = [
    ("400m", 400), ("1/2 mile", 804.67), ("1k", 1000), ("1 mile", 1609.34), ("2 mile", 3218.69),
    ("5k", 5000), ("10k", 10000), ("15k", 15000), ("10 mile", 16093.4), ("20k", 20000),
    ("Half-Marathon", 21097.5), ("30k", 30000), ("Marathon", 42195),
]


# world-record speeds (m/s); a "best effort" faster than this is a recording glitch
WR_SPEED = {"400m": 9.3, "1/2 mile": 8.0, "1k": 7.7, "1 mile": 7.3, "2 mile": 6.9, "5k": 6.7, "10k": 6.4,
            "15k": 6.3, "10 mile": 6.2, "20k": 6.1, "Half-Marathon": 6.1, "30k": 5.9, "Marathon": 5.8}


def fit_from_zip(blob: bytes) -> bytes | None:
    """Garmin's download is a ZIP holding the original file; return the .fit inside."""
    if blob[:2] != b"PK":
        return blob if blob[8:12] == b".FIT" else None
    with zipfile.ZipFile(io.BytesIO(blob)) as z:
        for info in z.infolist():
            if info.filename.lower().endswith(".fit") and 0 < info.file_size < MAX_FIT_BYTES:
                return z.read(info)
    return None


def _vo2max_from_mesg140(messages: dict) -> float | None:
    """Garmin's VO2max estimate, from the undocumented 'physiological metrics'
    message 140, field 7 (fixed point: value / 65536 * 3.5 = ml/kg/min).
    Community reverse-engineering, not an official field: sanity-bounded."""
    m = (messages.get("140") or messages.get(140) or [None])[0]
    v = m.get(7) if isinstance(m, dict) else None
    if not isinstance(v, (int, float)):
        return None
    vo2 = v / 65536 * 3.5
    return round(vo2, 1) if 25 <= vo2 <= 95 else None


def _arr(records, key, scale=1.0):
    out = []
    for r in records:
        v = r.get(key)
        out.append(None if v is None else v * scale)
    return out


def _grade(dist: np.ndarray, alt: np.ndarray, half_window: float = 30.0) -> np.ndarray:
    """Grade (%) as slope of altitude over ±half_window metres of distance."""
    lo = np.searchsorted(dist, dist - half_window, side="left")
    hi = np.clip(np.searchsorted(dist, dist + half_window, side="right") - 1, 0, len(dist) - 1)
    dd = dist[hi] - dist[lo]
    with np.errstate(divide="ignore", invalid="ignore"):
        g = np.where(dd > 8, (alt[hi] - alt[lo]) / dd, 0.0)
    return np.clip(np.nan_to_num(g), -0.30, 0.30) * 100


def _round(seq, nd):
    return [None if v is None else round(float(v), nd) for v in seq]


def parse_fit(fit_bytes: bytes, sport: str) -> dict | None:
    stream = Stream.from_byte_array(bytearray(fit_bytes))
    decoder = Decoder(stream)
    if not decoder.is_fit():
        return None
    messages, _errors = decoder.read(convert_datetimes_to_dates=True, merge_heart_rates=True)
    records = [r for r in messages.get("record_mesgs", []) if isinstance(r.get("timestamp"), datetime)]
    session = (messages.get("session_mesgs") or [{}])[0]
    out: dict = {"session": {}, "streams": {}, "laps": []}

    rpe = session.get("workout_rpe")
    feel = session.get("workout_feel")
    out["session"] = {
        "rpe": rpe / 10 if isinstance(rpe, (int, float)) and rpe > 0 else None,
        "feel": feel if isinstance(feel, (int, float)) else None,
        "avg_temp": session.get("avg_temperature"),
        "sub_sport": str(session.get("sub_sport") or ""),
        "vo2max": _vo2max_from_mesg140(messages),
    }
    if not records:
        return out

    t0 = records[0]["timestamp"]
    t = np.array([(r["timestamp"] - t0).total_seconds() for r in records])
    s: dict = {"time": t.round(1).tolist()}

    dist = _arr(records, "distance")
    if any(v is not None for v in dist):
        d = np.array([np.nan if v is None else v for v in dist], dtype=float)
        d = np.maximum.accumulate(np.nan_to_num(d, nan=0.0))  # monotonic, gaps carried
        s["distance"] = d.round(1).tolist()
    lat = _arr(records, "position_lat", SEMICIRCLE)
    lng = _arr(records, "position_long", SEMICIRCLE)
    if any(v is not None for v in lat):
        s["latlng"] = [None if a is None or b is None else [round(a, 6), round(b, 6)] for a, b in zip(lat, lng)]

    alt = _arr(records, "enhanced_altitude")
    if all(v is None for v in alt):
        alt = _arr(records, "altitude")
    if any(v is not None for v in alt):
        s["altitude"] = _round(alt, 1)

    spd = _arr(records, "enhanced_speed")
    if all(v is None for v in spd):
        spd = _arr(records, "speed")
    if any(v is not None for v in spd):
        s["velocity_smooth"] = _round(spd, 3)
        s["moving"] = [bool(v is not None and v > 0.5) for v in spd]

    hr = _arr(records, "heart_rate")
    if any(v is not None for v in hr):
        s["heartrate"] = [None if v is None else int(v) for v in hr]

    cad = _arr(records, "cadence")
    if any(v is not None for v in cad):
        if sport == "run":
            frac = _arr(records, "fractional_cadence")
            cad = [None if c is None else (c + (f or 0)) * 2 for c, f in zip(cad, frac)]
        s["cadence"] = _round(cad, 1)

    pw = _arr(records, "power")
    if any(v is not None for v in pw):
        s["watts"] = [None if v is None else int(v) for v in pw]
    temp = _arr(records, "temperature")
    if any(v is not None for v in temp):
        s["temp"] = _round(temp, 0)

    # running dynamics
    for key, name, scale, nd in (("vertical_oscillation", "vert_osc", 0.1, 2), ("stance_time", "gct", 1, 0),
                                 ("step_length", "stride", 0.001, 3), ("vertical_ratio", "vert_ratio", 1, 2),
                                 ("enhanced_respiration_rate", "resp", 1, 1)):
        vals = _arr(records, key, scale)
        if any(v is not None for v in vals):
            s[name] = _round(vals, nd)

    if "distance" in s and "altitude" in s:
        a = np.array([np.nan if v is None else v for v in s["altitude"]], dtype=float)
        if np.isfinite(a).any():
            idx = np.arange(len(a))
            ok = np.isfinite(a)
            a = np.interp(idx, idx[ok], a[ok])
            s["grade_smooth"] = _grade(np.array(s["distance"]), a).round(1).tolist()
    out["streams"] = s

    ts = [r["timestamp"] for r in records]
    for i, lap in enumerate(messages.get("lap_mesgs", [])):
        st = lap.get("start_time")
        if not isinstance(st, datetime):
            continue
        el = lap.get("total_elapsed_time") or 0
        si = int(np.searchsorted(t, (st - t0).total_seconds(), side="left"))
        ei = int(np.searchsorted(t, (st - t0).total_seconds() + el, side="right") - 1)
        lc = lap.get("avg_cadence")
        if lc is not None and sport == "run":
            lc = (lc + (lap.get("avg_fractional_cadence") or 0)) * 2
        out["laps"].append({
            "lap_index": i,
            "intensity": LAP_INTENSITY.get(str(lap.get("intensity") or "active"), "active"),
            "start_offset": (st - t0).total_seconds(),
            "distance": lap.get("total_distance"),
            "elapsed_time": el,
            "moving_time": lap.get("total_timer_time"),
            "avg_speed": lap.get("enhanced_avg_speed") or lap.get("avg_speed"),
            "max_speed": lap.get("enhanced_max_speed") or lap.get("max_speed"),
            "avg_hr": lap.get("avg_heart_rate"),
            "max_hr": lap.get("max_heart_rate"),
            "avg_cadence": lc,
            "avg_power": lap.get("avg_power"),
            "elev_gain": lap.get("total_ascent"),
            "start_index": max(0, min(si, len(ts) - 1)),
            "end_index": max(0, min(ei, len(ts) - 1)),
        })
    return out


def _sustained(mask: np.ndarray, n: int) -> np.ndarray:
    """Keep only runs of at least n consecutive True values."""
    out = np.zeros(len(mask), dtype=bool)
    edges = np.flatnonzero(np.diff(np.concatenate([[0], mask.astype(np.int8), [0]])))
    for s, e in zip(edges[::2], edges[1::2]):
        if e - s >= n:
            out[s:e] = True
    return out


def implausible(speed: np.ndarray, cadence: np.ndarray | None) -> np.ndarray:
    """Samples to ignore when looking for best efforts (~1 Hz arrays):
    GPS jumps (> 10 m/s), and SUSTAINED (>= 10 s) fast movement without a running
    cadence or with an impossible stride (> 2.6 m): bike or vehicle with the watch
    left in run mode. Isolated cadence-sensor dropouts inside a real run are kept."""
    bad = speed > 10
    if cadence is not None:
        cad = np.nan_to_num(np.asarray(cadence, dtype=float))
        odd = ((cad < 100) & (speed > 3.0)) | ((cad > 100) & (speed / np.maximum(cad / 60, 1e-6) > 2.6))
        bad |= _sustained(odd, 10)
    return bad


def best_efforts(time: list[float], distance: list[float], cadence: list | None = None) -> list[dict]:
    """Fastest time over each standard distance (interpolated sliding window).
    Distance covered fast without a running cadence (bike / vehicle with the watch in
    run mode) or with an impossible stride (GPS jump) is not counted."""
    t = np.asarray(time, dtype=float)
    d = np.maximum.accumulate(np.nan_to_num(np.asarray(distance, dtype=float)))
    if len(d) > 1:
        step = np.diff(d, prepend=d[0])
        v = step / np.maximum(np.diff(t, prepend=t[0]), 1e-6)
        cad = None
        if cadence is not None and len(cadence) == len(d):
            cad = np.asarray([np.nan if x is None else x for x in cadence], dtype=float)
        step[implausible(v, cad)] = 0
        d = np.cumsum(step)
    if len(d) < 10 or d[-1] < 400:
        return []
    out = []
    for name, target in EFFORT_DISTANCES:
        if d[-1] - d[0] < target:
            break
        j = np.searchsorted(d, d + target, side="left")
        ok = j < len(d)
        i_idx = np.nonzero(ok)[0]
        if len(i_idx) == 0:
            break
        j_idx = j[ok]
        jm = np.maximum(j_idx - 1, 0)
        span = d[j_idx] - d[jm]
        with np.errstate(divide="ignore", invalid="ignore"):
            frac = np.where(span > 0, (d[i_idx] + target - d[jm]) / span, 0)
        t_end = t[jm] + frac * (t[j_idx] - t[jm])
        dur = t_end - t[i_idx]
        k = int(np.argmin(dur))
        best = float(dur[k])
        if best <= 0 or target / best > WR_SPEED.get(name, 6.6):  # faster than the world record -> GPS glitch
            continue
        out.append({"name": name, "distance": target, "elapsed_time": round(best, 1),
                    "start_index": int(i_idx[k]), "end_index": int(j_idx[k])})
    return out
