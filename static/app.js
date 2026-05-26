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
  };

  // ======= Screenshot/recording deterrence (NOT true prevention) =======
  // IMPORTANT: Real screenshot/screen-recording prevention is impossible in the browser.
  // These measures only reduce casual capture and improve user awareness.
  document.addEventListener("contextmenu", (e) => e.preventDefault(), { passive: false });
  document.addEventListener(
    "keydown",
    (e) => {
      const key = String(e.key || "").toLowerCase();
      const ctrl = e.ctrlKey || e.metaKey;
      const blocked =
        (ctrl && ["u", "s", "p"].includes(key)) || // view-source/save/print
        (ctrl && e.shiftKey && ["i", "j", "c"].includes(key)) || // devtools shortcuts
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

  // ======= WebRTC state =======
  let socket = null;
  let pc = null;
  let localStream = null;
  let role = "callee";
  let micEnabled = true;
  let camEnabled = true;
  let started = false;
  let makingOffer = false;
  let polite = true; // perfect negotiation: one side is polite (accepts glare)

  const ICE_SERVERS = buildIceServers(cfg.turn);
  const RTC_CONFIG = {
    iceServers: ICE_SERVERS,
    // Prefer security+reliability over exotic policies:
    // Use "all" so candidates work on mobile networks; TURN is optional but recommended.
    iceCandidatePoolSize: 2,
  };

  function buildIceServers(turn) {
    const servers = [{ urls: ["stun:stun.l.google.com:19302"] }];
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

  async function ensureMedia() {
    if (localStream) return localStream;
    setStatus("Requesting camera/mic…");
    setOverlay(true, "Waiting for permissions…");

    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: {
          facingMode: "user",
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });

      el.localVideo.srcObject = localStream;
      setOverlay(false);
      return localStream;
    } catch (err) {
      setOverlay(true, "Camera/microphone permission is required.");
      setStatus("Permissions needed", "bad");
      showNotice("Allow camera + microphone to start the call.");
      throw err;
    }
  }

  function createPeerConnection() {
    pc = new RTCPeerConnection(RTC_CONFIG);

    pc.addEventListener("track", (ev) => {
      // Attach first remote stream.
      const [stream] = ev.streams;
      if (stream && el.remoteVideo.srcObject !== stream) {
        el.remoteVideo.srcObject = stream;
        setOverlay(false);
      }
    });

    pc.addEventListener("icecandidate", (ev) => {
      if (ev.candidate) {
        safeSignal("ice", ev.candidate);
      }
    });

    pc.addEventListener("iceconnectionstatechange", () => {
      const s = pc.iceConnectionState;
      if (s === "connected" || s === "completed") setStatus("Connected", "ok");
      else if (s === "failed") {
        setStatus("Reconnecting…");
        // Attempt ICE restart to recover on mobile networks.
        try {
          pc.restartIce();
        } catch (_) {}
      } else if (s === "disconnected") {
        setStatus("Disconnected…");
      } else {
        setStatus("Connecting…");
      }
    });

    // Perfect negotiation pattern to reduce glare issues.
    pc.addEventListener("negotiationneeded", async () => {
      try {
        makingOffer = true;
        await pc.setLocalDescription();
        safeSignal("offer", pc.localDescription);
      } catch (err) {
        // Intentionally avoid logging SDP.
        showNotice("Negotiation error. Try reconnecting.");
      } finally {
        makingOffer = false;
      }
    });

    return pc;
  }

  async function start() {
    if (started) return;
    started = true;

    if (!roomToken) {
      setStatus("Auth error", "bad");
      showNotice("Missing room token. Please refresh.");
      return;
    }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setStatus("Unsupported", "bad");
      showNotice("This browser does not support WebRTC getUserMedia.");
      return;
    }

    setOverlay(true, "Preparing call…");
    await ensureMedia();

    setStatus("Connecting…");

    socket = io({
      transports: ["websocket"], // SECURITY: avoid long-polling downgrade.
      upgrade: false,
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 500,
      reconnectionDelayMax: 4000,
      timeout: 8000,
    });

    socket.on("connect", () => {
      setStatus("Connected to server…");
      safePing();
    });

    socket.on("disconnect", () => {
      setStatus("Reconnecting…");
      setOverlay(true, "Reconnecting…");
    });

    socket.on("connect_error", () => {
      setStatus("Connection blocked", "bad");
      showNotice("Connection blocked (auth/limit). If a 3rd user joined, server rejects it.");
      setOverlay(true, "Access denied or room full.");
    });

    socket.on("session", async (payload) => {
      role = payload && payload.role ? payload.role : "callee";
      // Polite/impolite choice: make caller impolite to break ties.
      polite = role !== "caller";

      // Create PC and add tracks.
      createPeerConnection();
      localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));

      // Show waiting state until remote arrives.
      setOverlay(true, "Waiting for the other user…");
      setStatus("Waiting…");
    });

    socket.on("peer_count", (p) => {
      const count = Number(p && p.count ? p.count : 0);
      el.peerPill.textContent = `Peers: ${count}/2`;
      if (count === 2) {
        setOverlay(false);
        setStatus("Connecting…");
      } else {
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
            // Impolite side ignores glare offer.
            return;
          }

          await pc.setRemoteDescription(desc);
          if (desc.type === "offer") {
            await pc.setLocalDescription();
            safeSignal("answer", pc.localDescription);
          }
        } else if (type === "ice") {
          if (data) {
            try {
              await pc.addIceCandidate(data);
            } catch (err) {
              // Ignore ICE errors during glare.
            }
          }
        } else if (type === "hangup") {
          endCall(false);
        } else if (type === "renegotiate") {
          try {
            pc.restartIce();
          } catch (_) {}
        }
      } catch (_) {
        // Avoid logging sensitive signaling contents (SDP/ICE).
        showNotice("Connection issue. Reconnecting…");
      }
    });

    // Keepalive to ensure auth + session stays valid.
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

  // ======= Mobile-friendly UX =======
  el.btnMic.addEventListener("click", toggleMic);
  el.btnCam.addEventListener("click", toggleCam);
  el.btnHangup.addEventListener("click", () => endCall(true));
  updateButtons();

  // Warn if the user starts screen sharing (detectable only if they choose it).
  // Note: Many browsers do not expose exact capture source; this is best-effort only.
  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener("devicechange", () => {
      showNotice("Device change detected. If you are sharing your screen, stop sharing for privacy.");
    });
  }

  // Autostart.
  start().catch(() => {});
})();

