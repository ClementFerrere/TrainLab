"""End-to-end test of the Garmin sync against a mock Personal API.

Builds a real FIT file with the official SDK encoder, serves it (and wellness
payloads shaped like docs/garmin_personal_api_openapi.json) through an
httpx.MockTransport, runs one sync cycle into a temporary database and checks
what lands in SQLite.

    .venv\\Scripts\\python tests\\test_garmin_pipeline.py
"""
from __future__ import annotations

import base64
import io
import json
import math
import sys
import tempfile
import time
import zipfile
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import httpx  # noqa: E402
from garmin_fit_sdk import Encoder, Profile  # noqa: E402

from backend import config, db, garmin  # noqa: E402

MN = Profile["mesg_num"]
TODAY = date.today()
RUN_DAY = TODAY - timedelta(days=1)
ACT_ID = 20_700_000_001


def make_fit() -> bytes:
    """A 6 km interval run: warm-up, 3 x 1 km fast with 400 m recoveries, cool-down."""
    t0 = datetime(RUN_DAY.year, RUN_DAY.month, RUN_DAY.day, 7, 0, tzinfo=timezone.utc)
    plan = [("warmup", 1500, 3.0), ("active", 1000, 4.6), ("rest", 400, 2.6), ("active", 1000, 4.7),
            ("rest", 400, 2.6), ("active", 1000, 4.8), ("cooldown", 700, 3.0)]
    enc = Encoder()
    enc.write_mesg({"mesg_num": MN["FILE_ID"], "type": "activity", "manufacturer": "garmin", "product": 4315,
                    "time_created": t0, "serial_number": 1234})
    dist, t, laps = 0.0, 0, []
    for inten, metres, v in plan:
        lap_start, lap_d0, hrs = t, dist, []
        while dist - lap_d0 < metres:
            hr = 120 + int(60 * (v - 2.5) / 2.5)
            hrs.append(hr)
            lat = 48.8566 + (dist / 111_320) * 0.3
            lng = 2.3522 + math.sin(dist / 800) * 0.01
            enc.write_mesg({"mesg_num": MN["RECORD"], "timestamp": t0 + timedelta(seconds=t),
                            "position_lat": round(lat / (180 / 2**31)), "position_long": round(lng / (180 / 2**31)),
                            "distance": dist, "enhanced_speed": v, "enhanced_altitude": 35 + math.sin(dist / 300) * 4,
                            "heart_rate": hr, "cadence": 85, "fractional_cadence": 0.5, "power": int(130 * v),
                            "vertical_oscillation": 86.0, "stance_time": 240.0, "step_length": 1150.0})
            dist += v
            t += 1
        laps.append({"mesg_num": MN["LAP"], "timestamp": t0 + timedelta(seconds=t), "start_time": t0 + timedelta(seconds=lap_start),
                     "total_elapsed_time": float(t - lap_start), "total_timer_time": float(t - lap_start),
                     "total_distance": dist - lap_d0, "enhanced_avg_speed": v, "avg_heart_rate": sum(hrs) // len(hrs),
                     "max_heart_rate": max(hrs), "avg_cadence": 85, "intensity": inten})
    for lap in laps:
        enc.write_mesg(lap)
    enc.write_mesg({"mesg_num": MN["SESSION"], "timestamp": t0 + timedelta(seconds=t), "start_time": t0, "sport": "running",
                    "total_elapsed_time": float(t), "total_timer_time": float(t), "total_distance": dist,
                    "workout_rpe": 70, "workout_feel": 75, "avg_temperature": 12})
    enc.write_mesg({"mesg_num": MN["ACTIVITY"], "timestamp": t0 + timedelta(seconds=t), "num_sessions": 1, "type": "manual"})
    return enc.close()


def zipped(fit: bytes) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr(f"{ACT_ID}_ACTIVITY.fit", fit)
    return buf.getvalue()


def jwt(exp: float) -> str:
    enc = lambda d: base64.urlsafe_b64encode(json.dumps(d).encode()).decode().rstrip("=")  # noqa: E731
    return f"{enc({'alg': 'none'})}.{enc({'exp': int(exp)})}.sig"


def handler(fit_zip: bytes, calls: list):
    def h(req: httpx.Request) -> httpx.Response:
        calls.append(f"{req.method} {req.url.path}")
        p = req.url.path
        if req.method == "POST" and p.endswith("/personal-api-key/token"):
            assert req.headers["authorization"] == "ApiKey test-key"
            return httpx.Response(200, text=jwt(time.time() + 86400))
        assert req.headers.get("authorization", "").startswith("Bearer "), p
        if p == "/biometric-service/heartRateZones/v2":
            return httpx.Response(200, json=[{"sport": "DEFAULT", "trainingMethod": "HR_RESERVE", "maxHeartRateUsed": 197,
                                              "restingHeartRateUsed": 46, "lactateThresholdHeartRateUsed": 177,
                                              "zone1Floor": 110, "zone2Floor": 130, "zone3Floor": 152, "zone4Floor": 172, "zone5Floor": 186}])
        if p == "/activitylist-service/activities/search/activities":
            if int(req.url.params.get("start", 0)) > 0:
                return httpx.Response(200, json=[])
            return httpx.Response(200, json=[{
                "activityId": ACT_ID, "activityName": "Paris - VMA", "activityType": {"typeKey": "running"},
                "eventType": {"typeKey": "training"}, "startTimeLocal": f"{RUN_DAY} 09:00:00", "startTimeGMT": f"{RUN_DAY} 07:00:00",
                "distance": 6000.0, "duration": 1500.0, "movingDuration": 1490.0, "elapsedDuration": 1500.0, "averageSpeed": 4.0,
                "averageHR": 160.0, "maxHR": 181.0, "averageRunningCadenceInStepsPerMinute": 171.0, "aerobicTrainingEffect": 3.9,
                "anaerobicTrainingEffect": 2.4, "activityTrainingLoad": 120.0, "vO2MaxValue": 55.0, "avgStrideLength": 115.0,
                "maxAvgPower_60": 640, "hasPolyline": True, "locationName": "Paris",
            }, {
                "activityId": ACT_ID + 1, "activityName": "Padel", "activityType": {"typeKey": "padel"},
                "eventType": {"typeKey": "uncategorized"}, "startTimeLocal": f"{RUN_DAY} 19:00:00", "startTimeGMT": f"{RUN_DAY} 17:00:00",
                "duration": 5400.0, "averageHR": 138.0, "maxHR": 176.0,
            }])
        if p.startswith("/download-service/files/activity/"):
            if p.endswith(str(ACT_ID)):
                return httpx.Response(200, content=fit_zip, headers={"content-type": "application/x-zip-compressed"})
            return httpx.Response(404)
        if p == "/sleep-service/sleep/dailySleepSummariesByDate":
            return httpx.Response(200, json=[{
                "calendarDate": str(TODAY), "sleepTimeSeconds": 27000, "deepSleepSeconds": 5000, "lightSleepSeconds": 15000,
                "remSleepSeconds": 7000, "awakeSleepSeconds": 1200, "awakeCount": 2, "avgHeartRate": 50.0, "avgSleepStress": 18.0,
                "averageRespirationValue": 14.2, "sleepStartTimestampLocal": int(datetime(RUN_DAY.year, RUN_DAY.month, RUN_DAY.day, 23, 10, tzinfo=timezone.utc).timestamp() * 1000),
                "sleepEndTimestampLocal": int(datetime(TODAY.year, TODAY.month, TODAY.day, 7, 0, tzinfo=timezone.utc).timestamp() * 1000),
                "sleepScores": {"overall": {"value": 81, "qualifierKey": "GOOD"}},
            }])
        if p.startswith("/hrv-service/hrv/daily/"):
            return httpx.Response(200, json={"hrvSummaries": [{"calendarDate": str(TODAY), "weeklyAvg": 62, "lastNightAvg": 58,
                                                               "lastNight5MinHigh": 85, "status": "BALANCED",
                                                               "baseline": {"balancedLow": 55, "balancedUpper": 70}}]})
        if p == "/usersummary-service/v2/dailysummaries":
            return httpx.Response(200, json={"data": [{"calendarDate": str(TODAY), "heartRate": {"restingValue": 45, "minValue": 43, "maxValue": 170},
                                                       "stress": {"avgLevel": 24, "highStressProportion": 0.04},
                                                       "bodyBattery": {"maxValue": 88, "minValue": 21, "chargedValue": 60, "drainedValue": 55},
                                                       "respiration": {"avgValue": 14}, "pulseOx": {"avgValue": 96},
                                                       "movement": {"steps": {"value": 12345}}, "intensityMinutes": {"moderate": 20, "vigorous": 30}}]})
        if p.startswith("/weight-service/weight/range/"):
            return httpx.Response(400, json={"message": "range too large"})  # exercise the tolerant path
        return httpx.Response(404)
    return h


def main() -> None:
    tmp = Path(tempfile.mkdtemp(prefix="trainlab-test-"))
    db.DB_PATH = tmp / "test.db"
    config.SECRETS_DIR = tmp / "secrets"
    config.SECRETS_DIR.mkdir()
    config.GARMIN_KEY_FILE = config.SECRETS_DIR / "garmin_personal_api_key"
    config.FIT_DIR = tmp / "fit"
    config.FIT_DIR.mkdir()
    garmin.MIN_INTERVAL_S = 0
    garmin.HISTORY_START = TODAY - timedelta(days=40)
    db.init_db()

    calls: list[str] = []
    fit_zip = zipped(make_fit())
    garmin.client._http = httpx.Client(base_url=config.GARMIN_API, transport=httpx.MockTransport(handler(fit_zip, calls)))
    garmin.client.save_key("test-key")
    assert config.GARMIN_KEY_FILE.read_text() == "test-key"

    garmin.sync._cycle()

    with db.session() as c:
        acts = {r["id"]: dict(r) for r in c.execute("SELECT * FROM activities")}
        run = acts[ACT_ID]
        assert run["sport"] == "run" and run["fit_status"] == 1, run
        assert acts[ACT_ID + 1]["sport"] == "racket" and acts[ACT_ID + 1]["fit_status"] == -1
        assert run["rpe"] == 7 and run["feel"] == 75, (run["rpe"], run["feel"])
        assert run["route"] and len(json.loads(run["route"])) > 10
        st = db.unpack(c.execute("SELECT data FROM streams WHERE activity_id=?", (ACT_ID,)).fetchone()[0])
        for k in ("time", "distance", "latlng", "altitude", "velocity_smooth", "heartrate", "cadence", "watts", "grade_smooth", "vert_osc", "gct", "stride"):
            assert k in st, f"missing stream {k}"
        assert abs(st["cadence"][100] - 171) < 0.01, st["cadence"][100]
        assert abs(st["vert_osc"][100] - 8.6) < 0.01 and abs(st["stride"][100] - 1.15) < 0.001
        laps = c.execute("SELECT intensity, distance FROM laps WHERE activity_id=? ORDER BY lap_index", (ACT_ID,)).fetchall()
        assert [l[0] for l in laps] == ["warmup", "active", "rest", "active", "rest", "active", "cooldown"], [l[0] for l in laps]
        best = {r["name"]: r["elapsed_time"] for r in c.execute("SELECT name, elapsed_time FROM best_efforts WHERE activity_id=?", (ACT_ID,))}
        assert "1k" in best and 205 <= best["1k"] <= 220, best  # fastest rep: 1000 m at 4.8 m/s ≈ 208 s
        assert "5k" in best
        m = c.execute("SELECT * FROM activity_metrics WHERE activity_id=?", (ACT_ID,)).fetchone()
        assert m["load_method"] == "stream" and m["load"] > 0 and m["ef"] > 0
        w = dict(c.execute("SELECT * FROM daily_wellness WHERE date=?", (str(TODAY),)).fetchone())
        assert w["sleep_seconds"] == 27000 and w["sleep_score"] == 81 and w["hrv_overnight"] == 58 and w["resting_hr"] == 45, w
        assert w["sleep_start"].startswith(f"{RUN_DAY}T23:10"), w["sleep_start"]
        assert w["intensity_min"] == 80 and w["steps"] == 12345
        s = db.get_settings(c)
        assert s["hr_zones"] == [130, 152, 172, 186] and s["lthr"] == 177 and s["hr_max"] == 197, s
        warns = c.execute("SELECT COUNT(*) FROM sync_log WHERE level='warning'").fetchone()[0]
        assert warns >= 1  # the 400 on weight was tolerated, not fatal
    assert (config.FIT_DIR / f"{ACT_ID}.zip").exists()
    print(f"OK — {len(calls)} mocked calls, best 1k {best['1k']:.1f}s, load {m['load']:.0f}, laps {len(laps)}")


if __name__ == "__main__":
    main()
