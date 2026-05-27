/* global io */
(() => {
  "use strict";

  const cfg = window.__APP_CONFIG__ || {};
  const roomToken = cfg.roomToken;

  const el = {
    localVideo: document.getElementById("localVideo"),
    remoteVideo: document.getElementById("remoteVideo"),
    statusPill: document.getElementById("statusPill"),
    peerPill: document.getElementById("peerPill"),
    notice: document.getElementById("notice"),
    remoteOverlay: document.getElementById("remoteOverlay"),
    remoteOverlayText: document.getElementById("remoteOverlayText"),
    btnMic: document.getElementById("btnMic"),
    btnCam: document.getElementById("btnCam"),
    btnHangup: document.getElementById("btnHangup"),
    permGate: document.getElementById("permGate"),
    permGateText: document.getElementById("permGateText"),
    permGateHint: document.getElementById("permGateHint"),
    btnEnableMedia: document.getElementById("btnEnableMedia"),
  };

  // ======= Screenshot/recording deterrence (best-effort) =======
  document.addEventListener("contextmenu", (e) => e.preventDefault(), { passive: false });
  document.addEventListener(
    "keydown",
    (e) => {
      const key = String(e.key || "").toLowerCase();
      const ctrl = e.ctrlKey || e.metaKey;
      const blocked =
        (ctrl && ["u", "s", "p"].includes(key)) ||
        (ctrl && e.shiftKey && ["i", "j", "c"].includes(key)) ||
        key === "f12";
      if (blocked) {
        e.preventDefault();
        showNotice("This app discourages inspection/recording, but cannot prevent it.");
      }
    },
    { passive: false }
  );

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      blurVideos(true);
      showNotice("Tab inactive: video blurred for privacy.");
    } else {
      blurVideos(false);
      showNotice("");
    }
  });

  function blurVideos(on) {
    const v = [el.localVideo, el.remoteVideo];
    v.forEach((x) => {
      if (!x) return;
      x.style.filter = on ? "blur(18px)" : "";
    });
  }

  // ======= UI helpers =======
  function setStatus(text, kind) {
    el.statusPill.textContent = text;
    el.statusPill.classList.remove("pill--ok", "pill--bad");
    if (kind === "ok") el.statusPill.classList.add("pill--ok");
    if (kind === "bad") el.statusPill.classList.add("pill--bad");
  }

  function showNotice(text) {
    el.notice.textContent = text || "";
  }

  function setOverlay(on, text) {
    if (!el.remoteOverlay) return;
    el.remoteOverlay.hidden = !on;
    if (el.remoteOverlayText && text) el.remoteOverlayText.textContent = text;
  }

  function showPermGate(show, hintText) {
    if (!el.permGate) return;
    el.permGate.hidden = !show;
    if (el.permGateHint && hintText) el.permGateHint.textContent = hintText;
  }

  function permissionHelp(err) {
    const name = err && err.name ? err.name : "";
    if (name === "NotAllowedError" || name === "PermissionDeniedError") {
      return (
        "Permission was blocked. On phone: open browser site settings for this URL and allow Camera + Microphone, then tap the button again. " +
        "Use Chrome or Safari (not in-app browsers like Instagram/WhatsApp)."
      );
    }
    if (name === "NotFoundError" || name === "DevicesNotFoundError") {
      return "No camera/microphone found on this device.";
    }
    if (name === "NotReadableError" || name === "TrackStartError") {
      return "Camera/mic is in use by another app. Close other apps using the camera and try again.";
    }
    if (name === "SecurityError") {
      return "Camera/mic requires HTTPS. Open the Render https:// link, not http://.";
    }
    return "Could not access camera/mic. Tap the button again or check browser permissions for this site.";
  }

  // ======= WebRTC state =======
  let socket = null;
  let pc = null;
  let localStream = null;
  let role = "callee";
  let micEnabled = true;
  let camEnabled = true;
  let started = false;
  let makingOffer = false;
  let polite = true;
  let pendingIceCandidates = [];
  let remoteReady = false;

  const ICE_SERVERS = buildIceServers(cfg.turn);
  const hasTurn = ICE_SERVERS.some((s) => {
    const urls = s.urls;
    const list = Array.isArray(urls) ? urls : [urls];
    return list.some((u) => String(u).startsWith("turn:") || String(u).startsWith("turns:"));
  });
  const RTC_CONFIG = {
    iceServers: ICE_SERVERS,
    iceCandidatePoolSize: 4,
    bundlePolicy: "max-bundle",
  };

  function buildIceServers(turn) {
    const servers = [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
      { urls: "stun:stun2.l.google.com:19302" },
    ];
    const urls = (turn && turn.urls ? String(turn.urls) : "").trim();
    const username = (turn && turn.username ? String(turn.username) : "").trim();
    const credential = (turn && turn.credential ? String(turn.credential) : "").trim();
    if (urls) {
      const list = urls
        .split(",")
        .map((u) => u.trim())
        .filter(Boolean);
      servers.push({
        urls: list,
        username: username || undefined,
        credential: credential || undefined,
      });
    }
    return servers;
  }

  async function playLocalVideo() {
    if (!el.localVideo || !el.localVideo.srcObject) return;
    try {
      await el.localVideo.play();
    } catch (_) {
      // iOS may require another tap
    }
  }

  async function requestMedia() {
    const attempts = [
      { audio: true, video: { facingMode: "user" } },
      { audio: true, video: true },
      { audio: true, video: false },
    ];
    let lastErr = null;
    for (const constraints of attempts) {
      try {
        return await navigator.mediaDevices.getUserMedia(constraints);
      } catch (err) {
        lastErr = err;
        if (err && (err.name === "NotAllowedError" || err.name === "PermissionDeniedError")) {
          throw err;
        }
      }
    }
    throw lastErr || new Error("getUserMedia failed");
  }

  async function ensureMedia() {
    if (localStream) return localStream;
    setStatus("Requesting camera/mic…");
    setOverlay(true, "Allow camera + microphone in the popup…");

    try {
      localStream = await requestMedia();
      el.localVideo.srcObject = localStream;
      await playLocalVideo();
      setOverlay(false);
      showPermGate(false);
      console.log("[DEBUG] Media obtained successfully");
      return localStream;
    } catch (err) {
      setOverlay(false);
      setStatus("Permissions needed", "bad");
      showNotice(permissionHelp(err));
      showPermGate(true, permissionHelp(err));
      throw err;
    }
  }

  async function flushPendingIce() {
    if (!pc || !pc.remoteDescription) return;
    const queued = pendingIceCandidates.slice();
    pendingIceCandidates = [];
    for (const candidate of queued) {
      try {
        await pc.addIceCandidate(candidate);
      } catch (_) {}
    }
  }

  async function addRemoteIceCandidate(candidate) {
    if (!pc || !candidate) return;
    if (!pc.remoteDescription) {
      pendingIceCandidates.push(candidate);
      return;
    }
    try {
      await pc.addIceCandidate(candidate);
    } catch (_) {}
  }

  async function sendOffer() {
    if (!pc || role !== "caller") {
      console.log("[DEBUG] sendOffer skipped: pc=", !!pc, "role=", role);
      return;
    }
    if (pc.signalingState !== "stable") {
      console.log("[DEBUG] sendOffer skipped, signalingState=", pc.signalingState);
      return;
    }
    try {
      makingOffer = true;
      console.log("[DEBUG] Creating offer");
      await pc.setLocalDescription();
      safeSignal("offer", pc.localDescription);
    } catch (err) {
      console.error("[DEBUG] sendOffer error", err);
      showNotice("Could not start call negotiation. Tap enable again.");
    } finally {
      makingOffer = false;
    }
  }

  function createPeerConnection() {
    pendingIceCandidates = [];
    remoteReady = false;
    pc = new RTCPeerConnection(RTC_CONFIG);

    pc.addEventListener("track", (ev) => {
      const [stream] = ev.streams;
      if (stream && el.remoteVideo.srcObject !== stream) {
        el.remoteVideo.srcObject = stream;
        el.remoteVideo.play().catch(() => {});
        setOverlay(false);
        console.log("[DEBUG] Remote stream attached");
      }
    });

    pc.addEventListener("icecandidate", (ev) => {
      if (ev.candidate) {
        safeSignal("ice", ev.candidate);
      }
    });

    pc.addEventListener("iceconnectionstatechange", () => {
      const s = pc.iceConnectionState;
      console.log("[DEBUG] ICE state:", s);
      if (s === "connected" || s === "completed") {
        setStatus("Connected", "ok");
        showNotice("");
      } else if (s === "failed") {
        setStatus("Call failed", "bad");
        showNotice(
          hasTurn
            ? "Video connection failed on mobile network. Close and reopen the page, then try again."
            : "Mobile video often needs TURN. Add TURN_URLS, TURN_USERNAME, TURN_CREDENTIAL in Render env vars."
        );
        try {
          pc.restartIce();
        } catch (_) {}
      } else if (s === "disconnected") {
        setStatus("Reconnecting…");
      } else {
        setStatus("Connecting…");
      }
    });

    pc.addEventListener("connectionstatechange", () => {
      console.log("[DEBUG] Connection state:", pc.connectionState);
      const s = pc.connectionState;
      if (s === "connected") setStatus("Connected", "ok");
      if (s === "failed") {
        setStatus("Call failed", "bad");
        if (!hasTurn) {
          showNotice("WebRTC connection failed – you likely need TURN on Render.");
        }
      }
    });

    pc.addEventListener("negotiationneeded", async () => {
      if (role !== "caller") return;
      console.log("[DEBUG] negotiationneeded → sendOffer");
      await sendOffer();
    });

    return pc;
  }

  function addLocalTracksToPC() {
    if (!pc || !localStream) return;
    const senders = pc.getSenders();
    const hasAudio = senders.some(s => s.track && s.track.kind === "audio");
    const hasVideo = senders.some(s => s.track && s.track.kind === "video");
    localStream.getTracks().forEach(track => {
      if (track.kind === "audio" && !hasAudio) {
        pc.addTrack(track, localStream);
        console.log("[DEBUG] Added audio track");
      } else if (track.kind === "video" && !hasVideo) {
        pc.addTrack(track, localStream);
        console.log("[DEBUG] Added video track");
      }
    });
  }

  async function start() {
    if (started) return;

    if (!roomToken) {
      setStatus("Auth error", "bad");
      showNotice("Missing room token. Please refresh.");
      return;
    }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setStatus("Unsupported", "bad");
      showNotice("This browser does not support WebRTC getUserMedia. Use Chrome or Safari.");
      showPermGate(true, "Try opening this page in Chrome or Safari, not an in-app browser.");
      return;
    }

    if (!window.isSecureContext) {
      setStatus("HTTPS required", "bad");
      showNotice("Camera/mic only works on HTTPS.");
      showPermGate(true, "Open the https:// Render URL.");
      return;
    }

    started = true;
    showPermGate(false);
    setOverlay(true, "Preparing call…");

    // --- FIX: obtain media FIRST before connecting to signaling ---
    try {
      await ensureMedia();
    } catch (err) {
      console.error("[DEBUG] Media error:", err);
      started = false;
      return;
    }

    setStatus("Connecting…");

    // Connect Socket.IO with authentication in query string
    socket = io({
      transports: ["polling", "websocket"],
      withCredentials: true,
      query: {
        roomToken: roomToken,
        userId: cfg.userId
      },
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 500,
      reconnectionDelayMax: 4000,
      timeout: 20000,
    });

    socket.on("connect", () => {
      console.log("[DEBUG] Socket connected, transport:", socket.io.engine.transport.name);
      setStatus("Connected to server…");
      safePing();
    });

    socket.on("disconnect", () => {
      console.log("[DEBUG] Socket disconnected");
      setStatus("Reconnecting…");
      setOverlay(true, "Reconnecting…");
    });

    socket.on("connect_error", (err) => {
      console.error("[DEBUG] Socket connect_error", err);
      setStatus("Server connection failed", "bad");
      const msg = `Cannot connect to server (${err?.message || "unknown"}). Refresh and log in again.`;
      showNotice(msg);
      setOverlay(true, "Server connection failed");
      started = false;
      showPermGate(true, msg);
    });

    socket.on("session", async (payload) => {
      console.log("[DEBUG] session event, role =", payload?.role);
      role = payload && payload.role ? payload.role : "callee";
      polite = role !== "caller";

      createPeerConnection();
      addLocalTracksToPC();

      if (remoteReady && role === "caller") {
        console.log("[DEBUG] Both peers present already, sending offer from session");
        setTimeout(() => sendOffer(), 100);
      }

      setOverlay(true, "Waiting for the other user…");
      setStatus("Waiting…");
    });

    socket.on("peer_count", async (p) => {
      const count = Number(p && p.count ? p.count : 0);
      el.peerPill.textContent = `Peers: ${count}/2`;
      console.log("[DEBUG] peer_count:", count);
      if (count === 2) {
        remoteReady = true;
        setOverlay(false);
        setStatus("Connecting…");
        if (role === "caller" && pc) {
          console.log("[DEBUG] Both peers connected, caller sending offer");
          setTimeout(() => sendOffer(), 400);
        } else if (role === "caller" && !pc) {
          console.log("[DEBUG] PC not ready, will send offer after session");
        }
      } else {
        remoteReady = false;
        setOverlay(true, "Waiting for the other user…");
        setStatus("Waiting…");
      }
    });

    socket.on("signal", async (payload) => {
      if (!pc) return;
      if (!payload || typeof payload !== "object") return;
      const type = payload.type;
      const data = payload.data;

      try {
        if (type === "offer" || type === "answer") {
          const desc = new RTCSessionDescription(data);
          const offerCollision = desc.type === "offer" && (makingOffer || pc.signalingState !== "stable");
          if (offerCollision && !polite) {
            console.log("[DEBUG] Ignoring glare offer");
            return;
          }

          await pc.setRemoteDescription(desc);
          await flushPendingIce();
          if (desc.type === "offer") {
            await pc.setLocalDescription();
            safeSignal("answer", pc.localDescription);
          }
        } else if (type === "ice") {
          await addRemoteIceCandidate(data);
        } else if (type === "hangup") {
          endCall(false);
        } else if (type === "renegotiate") {
          try {
            pc.restartIce();
          } catch (_) {}
        }
      } catch (err) {
        console.error("[DEBUG] signal processing error", err);
        showNotice("Connection issue. Reconnecting…");
      }
    });

    socket.on("pong_secure", () => {});
    setInterval(safePing, 30000);
  }

  function safeSignal(type, data) {
    if (!socket || !socket.connected) return;
    socket.emit("signal", { roomToken, type, data });
  }

  function safePing() {
    if (!socket || !socket.connected) return;
    socket.emit("ping_secure", { roomToken });
  }

  function updateButtons() {
    el.btnMic.textContent = micEnabled ? "Mic On" : "Mic Off";
    el.btnMic.setAttribute("aria-pressed", String(!micEnabled));
    el.btnCam.textContent = camEnabled ? "Cam On" : "Cam Off";
    el.btnCam.setAttribute("aria-pressed", String(!camEnabled));
  }

  async function toggleMic() {
    if (!localStream) return;
    micEnabled = !micEnabled;
    localStream.getAudioTracks().forEach((t) => (t.enabled = micEnabled));
    updateButtons();
  }

  async function toggleCam() {
    if (!localStream) return;
    camEnabled = !camEnabled;
    localStream.getVideoTracks().forEach((t) => (t.enabled = camEnabled));
    updateButtons();
  }

  function endCall(announce) {
    if (announce) safeSignal("hangup", { bye: true });

    setStatus("Ended");
    setOverlay(true, "Call ended.");

    if (pc) {
      try {
        pc.ontrack = null;
        pc.onicecandidate = null;
        pc.onnegotiationneeded = null;
        pc.close();
      } catch (_) {}
      pc = null;
    }

    if (localStream) {
      localStream.getTracks().forEach((t) => {
        try {
          t.stop();
        } catch (_) {}
      });
      localStream = null;
    }

    if (socket) {
      try {
        socket.disconnect();
      } catch (_) {}
      socket = null;
    }
  }

  // ======= UI event binding =======
  el.btnMic.addEventListener("click", toggleMic);
  el.btnCam.addEventListener("click", toggleCam);
  el.btnHangup.addEventListener("click", () => endCall(true));
  updateButtons();

  // Warn about screen sharing (best-effort)
  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener("devicechange", () => {
      showNotice("Device change detected. If you are sharing your screen, stop sharing for privacy.");
    });
  }

  // Initial state: show permission gate
  showPermGate(
    true,
    hasTurn
      ? "Use Chrome or Safari. Tap the button, allow camera + mic, then wait for the other user."
      : "Use Chrome or Safari. Mobile calls often fail without TURN — add TURN env vars on Render for best results."
  );
  setOverlay(false);
  setStatus("Tap button to start");

  if (el.btnEnableMedia) {
    el.btnEnableMedia.addEventListener("click", () => {
      start().catch((err) => {
        console.error("[DEBUG] start() failed", err);
      });
    });
  } else {
    showNotice("Page error: enable button missing. Hard refresh the page.");
  }
})();