"""Smoke test: every API endpoint answers on the demo database, and the
local-only guards hold.

    .venv\\Scripts\\python scripts\\demo_data.py      (once)
    .venv\\Scripts\\python tests\\test_api_smoke.py
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

os.environ["SPORT_DEMO"] = "1"
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi.testclient import TestClient  # noqa: E402

from backend.app import app  # noqa: E402
from backend.config import PORT  # noqa: E402


def main() -> None:
    with TestClient(app, base_url=f"http://127.0.0.1:{PORT}") as c:
        acts = c.get("/api/activities?limit=50").json()
        assert acts, "demo.db is empty — run scripts/demo_data.py"
        aid = next(a["id"] for a in acts if a["sport"] == "run")
        urls = [
            "/api/status", "/api/settings", "/api/goals", "/api/cockpit", "/api/activities?sport=run&limit=5",
            f"/api/activities/{aid}", "/api/calendar?start=2026-10-01&end=2026-10-31", "/api/weekly?weeks=12",
            "/api/load?start=2026-01-01", "/api/performance", "/api/gear", "/api/routes?limit=20", "/api/punchcard",
            "/api/wellness?start=2026-09-01", "/api/lab/variables", "/api/lab/pair?x=load&y=hrv&lag=1",
            "/api/lab/matrix?keys=load,hrv,resting_hr,sleep_hours&lag=0", "/api/lab/discover?target=hrv",
            "/api/lab/series?keys=load,hrv", "/api/profile/matrix", "/api/profile/predictions", "/api/profile/curves",
            "/api/profile/engine", f"/api/activities/{aid}/intervals", "/api/readiness", "/api/ml/experiments", "/api/ml/now", "/",
        ]
        for u in urls:
            r = c.get(u)
            assert r.status_code == 200, (u, r.status_code, r.text[:200])
        detail = c.get(f"/api/activities/{aid}").json()
        assert detail["streams"].get("heartrate") and detail["laps"]
        assert c.post("/api/garmin/sync").status_code == 403                      # missing CSRF header
        assert c.get("/api/status", headers={"host": "evil.example"}).status_code == 403  # DNS rebinding
        assert c.get("/api/activities/999").status_code == 404
    print(f"OK — {len(urls)} endpoints")


if __name__ == "__main__":
    main()
