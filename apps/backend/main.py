import asyncio
import base64
import hashlib
import hmac
import json
import logging
import os
import re
import time
from urllib.error import URLError
from urllib.parse import urlencode
from urllib.request import urlopen
from datetime import datetime, timezone
from pathlib import Path
from threading import RLock
from typing import Any, Dict, List, Optional, Tuple
from uuid import uuid4

from fastapi import FastAPI, HTTPException, Query, Request, Response, WebSocket, WebSocketDisconnect, status
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

BASE_DIR = Path(__file__).resolve().parents[2]
FRONTEND_DIR = BASE_DIR / "apps" / "frontend"

APP_HTML_PATH = FRONTEND_DIR / "index.html"
ADMIN_HTML_PATH = FRONTEND_DIR / "admin.html"

ROLE_PEER = "peer"
ROLE_HOST = "host"
ROLE_CLIENT = "client"
ALLOWED_ROLES = {ROLE_PEER, ROLE_HOST, ROLE_CLIENT}

HOST_TRANSPORT_BROWSER = "browser"
HOST_TRANSPORT_INSTALLED = "installed_app"

STATUS_OFFLINE = "offline"
STATUS_ONLINE = "online"
STATUS_CONNECTING = "connecting"
STATUS_CONNECTED = "connected"

SESSION_COOKIE = "omni_session_id"
BROWSER_COOKIE = "omni_browser_id"

HEARTBEAT_TIMEOUT_SECONDS = 45
DISCONNECTED_SESSION_GRACE_SECONDS = 30
CLEANUP_INTERVAL_SECONDS = 10
PAIRING_SIGNAL_TIMEOUT_SECONDS = 30
VALID_PAIRING_STATES = {"signaling", "connecting", "connected", "disconnected", "failed", "closed"}

DEFAULT_STUN_SERVERS = [
    {"urls": ["stun:stun.l.google.com:19302"]},
    {"urls": ["stun:stun1.l.google.com:19302"]},
]
DEFAULT_OPENRELAY_STUN_URI = "stun:openrelay.metered.ca:80"
DEFAULT_OPENRELAY_TURN_URIS = [
    "turn:openrelay.metered.ca:80",
    "turn:openrelay.metered.ca:443",
    "turn:openrelay.metered.ca:443?transport=tcp",
]
DEFAULT_OPENRELAY_USERNAME = "openrelayproject"
DEFAULT_OPENRELAY_CREDENTIAL = "openrelayproject"
DEFAULT_METERED_CACHE_TTL_SECONDS = 300
DEFAULT_TURN_REST_TTL_SECONDS = 3600

HOST_ID_PATTERN = re.compile(r"^[A-Za-z0-9-]{8,80}$")
HOST_CODE_PATTERN = re.compile(r"^\d{6}$")

logging.basicConfig(level=os.getenv("OMNI_LOG_LEVEL", "INFO").upper())
logger = logging.getLogger("omniportal.backend")

app = FastAPI()
app.mount("/frontend", StaticFiles(directory=FRONTEND_DIR), name="frontend")

STATE_LOCK = RLock()
SESSIONS: Dict[str, Dict[str, Any]] = {}
BROWSER_HOSTS: Dict[str, Dict[str, Any]] = {}
INSTALLED_HOSTS: Dict[str, Dict[str, Any]] = {}
LIVE_CLIENT_CONNECTIONS: Dict[str, Dict[str, Any]] = {}
LIVE_BROWSER_HOST_CONNECTIONS: Dict[str, Dict[str, Any]] = {}
LIVE_INSTALLED_HOST_CONNECTIONS: Dict[str, Dict[str, Any]] = {}
PAIRINGS: Dict[str, Dict[str, Any]] = {}
CLEANUP_TASK: Optional[asyncio.Task[Any]] = None
ICE_CONFIG_CACHE: Dict[str, Any] = {
    "servers": None,
    "source": None,
    "expires_at": 0.0,
}
ICE_CACHE_LOCK = RLock()


class HostRegisterRequest(BaseModel):
    host_name: str = Field(..., min_length=1, max_length=50)


class HostV1RegisterRequest(BaseModel):
    host_id: str = Field(..., min_length=8, max_length=80)
    host_code: str = Field(..., min_length=6, max_length=6)
    display_name: str = Field(..., min_length=1, max_length=50)
    device_name: Optional[str] = Field(None, max_length=100)


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def utc_now_iso() -> str:
    return utc_now().isoformat()


def monotonic_now() -> float:
    return time.monotonic()


def iso_age_seconds(iso_value: Optional[str]) -> float:
    if not iso_value:
        return 0.0
    try:
        value = datetime.fromisoformat(iso_value)
    except ValueError:
        return 0.0
    return max(0.0, (utc_now() - value).total_seconds())


def configured_stun_servers() -> List[Dict[str, Any]]:
    raw = os.getenv("OMNI_STUN_SERVERS", "").strip()
    if not raw:
        return DEFAULT_STUN_SERVERS

    servers: List[Dict[str, Any]] = []
    for item in raw.split(","):
        url = item.strip()
        if url:
            servers.append({"urls": [url]})
    return servers or DEFAULT_STUN_SERVERS


def env_flag(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def build_ice_server(url: str, username: Optional[str] = None, credential: Optional[str] = None) -> Dict[str, Any]:
    server: Dict[str, Any] = {"urls": [url]}
    if username:
        server["username"] = username
    if credential:
        server["credential"] = credential
    return server


def parse_ice_servers_json(raw: str) -> List[Dict[str, Any]]:
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as error:
        logger.warning("Invalid OMNI_ICE_SERVERS_JSON; falling back to env-based ICE config: %s", error)
        return []

    if not isinstance(parsed, list):
        logger.warning("OMNI_ICE_SERVERS_JSON must be a JSON array; falling back to env-based ICE config")
        return []

    servers: List[Dict[str, Any]] = []
    for item in parsed:
        if not isinstance(item, dict):
            continue
        urls = item.get("urls")
        username = item.get("username")
        credential = item.get("credential")
        if isinstance(urls, str):
            urls = [urls]
        if not isinstance(urls, list):
            continue
        normalized_urls = [str(url).strip() for url in urls if str(url).strip()]
        if not normalized_urls:
            continue
        server: Dict[str, Any] = {"urls": normalized_urls}
        if isinstance(username, str) and username.strip():
            server["username"] = username.strip()
        if isinstance(credential, str) and credential.strip():
            server["credential"] = credential.strip()
        servers.append(server)
    return servers


def parse_ice_servers_payload(payload: Any) -> List[Dict[str, Any]]:
    if not isinstance(payload, list):
        return []
    return parse_ice_servers_json(json.dumps(payload))


def normalized_server_urls(server: Dict[str, Any]) -> List[str]:
    urls = server.get("urls")
    if isinstance(urls, str):
        return [urls.strip()] if urls.strip() else []
    if isinstance(urls, list):
        return [str(url).strip() for url in urls if str(url).strip()]
    return []


def is_turn_url(url: str) -> bool:
    normalized = url.strip().lower()
    return normalized.startswith("turn:") or normalized.startswith("turns:")


def direct_ice_servers(ice_servers: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    direct_servers: List[Dict[str, Any]] = []
    for server in ice_servers:
        urls = [url for url in normalized_server_urls(server) if not is_turn_url(url)]
        if not urls:
            continue
        direct_servers.append({"urls": urls})
    return direct_servers


def metered_cache_ttl_seconds() -> int:
    raw = os.getenv("OMNI_METERED_CACHE_TTL_SECONDS", "").strip()
    if not raw:
        return DEFAULT_METERED_CACHE_TTL_SECONDS
    try:
        return max(0, int(raw))
    except ValueError:
        logger.warning("Invalid OMNI_METERED_CACHE_TTL_SECONDS=%s; using default cache TTL", raw)
        return DEFAULT_METERED_CACHE_TTL_SECONDS


def configured_metered_api_ice_servers() -> List[Dict[str, Any]]:
    app_name = os.getenv("OMNI_METERED_APP_NAME", "").strip()
    credential_api_key = os.getenv("OMNI_METERED_CREDENTIAL_API_KEY", "").strip()
    if not app_name or not credential_api_key:
        return []

    ttl_seconds = metered_cache_ttl_seconds()
    now = monotonic_now()
    with ICE_CACHE_LOCK:
        cached_servers = ICE_CONFIG_CACHE.get("servers")
        cached_source = ICE_CONFIG_CACHE.get("source")
        expires_at = float(ICE_CONFIG_CACHE.get("expires_at") or 0.0)
        if cached_source == "metered_api" and isinstance(cached_servers, list) and now < expires_at:
            return [dict(server) for server in cached_servers]

    query_params = {"apiKey": credential_api_key}
    region = os.getenv("OMNI_METERED_REGION", "").strip()
    normalized_region = region.lower()
    if region and normalized_region not in {"standard", "free"}:
        query_params["region"] = region

    url = f"https://{app_name}.metered.live/api/v1/turn/credentials?{urlencode(query_params)}"
    timeout_seconds = float(os.getenv("OMNI_METERED_FETCH_TIMEOUT_SECONDS", "5").strip() or "5")
    log_context = {
        "app_name": app_name,
        "region": region or "default",
    }
    try:
        with urlopen(url, timeout=timeout_seconds) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except (URLError, TimeoutError, json.JSONDecodeError, ValueError) as error:
        logger.warning("metered_ice_fetch_failed app=%s region=%s error=%s", log_context["app_name"], log_context["region"], error)
        return []

    servers = parse_ice_servers_payload(payload)
    if not servers:
        logger.warning("metered_ice_fetch_empty app=%s region=%s", log_context["app_name"], log_context["region"])
        return []

    with ICE_CACHE_LOCK:
        ICE_CONFIG_CACHE["servers"] = [dict(server) for server in servers]
        ICE_CONFIG_CACHE["source"] = "metered_api"
        ICE_CONFIG_CACHE["expires_at"] = monotonic_now() + ttl_seconds
    logger.info("metered_ice_fetch_ok app=%s region=%s count=%s", log_context["app_name"], log_context["region"], len(servers))
    return servers


def configured_turn_servers() -> List[Dict[str, Any]]:
    raw_turn_uris = os.getenv("OMNI_TURN_URIS", "").strip()
    if not raw_turn_uris:
        return []

    username = os.getenv("OMNI_TURN_USERNAME", "").strip()
    credential = os.getenv("OMNI_TURN_CREDENTIAL", "").strip()
    if not username or not credential:
        logger.warning("OMNI_TURN_URIS is set, but OMNI_TURN_USERNAME or OMNI_TURN_CREDENTIAL is missing; skipping TURN URIs")
        return []

    servers: List[Dict[str, Any]] = []
    for item in raw_turn_uris.split(","):
        url = item.strip()
        if url:
            servers.append(build_ice_server(url, username=username, credential=credential))
    return servers


def turn_rest_ttl_seconds() -> int:
    raw = os.getenv("OMNI_TURN_REST_TTL_SECONDS", "").strip()
    if not raw:
        return DEFAULT_TURN_REST_TTL_SECONDS
    try:
        return max(60, int(raw))
    except ValueError:
        logger.warning("Invalid OMNI_TURN_REST_TTL_SECONDS=%s; using default TURN REST TTL", raw)
        return DEFAULT_TURN_REST_TTL_SECONDS


def configured_turn_rest_servers() -> List[Dict[str, Any]]:
    raw_turn_uris = os.getenv("OMNI_TURN_URIS", "").strip()
    shared_secret = os.getenv("OMNI_TURN_REST_SECRET", "").strip()
    if not raw_turn_uris or not shared_secret:
        return []

    username_suffix = os.getenv("OMNI_TURN_REST_USERNAME_PREFIX", "omniportal").strip() or "omniportal"
    expiry_timestamp = int(time.time()) + turn_rest_ttl_seconds()
    username = f"{expiry_timestamp}:{username_suffix}"
    digest = hmac.new(shared_secret.encode("utf-8"), username.encode("utf-8"), hashlib.sha1).digest()
    credential = base64.b64encode(digest).decode("utf-8")

    servers: List[Dict[str, Any]] = []
    for item in raw_turn_uris.split(","):
        url = item.strip()
        if url:
            servers.append(build_ice_server(url, username=username, credential=credential))
    return servers


def configured_openrelay_ice_servers() -> List[Dict[str, Any]]:
    stun_uri = os.getenv("OMNI_OPENRELAY_STUN_URI", DEFAULT_OPENRELAY_STUN_URI).strip() or DEFAULT_OPENRELAY_STUN_URI
    raw_turn_uris = os.getenv("OMNI_OPENRELAY_TURN_URIS", ",".join(DEFAULT_OPENRELAY_TURN_URIS)).strip()
    username = os.getenv("OMNI_OPENRELAY_USERNAME", DEFAULT_OPENRELAY_USERNAME).strip() or DEFAULT_OPENRELAY_USERNAME
    credential = os.getenv("OMNI_OPENRELAY_CREDENTIAL", DEFAULT_OPENRELAY_CREDENTIAL).strip() or DEFAULT_OPENRELAY_CREDENTIAL

    servers = [build_ice_server(stun_uri)]
    for item in raw_turn_uris.split(","):
        url = item.strip()
        if url:
            servers.append(build_ice_server(url, username=username, credential=credential))
    return servers


def configured_ice_servers() -> Tuple[List[Dict[str, Any]], str]:
    metered_servers = configured_metered_api_ice_servers()
    if metered_servers:
        return metered_servers, "metered_api"

    raw_ice_servers = os.getenv("OMNI_ICE_SERVERS_JSON", "").strip()
    if raw_ice_servers:
        ice_servers = parse_ice_servers_json(raw_ice_servers)
        if ice_servers:
            return ice_servers, "static_ice_json"

    ice_servers = configured_stun_servers()
    turn_rest_servers = configured_turn_rest_servers()
    if turn_rest_servers:
        return [*ice_servers, *turn_rest_servers], "turn_rest_env"

    turn_servers = configured_turn_servers()
    if turn_servers:
        return [*ice_servers, *turn_servers], "stun_turn_env"

    if env_flag("OMNI_USE_OPENRELAY", False):
        return configured_openrelay_ice_servers(), "openrelay_default"

    return ice_servers, "stun_only"


def normalize_host_name(host_name: str) -> str:
    value = " ".join(host_name.strip().split())
    if not value:
        raise HTTPException(status_code=400, detail="host_name is required")
    if len(value) > 50:
        raise HTTPException(status_code=400, detail="host_name must be 50 characters or fewer")
    return value


def normalize_display_name(display_name: str) -> str:
    value = " ".join(display_name.strip().split())
    if not value:
        raise HTTPException(status_code=400, detail="display_name is required")
    if len(value) > 50:
        raise HTTPException(status_code=400, detail="display_name must be 50 characters or fewer")
    return value


def normalize_device_name(device_name: Optional[str]) -> Optional[str]:
    if device_name is None:
        return None
    value = " ".join(device_name.strip().split())
    if not value:
        return None
    if len(value) > 100:
        raise HTTPException(status_code=400, detail="device_name must be 100 characters or fewer")
    return value


def normalize_host_id(host_id: str) -> str:
    value = host_id.strip()
    if not HOST_ID_PATTERN.match(value):
        raise HTTPException(status_code=400, detail="host_id must be 8-80 characters using letters, numbers, or hyphens")
    return value


def normalize_host_code(host_code: str) -> str:
    value = host_code.strip()
    if not HOST_CODE_PATTERN.match(value):
        raise HTTPException(status_code=400, detail="host_code must be exactly 6 numeric digits")
    return value


def normalize_pairing_state(state_value: str) -> str:
    value = state_value.strip().lower()
    if value not in VALID_PAIRING_STATES:
        raise HTTPException(status_code=400, detail="rtc_state is invalid")
    return value


def current_browser_id(request: Request) -> Optional[str]:
    return request.cookies.get(BROWSER_COOKIE)


def ensure_browser_id(request: Request) -> str:
    return current_browser_id(request) or uuid4().hex


def set_browser_cookie(response: Response, browser_id: str) -> None:
    response.set_cookie(BROWSER_COOKIE, browser_id, httponly=True, samesite="lax", path="/")


def set_session_cookie(response: Response, session_id: str) -> None:
    response.set_cookie(SESSION_COOKIE, session_id, httponly=True, samesite="lax", path="/")


def set_identity_cookies(response: Response, browser_id: str, session_id: str) -> None:
    set_browser_cookie(response, browser_id)
    set_session_cookie(response, session_id)


def clear_identity_cookies(response: Response) -> None:
    response.delete_cookie(BROWSER_COOKIE, path="/")
    response.delete_cookie(SESSION_COOKIE, path="/")


def browser_host_connect_id(browser_id: str) -> str:
    return f"browser-host:{browser_id}"


def installed_host_connect_id(host_id: str) -> str:
    return f"host:{host_id}"


def connect_id_for_host_record(host: Dict[str, Any]) -> str:
    if host["transport"] == HOST_TRANSPORT_INSTALLED:
        return installed_host_connect_id(host["host_id"])
    return browser_host_connect_id(host["browser_id"])


def current_session(browser_id: Optional[str]) -> Optional[Dict[str, Any]]:
    if not browser_id:
        return None
    with STATE_LOCK:
        session = SESSIONS.get(browser_id)
        return dict(session) if session else None


def generate_browser_peer_code(exclude_browser_id: Optional[str] = None) -> str:
    with STATE_LOCK:
        used_codes = {
            host.get("host_code")
            for browser_id, host in BROWSER_HOSTS.items()
            if browser_id != exclude_browser_id and host.get("host_code")
        }
        used_codes.update(host["host_code"] for host in INSTALLED_HOSTS.values())

    for _ in range(1000):
        code = f"{int.from_bytes(os.urandom(3), 'big') % 1000000:06d}"
        if code not in used_codes:
            return code
    raise HTTPException(status_code=500, detail="Could not allocate a unique browser code")


def upsert_session(browser_id: str, role: str, host_name: Optional[str] = None) -> Dict[str, Any]:
    if role not in ALLOWED_ROLES:
        raise HTTPException(status_code=400, detail="invalid role")

    with STATE_LOCK:
        now = utc_now_iso()
        session = SESSIONS.get(browser_id)
        if session is None:
            session = {
                "session_id": uuid4().hex,
                "browser_id": browser_id,
                "created_at": now,
            }
            SESSIONS[browser_id] = session
        session["role"] = role
        session["host_name"] = host_name
        session["updated_at"] = now
        session["disconnected_at"] = None
        return dict(session)


def clear_existing_host_for_browser(browser_id: str) -> None:
    with STATE_LOCK:
        BROWSER_HOSTS.pop(browser_id, None)


def register_browser_peer_state(browser_id: str, session_id: str) -> Dict[str, Any]:
    now = utc_now_iso()
    with STATE_LOCK:
        existing = BROWSER_HOSTS.get(browser_id)
        host_code = existing["host_code"] if existing and existing.get("host_code") else generate_browser_peer_code(browser_id)
        host = {
            "host_id": f"legacy-browser-{session_id}",
            "browser_id": browser_id,
            "display_name": f"Browser {host_code}",
            "host_name": f"Browser {host_code}",
            "host_code": host_code,
            "device_name": "Browser peer",
            "transport": HOST_TRANSPORT_BROWSER,
            "created_at": existing["created_at"] if existing else now,
            "updated_at": now,
            "disconnected_at": None,
            "last_online": existing["last_online"] if existing else None,
        }
        BROWSER_HOSTS[browser_id] = host
        return dict(host)


def upsert_installed_host_state(payload: HostV1RegisterRequest) -> Dict[str, Any]:
    host_id = normalize_host_id(payload.host_id)
    host_code = normalize_host_code(payload.host_code)
    display_name = normalize_display_name(payload.display_name)
    device_name = normalize_device_name(payload.device_name)
    now = utc_now_iso()

    with STATE_LOCK:
        for existing_host_id, existing in INSTALLED_HOSTS.items():
            if existing_host_id == host_id:
                continue
            if existing["host_code"] == host_code:
                raise HTTPException(status_code=409, detail="host_code is already registered to another host")

        existing = INSTALLED_HOSTS.get(host_id)
        record = {
            "host_id": host_id,
            "display_name": display_name,
            "host_code": host_code,
            "device_name": device_name,
            "transport": HOST_TRANSPORT_INSTALLED,
            "created_at": existing["created_at"] if existing else now,
            "updated_at": now,
            "disconnected_at": existing["disconnected_at"] if existing else None,
            "last_online": existing["last_online"] if existing else None,
        }
        INSTALLED_HOSTS[host_id] = record
        return dict(record)


def get_host_record_by_connect_id(connect_id: str) -> Optional[Dict[str, Any]]:
    with STATE_LOCK:
        if connect_id.startswith("host:"):
            host_id = connect_id.removeprefix("host:")
            host = INSTALLED_HOSTS.get(host_id)
            return dict(host) if host else None
        if connect_id.startswith("browser-host:"):
            browser_id = connect_id.removeprefix("browser-host:")
            host = BROWSER_HOSTS.get(browser_id)
            return dict(host) if host else None
    return None


def host_connection_for_record(host: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    with STATE_LOCK:
        if host["transport"] == HOST_TRANSPORT_INSTALLED:
            connection = LIVE_INSTALLED_HOST_CONNECTIONS.get(host["host_id"])
        else:
            connection = LIVE_CLIENT_CONNECTIONS.get(host["browser_id"])
        return dict(connection) if connection else None


def pairing_status_for_host(connect_id: str) -> Optional[str]:
    with STATE_LOCK:
        pairing = PAIRINGS.get(connect_id)
        return pairing["state"] if pairing else None


def public_host_status(host: Dict[str, Any]) -> str:
    connection = host_connection_for_record(host)
    if connection is None:
        return STATUS_OFFLINE

    pairing_state = pairing_status_for_host(connect_id_for_host_record(host))
    if pairing_state in {"connected"}:
        return STATUS_CONNECTED
    if pairing_state in {"signaling", "connecting"}:
        return STATUS_CONNECTING
    return STATUS_ONLINE


def host_payload(host: Dict[str, Any]) -> Dict[str, Any]:
    connect_id = connect_id_for_host_record(host)
    connection = host_connection_for_record(host)
    status_value = public_host_status(host)
    return {
        "host_id": host["host_id"],
        "connect_id": connect_id,
        "browser_id": connect_id,
        "display_name": host["display_name"],
        "host_name": host["display_name"],
        "host_code": host["host_code"],
        "device_name": host["device_name"],
        "transport": host["transport"],
        "created_at": host["created_at"],
        "updated_at": host["updated_at"],
        "last_online": host["last_online"],
        "online": connection is not None,
        "available": connection is not None and PAIRINGS.get(connect_id) is None,
        "paired": PAIRINGS.get(connect_id) is not None,
        "status": status_value,
    }


def connected_host_snapshot() -> List[Dict[str, Any]]:
    with STATE_LOCK:
        browser_hosts = [host_payload(host) for host in BROWSER_HOSTS.values() if LIVE_CLIENT_CONNECTIONS.get(host["browser_id"]) is not None]
        installed_hosts = [host_payload(host) for host in INSTALLED_HOSTS.values() if LIVE_INSTALLED_HOST_CONNECTIONS.get(host["host_id"]) is not None]
    hosts = browser_hosts + installed_hosts
    return sorted(hosts, key=lambda item: item["created_at"], reverse=True)


def connected_peer_snapshot() -> List[Dict[str, Any]]:
    with STATE_LOCK:
        clients: List[Dict[str, Any]] = []
        for session in SESSIONS.values():
            if session["role"] != ROLE_PEER:
                continue
            browser_id = session["browser_id"]
            live_connection = LIVE_CLIENT_CONNECTIONS.get(browser_id)
            if live_connection is None:
                continue
            pairing = PAIRINGS.get(browser_id)
            peer_display_name = None
            peer_connect_id = None
            if pairing is not None:
                peer_connect_id = pairing["host_connect_id"]
                host = get_host_record_by_connect_id(peer_connect_id)
                peer_display_name = host["display_name"] if host else None
            clients.append(
                {
                    "browser_id": browser_id,
                    "session_id": session["session_id"],
                    "peer_code": BROWSER_HOSTS.get(browser_id, {}).get("host_code"),
                    "connected_at": live_connection["connected_at"],
                    "updated_at": session["updated_at"],
                    "paired": pairing is not None,
                    "pair_id": pairing["pair_id"] if pairing else None,
                    "peer_connect_id": peer_connect_id,
                    "peer_display_name": peer_display_name,
                }
            )
    return sorted(clients, key=lambda item: item["connected_at"], reverse=True)


def active_connection_snapshot() -> List[Dict[str, Any]]:
    with STATE_LOCK:
        connections: List[Dict[str, Any]] = []
        seen_pair_ids = set()
        for pairing in PAIRINGS.values():
            pair_id = pairing["pair_id"]
            if pair_id in seen_pair_ids:
                continue
            seen_pair_ids.add(pair_id)
            host = get_host_record_by_connect_id(pairing["host_connect_id"])
            connections.append(
                {
                    "pair_id": pair_id,
                    "host_connect_id": pairing["host_connect_id"],
                    "host_display_name": host["display_name"] if host else "Unknown host",
                    "host_code": host["host_code"] if host else None,
                    "client_browser_id": pairing["client_browser_id"],
                    "state": pairing["state"],
                    "created_at": pairing["created_at"],
                    "updated_at": pairing["updated_at"],
                }
            )
    return sorted(connections, key=lambda item: item["created_at"], reverse=True)


def active_session_snapshot() -> List[Dict[str, Any]]:
    sessions: List[Dict[str, Any]] = []
    with STATE_LOCK:
        for session in SESSIONS.values():
            browser_id = session["browser_id"]
            pairing = PAIRINGS.get(browser_id)
            sessions.append(
                {
                    "session_key": f"browser:{browser_id}",
                    "role": session["role"],
                    "transport": HOST_TRANSPORT_BROWSER,
                    "display_name": BROWSER_HOSTS.get(browser_id, {}).get("display_name"),
                    "host_code": BROWSER_HOSTS.get(browser_id, {}).get("host_code"),
                    "browser_id": browser_id,
                    "updated_at": session["updated_at"],
                    "online": LIVE_CLIENT_CONNECTIONS.get(browser_id) is not None,
                    "disconnected_at": session.get("disconnected_at"),
                    "paired": pairing is not None,
                }
            )

        for host in INSTALLED_HOSTS.values():
            pairing = PAIRINGS.get(installed_host_connect_id(host["host_id"]))
            sessions.append(
                {
                    "session_key": f"host:{host['host_id']}",
                    "role": ROLE_HOST,
                    "transport": HOST_TRANSPORT_INSTALLED,
                    "display_name": host["display_name"],
                    "host_code": host["host_code"],
                    "device_name": host["device_name"],
                    "updated_at": host["updated_at"],
                    "online": LIVE_INSTALLED_HOST_CONNECTIONS.get(host["host_id"]) is not None,
                    "disconnected_at": host.get("disconnected_at"),
                    "paired": pairing is not None,
                }
            )
    return sorted(sessions, key=lambda item: item["updated_at"], reverse=True)


def list_client_visible_hosts() -> List[Dict[str, Any]]:
    return connected_host_snapshot()


def admin_overview_payload() -> Dict[str, Any]:
    hosts = connected_host_snapshot()
    clients = connected_peer_snapshot()
    connections = active_connection_snapshot()
    sessions = active_session_snapshot()
    return {
        "hosts": hosts,
        "clients": clients,
        "connections": connections,
        "sessions": sessions,
        "stats": {
            "connected_hosts": len(hosts),
            "connected_clients": len(clients),
            "active_connections": len(connections),
            "active_sessions": len(sessions),
        },
    }


def me_payload(browser_id: str) -> Dict[str, Any]:
    session = current_session(browser_id)
    if session is None or session["role"] not in ALLOWED_ROLES:
        return {"session": None}

    online = False
    host_name = None
    if session["role"] == ROLE_PEER:
        online = browser_id in LIVE_CLIENT_CONNECTIONS
        host = BROWSER_HOSTS.get(browser_id)
        if host is not None:
            host_name = host["display_name"]
    elif session["role"] == ROLE_CLIENT:
        online = browser_id in LIVE_CLIENT_CONNECTIONS
    else:
        online = browser_id in LIVE_BROWSER_HOST_CONNECTIONS
        host = BROWSER_HOSTS.get(browser_id)
        if host is not None:
            host_name = host["display_name"]

    payload = {
        "session_id": session["session_id"],
        "browser_id": browser_id,
        "role": session["role"],
        "online": online,
    }
    if host_name:
        payload["host_name"] = host_name
        payload["display_name"] = host_name
    browser_host = BROWSER_HOSTS.get(browser_id)
    if browser_host is not None:
        payload["peer_code"] = browser_host.get("host_code")
    return {"session": payload}


def pairing_payload_for_client(pairing: Dict[str, Any]) -> Dict[str, Any]:
    host = get_host_record_by_connect_id(pairing["host_connect_id"])
    return {
        "type": "pairing_started",
        "pair_id": pairing["pair_id"],
        "peer_id": pairing["host_connect_id"],
        "peer_browser_id": pairing["host_connect_id"],
        "peer_role": ROLE_PEER if host and host.get("transport") == HOST_TRANSPORT_BROWSER else ROLE_HOST,
        "peer_display_name": host["display_name"] if host else None,
    }


def pairing_payload_for_host(pairing: Dict[str, Any]) -> Dict[str, Any]:
    joining_browser = BROWSER_HOSTS.get(pairing["client_browser_id"])
    return {
        "type": "pairing_started",
        "pair_id": pairing["pair_id"],
        "peer_id": pairing["client_browser_id"],
        "peer_browser_id": pairing["client_browser_id"],
        "peer_role": ROLE_PEER,
        "peer_display_name": joining_browser["display_name"] if joining_browser else "Connected Browser",
    }


def validate_host_availability(connect_id: str) -> Tuple[bool, str]:
    host = get_host_record_by_connect_id(connect_id)
    if host is None:
        return False, "Selected browser does not exist."
    if host_connection_for_record(host) is None:
        return False, "Selected browser is offline."
    with STATE_LOCK:
        if PAIRINGS.get(connect_id) is not None:
            return False, "Selected browser is already paired."
    return True, ""


def find_host_connect_id_by_code(host_code: str) -> Optional[str]:
    normalized_code = normalize_host_code(host_code)
    with STATE_LOCK:
        for host in INSTALLED_HOSTS.values():
            if host["host_code"] == normalized_code:
                return installed_host_connect_id(host["host_id"])
        for host in BROWSER_HOSTS.values():
            if host.get("host_code") == normalized_code:
                return browser_host_connect_id(host["browser_id"])
    return None


def create_pairing(host_connect_id: str, client_browser_id: str) -> Dict[str, Any]:
    now = utc_now_iso()
    pairing = {
        "pair_id": uuid4().hex,
        "host_connect_id": host_connect_id,
        "client_browser_id": client_browser_id,
        "state": "signaling",
        "created_at": now,
        "updated_at": now,
    }
    with STATE_LOCK:
        PAIRINGS[host_connect_id] = dict(pairing)
        PAIRINGS[client_browser_id] = dict(pairing)
    logger.info(
        "pairing_created pair_id=%s host=%s client=%s",
        pairing["pair_id"],
        host_connect_id,
        client_browser_id,
    )
    return pairing


def clear_pairing_for_peer(peer_id: str) -> Optional[Dict[str, Any]]:
    with STATE_LOCK:
        pairing = PAIRINGS.get(peer_id)
        if pairing is None:
            return None
        PAIRINGS.pop(pairing["host_connect_id"], None)
        PAIRINGS.pop(pairing["client_browser_id"], None)
        pairing["updated_at"] = utc_now_iso()
        return dict(pairing)


def get_live_socket_for_peer(peer_id: str) -> Optional[WebSocket]:
    with STATE_LOCK:
        if peer_id.startswith("host:"):
            host_id = peer_id.removeprefix("host:")
            connection = LIVE_INSTALLED_HOST_CONNECTIONS.get(host_id)
        elif peer_id.startswith("browser-host:"):
            browser_id = peer_id.removeprefix("browser-host:")
            connection = LIVE_CLIENT_CONNECTIONS.get(browser_id)
        else:
            connection = LIVE_CLIENT_CONNECTIONS.get(peer_id)
        return connection["websocket"] if connection else None


def all_live_websockets() -> List[WebSocket]:
    with STATE_LOCK:
        sockets = [item["websocket"] for item in LIVE_CLIENT_CONNECTIONS.values()]
        sockets.extend(item["websocket"] for item in LIVE_INSTALLED_HOST_CONNECTIONS.values())
    return sockets


def mark_browser_connection_activity(browser_id: str, role: str) -> None:
    now_iso = utc_now_iso()
    now_monotonic = monotonic_now()
    with STATE_LOCK:
        if role in {ROLE_CLIENT, ROLE_PEER}:
            connection = LIVE_CLIENT_CONNECTIONS.get(browser_id)
        else:
            connection = LIVE_BROWSER_HOST_CONNECTIONS.get(browser_id)
        if connection is not None:
            connection["last_seen_at"] = now_iso
            connection["last_seen_monotonic"] = now_monotonic

        session = SESSIONS.get(browser_id)
        if session is not None:
            session["updated_at"] = now_iso
            session["disconnected_at"] = None

        host = BROWSER_HOSTS.get(browser_id)
        if host is not None:
            host["updated_at"] = now_iso
            host["disconnected_at"] = None
            host["last_online"] = now_iso


def mark_installed_host_activity(host_id: str) -> None:
    now_iso = utc_now_iso()
    now_monotonic = monotonic_now()
    with STATE_LOCK:
        connection = LIVE_INSTALLED_HOST_CONNECTIONS.get(host_id)
        if connection is not None:
            connection["last_seen_at"] = now_iso
            connection["last_seen_monotonic"] = now_monotonic

        host = INSTALLED_HOSTS.get(host_id)
        if host is not None:
            host["updated_at"] = now_iso
            host["disconnected_at"] = None
            host["last_online"] = now_iso


async def send_json_safe(websocket: Optional[WebSocket], payload: Dict[str, Any]) -> None:
    if websocket is None:
        return
    try:
        await websocket.send_json(payload)
    except Exception as error:
        logger.warning("websocket_send_failed payload_type=%s error=%s", payload.get("type"), error)
        return


async def close_socket_safe(websocket: Optional[WebSocket], code: int, reason: str) -> None:
    if websocket is None:
        return
    try:
        await websocket.close(code=code, reason=reason)
    except Exception as error:
        logger.warning("websocket_close_failed code=%s reason=%s error=%s", code, reason, error)
        return


async def send_hosts_snapshot() -> None:
    payload = {"type": "hosts_snapshot", "hosts": list_client_visible_hosts()}
    for websocket in all_live_websockets():
        await send_json_safe(websocket, payload)


async def broadcast_system_state() -> None:
    await send_hosts_snapshot()


async def clear_pairing_and_notify(peer_id: str, reason: str, initiator: Optional[str] = None) -> None:
    pairing = clear_pairing_for_peer(peer_id)
    if pairing is None:
        return
    logger.info(
        "pairing_cleared pair_id=%s reason=%s initiator=%s host=%s client=%s",
        pairing["pair_id"],
        reason,
        initiator,
        pairing["host_connect_id"],
        pairing["client_browser_id"],
    )

    payload = {
        "type": "pairing_cleared",
        "reason": reason,
        "pair_id": pairing["pair_id"],
        "initiator": initiator,
    }
    await send_json_safe(get_live_socket_for_peer(pairing["host_connect_id"]), payload)
    await send_json_safe(get_live_socket_for_peer(pairing["client_browser_id"]), payload)
    await broadcast_system_state()


async def mark_pairing_state(peer_id: str, state_value: str) -> None:
    normalized_state = normalize_pairing_state(state_value)
    with STATE_LOCK:
        pairing = PAIRINGS.get(peer_id)
        if pairing is None:
            return
        now = utc_now_iso()
        for participant in (pairing["host_connect_id"], pairing["client_browser_id"]):
            PAIRINGS[participant]["state"] = normalized_state
            PAIRINGS[participant]["updated_at"] = now
    logger.info("pairing_state_changed pair_id=%s peer=%s state=%s", pairing["pair_id"], peer_id, normalized_state)
    if normalized_state in {"failed", "disconnected", "closed"}:
        await clear_pairing_and_notify(peer_id, f"rtc_{normalized_state}", initiator=peer_id)
        return
    await broadcast_system_state()


async def connect_browser_websocket(browser_id: str, role: str, websocket: WebSocket) -> None:
    previous_socket = None
    now_iso = utc_now_iso()
    now_monotonic = monotonic_now()

    with STATE_LOCK:
        if role in {ROLE_CLIENT, ROLE_PEER}:
            existing = LIVE_CLIENT_CONNECTIONS.get(browser_id)
            if existing is not None:
                previous_socket = existing["websocket"]
            LIVE_CLIENT_CONNECTIONS[browser_id] = {
                "websocket": websocket,
                "role": role,
                "connected_at": now_iso,
                "last_seen_at": now_iso,
                "last_seen_monotonic": now_monotonic,
            }
        else:
            existing = LIVE_BROWSER_HOST_CONNECTIONS.get(browser_id)
            if existing is not None:
                previous_socket = existing["websocket"]
            LIVE_BROWSER_HOST_CONNECTIONS[browser_id] = {
                "websocket": websocket,
                "role": role,
                "connected_at": now_iso,
                "last_seen_at": now_iso,
                "last_seen_monotonic": now_monotonic,
            }
            host = BROWSER_HOSTS.get(browser_id)
            if host is not None:
                host["updated_at"] = now_iso
                host["disconnected_at"] = None
                host["last_online"] = now_iso

        session = SESSIONS.get(browser_id)
        if session is not None:
            session["updated_at"] = now_iso
            session["disconnected_at"] = None

    logger.info("browser_socket_connected browser_id=%s role=%s", browser_id, role)
    await close_socket_safe(previous_socket, 4000, "Superseded by a newer connection.")
    await broadcast_system_state()


async def connect_installed_host_websocket(host_id: str, websocket: WebSocket) -> None:
    previous_socket = None
    now_iso = utc_now_iso()
    now_monotonic = monotonic_now()

    with STATE_LOCK:
        existing = LIVE_INSTALLED_HOST_CONNECTIONS.get(host_id)
        if existing is not None:
            previous_socket = existing["websocket"]
        LIVE_INSTALLED_HOST_CONNECTIONS[host_id] = {
            "websocket": websocket,
            "role": ROLE_HOST,
            "connected_at": now_iso,
            "last_seen_at": now_iso,
            "last_seen_monotonic": now_monotonic,
        }
        host = INSTALLED_HOSTS.get(host_id)
        if host is not None:
            host["updated_at"] = now_iso
            host["disconnected_at"] = None
            host["last_online"] = now_iso

    logger.info("host_socket_connected host_id=%s", host_id)
    await close_socket_safe(previous_socket, 4000, "Superseded by a newer connection.")
    await broadcast_system_state()


async def expire_browser_connection(browser_id: str, reason: str, role: Optional[str] = None, websocket: Optional[WebSocket] = None) -> None:
    socket_to_close = None
    resolved_role = role
    now_iso = utc_now_iso()

    with STATE_LOCK:
        if resolved_role is None:
            if browser_id in LIVE_CLIENT_CONNECTIONS:
                resolved_role = ROLE_PEER
            elif browser_id in LIVE_BROWSER_HOST_CONNECTIONS:
                resolved_role = ROLE_HOST

        if resolved_role in {ROLE_CLIENT, ROLE_PEER}:
            existing = LIVE_CLIENT_CONNECTIONS.get(browser_id)
            if existing is None:
                return
            if websocket is not None and existing["websocket"] is not websocket:
                return
            socket_to_close = existing["websocket"]
            LIVE_CLIENT_CONNECTIONS.pop(browser_id, None)
        else:
            existing = LIVE_BROWSER_HOST_CONNECTIONS.get(browser_id)
            if existing is None:
                return
            if websocket is not None and existing["websocket"] is not websocket:
                return
            socket_to_close = existing["websocket"]
            LIVE_BROWSER_HOST_CONNECTIONS.pop(browser_id, None)
            host = BROWSER_HOSTS.get(browser_id)
            if host is not None:
                host["updated_at"] = now_iso
                host["disconnected_at"] = now_iso

        session = SESSIONS.get(browser_id)
        if session is not None:
            session["updated_at"] = now_iso
            session["disconnected_at"] = now_iso

    participant_id = browser_id
    logger.info("browser_socket_expired browser_id=%s role=%s reason=%s", browser_id, resolved_role, reason)
    await clear_pairing_and_notify(participant_id, reason, initiator=participant_id)
    await clear_pairing_and_notify(browser_host_connect_id(browser_id), reason, initiator=browser_id)
    if websocket is None:
        await close_socket_safe(socket_to_close, 4001, reason)
    await broadcast_system_state()


async def expire_installed_host_connection(host_id: str, reason: str, websocket: Optional[WebSocket] = None) -> None:
    socket_to_close = None
    now_iso = utc_now_iso()

    with STATE_LOCK:
        existing = LIVE_INSTALLED_HOST_CONNECTIONS.get(host_id)
        if existing is None:
            return
        if websocket is not None and existing["websocket"] is not websocket:
            return
        socket_to_close = existing["websocket"]
        LIVE_INSTALLED_HOST_CONNECTIONS.pop(host_id, None)
        host = INSTALLED_HOSTS.get(host_id)
        if host is not None:
            host["updated_at"] = now_iso
            host["disconnected_at"] = now_iso

    participant_id = installed_host_connect_id(host_id)
    logger.info("host_socket_expired host_id=%s reason=%s", host_id, reason)
    await clear_pairing_and_notify(participant_id, reason, initiator=participant_id)
    if websocket is None:
        await close_socket_safe(socket_to_close, 4001, reason)
    await broadcast_system_state()


async def cleanup_stale_state() -> None:
    stale_clients: List[str] = []
    stale_browser_hosts: List[str] = []
    stale_installed_hosts: List[str] = []
    stale_sessions: List[str] = []
    stale_pair_participants: List[str] = []
    now_monotonic = monotonic_now()

    with STATE_LOCK:
        for browser_id, connection in LIVE_CLIENT_CONNECTIONS.items():
            if now_monotonic - connection["last_seen_monotonic"] > HEARTBEAT_TIMEOUT_SECONDS:
                stale_clients.append(browser_id)

        for browser_id, connection in LIVE_BROWSER_HOST_CONNECTIONS.items():
            if now_monotonic - connection["last_seen_monotonic"] > HEARTBEAT_TIMEOUT_SECONDS:
                stale_browser_hosts.append(browser_id)

        for host_id, connection in LIVE_INSTALLED_HOST_CONNECTIONS.items():
            if now_monotonic - connection["last_seen_monotonic"] > HEARTBEAT_TIMEOUT_SECONDS:
                stale_installed_hosts.append(host_id)

        for browser_id, session in SESSIONS.items():
            if browser_id in LIVE_CLIENT_CONNECTIONS or browser_id in LIVE_BROWSER_HOST_CONNECTIONS:
                continue
            disconnected_at = session.get("disconnected_at")
            if disconnected_at and iso_age_seconds(disconnected_at) > DISCONNECTED_SESSION_GRACE_SECONDS:
                stale_sessions.append(browser_id)

        seen_pair_ids = set()
        for participant_id, pairing in PAIRINGS.items():
            if participant_id != pairing["host_connect_id"]:
                continue
            if pairing["pair_id"] in seen_pair_ids:
                continue
            seen_pair_ids.add(pairing["pair_id"])
            if pairing["state"] == "connected":
                continue
            if iso_age_seconds(pairing["updated_at"]) > PAIRING_SIGNAL_TIMEOUT_SECONDS:
                stale_pair_participants.append(participant_id)

    for browser_id in stale_clients:
        await expire_browser_connection(browser_id, "heartbeat_timeout", role=ROLE_CLIENT)
    for browser_id in stale_browser_hosts:
        await expire_browser_connection(browser_id, "heartbeat_timeout", role=ROLE_HOST)
    for host_id in stale_installed_hosts:
        await expire_installed_host_connection(host_id, "heartbeat_timeout")
    for participant_id in stale_pair_participants:
        await clear_pairing_and_notify(participant_id, "pairing_timeout", initiator=participant_id)

    if stale_sessions:
        with STATE_LOCK:
            for browser_id in stale_sessions:
                if PAIRINGS.get(browser_id) is not None:
                    continue
                BROWSER_HOSTS.pop(browser_id, None)
                SESSIONS.pop(browser_id, None)


async def cleanup_loop() -> None:
    while True:
        await asyncio.sleep(CLEANUP_INTERVAL_SECONDS)
        await cleanup_stale_state()


def page_html(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def serve_page(path: Path, browser_id: Optional[str] = None) -> HTMLResponse:
    response = HTMLResponse(page_html(path))
    response.headers["Cache-Control"] = "no-store"
    if browser_id:
        set_browser_cookie(response, browser_id)
    return response


@app.on_event("startup")
async def startup_event() -> None:
    global CLEANUP_TASK
    CLEANUP_TASK = asyncio.create_task(cleanup_loop())


@app.on_event("shutdown")
async def shutdown_event() -> None:
    global CLEANUP_TASK
    if CLEANUP_TASK is None:
        return
    CLEANUP_TASK.cancel()
    try:
        await CLEANUP_TASK
    except asyncio.CancelledError:
        pass
    CLEANUP_TASK = None


@app.get("/", response_class=HTMLResponse)
def root(request: Request) -> HTMLResponse:
    return serve_page(APP_HTML_PATH, browser_id=ensure_browser_id(request))


@app.get("/host", response_class=HTMLResponse)
def host_page(request: Request) -> HTMLResponse:
    return serve_page(APP_HTML_PATH, browser_id=ensure_browser_id(request))


@app.get("/client", response_class=HTMLResponse)
def client_page(request: Request) -> HTMLResponse:
    return serve_page(APP_HTML_PATH, browser_id=ensure_browser_id(request))


@app.get("/admin", response_class=HTMLResponse)
def admin_page() -> HTMLResponse:
    return serve_page(ADMIN_HTML_PATH)


@app.get("/app.js")
def legacy_app_js() -> FileResponse:
    response = FileResponse(FRONTEND_DIR / "app.js", media_type="application/javascript")
    response.headers["Cache-Control"] = "no-store"
    return response


@app.get("/status")
def get_status() -> Dict[str, Any]:
    with STATE_LOCK:
        pair_ids = {pairing["pair_id"] for pairing in PAIRINGS.values()}
        live_connections = len(LIVE_CLIENT_CONNECTIONS) + len(LIVE_BROWSER_HOST_CONNECTIONS) + len(LIVE_INSTALLED_HOST_CONNECTIONS)
        active_hosts = len(connected_host_snapshot())
    return {
        "status": "ok",
        "live_connections": live_connections,
        "active_hosts": active_hosts,
        "active_pairs": len(pair_ids),
    }


@app.get("/api/config")
def get_config() -> Dict[str, Any]:
    ice_servers, ice_source = configured_ice_servers()
    direct_servers = direct_ice_servers(ice_servers)
    return {
        "ice_servers": ice_servers,
        "direct_ice_servers": direct_servers,
        "stun_servers": ice_servers,
        "ice_source": ice_source,
    }


@app.get("/api/me")
def get_me(request: Request, response: Response) -> Dict[str, Any]:
    browser_id = ensure_browser_id(request)
    set_browser_cookie(response, browser_id)
    return me_payload(browser_id)


@app.get("/api/hosts")
def list_hosts() -> Dict[str, Any]:
    return {"hosts": list_client_visible_hosts()}


@app.get("/api/admin/overview")
def admin_overview() -> Dict[str, Any]:
    return admin_overview_payload()


@app.post("/api/host/register")
async def register_host(payload: HostRegisterRequest, request: Request, response: Response) -> Dict[str, Any]:
    raise HTTPException(
        status_code=410,
        detail="Browser hosting has been retired. Use the installed OmniPortal Host desktop app instead.",
    )


@app.post("/api/host-v1/register")
async def register_host_v1(payload: HostV1RegisterRequest) -> Dict[str, Any]:
    host = upsert_installed_host_state(payload)
    logger.info(
        "host_registered host_id=%s host_code=%s display_name=%s device_name=%s",
        host["host_id"],
        host["host_code"],
        host["display_name"],
        host["device_name"],
    )
    await broadcast_system_state()
    return {"host": host_payload(host)}


@app.post("/api/client/join")
async def join_client(request: Request, response: Response) -> Dict[str, Any]:
    browser_id = ensure_browser_id(request)
    logger.info("peer_join_requested browser_id=%s", browser_id)

    await clear_pairing_and_notify(browser_id, "role_changed", initiator=browser_id)
    await clear_pairing_and_notify(browser_host_connect_id(browser_id), "role_changed", initiator=browser_host_connect_id(browser_id))
    await expire_browser_connection(browser_id, "role_changed")

    session = upsert_session(browser_id, ROLE_PEER)
    register_browser_peer_state(browser_id, session["session_id"])
    set_identity_cookies(response, browser_id, session["session_id"])
    await broadcast_system_state()
    return {"session": session}


@app.post("/api/peer/join")
async def join_peer(request: Request, response: Response) -> Dict[str, Any]:
    return await join_client(request, response)


@app.post("/api/session/reset")
async def reset_session(request: Request, response: Response) -> Dict[str, Any]:
    browser_id = ensure_browser_id(request)
    logger.info("session_reset_requested browser_id=%s", browser_id)

    await clear_pairing_and_notify(browser_id, "session_reset", initiator=browser_id)
    await clear_pairing_and_notify(browser_host_connect_id(browser_id), "session_reset", initiator=browser_host_connect_id(browser_id))
    await expire_browser_connection(browser_id, "session_reset")
    with STATE_LOCK:
        BROWSER_HOSTS.pop(browser_id, None)
        SESSIONS.pop(browser_id, None)
    clear_identity_cookies(response)
    await broadcast_system_state()
    return {"reset": True}


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    browser_id = websocket.cookies.get(BROWSER_COOKIE)
    if not browser_id:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION, reason="Browser identity is required.")
        return

    session = current_session(browser_id)
    if session is None or session["role"] not in ALLOWED_ROLES:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION, reason="A browser session is required.")
        return

    role = session["role"]
    if role != ROLE_PEER:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION, reason="This socket is reserved for browser peer sessions.")
        return

    await websocket.accept()
    await connect_browser_websocket(browser_id, role, websocket)
    logger.info("browser_socket_accepted browser_id=%s role=%s", browser_id, role)

    session = current_session(browser_id)
    await send_json_safe(
        websocket,
        {
            "type": "welcome",
            "peer_id": browser_id,
            "browser_id": browser_id,
            "role": session["role"] if session else None,
            "session_id": session["session_id"] if session else None,
        },
    )
    await send_json_safe(websocket, {"type": "hosts_snapshot", "hosts": list_client_visible_hosts()})

    try:
        while True:
            payload = await websocket.receive_json()
            mark_browser_connection_activity(browser_id, role)
            message_type = payload.get("type")

            if message_type == "heartbeat":
                continue

            if message_type == "connect_to_host":
                connect_id = payload.get("connect_id")
                legacy_host_browser_id = payload.get("host_browser_id")
                requested_host_code = payload.get("host_code")
                if isinstance(connect_id, str):
                    connect_id = connect_id.strip()
                else:
                    connect_id = None
                if not connect_id and isinstance(legacy_host_browser_id, str):
                    connect_id = legacy_host_browser_id.strip()
                if not connect_id and isinstance(requested_host_code, str) and requested_host_code.strip():
                    try:
                        connect_id = find_host_connect_id_by_code(requested_host_code.strip())
                    except HTTPException:
                        connect_id = None
                if not isinstance(requested_host_code, str) or not requested_host_code.strip():
                    await send_json_safe(websocket, {"type": "error", "message": "A valid 6-digit browser code is required."})
                    continue
                try:
                    normalized_requested_code = normalize_host_code(requested_host_code.strip())
                except HTTPException:
                    await send_json_safe(websocket, {"type": "error", "message": "A valid 6-digit browser code is required."})
                    continue
                if not isinstance(connect_id, str) or not connect_id:
                    logger.info("pairing_rejected_no_host browser_id=%s host_code=%s", browser_id, normalized_requested_code)
                    await send_json_safe(websocket, {"type": "error", "message": "No online browser was found for that code."})
                    continue
                if connect_id == browser_host_connect_id(browser_id):
                    await send_json_safe(websocket, {"type": "error", "message": "You cannot connect to your own code."})
                    continue

                await clear_pairing_and_notify(browser_id, "replaced_by_new_pair", initiator=browser_id)
                is_available, error_message = validate_host_availability(connect_id)
                if not is_available:
                    logger.info(
                        "pairing_rejected_unavailable browser_id=%s host=%s host_code=%s reason=%s",
                        browser_id,
                        connect_id,
                        normalized_requested_code,
                        error_message,
                    )
                    await send_json_safe(websocket, {"type": "error", "message": error_message})
                    await send_json_safe(websocket, {"type": "hosts_snapshot", "hosts": list_client_visible_hosts()})
                    continue

                host = get_host_record_by_connect_id(connect_id)
                if host is None:
                    logger.info("pairing_rejected_missing_host browser_id=%s host=%s", browser_id, connect_id)
                    await send_json_safe(websocket, {"type": "error", "message": "Selected browser does not exist."})
                    continue

                if host.get("host_code") != normalized_requested_code:
                    logger.info(
                        "pairing_rejected_code_mismatch browser_id=%s host=%s requested=%s actual=%s",
                        browser_id,
                        connect_id,
                        normalized_requested_code,
                        host.get("host_code"),
                    )
                    await send_json_safe(websocket, {"type": "error", "message": "That code did not match the selected browser."})
                    continue

                pairing = create_pairing(connect_id, browser_id)
                host_socket = get_live_socket_for_peer(connect_id)
                if host_socket is None:
                    logger.info("pairing_rejected_host_offline browser_id=%s host=%s", browser_id, connect_id)
                    await clear_pairing_and_notify(browser_id, "host_went_offline", initiator=connect_id)
                    await send_json_safe(websocket, {"type": "error", "message": "Selected browser went offline."})
                    continue

                client_payload = pairing_payload_for_client(pairing)
                client_payload["initiator"] = True
                host_payload_data = pairing_payload_for_host(pairing)
                host_payload_data["initiator"] = False

                await send_json_safe(websocket, client_payload)
                await send_json_safe(host_socket, host_payload_data)
                await broadcast_system_state()
                continue

            if message_type == "leave_pair":
                participant_id = browser_id if PAIRINGS.get(browser_id) is not None else browser_host_connect_id(browser_id)
                await clear_pairing_and_notify(participant_id, "left_by_user", initiator=participant_id)
                continue

            if message_type == "rtc_state":
                state_value = payload.get("state")
                if not isinstance(state_value, str) or not state_value:
                    await send_json_safe(websocket, {"type": "error", "message": "A valid RTC state is required."})
                    continue
                participant_id = browser_id if PAIRINGS.get(browser_id) is not None else browser_host_connect_id(browser_id)
                try:
                    await mark_pairing_state(participant_id, state_value)
                except HTTPException as error:
                    await send_json_safe(websocket, {"type": "error", "message": error.detail})
                continue

            if message_type == "signal":
                signal = payload.get("signal")
                target_peer_id = payload.get("target_peer_id")
                if not isinstance(signal, dict):
                    await send_json_safe(websocket, {"type": "error", "message": "Signal payload is required."})
                    continue
                if not isinstance(target_peer_id, str) or not target_peer_id:
                    await send_json_safe(websocket, {"type": "error", "message": "Signal target is required."})
                    continue

                participant_id = browser_id if PAIRINGS.get(browser_id) is not None else browser_host_connect_id(browser_id)
                with STATE_LOCK:
                    pairing = PAIRINGS.get(participant_id)
                if pairing is None:
                    await send_json_safe(websocket, {"type": "error", "message": "No active peer is available for signaling."})
                    continue

                expected_peer_id = pairing["host_connect_id"] if participant_id == pairing["client_browser_id"] else pairing["client_browser_id"]
                if expected_peer_id != target_peer_id:
                    await send_json_safe(websocket, {"type": "error", "message": "Signal target is not the current peer."})
                    continue

                target_socket = get_live_socket_for_peer(target_peer_id)
                if target_socket is None:
                    await clear_pairing_and_notify(participant_id, "peer_disconnected", initiator=target_peer_id)
                    continue

                await send_json_safe(
                    target_socket,
                    {
                        "type": "signal",
                        "from_peer_id": participant_id,
                        "from_browser_id": participant_id,
                        "signal": signal,
                    },
                )
                logger.info("signal_relayed source=%s target=%s kind=%s", participant_id, target_peer_id, signal.get("kind"))
                continue

            await send_json_safe(websocket, {"type": "error", "message": "Unsupported message type."})
    except WebSocketDisconnect:
        logger.info("browser_socket_disconnected browser_id=%s role=%s", browser_id, role)
    except Exception as error:
        logger.exception("browser_socket_failed browser_id=%s role=%s error=%s", browser_id, role, error)
    finally:
        await expire_browser_connection(browser_id, "peer_disconnected", role=role, websocket=websocket)


@app.websocket("/ws/host-v1")
async def host_v1_websocket_endpoint(websocket: WebSocket, host_id: str = Query(...)) -> None:
    normalized_host_id = normalize_host_id(host_id)
    with STATE_LOCK:
        host = INSTALLED_HOSTS.get(normalized_host_id)
    if host is None:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION, reason="Host must register before opening the socket.")
        return

    await websocket.accept()
    await connect_installed_host_websocket(normalized_host_id, websocket)
    logger.info("host_socket_accepted host_id=%s", normalized_host_id)
    await send_json_safe(
        websocket,
        {
            "type": "welcome",
            "peer_id": installed_host_connect_id(normalized_host_id),
            "role": ROLE_HOST,
            "host_id": normalized_host_id,
            "host_code": host["host_code"],
        },
    )

    try:
        while True:
            payload = await websocket.receive_json()
            mark_installed_host_activity(normalized_host_id)
            message_type = payload.get("type")

            if message_type == "heartbeat":
                continue

            if message_type == "leave_pair":
                participant_id = installed_host_connect_id(normalized_host_id)
                await clear_pairing_and_notify(participant_id, "left_by_user", initiator=participant_id)
                continue

            if message_type == "rtc_state":
                state_value = payload.get("state")
                if not isinstance(state_value, str) or not state_value:
                    await send_json_safe(websocket, {"type": "error", "message": "A valid RTC state is required."})
                    continue
                try:
                    await mark_pairing_state(installed_host_connect_id(normalized_host_id), state_value)
                except HTTPException as error:
                    await send_json_safe(websocket, {"type": "error", "message": error.detail})
                continue

            if message_type == "signal":
                signal = payload.get("signal")
                target_peer_id = payload.get("target_peer_id")
                if not isinstance(signal, dict):
                    await send_json_safe(websocket, {"type": "error", "message": "Signal payload is required."})
                    continue
                if not isinstance(target_peer_id, str) or not target_peer_id:
                    await send_json_safe(websocket, {"type": "error", "message": "Signal target is required."})
                    continue

                participant_id = installed_host_connect_id(normalized_host_id)
                with STATE_LOCK:
                    pairing = PAIRINGS.get(participant_id)
                if pairing is None or pairing["client_browser_id"] != target_peer_id:
                    await send_json_safe(websocket, {"type": "error", "message": "Signal target is not the current peer."})
                    continue

                target_socket = get_live_socket_for_peer(target_peer_id)
                if target_socket is None:
                    await clear_pairing_and_notify(participant_id, "peer_disconnected", initiator=target_peer_id)
                    continue

                await send_json_safe(
                    target_socket,
                    {
                        "type": "signal",
                        "from_peer_id": participant_id,
                        "from_browser_id": participant_id,
                        "signal": signal,
                    },
                )
                logger.info("signal_relayed source=%s target=%s kind=%s", participant_id, target_peer_id, signal.get("kind"))
                continue

            await send_json_safe(websocket, {"type": "error", "message": "Unsupported message type."})
    except WebSocketDisconnect:
        logger.info("host_socket_disconnected host_id=%s", normalized_host_id)
    except Exception as error:
        logger.exception("host_socket_failed host_id=%s error=%s", normalized_host_id, error)
    finally:
        await expire_installed_host_connection(normalized_host_id, "peer_disconnected", websocket=websocket)
