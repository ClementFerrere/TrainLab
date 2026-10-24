"""Paths, environment and process-wide setup."""
from __future__ import annotations

import os
import subprocess
from pathlib import Path

import truststore
from dotenv import load_dotenv

# Antivirus "web shields" and corporate proxies often re-sign HTTPS traffic with their
# own root CA, which lives in the OS certificate store but not in certifi.
# Using the OS trust store keeps full TLS verification without disabling it.
truststore.inject_into_ssl()

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
SECRETS_DIR = DATA_DIR / "secrets"
FIT_DIR = DATA_DIR / "fit"                 # local archive of original Garmin files
DEMO = os.getenv("SPORT_DEMO", "") == "1"   # synthetic dataset, no sync workers
# QA instance on the real DB: no sync workers and no Strava enrichment, so screenshots
# taken for automated review never contain Strava data (Strava API Policy §5.3).
QA = os.getenv("SPORT_QA", "") == "1"
DB_PATH = DATA_DIR / ("demo.db" if DEMO else "sport.db")
FRONTEND_DIR = ROOT / "frontend"

for _d in (DATA_DIR, SECRETS_DIR, FIT_DIR):
    _d.mkdir(parents=True, exist_ok=True)

GARMIN_KEY_FILE = SECRETS_DIR / "garmin_personal_api_key"
GARMIN_API = "https://personal.connectapi.garmin.com"


def lock_down_secrets() -> None:
    """Restrict data/secrets to the current Windows user (no inherited ACLs)."""
    if os.name != "nt":
        os.chmod(SECRETS_DIR, 0o700)
        return
    user = os.environ.get("USERNAME")
    if not user:
        return
    subprocess.run(
        ["icacls", str(SECRETS_DIR), "/inheritance:r", "/grant:r", f"{user}:(OI)(CI)F"],
        capture_output=True, check=False,
    )

HOST = "127.0.0.1"  # never expose the server on the network
PORT = int(os.getenv("SPORT_PORT", "8765"))
BASE_URL = f"http://{HOST}:{PORT}"

STRAVA_CLIENT_ID = ""
STRAVA_CLIENT_SECRET = ""


def reload_env() -> None:
    """Re-read .env so credentials added while the server runs are picked up."""
    global STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET
    load_dotenv(ROOT / ".env", override=True)
    STRAVA_CLIENT_ID = os.getenv("STRAVA_CLIENT_ID", "").strip()
    STRAVA_CLIENT_SECRET = os.getenv("STRAVA_CLIENT_SECRET", "").strip()


def strava_configured() -> bool:
    reload_env()
    return bool(STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET)


reload_env()

# How far back the first sync fetches sleep / HRV / daily summaries (activities: the
# whole Garmin history). Optional, set TRAINLAB_HISTORY_YEARS in .env.
HISTORY_YEARS = float(os.getenv("TRAINLAB_HISTORY_YEARS", "") or 3)
