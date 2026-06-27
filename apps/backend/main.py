import asyncio
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock
from typing import Any, Dict, List, Optional, Tuple
from uuid import uuid4

from fastapi import FastAPI, HTTPException, Request, Response, WebSocket, WebSocketDisconnect, status
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

BASE_DIR = Path(__file__).resolve().parents[2]
FRONTEND_DIR = BASE_DIR / "apps" / "frontend"

LANDING_HTML_PATH = FRONTEND_DIR / "index.html"
HOST_HTML_PATH = FRONTEND_DIR / "host.html"
CLIENT_HTML_PATH = FRONTEND_DIR / "client.html"
ADMIN_HTML_PATH = FRONTEND_DIR / "admin.html"

ROLE_HOST = "host"
ROLE_CLIENT = "client"
ALLOWED_ROLES = {ROLE_HOST, ROLE_CLIENT}

SESSION_COOKIE = "omni_session_id"
BROWSER_COOKIE = "omni_browser_id"

HEARTBEAT_TIMEOUT_SECONDS = 45
DISCONNECTED_SESSION_GRACE_SECONDS = 30
CLEANUP_INTERVAL_SECONDS = 10

DEFAULT_STUN_SERVERS = [
    {"urls": ["stun:stun.l.google.com:19302"]},
    {"urls": ["stun:stun1.l.google.com:19302"]},
]

app = FastAPI()
app.mount("/frontend", StaticFiles(directory=FRONTEND_DIR), name="frontend")

STATE_LOCK = Lock()
SESSIONS: Dict[str, Dict[str, Any]] = {}
ACTIVE_HOSTS: Dict[str, Dict[str, Any]] = {}
LIVE_CONNECTIONS: Dict[str, Dict[str, Any]] = {}
PAIRINGS: Dict[str, Dict[str, Any]] = {}
CLEANUP_TASK: Optional[asyncio.Task[Any]] = None


class HostRegisterRequest(BaseModel):
    host_name: str = Field(..., min_length=1, max_length=50)


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


def normalize_host_name(host_name: str) -> str:
    value = " ".join(host_name.strip().split())
    if not value:
        raise HTTPException(status_code=400, detail="host_name is required")
    if len(value) > 50:
        raise HTTPException(status_code=400, detail="host_name must be 50 characters or fewer")
    return value


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


def current_session(browser_id: Optional[str]) -> Optional[Dict[str, Any]]:
    if not browser_id:
        return None
    with STATE_LOCK:
        session = SESSIONS.get(browser_id)
        return dict(session) if session else None


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
        ACTIVE_HOSTS.pop(browser_id, None)


def register_host_state(browser_id: str, host_name: str, session_id: str) -> Dict[str, Any]:
    now = utc_now_iso()
    with STATE_LOCK:
        existing = ACTIVE_HOSTS.get(browser_id)
        host = {
            "host_id": session_id,
            "session_id": session_id,
            "browser_id": browser_id,
            "host_name": host_name,
            "created_at": existing["created_at"] if existing else now,
            "updated_at": now,
            "disconnected_at": None,
        }
        ACTIVE_HOSTS[browser_id] = host
        return dict(host)


def get_live_socket(browser_id: str) -> Optional[WebSocket]:
    with STATE_LOCK:
        connection = LIVE_CONNECTIONS.get(browser_id)
        return connection["websocket"] if connection else None


def get_pairing(browser_id: str) -> Optional[Dict[str, Any]]:
    with STATE_LOCK:
        pairing = PAIRINGS.get(browser_id)
        return dict(pairing) if pairing else None


def mark_connection_activity(browser_id: str) -> None:
    now_iso = utc_now_iso()
    now_monotonic = monotonic_now()
    with STATE_LOCK:
        connection = LIVE_CONNECTIONS.get(browser_id)
        if connection is not None:
            connection["last_seen_at"] = now_iso
            connection["last_seen_monotonic"] = now_monotonic
        session = SESSIONS.get(browser_id)
        if session is not None:
            session["updated_at"] = now_iso
            session["disconnected_at"] = None
        host = ACTIVE_HOSTS.get(browser_id)
        if host is not None:
            host["updated_at"] = now_iso
            host["disconnected_at"] = None


def me_payload(browser_id: str) -> Dict[str, Any]:
    session = current_session(browser_id)
    if session is None or session["role"] not in ALLOWED_ROLES:
        return {"session": None}

    payload = {
        "session_id": session["session_id"],
        "browser_id": browser_id,
        "role": session["role"],
        "online": browser_id in LIVE_CONNECTIONS,
    }
    if session["role"] == ROLE_HOST:
        host = ACTIVE_HOSTS.get(browser_id)
        if host is None:
            return {"session": None}
        payload["host_name"] = host["host_name"]
    return {"session": payload}


def host_payload(host: Dict[str, Any]) -> Dict[str, Any]:
    browser_id = host["browser_id"]
    live_connection = LIVE_CONNECTIONS.get(browser_id)
    pairing = PAIRINGS.get(browser_id)
    return {
        "host_id": host["host_id"],
        "browser_id": browser_id,
        "host_name": host["host_name"],
        "created_at": host["created_at"],
        "updated_at": host["updated_at"],
        "online": live_connection is not None,
        "available": live_connection is not None and pairing is None,
        "paired": pairing is not None,
    }


def connected_host_snapshot() -> List[Dict[str, Any]]:
    with STATE_LOCK:
        hosts = [host_payload(host) for host in ACTIVE_HOSTS.values() if LIVE_CONNECTIONS.get(host["browser_id"]) is not None]
    return sorted(hosts, key=lambda item: item["created_at"], reverse=True)


def connected_client_snapshot() -> List[Dict[str, Any]]:
    with STATE_LOCK:
        clients: List[Dict[str, Any]] = []
        for session in SESSIONS.values():
            if session["role"] != ROLE_CLIENT:
                continue
            browser_id = session["browser_id"]
            live_connection = LIVE_CONNECTIONS.get(browser_id)
            if live_connection is None:
                continue
            pairing = PAIRINGS.get(browser_id)
            host_name = None
            pair_id = None
            peer_browser_id = None
            if pairing is not None:
                pair_id = pairing["pair_id"]
                peer_browser_id = pairing["host_browser_id"]
                host = ACTIVE_HOSTS.get(peer_browser_id)
                host_name = host["host_name"] if host else None
            clients.append(
                {
                    "browser_id": browser_id,
                    "session_id": session["session_id"],
                    "connected_at": live_connection["connected_at"],
                    "updated_at": session["updated_at"],
                    "paired": pairing is not None,
                    "pair_id": pair_id,
                    "peer_browser_id": peer_browser_id,
                    "peer_host_name": host_name,
                }
            )
    return sorted(clients, key=lambda item: item["connected_at"], reverse=True)


def active_connection_snapshot() -> List[Dict[str, Any]]:
    with STATE_LOCK:
        connections = []
        seen_pair_ids = set()
        for pairing in PAIRINGS.values():
            pair_id = pairing["pair_id"]
            if pair_id in seen_pair_ids:
                continue
            seen_pair_ids.add(pair_id)
            host = ACTIVE_HOSTS.get(pairing["host_browser_id"])
            connections.append(
                {
                    "pair_id": pair_id,
                    "host_browser_id": pairing["host_browser_id"],
                    "host_name": host["host_name"] if host else "Unknown host",
                    "client_browser_id": pairing["client_browser_id"],
                    "state": pairing["state"],
                    "created_at": pairing["created_at"],
                    "updated_at": pairing["updated_at"],
                }
            )
    return sorted(connections, key=lambda item: item["created_at"], reverse=True)


def active_session_snapshot() -> List[Dict[str, Any]]:
    with STATE_LOCK:
        sessions = []
        for session in SESSIONS.values():
            browser_id = session["browser_id"]
            pairing = PAIRINGS.get(browser_id)
            sessions.append(
                {
                    "browser_id": browser_id,
                    "session_id": session["session_id"],
                    "role": session["role"],
                    "host_name": session.get("host_name"),
                    "updated_at": session["updated_at"],
                    "online": LIVE_CONNECTIONS.get(browser_id) is not None,
                    "disconnected_at": session.get("disconnected_at"),
                    "paired": pairing is not None,
                }
            )
    return sorted(sessions, key=lambda item: item["updated_at"], reverse=True)


def list_client_visible_hosts() -> List[Dict[str, Any]]:
    hosts = connected_host_snapshot()
    return sorted(hosts, key=lambda item: item["created_at"], reverse=True)


def admin_overview_payload() -> Dict[str, Any]:
    hosts = connected_host_snapshot()
    clients = connected_client_snapshot()
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


def get_peer_browser_id(browser_id: str) -> Optional[str]:
    pairing = get_pairing(browser_id)
    if pairing is None:
        return None
    if pairing["host_browser_id"] == browser_id:
        return pairing["client_browser_id"]
    return pairing["host_browser_id"]


def validate_host_availability(host_browser_id: str) -> Tuple[bool, str]:
    with STATE_LOCK:
        host = ACTIVE_HOSTS.get(host_browser_id)
        if host is None:
            return False, "Selected host does not exist."
        if LIVE_CONNECTIONS.get(host_browser_id) is None:
            return False, "Selected host is offline."
        if PAIRINGS.get(host_browser_id) is not None:
            return False, "Selected host is already paired."
    return True, ""


def create_pairing(host_browser_id: str, client_browser_id: str) -> Dict[str, Any]:
    now = utc_now_iso()
    pairing = {
        "pair_id": uuid4().hex,
        "host_browser_id": host_browser_id,
        "client_browser_id": client_browser_id,
        "state": "signaling",
        "created_at": now,
        "updated_at": now,
    }
    with STATE_LOCK:
        PAIRINGS[host_browser_id] = dict(pairing)
        PAIRINGS[client_browser_id] = dict(pairing)
    return pairing


def clear_pairing_for_browser(browser_id: str) -> Optional[Dict[str, Any]]:
    with STATE_LOCK:
        pairing = PAIRINGS.get(browser_id)
        if pairing is None:
            return None
        host_browser_id = pairing["host_browser_id"]
        client_browser_id = pairing["client_browser_id"]
        PAIRINGS.pop(host_browser_id, None)
        PAIRINGS.pop(client_browser_id, None)
        pairing["updated_at"] = utc_now_iso()
        return dict(pairing)


async def send_json_safe(websocket: Optional[WebSocket], payload: Dict[str, Any]) -> None:
    if websocket is None:
        return
    try:
        await websocket.send_json(payload)
    except Exception:
        return


async def close_socket_safe(websocket: Optional[WebSocket], code: int, reason: str) -> None:
    if websocket is None:
        return
    try:
        await websocket.close(code=code, reason=reason)
    except Exception:
        return


async def send_hosts_snapshot() -> None:
    hosts = list_client_visible_hosts()
    with STATE_LOCK:
        targets = [connection["websocket"] for connection in LIVE_CONNECTIONS.values()]
    payload = {"type": "hosts_snapshot", "hosts": hosts}
    for websocket in targets:
        await send_json_safe(websocket, payload)


async def broadcast_system_state() -> None:
    await send_hosts_snapshot()


async def clear_pairing_and_notify(browser_id: str, reason: str, initiator: Optional[str] = None) -> None:
    pairing = clear_pairing_for_browser(browser_id)
    if pairing is None:
        return

    payload = {
        "type": "pairing_cleared",
        "reason": reason,
        "pair_id": pairing["pair_id"],
        "initiator": initiator,
    }
    await send_json_safe(get_live_socket(pairing["host_browser_id"]), payload)
    await send_json_safe(get_live_socket(pairing["client_browser_id"]), payload)
    await broadcast_system_state()


async def mark_pairing_state(browser_id: str, state: str) -> None:
    with STATE_LOCK:
        pairing = PAIRINGS.get(browser_id)
        if pairing is None:
            return
        now = utc_now_iso()
        for peer_browser_id in (pairing["host_browser_id"], pairing["client_browser_id"]):
            PAIRINGS[peer_browser_id]["state"] = state
            PAIRINGS[peer_browser_id]["updated_at"] = now


async def connect_websocket(browser_id: str, websocket: WebSocket) -> None:
    previous_socket = None
    role = None
    now_iso = utc_now_iso()
    now_monotonic = monotonic_now()
    with STATE_LOCK:
        session = SESSIONS.get(browser_id)
        if session is not None:
            role = session["role"]
        existing = LIVE_CONNECTIONS.get(browser_id)
        if existing is not None:
            previous_socket = existing["websocket"]
        LIVE_CONNECTIONS[browser_id] = {
            "websocket": websocket,
            "role": role,
            "connected_at": now_iso,
            "last_seen_at": now_iso,
            "last_seen_monotonic": now_monotonic,
        }
        if session is not None:
            session["updated_at"] = now_iso
            session["disconnected_at"] = None
        host = ACTIVE_HOSTS.get(browser_id)
        if host is not None:
            host["updated_at"] = now_iso
            host["disconnected_at"] = None
    await close_socket_safe(previous_socket, 4000, "Superseded by a newer connection.")
    await broadcast_system_state()


async def expire_browser_connection(browser_id: str, reason: str, websocket: Optional[WebSocket] = None) -> None:
    socket_to_close = None
    now_iso = utc_now_iso()
    with STATE_LOCK:
        existing = LIVE_CONNECTIONS.get(browser_id)
        if existing is None:
            return
        if websocket is not None and existing["websocket"] is not websocket:
            return
        socket_to_close = existing["websocket"]
        LIVE_CONNECTIONS.pop(browser_id, None)
        session = SESSIONS.get(browser_id)
        if session is not None:
            session["updated_at"] = now_iso
            session["disconnected_at"] = now_iso
        host = ACTIVE_HOSTS.get(browser_id)
        if host is not None:
            host["updated_at"] = now_iso
            host["disconnected_at"] = now_iso

    await clear_pairing_and_notify(browser_id, reason, initiator=browser_id)
    if websocket is None:
        await close_socket_safe(socket_to_close, 4001, reason)
    await broadcast_system_state()


async def disconnect_websocket(browser_id: str, websocket: WebSocket) -> None:
    await expire_browser_connection(browser_id, "peer_disconnected", websocket=websocket)


async def cleanup_stale_state() -> None:
    stale_connections: List[str] = []
    stale_sessions: List[str] = []
    now_monotonic = monotonic_now()

    with STATE_LOCK:
        for browser_id, connection in LIVE_CONNECTIONS.items():
            age = now_monotonic - connection["last_seen_monotonic"]
            if age > HEARTBEAT_TIMEOUT_SECONDS:
                stale_connections.append(browser_id)

        for browser_id, session in SESSIONS.items():
            if LIVE_CONNECTIONS.get(browser_id) is not None:
                continue
            disconnected_at = session.get("disconnected_at")
            if disconnected_at and iso_age_seconds(disconnected_at) > DISCONNECTED_SESSION_GRACE_SECONDS:
                stale_sessions.append(browser_id)

    for browser_id in stale_connections:
        await expire_browser_connection(browser_id, "heartbeat_timeout")

    if stale_sessions:
        with STATE_LOCK:
            for browser_id in stale_sessions:
                pairing = PAIRINGS.get(browser_id)
                if pairing is not None:
                    continue
                ACTIVE_HOSTS.pop(browser_id, None)
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
    return serve_page(LANDING_HTML_PATH, browser_id=ensure_browser_id(request))


@app.get("/host", response_class=HTMLResponse)
def host_page(request: Request) -> HTMLResponse:
    return serve_page(HOST_HTML_PATH, browser_id=ensure_browser_id(request))


@app.get("/client", response_class=HTMLResponse)
def client_page(request: Request) -> HTMLResponse:
    return serve_page(CLIENT_HTML_PATH, browser_id=ensure_browser_id(request))


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
        return {
            "status": "ok",
            "live_connections": len(LIVE_CONNECTIONS),
            "active_hosts": len(ACTIVE_HOSTS),
            "active_pairs": len(pair_ids),
        }


@app.get("/api/config")
def get_config() -> Dict[str, Any]:
    return {"stun_servers": configured_stun_servers()}


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
    browser_id = ensure_browser_id(request)
    host_name = normalize_host_name(payload.host_name)

    await clear_pairing_and_notify(browser_id, "role_changed", initiator=browser_id)
    session = upsert_session(browser_id, ROLE_HOST, host_name)
    host = register_host_state(browser_id, host_name, session["session_id"])
    set_identity_cookies(response, browser_id, session["session_id"])
    await broadcast_system_state()
    return {"session": session, "host": host_payload(host)}


@app.post("/api/client/join")
async def join_client(request: Request, response: Response) -> Dict[str, Any]:
    browser_id = ensure_browser_id(request)

    await clear_pairing_and_notify(browser_id, "role_changed", initiator=browser_id)
    clear_existing_host_for_browser(browser_id)
    session = upsert_session(browser_id, ROLE_CLIENT)
    set_identity_cookies(response, browser_id, session["session_id"])
    await broadcast_system_state()
    return {"session": session}


@app.post("/api/session/reset")
async def reset_session(request: Request, response: Response) -> Dict[str, Any]:
    browser_id = ensure_browser_id(request)

    await clear_pairing_and_notify(browser_id, "session_reset", initiator=browser_id)
    await expire_browser_connection(browser_id, "session_reset")
    with STATE_LOCK:
        ACTIVE_HOSTS.pop(browser_id, None)
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
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION, reason="A host or client session is required.")
        return

    await websocket.accept()
    await connect_websocket(browser_id, websocket)

    session = current_session(browser_id)
    await send_json_safe(
        websocket,
        {
            "type": "welcome",
            "browser_id": browser_id,
            "role": session["role"] if session else None,
            "session_id": session["session_id"] if session else None,
        },
    )
    await send_json_safe(websocket, {"type": "hosts_snapshot", "hosts": list_client_visible_hosts()})

    try:
        while True:
            payload = await websocket.receive_json()
            mark_connection_activity(browser_id)
            message_type = payload.get("type")
            session = current_session(browser_id)
            role = session["role"] if session else None

            if message_type == "heartbeat":
                continue

            if message_type == "connect_to_host":
                if role != ROLE_CLIENT:
                    await send_json_safe(websocket, {"type": "error", "message": "Only clients can connect to hosts."})
                    continue

                host_browser_id = payload.get("host_browser_id")
                if not isinstance(host_browser_id, str) or not host_browser_id:
                    await send_json_safe(websocket, {"type": "error", "message": "A valid host identifier is required."})
                    continue
                if host_browser_id == browser_id:
                    await send_json_safe(websocket, {"type": "error", "message": "A client cannot connect to itself."})
                    continue

                await clear_pairing_and_notify(browser_id, "replaced_by_new_pair", initiator=browser_id)
                is_available, error_message = validate_host_availability(host_browser_id)
                if not is_available:
                    await send_json_safe(websocket, {"type": "error", "message": error_message})
                    await send_json_safe(websocket, {"type": "hosts_snapshot", "hosts": list_client_visible_hosts()})
                    continue

                pairing = create_pairing(host_browser_id, browser_id)
                host_socket = get_live_socket(host_browser_id)
                if host_socket is None:
                    await clear_pairing_and_notify(browser_id, "host_went_offline", initiator=host_browser_id)
                    await send_json_safe(websocket, {"type": "error", "message": "Selected host went offline."})
                    continue

                await send_json_safe(
                    websocket,
                    {
                        "type": "pairing_started",
                        "pair_id": pairing["pair_id"],
                        "peer_browser_id": host_browser_id,
                        "peer_role": ROLE_HOST,
                        "initiator": True,
                    },
                )
                await send_json_safe(
                    host_socket,
                    {
                        "type": "pairing_started",
                        "pair_id": pairing["pair_id"],
                        "peer_browser_id": browser_id,
                        "peer_role": ROLE_CLIENT,
                        "initiator": False,
                    },
                )
                await broadcast_system_state()
                continue

            if message_type == "leave_pair":
                await clear_pairing_and_notify(browser_id, "left_by_user", initiator=browser_id)
                continue

            if message_type == "rtc_state":
                state_value = payload.get("state")
                if not isinstance(state_value, str) or not state_value:
                    await send_json_safe(websocket, {"type": "error", "message": "A valid RTC state is required."})
                    continue
                await mark_pairing_state(browser_id, state_value)
                continue

            if message_type == "signal":
                signal = payload.get("signal")
                target_browser_id = payload.get("target_browser_id")
                if not isinstance(signal, dict):
                    await send_json_safe(websocket, {"type": "error", "message": "Signal payload is required."})
                    continue
                if not isinstance(target_browser_id, str) or not target_browser_id:
                    await send_json_safe(websocket, {"type": "error", "message": "Signal target is required."})
                    continue

                peer_browser_id = get_peer_browser_id(browser_id)
                if peer_browser_id is None or peer_browser_id != target_browser_id:
                    await send_json_safe(websocket, {"type": "error", "message": "Signal target is not the current peer."})
                    continue

                target_socket = get_live_socket(target_browser_id)
                if target_socket is None:
                    await clear_pairing_and_notify(browser_id, "peer_disconnected", initiator=target_browser_id)
                    continue

                await send_json_safe(
                    target_socket,
                    {
                        "type": "signal",
                        "from_browser_id": browser_id,
                        "signal": signal,
                    },
                )
                continue

            await send_json_safe(websocket, {"type": "error", "message": "Unsupported message type."})
    except WebSocketDisconnect:
        pass
    finally:
        await disconnect_websocket(browser_id, websocket)
