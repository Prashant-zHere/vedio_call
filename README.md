# Secure 1-to-1 Video Call (Flask + WebRTC)

Production-ready, **highly locked-down** 1-to-1 video calling web app for **exactly two trusted users**.

- **No signup / no registration**
- **No database**
- **No call recording**
- **No chat**
- **No media storage**
- **Flask handles signaling only** (SDP/ICE relay) — audio/video flows **peer-to-peer** via WebRTC (DTLS/SRTP).

## Project structure

```
project/
├── app.py
├── requirements.txt
├── Procfile
├── render.yaml
├── .env.example
├── templates/
│   ├── login.html
│   └── index.html
├── static/
│   ├── style.css
│   └── app.js
└── utils/
    └── security.py
```

## Local setup (Windows / PowerShell)

1. Create a virtual environment and install deps:

```bash
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

2. Generate two password hashes (one for each trusted user):

```bash
python -m utils.security hash "User1StrongPasswordHere"
python -m utils.security hash "User2StrongPasswordHere"
```

3. Create a `.env` file based on `.env.example`:

- Set `SECRET_KEY` to a long random value.
- Set `PASSWORD_USER1_HASH` and `PASSWORD_USER2_HASH` to the generated hashes.

4. Run the server:

```bash
python app.py
```

For local testing, you may need to use plain `http://localhost:5000` and set cookie security accordingly because this app **uses secure session cookies** by default. For local testing you can either:

- Use a local HTTPS reverse proxy (recommended), or
- Set `SESSION_COOKIE_SECURE=false` in your local `.env` (do not deploy that).

## Render deployment (recommended)

### 1) Create a new Render Web Service

- Connect your GitHub repo
- Render will detect `render.yaml` automatically (Blueprint)

### 2) Set environment variables in Render

In Render dashboard → Service → Environment:

- `SECRET_KEY`: generate a strong random value (Render can auto-generate)
- `PASSWORD_USER1_HASH`: paste output from `python -m utils.security hash "..."`  
- `PASSWORD_USER2_HASH`: paste output from `python -m utils.security hash "..."`  
- `SESSION_IDLE_TIMEOUT_SECONDS`: default `900` (15 minutes)
- `RATE_LIMIT_PER_MINUTE`: default `60`

Optional TURN (highly recommended for mobile carrier NAT):

- `TURN_URLS`: comma-separated, e.g. `turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349?transport=tcp`
- `TURN_USERNAME`
- `TURN_CREDENTIAL`

### 3) Deploy

Render will run:

- Build: `pip install -r requirements.txt`
- Start: `gunicorn --worker-class eventlet -w 1 app:app`

**Important**: This app uses in-memory state to enforce “max 2 users”, so it runs with **1 worker** by design. (Multiple workers would each have their own “2 user” counter.)

## How authentication works (two trusted users only)

- The login page asks for a password.
- Server checks the password against **two** hashes:
  - `PASSWORD_USER1_HASH`
  - `PASSWORD_USER2_HASH`
- If it matches either hash, the session is marked authenticated as `user1` or `user2`.
- Sessions use:
  - **HttpOnly** cookies (JS can’t read them)
  - **SameSite=Strict**
  - **Secure** cookies (HTTPS required)
  - **Idle timeout** enforced on every request

## Room model (single private room, max 2 users)

- There is **exactly one private room** per running server instance.
- A cryptographically random `ROOM_TOKEN` is generated at server start and **only rendered after auth**.
- Socket connections are rejected server-side if:
  - not authenticated
  - wrong room token
  - event rate limit exceeded
  - a third user tries to connect (hard cap of 2)
- When both users disconnect, in-memory state is cleared immediately (no persistence).

## Transport security (HTTPS + WSS + WebRTC DTLS/SRTP)

- **HTTPS** is forced at the Flask layer in production (`FLASK_ENV=production`).
- WebSockets use **WSS** automatically when served behind HTTPS on Render.
- WebRTC media uses:
  - **DTLS** for key exchange
  - **SRTP** for encrypted audio/video

Flask never receives raw audio/video; it only relays **signaling** messages needed for peers to connect.

## TURN/STUN notes (mobile optimization)

- STUN helps discover public-facing addresses for NAT traversal.
- TURN relays media when direct P2P is impossible (common on mobile networks / strict NAT).
- This app includes:
  - Default STUN: `stun:stun.l.google.com:19302`
  - Optional TURN via env vars

For best reliability on mobile, configure a TURN service (e.g., coturn) and set `TURN_URLS`, `TURN_USERNAME`, `TURN_CREDENTIAL`.

## Security headers & caching

The app sets strict headers including:

- HSTS
- CSP (restrictive, nonce-based for scripts)
- X-Frame-Options (DENY) + `frame-ancestors 'none'` (no embedding)
- X-Content-Type-Options (nosniff)
- Referrer-Policy (no-referrer)
- Permissions-Policy (camera/microphone allowed only for same-origin)

Sensitive pages also send:

- `Cache-Control: no-store`

## Anti-bruteforce + rate limiting

- Login attempts and websocket events are rate-limited in-memory.
- A lockout triggers after repeated failures.

Privacy choice: the limiter key is an **HMAC of IP + User-Agent**, so the server does not store raw IP addresses.

## Screenshot / screen recording limitations (important)

**It is impossible to fully prevent screenshots or screen recording on the web.**

Reasons:

- OS-level screenshot shortcuts work outside the browser’s control.
- Screen recording tools operate at the OS level.
- Browsers do not provide a reliable API to detect screenshots/recording.

Mitigations implemented (deterrence only):

- Disable right-click context menu
- Block common “inspect” shortcuts (best-effort)
- Blur videos when the tab is hidden/inactive
- Show warnings on suspicious device changes

## Production notes

- Keep `SECRET_KEY` secret and rotate if compromised.
- Use strong passwords for both users.
- Configure TURN for reliable mobile connectivity.
- Do not increase worker count unless you also add shared state (e.g., Redis).

