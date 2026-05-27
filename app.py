import os
import secrets
import time
from typing import Dict, Optional, Set, Tuple

import eventlet

eventlet.monkey_patch()  # Required for Flask-SocketIO + eventlet in production.

from dotenv import load_dotenv
from flask import Flask, abort, jsonify, make_response, redirect, render_template, request, session, url_for
from flask_socketio import SocketIO, disconnect, emit, join_room, leave_room
from werkzeug.middleware.proxy_fix import ProxyFix

from utils.security import (
    LoginLockout,
    SlidingWindowRateLimiter,
    make_csrf_token,
    must_getenv,
    no_store_headers,
    security_headers,
    stable_anonymous_client_key,
    verify_password_hash,
)


load_dotenv()


def create_app() -> Tuple[Flask, SocketIO]:
    app = Flask(__name__, static_folder="static", template_folder="templates")

    # Render/Proxies: honor X-Forwarded-* so URL generation + HTTPS redirect works.
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1, x_port=1)

    # REQUIRED: used to sign session cookies.
    app.secret_key = must_getenv("SECRET_KEY")

    # Session cookie hardening.
    # SECURITY: Secure cookies (sent only over HTTPS) are required in production.
    # For local HTTP testing, set SESSION_COOKIE_SECURE=False in your .env.
    session_cookie_secure = os.getenv("SESSION_COOKIE_SECURE", "true").strip().lower()
    session_cookie_secure_bool = session_cookie_secure in ("1", "true", "yes", "on")
    app.config.update(
        SESSION_COOKIE_HTTPONLY=True,
        # Lax works better on mobile after login redirect while staying same-site safe.
        SESSION_COOKIE_SAMESITE="Lax",
        SESSION_COOKIE_SECURE=session_cookie_secure_bool,
        PERMANENT_SESSION_LIFETIME=int(os.getenv("SESSION_IDLE_TIMEOUT_SECONDS", "900")),
    )

    # Flask-SocketIO (signaling only; media stays P2P via WebRTC).
    socketio = SocketIO(
        app,
        cors_allowed_origins=[],  # No cross-origin allowed.
        async_mode="eventlet",
        ping_interval=25,
        ping_timeout=60,
        cookie=None,  # rely on Flask session cookie
        logger=False,  # SECURITY: do not log signaling details
        engineio_logger=False,
    )

    return app, socketio


app, socketio = create_app()

# Two trusted users only. Passwords are stored as hashes in environment variables.
USER1_HASH = must_getenv("PASSWORD_USER1_HASH")
USER2_HASH = must_getenv("PASSWORD_USER2_HASH")

RATE_LIMIT_PER_MINUTE = int(os.getenv("RATE_LIMIT_PER_MINUTE", "60"))
rate_limiter = SlidingWindowRateLimiter(RATE_LIMIT_PER_MINUTE)
lockout = LoginLockout(max_fails=8, lock_seconds=300)

# Single private room token (not enumerable; only rendered after authentication).
ROOM_TOKEN = secrets.token_urlsafe(24)
ROOM_NAME = "private_room"  # server-side constant; not exposed

# Connection tracking (in-memory only; auto-destroyed when users disconnect).
connected_sids: Set[str] = set()
sid_to_user: Dict[str, str] = {}
user_to_sid: Dict[str, str] = {}


def _client_key() -> str:
    # Use the proxy-provided remote address; do NOT log it.
    ip = request.headers.get("X-Forwarded-For", request.remote_addr or "")
    # If X-Forwarded-For contains multiple, take the first (client IP).
    ip = ip.split(",")[0].strip()
    ua = request.headers.get("User-Agent", "")
    return stable_anonymous_client_key(app.secret_key, ip, ua)


def _is_https_request() -> bool:
    # ProxyFix makes request.scheme reflect X-Forwarded-Proto.
    return request.scheme == "https"


def _require_https():
    # SECURITY: Force HTTPS. On Render, external traffic is HTTPS; internal may be HTTP.
    # IMPORTANT: Default to development to avoid HTTPS redirects during local HTTP testing.
    # Render sets FLASK_ENV=production in render.yaml.
    if not _is_https_request() and os.getenv("FLASK_ENV", "development") == "production":
        url = request.url.replace("http://", "https://", 1)
        return redirect(url, code=301)
    return None


def _session_is_authenticated() -> bool:
    return session.get("auth") is True and session.get("user_id") in ("user1", "user2")


def _touch_session():
    # SECURITY: server-side idle timeout enforcement uses timestamps stored in the signed session cookie.
    session["last_seen"] = int(time.time())
    session.permanent = True


@app.before_request
def before_request():
    r = _require_https()
    if r is not None:
        return r

    # Idle session expiry (server-side check).
    if session.get("auth"):
        try:
            idle = int(os.getenv("SESSION_IDLE_TIMEOUT_SECONDS", "900"))
        except Exception:
            idle = 900
        last_seen = session.get("last_seen")
        now_ts = int(time.time())
        if isinstance(last_seen, int) and now_ts - last_seen > idle:
            session.clear()
        else:
            _touch_session()


@app.after_request
def after_request(resp):
    # Apply strict security headers to all responses.
    nonce = getattr(request, "_csp_nonce", None)
    if nonce:
        for k, v in security_headers(nonce).items():
            resp.headers.setdefault(k, v)
    else:
        # Some endpoints may not render templates; still add core headers without CSP nonce.
        for k, v in security_headers(secrets.token_urlsafe(12)).items():
            if k == "Content-Security-Policy":
                continue
            resp.headers.setdefault(k, v)

    # Disable caching on authenticated pages.
    if _session_is_authenticated():
        for k, v in no_store_headers().items():
            resp.headers[k] = v
    return resp


@app.get("/")
def root():
    if _session_is_authenticated():
        return redirect(url_for("call"))
    return redirect(url_for("login"))


@app.get("/login")
def login():
    # New CSRF token each time login page is rendered.
    session["csrf"] = make_csrf_token()
    nonce = secrets.token_urlsafe(16)
    request._csp_nonce = nonce
    return render_template("login.html", csrf=session["csrf"], nonce=nonce, error=None)


@app.post("/login")
def login_post():
    # Rate limit login attempts (privacy-preserving client key).
    key = _client_key()
    if not rate_limiter.allow("login:" + key):
        abort(429)
    if lockout.is_locked(key):
        abort(429)

    csrf = request.form.get("csrf", "")
    if not csrf or csrf != session.get("csrf"):
        abort(400)

    password = (request.form.get("password") or "").strip()
    if len(password) < 8 or len(password) > 200:
        lockout.record_failure(key)
        return _login_error("Invalid password.")

    # Server-side verification only. No password is ever sent to the frontend JS.
    user_id: Optional[str] = None
    if verify_password_hash(USER1_HASH, password):
        user_id = "user1"
    elif verify_password_hash(USER2_HASH, password):
        user_id = "user2"

    if not user_id:
        lockout.record_failure(key)
        return _login_error("Invalid password.")

    lockout.record_success(key)
    session.clear()
    session["auth"] = True
    session["user_id"] = user_id
    session["csrf"] = make_csrf_token()
    _touch_session()
    return redirect(url_for("call"))


def _login_error(msg: str):
    session["csrf"] = make_csrf_token()
    nonce = secrets.token_urlsafe(16)
    request._csp_nonce = nonce
    resp = make_response(render_template("login.html", csrf=session["csrf"], nonce=nonce, error=msg))
    return resp


@app.post("/logout")
def logout():
    if not _session_is_authenticated():
        abort(401)
    csrf = request.form.get("csrf", "")
    if not csrf or csrf != session.get("csrf"):
        abort(400)
    session.clear()
    return redirect(url_for("login"))


@app.get("/call")
def call():
    if not _session_is_authenticated():
        return redirect(url_for("login"))
    nonce = secrets.token_urlsafe(16)
    request._csp_nonce = nonce

    # TURN placeholders: provided via env. We render into page after auth only.
    turn_urls = os.getenv("TURN_URLS", "").strip()
    turn_username = os.getenv("TURN_USERNAME", "").strip()
    turn_credential = os.getenv("TURN_CREDENTIAL", "").strip()

    return render_template(
        "index.html",
        nonce=nonce,
        roomToken=ROOM_TOKEN,
        csrf=session["csrf"],
        userId=session.get("user_id"),
        turnUrls=turn_urls,
        turnUsername=turn_username,
        turnCredential=turn_credential,
    )


def _require_socket_auth() -> str:
    if not _session_is_authenticated():
        raise PermissionError("not authenticated")
    return session["user_id"]


@socketio.on("connect")
def on_connect():
    # Prevent direct websocket access without authentication.
    try:
        user_id = _require_socket_auth()
    except Exception:
        return False  # Reject connect

    # Rate limit socket connects.
    key = _client_key()
    if not rate_limiter.allow("ws_connect:" + key):
        return False

    # Enforce maximum of exactly 2 simultaneous users.
    if len(connected_sids) >= 2:
        return False

    # Enforce single active connection per trusted user.
    existing_sid = user_to_sid.get(user_id)
    if existing_sid and existing_sid in connected_sids:
        # SECURITY: Prefer disconnecting the older session to reduce account sharing.
        # We do not emit any sensitive details.
        try:
            socketio.server.disconnect(existing_sid)
        except Exception:
            pass

    connected_sids.add(request.sid)
    sid_to_user[request.sid] = user_id
    user_to_sid[user_id] = request.sid

    join_room(ROOM_NAME)

    # Tell the client its role based on join order.
    # First user becomes "caller" (creates offer), second becomes "callee".
    role = "caller" if len(connected_sids) == 1 else "callee"
    emit("session", {"ok": True, "role": role})
    emit("peer_count", {"count": len(connected_sids)}, room=ROOM_NAME)


@socketio.on("disconnect")
def on_disconnect():
    sid = request.sid
    user_id = sid_to_user.get(sid)
    connected_sids.discard(sid)
    sid_to_user.pop(sid, None)
    if user_id and user_to_sid.get(user_id) == sid:
        user_to_sid.pop(user_id, None)

    try:
        leave_room(ROOM_NAME)
    except Exception:
        pass

    # Auto-destroy in-memory state when both users are gone.
    if len(connected_sids) == 0:
        sid_to_user.clear()
        user_to_sid.clear()

    emit("peer_count", {"count": len(connected_sids)}, room=ROOM_NAME)


def _validate_room_token(payload: dict) -> None:
    token = (payload or {}).get("roomToken", "")
    if not token or not isinstance(token, str) or token != ROOM_TOKEN:
        raise PermissionError("bad room token")


def _rate_limit_event(event_name: str) -> None:
    key = _client_key()
    if not rate_limiter.allow(f"ws:{event_name}:" + key):
        raise PermissionError("rate limited")


@socketio.on("signal")
def on_signal(payload):
    """
    Signaling relay. SECURITY:
    - Flask must never see raw media; WebRTC does DTLS/SRTP end-to-end.
    - We do not log SDP/ICE to avoid leaking metadata in logs.
    - We validate authentication, room token, payload shape, and rate-limit.
    """
    try:
        _require_socket_auth()
        _rate_limit_event("signal")
        _validate_room_token(payload or {})
    except Exception:
        disconnect()
        return

    if not isinstance(payload, dict):
        disconnect()
        return

    msg_type = payload.get("type")
    data = payload.get("data")

    # Only allow the minimal set of signaling message types.
    if msg_type not in ("offer", "answer", "ice", "hangup", "renegotiate"):
        disconnect()
        return

    # Very basic size limits to reduce abuse. (SDPs can be large but bounded.)
    try:
        serialized_len = len(str(data)) + len(str(msg_type))
    except Exception:
        serialized_len = 999999
    if serialized_len > 100_000:
        disconnect()
        return

    emit("signal", {"type": msg_type, "data": data}, room=ROOM_NAME, include_self=False)


@socketio.on("ping_secure")
def on_ping_secure(payload):
    # Keepalive + auth check.
    try:
        _require_socket_auth()
        _rate_limit_event("ping")
        _validate_room_token(payload or {})
    except Exception:
        disconnect()
        return
    emit("pong_secure", {"ok": True})


@app.get("/healthz")
def healthz():
    # Minimal health endpoint (no auth). Keep it cache-safe.
    resp = make_response(jsonify(ok=True))
    for k, v in no_store_headers().items():
        resp.headers[k] = v
    return resp


if __name__ == "__main__":
    # Local dev only. In production on Render use gunicorn Procfile.
    socketio.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "5000")), debug=False)
