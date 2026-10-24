"""Strava: OAuth (personal API application) + a 7-day enrichment cache.

Compliance with the Strava API Policy (2026):
  - §6.2 data is kept at most 7 days after it was fetched (purged every cycle);
  - §5.5 nothing from Strava (or derived from it) goes into persistent tables —
    the cache is matched to Garmin activities at request time only;
  - §5.3 the cache is display-only in the local UI; it is not fed to the
    correlation lab or to any AI tool.
Garmin is the system of record; Strava only adds names, descriptions, RPE,
shoes and kudos for the most recent days.
"""
from __future__ import annotations

import json
import secrets
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import urlencode

import httpx

from . import config, db

API = "https://www.strava.com/api/v3"
OAUTH_AUTHORIZE = "https://www.strava.com/oauth/authorize"
OAUTH_TOKEN = "https://www.strava.com/oauth/token"
REDIRECT_URI = f"{config.BASE_URL}/api/strava/callback"
SCOPES = "read,activity:read_all,profile:read_all"
RETENTION = timedelta(days=7)
DETAIL_REFRESH = timedelta(hours=12)

STRAVA_TOKEN_FILE = config.SECRETS_DIR / "strava_tokens.json"


class RateLimited(Exception):
    def __init__(self, wait_s: float):
        super().__init__(f"rate limited, wait {wait_s:.0f}s")
        self.wait_s = wait_s


class NotConnected(Exception):
    pass


# --------------------------------------------------------------------------- OAuth

_pending_states: set[str] = set()


def load_tokens() -> dict[str, Any] | None:
    if STRAVA_TOKEN_FILE.exists():
        return json.loads(STRAVA_TOKEN_FILE.read_text())
    return None


def save_tokens(tok: dict[str, Any]) -> None:
    old = load_tokens() or {}
    keep = {k: tok[k] for k in ("access_token", "refresh_token", "expires_at") if k in tok}
    keep["scope"] = tok.get("scope") or old.get("scope")
    athlete = tok.get("athlete") or old.get("athlete") or {}
    keep["athlete"] = {k: athlete.get(k) for k in ("id", "firstname", "lastname")} if athlete else None
    config.lock_down_secrets()
    STRAVA_TOKEN_FILE.write_text(json.dumps(keep, indent=2))


def is_connected() -> bool:
    return load_tokens() is not None


def authorize_url() -> str:
    state = secrets.token_urlsafe(16)
    _pending_states.add(state)
    q = {"client_id": config.STRAVA_CLIENT_ID, "response_type": "code", "redirect_uri": REDIRECT_URI,
         "approval_prompt": "auto", "scope": SCOPES, "state": state}
    return f"{OAUTH_AUTHORIZE}?{urlencode(q)}"


def exchange_code(code: str, state: str, scope: str) -> None:
    if state not in _pending_states:
        raise ValueError("État OAuth invalide (relance la connexion depuis la plateforme).")
    _pending_states.discard(state)
    r = httpx.post(OAUTH_TOKEN, data={"client_id": config.STRAVA_CLIENT_ID, "client_secret": config.STRAVA_CLIENT_SECRET,
                                      "code": code, "grant_type": "authorization_code"}, timeout=30)
    r.raise_for_status()
    tok = r.json()
    tok["scope"] = scope
    save_tokens(tok)


def disconnect() -> None:
    tok = load_tokens()
    if tok:
        try:
            httpx.post("https://www.strava.com/oauth/deauthorize", data={"access_token": tok["access_token"]}, timeout=15)
        except httpx.HTTPError:
            pass
        STRAVA_TOKEN_FILE.unlink(missing_ok=True)
    with db.session() as c:
        c.execute("DELETE FROM strava_cache")
        c.execute("DELETE FROM strava_gear_cache")


def _access_token() -> str:
    tok = load_tokens()
    if not tok:
        raise NotConnected()
    if tok["expires_at"] - 120 < time.time():
        config.reload_env()
        r = httpx.post(OAUTH_TOKEN, data={"client_id": config.STRAVA_CLIENT_ID, "client_secret": config.STRAVA_CLIENT_SECRET,
                                          "grant_type": "refresh_token", "refresh_token": tok["refresh_token"]}, timeout=30)
        r.raise_for_status()
        save_tokens(r.json())
        tok = load_tokens()
    return tok["access_token"]


rate = {"used_15": 0, "limit_15": 100, "used_day": 0, "limit_day": 1000}


def api_get(path: str, params: dict[str, Any] | None = None) -> Any:
    r = httpx.get(f"{API}{path}", params=params, headers={"Authorization": f"Bearer {_access_token()}"}, timeout=60)
    lim = r.headers.get("x-readratelimit-limit") or r.headers.get("x-ratelimit-limit")
    use = r.headers.get("x-readratelimit-usage") or r.headers.get("x-ratelimit-usage")
    if lim and use:
        rate["limit_15"], rate["limit_day"] = (int(x) for x in lim.split(",")[:2])
        rate["used_15"], rate["used_day"] = (int(x) for x in use.split(",")[:2])
    if r.status_code == 429:
        raise RateLimited(900)
    if r.status_code == 404:
        return None
    r.raise_for_status()
    return r.json()


# --------------------------------------------------------------------------- 7-day cache

def _now() -> datetime:
    return datetime.now(timezone.utc)


def purge() -> int:
    cutoff = (_now() - RETENTION).isoformat()
    with db.session() as c:
        n = c.execute("DELETE FROM strava_cache WHERE fetched_at < ?", (cutoff,)).rowcount
        n += c.execute("DELETE FROM strava_gear_cache WHERE fetched_at < ?", (cutoff,)).rowcount
    return n


def _subset(d: dict[str, Any]) -> dict[str, Any]:
    return {"name": d.get("name"), "description": d.get("description"), "rpe": d.get("perceived_exertion"),
            "gear_id": d.get("gear_id"), "kudos": d.get("kudos_count"), "prs": d.get("pr_count"),
            "achievements": d.get("achievement_count")}


class StravaSync:
    INTERVAL_S = 30 * 60

    def __init__(self) -> None:
        self.state: dict[str, Any] = {"running": False, "phase": "idle", "message": "", "last_sync": None}
        self._wake = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        if self._thread is None:
            self._thread = threading.Thread(target=self._loop, name="strava-sync", daemon=True)
            self._thread.start()

    def trigger(self) -> None:
        self._wake.set()

    def _loop(self) -> None:
        while True:
            wait_s = self.INTERVAL_S
            purge()
            if config.strava_configured() and is_connected():
                try:
                    self.state.update(running=True, phase="sync", message="Enrichissement 7 jours")
                    self._cycle()
                    self.state.update(phase="ok", message="À jour (fenêtre 7 jours)", last_sync=_now().astimezone().isoformat(timespec="minutes"))
                except RateLimited as e:
                    wait_s = e.wait_s
                    self.state.update(phase="paused", message="Quota Strava atteint — reprise automatique")
                except NotConnected:
                    self.state.update(phase="idle", message="Strava non connecté")
                except Exception as e:
                    db.log("strava", f"{type(e).__name__}: {e}", "error")
                    self.state.update(phase="error", message=f"{type(e).__name__}: {e}")
                    wait_s = 600
                finally:
                    self.state["running"] = False
            self._wake.wait(timeout=wait_s)
            self._wake.clear()

    def _cycle(self) -> None:
        after = int((_now() - RETENTION).timestamp())
        acts = api_get("/athlete/activities", {"after": after, "per_page": 100}) or []
        now = _now()
        with db.session() as c:
            fresh = {r["strava_id"]: r["fetched_at"] for r in c.execute("SELECT strava_id, fetched_at FROM strava_cache")}
        for a in acts:
            fetched = fresh.get(a["id"])
            if fetched and now - datetime.fromisoformat(fetched) < DETAIL_REFRESH:
                continue
            d = api_get(f"/activities/{a['id']}") or a
            with db.session() as c:
                c.execute("INSERT INTO strava_cache(strava_id, fetched_at, start_utc, sport_type, payload) VALUES (?,?,?,?,?) "
                          "ON CONFLICT(strava_id) DO UPDATE SET fetched_at=excluded.fetched_at, payload=excluded.payload",
                          (a["id"], now.isoformat(), a.get("start_date"), a.get("sport_type"), db.pack(_subset(d))))
        with db.session() as c:
            g = c.execute("SELECT MAX(fetched_at) FROM strava_gear_cache").fetchone()[0]
        if not g or now - datetime.fromisoformat(g) > DETAIL_REFRESH:
            athlete = api_get("/athlete") or {}
            with db.session() as c:
                c.execute("DELETE FROM strava_gear_cache")
                for kind, items in (("bike", athlete.get("bikes") or []), ("shoe", athlete.get("shoes") or [])):
                    for it in items:
                        c.execute("INSERT INTO strava_gear_cache(id, fetched_at, payload) VALUES (?,?,?)",
                                  (it["id"], now.isoformat(), db.pack({"kind": kind, "name": it.get("name"),
                                                                        "distance": it.get("distance"), "retired": it.get("retired"),
                                                                        "primary": it.get("primary")})))


sync = StravaSync()


# --------------------------------------------------------------------------- request-time enrichment

def enrichment_for(activities: list[dict[str, Any]]) -> dict[int, dict[str, Any]]:
    """Match Garmin activities to cached Strava ones by start time (±3 min)."""
    with db.session() as c:
        rows = c.execute("SELECT start_utc, payload FROM strava_cache").fetchall()
        gear = {r["id"]: db.unpack(r["payload"]) for r in c.execute("SELECT id, payload FROM strava_gear_cache")}
    if not rows:
        return {}
    cache = []
    for r in rows:
        try:
            cache.append((datetime.fromisoformat(r["start_utc"].replace("Z", "+00:00")).timestamp(), db.unpack(r["payload"])))
        except (AttributeError, ValueError):
            continue
    out: dict[int, dict[str, Any]] = {}
    for a in activities:
        su = a.get("start_utc")
        if not su:
            continue
        t = datetime.fromisoformat(su.replace("Z", "+00:00")).timestamp()
        best = min(cache, key=lambda x: abs(x[0] - t), default=None)
        if best and abs(best[0] - t) <= 180:
            p = dict(best[1])
            g = gear.get(p.get("gear_id"))
            p["gear_name"] = g.get("name") if g else None
            out[a["id"]] = p
    return out


def gear_list() -> list[dict[str, Any]]:
    with db.session() as c:
        return [{"id": r["id"], **db.unpack(r["payload"])} for r in c.execute("SELECT id, payload FROM strava_gear_cache")]


def status() -> dict[str, Any]:
    tok = load_tokens() or {}
    with db.session() as c:
        n = c.execute("SELECT COUNT(*) FROM strava_cache").fetchone()[0]
    return {"configured": config.strava_configured(), "connected": is_connected(), "athlete": tok.get("athlete"),
            "scope": tok.get("scope"), "sync": sync.state, "cached": n, "rate": rate, "redirect_uri": REDIRECT_URI}
