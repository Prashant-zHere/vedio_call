import hmac
import os
import secrets
import time
from dataclasses import dataclass
from hashlib import sha256
from typing import Callable, Dict, Optional, Tuple

from werkzeug.security import check_password_hash, generate_password_hash


def _env(name: str, default: Optional[str] = None) -> Optional[str]:
    v = os.getenv(name)
    return v if v not in (None, "") else default


def must_getenv(name: str) -> str:
    v = os.getenv(name)
    if not v:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return v


def now() -> float:
    return time.time()


def make_csrf_token() -> str:
    # CSRF token for form POSTs; stored in session server-side.
    return secrets.token_urlsafe(32)


def hash_password_for_env(plain: str) -> str:
    # PBKDF2 is available in Werkzeug and is safe for password hashing.
    return generate_password_hash(plain, method="pbkdf2:sha256", salt_length=16)


def verify_password_hash(stored_hash: str, password: str) -> bool:
    return check_password_hash(stored_hash, password)


def stable_anonymous_client_key(secret: str, ip: str, user_agent: str) -> str:
    """
    Returns a privacy-preserving, non-reversible identifier for rate limiting / lockouts.
    """
    msg = (ip + "\n" + user_agent).encode("utf-8", "ignore")
    return hmac.new(secret.encode("utf-8"), msg, sha256).hexdigest()


@dataclass
class RateLimitState:
    window_start: float
    count: int


class SlidingWindowRateLimiter:
    """
    Lightweight in-memory rate limiter.
    """

    def __init__(self, limit_per_minute: int):
        self.limit = max(1, int(limit_per_minute))
        self._states: Dict[str, RateLimitState] = {}

    def allow(self, key: str) -> bool:
        t = now()
        st = self._states.get(key)
        if st is None or t - st.window_start >= 60:
            self._states[key] = RateLimitState(window_start=t, count=1)
            return True
        st.count += 1
        return st.count <= self.limit


@dataclass
class LockoutState:
    fails: int
    locked_until: float


class LoginLockout:
    """
    Anti-bruteforce lockout.
    """

    def __init__(self, max_fails: int = 8, lock_seconds: int = 300):
        self.max_fails = max(1, int(max_fails))
        self.lock_seconds = max(30, int(lock_seconds))
        self._states: Dict[str, LockoutState] = {}

    def is_locked(self, key: str) -> bool:
        st = self._states.get(key)
        if not st:
            return False
        if st.locked_until <= now():
            del self._states[key]
            return False
        return True

    def record_failure(self, key: str) -> None:
        t = now()
        st = self._states.get(key)
        if not st:
            self._states[key] = LockoutState(fails=1, locked_until=0.0)
            return
        st.fails += 1
        if st.fails >= self.max_fails:
            st.locked_until = t + self.lock_seconds

    def record_success(self, key: str) -> None:
        self._states.pop(key, None)


def security_headers(nonce: str) -> Dict[str, str]:
    """
    Returns a set of strict security headers.
    CSP now allows the Socket.IO CDN for script loading.
    """
    csp = (
        "default-src 'none'; "
        "base-uri 'none'; "
        "form-action 'self'; "
        "frame-ancestors 'none'; "
        "img-src 'self' data: blob:; "
        "media-src 'self' blob:; "
        "connect-src 'self' wss: https:; "
        "style-src 'self'; "
        f"script-src 'self' 'nonce-{nonce}' https://cdn.socket.io; "
    )
    flask_env = os.getenv("FLASK_ENV", "development").strip().lower()
    include_hsts = flask_env == "production"

    headers: Dict[str, str] = {
        "Content-Security-Policy": csp,
        "X-Frame-Options": "DENY",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Permissions-Policy": "camera=(self), microphone=(self), geolocation=()",
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Resource-Policy": "same-origin",
    }

    if include_hsts:
        headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains; preload"

    return headers


def no_store_headers() -> Dict[str, str]:
    return {
        "Cache-Control": "no-store, max-age=0",
        "Pragma": "no-cache",
        "Expires": "0",
    }


def cli_main() -> None:
    import sys

    if len(sys.argv) >= 3 and sys.argv[1] == "hash":
        print(hash_password_for_env(sys.argv[2]))
        return
    print('Usage: python -m utils.security hash "your_password"')
    raise SystemExit(2)


if __name__ == "__main__":
    cli_main()