(function () {
  const DIRECT_ATTEMPT_TIMEOUT_MS = 8000;
  const PAIRING_ATTEMPT_TIMEOUT_MS = 30000;
  const MAX_CHAT_MESSAGE_LENGTH = 400;
  const LATENCY_PING_INTERVAL_MS = 10000;
  const LATENCY_PING_INITIAL_DELAY_MS = 1500;
  const PROTOCOL_TYPE_CHAT = "chat";
  const PROTOCOL_TYPE_PING = "ping";
  const PROTOCOL_TYPE_PONG = "pong";
  const state = {
    config: null,
    runtime: null,
    stunServers: [],
    directIceServers: [],
    relayIceServers: [],
    currentIceMode: "direct",
    socket: null,
    socketReady: false,
    heartbeatTimer: null,
    currentPair: null,
    peerState: "Idle",
    chatReady: false,
    peerConnection: null,
    dataChannel: null,
    reconnectTimer: null,
    reconnectDelayMs: 2000,
    autoConnectEnabled: true,
    modalMode: null,
    modalPinGenerated: false,
    directAttemptTimer: null,
    pairingAttemptTimer: null,
    pendingRemoteCandidates: [],
    latencyPingTimer: null,
    lastLatencyMs: null,
    iceSource: null,
  };

  const waitingScreen = document.getElementById("waitingScreen");
  const chatScreen = document.getElementById("chatScreen");
  const waitingStatusLine = document.getElementById("waitingStatusLine");
  const sessionStatusLine = document.getElementById("sessionStatusLine");
  const displayNameValue = document.getElementById("displayNameValue");
  const hostCodeValue = document.getElementById("hostCodeValue");
  const deviceNameValue = document.getElementById("deviceNameValue");
  const serverUrlValue = document.getElementById("serverUrlValue");
  const iceSourceValue = document.getElementById("iceSourceValue");
  const hostIdValue = document.getElementById("hostIdValue");
  const sessionTitle = document.getElementById("sessionTitle");
  const sessionSubtitle = document.getElementById("sessionSubtitle");
  const latencyMetric = document.getElementById("latencyMetric");
  const leavePairButton = document.getElementById("leavePairButton");
  const chatLog = document.getElementById("chatLog");
  const chatInput = document.getElementById("chatInput");
  const sendMessageButton = document.getElementById("sendMessageButton");
  const editOverlay = document.getElementById("editOverlay");
  const overlayTitle = document.getElementById("overlayTitle");
  const overlayCopy = document.getElementById("overlayCopy");
  const overlayBody = document.getElementById("overlayBody");
  const overlaySaveButton = document.getElementById("overlaySaveButton");
  const overlayCancelButton = document.getElementById("overlayCancelButton");
  const overlayCloseButton = document.getElementById("overlayCloseButton");

  function log(scope, message, extra) {
    const stamp = new Date().toISOString();
    if (typeof extra === "undefined") {
      console.log(`[OmniPortalHostV1][${stamp}][${scope}] ${message}`);
      return;
    }
    console.log(`[OmniPortalHostV1][${stamp}][${scope}] ${message}`, extra);
  }

  function logError(scope, message, error) {
    console.error(`[OmniPortalHostV1][${new Date().toISOString()}][${scope}] ${message}`, error);
  }

  function setLineStatus(element, message, tone = "neutral") {
    element.textContent = message;
    element.dataset.tone = tone;
  }

  function setWaitingStatus(message, tone = "neutral") {
    setLineStatus(waitingStatusLine, message, tone);
  }

  function setSessionStatus(message, tone = "neutral") {
    setLineStatus(sessionStatusLine, message, tone);
  }

  function humanizeReason(reason) {
    switch (reason) {
      case "left_by_user":
        return "the session was ended";
      case "peer_disconnected":
        return "the other side disconnected";
      case "signaling_socket_closed":
        return "the signaling connection was lost";
      case "heartbeat_timeout":
        return "the connection timed out";
      case "host_went_offline":
        return "the host went offline";
      case "pairing_timeout":
        return "the connection attempt timed out";
      case "replaced_by_new_pair":
        return "a newer connection attempt replaced this one";
      case "rtc_failed":
        return "the direct connection failed";
      case "rtc_disconnected":
        return "the direct connection was interrupted";
      case "rtc_closed":
        return "the direct connection was closed";
      default:
        return reason ? String(reason).replace(/_/g, " ") : "the session ended";
    }
  }

  function clearPairingAttemptTimer() {
    if (state.pairingAttemptTimer) {
      window.clearTimeout(state.pairingAttemptTimer);
      state.pairingAttemptTimer = null;
    }
  }

  function clearDirectAttemptTimer() {
    if (state.directAttemptTimer) {
      window.clearTimeout(state.directAttemptTimer);
      state.directAttemptTimer = null;
    }
  }

  function stopLatencyPings() {
    if (state.latencyPingTimer) {
      window.clearTimeout(state.latencyPingTimer);
      state.latencyPingTimer = null;
    }
  }

  function renderLatencyMetric() {
    if (!latencyMetric) {
      return;
    }
    if (!state.currentPair) {
      latencyMetric.textContent = "Latency unavailable";
      return;
    }
    if (!state.chatReady) {
      latencyMetric.textContent = state.currentIceMode === "relay"
        ? "Retrying through TURN relay..."
        : "Measuring direct path...";
      return;
    }
    if (typeof state.lastLatencyMs === "number") {
      latencyMetric.textContent = `Last RTT ${state.lastLatencyMs} ms`;
      return;
    }
    latencyMetric.textContent = "Measuring latency...";
  }

  function startPairingAttemptTimer() {
    clearPairingAttemptTimer();
    state.pairingAttemptTimer = window.setTimeout(() => {
      state.pairingAttemptTimer = null;
      if (!state.currentPair || state.chatReady) {
        return;
      }
      log("pairing", "Pairing attempt timed out", state.currentPair);
      setSessionStatus("The client did not finish establishing the direct connection in time.", "error");
      if (state.socketReady) {
        state.socket.send(JSON.stringify({ type: "leave_pair" }));
      }
      handlePairingCleared({ reason: "pairing_timeout" }).catch((error) => {
        logError("pairing", "Timed pairing cleanup failed", error);
      });
    }, PAIRING_ATTEMPT_TIMEOUT_MS);
  }

  function startDirectAttemptTimer() {
    clearDirectAttemptTimer();
    if (state.currentIceMode !== "direct") {
      return;
    }
    state.directAttemptTimer = window.setTimeout(() => {
      state.directAttemptTimer = null;
      if (!state.currentPair || state.chatReady || state.currentIceMode !== "direct") {
        return;
      }
      promoteToRelayMode("direct_timeout").catch((error) => {
        logError("webrtc", "Relay fallback failed after direct timeout", error);
      });
    }, DIRECT_ATTEMPT_TIMEOUT_MS);
  }

  function normalizeServerUrl(value) {
    return String(value || "").trim().replace(/\/+$/, "");
  }

  function validateServerUrl(value) {
    const normalized = normalizeServerUrl(value);
    const parsed = new URL(normalized);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error("Server URL must start with http:// or https://");
    }
    return normalized;
  }

  function apiUrl(path) {
    return `${normalizeServerUrl(state.config.server_url)}${path}`;
  }

  function hostSocketUrl() {
    const base = new URL(normalizeServerUrl(state.config.server_url));
    base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
    base.pathname = "/ws/host-v1";
    base.search = `host_id=${encodeURIComponent(state.config.host_id)}`;
    return base.toString();
  }

  async function fetchJson(url, options) {
    return window.omniHost.requestJson({
      url,
      method: options?.method || "GET",
      headers: options?.headers || {},
      body: options?.body,
    });
  }

  function clearReconnectTimer() {
    if (state.reconnectTimer) {
      window.clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }
  }

  function scheduleReconnect(reason = "signal_lost") {
    if (!state.autoConnectEnabled || state.reconnectTimer) {
      return;
    }
    const delay = state.reconnectDelayMs;
    state.reconnectTimer = window.setTimeout(() => {
      state.reconnectTimer = null;
      ensureHostOnline(true).catch((error) => {
        logError("socket", "Reconnect attempt failed", error);
        setWaitingStatus(`Reconnecting failed: ${error.message}`, "error");
        state.reconnectDelayMs = Math.min(state.reconnectDelayMs * 2, 15000);
        scheduleReconnect(reason);
      });
    }, delay);
    setWaitingStatus("Reconnecting to OmniPortal...", reason === "signal_lost" ? "neutral" : "error");
  }

  function startHeartbeat() {
    stopHeartbeat();
    state.heartbeatTimer = window.setInterval(() => {
      if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
        return;
      }
      state.socket.send(JSON.stringify({ type: "heartbeat" }));
    }, 15000);
  }

  function stopHeartbeat() {
    if (state.heartbeatTimer) {
      window.clearInterval(state.heartbeatTimer);
      state.heartbeatTimer = null;
    }
  }

  function appendChat(kind, text) {
    if (chatLog.children.length === 1 && chatLog.textContent.includes("Waiting for a client to connect.")) {
      chatLog.innerHTML = "";
    }
    const row = document.createElement("div");
    row.className = `chat-row ${kind}`;
    row.textContent = text;
    chatLog.appendChild(row);
    chatLog.scrollTop = chatLog.scrollHeight;
  }

  function resetChatLog(message = "Waiting for a client to connect.") {
    chatLog.innerHTML = "";
    appendChat("system", message);
  }

  function renderDetails() {
    if (!state.config || !state.runtime) {
      displayNameValue.textContent = "Loading...";
      hostCodeValue.textContent = "Loading...";
      deviceNameValue.textContent = "Loading...";
      serverUrlValue.textContent = "Loading...";
      iceSourceValue.textContent = "Loading...";
      hostIdValue.textContent = "Loading...";
      return;
    }
    displayNameValue.textContent = state.config.display_name || state.runtime.deviceName;
    hostCodeValue.textContent = state.config.host_code;
    deviceNameValue.textContent = state.runtime.deviceName;
    serverUrlValue.textContent = state.config.server_url;
    iceSourceValue.textContent = humanizeIceSource(state.iceSource);
    hostIdValue.textContent = state.config.host_id;
  }

  function humanizeIceSource(source) {
    switch (source) {
      case "metered_api":
        return "Metered credential API";
      case "static_ice_json":
        return "Pinned static ICE JSON";
      case "turn_rest_env":
        return "Self-hosted TURN with temporary credentials";
      case "stun_turn_env":
        return "Custom TURN with static credentials";
      case "openrelay_default":
        return "OpenRelay public fallback";
      case "stun_only":
        return "Direct STUN only";
      default:
        return "Loading backend relay policy...";
    }
  }

  function renderScreenState() {
    const connected = Boolean(state.currentPair);
    chatInput.disabled = !state.chatReady;
    sendMessageButton.disabled = !state.chatReady;
    renderLatencyMetric();
    if (connected) {
      waitingScreen.classList.add("hidden");
      chatScreen.classList.remove("hidden");
      sessionTitle.textContent = state.currentPair.peerDisplayName || "Client Connected";
      sessionSubtitle.textContent = state.chatReady
        ? "Direct chat is active with the connected client."
        : "Negotiating the direct peer connection.";
      return;
    }

    chatScreen.classList.add("hidden");
    waitingScreen.classList.remove("hidden");
    sessionTitle.textContent = "OmniPortal Chat";
    sessionSubtitle.textContent = "A client is now paired with this host.";
  }

  function teardownDataChannel() {
    stopLatencyPings();
    if (!state.dataChannel) {
      return;
    }
    try {
      state.dataChannel.onopen = null;
      state.dataChannel.onmessage = null;
      state.dataChannel.onclose = null;
      state.dataChannel.onerror = null;
      state.dataChannel.close();
    } catch (error) {
      logError("webrtc", "Data channel close failed", error);
    }
    state.dataChannel = null;
    state.chatReady = false;
  }

  function teardownPeerConnection() {
    clearDirectAttemptTimer();
    clearPairingAttemptTimer();
    teardownDataChannel();
    if (state.peerConnection) {
      try {
        state.peerConnection.onicecandidate = null;
        state.peerConnection.ondatachannel = null;
        state.peerConnection.onconnectionstatechange = null;
        state.peerConnection.oniceconnectionstatechange = null;
        state.peerConnection.onicecandidateerror = null;
        state.peerConnection.close();
      } catch (error) {
        logError("webrtc", "Peer connection close failed", error);
      }
    }
    state.peerConnection = null;
    state.pendingRemoteCandidates = [];
    state.lastLatencyMs = null;
    state.peerState = state.currentPair ? "Connecting" : "Idle";
    renderLatencyMetric();
  }

  function hasRelayFallback() {
    return state.relayIceServers.length > 0
      && JSON.stringify(state.relayIceServers) !== JSON.stringify(state.directIceServers);
  }

  function activeIceServers() {
    if (state.currentIceMode === "relay" && state.relayIceServers.length) {
      return state.relayIceServers;
    }
    if (state.directIceServers.length) {
      return state.directIceServers;
    }
    return state.relayIceServers;
  }

  function sendProtocolPayload(payload) {
    if (!state.dataChannel || state.dataChannel.readyState !== "open") {
      throw new Error("The direct client channel is not ready yet.");
    }
    state.dataChannel.send(JSON.stringify(payload));
  }

  function scheduleLatencyPing(delay = LATENCY_PING_INTERVAL_MS) {
    stopLatencyPings();
    if (!state.chatReady || !state.dataChannel || state.dataChannel.readyState !== "open") {
      return;
    }
    state.latencyPingTimer = window.setTimeout(() => {
      state.latencyPingTimer = null;
      const sentAt = performance.now();
      try {
        sendProtocolPayload({
          type: PROTOCOL_TYPE_PING,
          id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
          sent_at: sentAt,
        });
      } catch (error) {
        logError("webrtc", "Failed to send latency ping", error);
        return;
      }
      scheduleLatencyPing(LATENCY_PING_INTERVAL_MS);
    }, delay);
  }

  async function promoteToRelayMode(reason) {
    if (!state.currentPair || state.chatReady || state.currentIceMode === "relay" || !hasRelayFallback()) {
      return;
    }
    log("webrtc", "Promoting to TURN relay mode", { reason });
    clearDirectAttemptTimer();
    state.currentIceMode = "relay";
    setSessionStatus("Direct path failed. Retrying with TURN relay.", "neutral");
    teardownPeerConnection();
    renderScreenState();
  }

  async function notifyRtcState(peerState) {
    state.peerState = peerState;
    if (!state.socketReady || !state.currentPair) {
      return;
    }
    try {
      state.socket.send(JSON.stringify({ type: "rtc_state", state: peerState.toLowerCase() }));
    } catch (error) {
      logError("webrtc", "Failed to report RTC state", error);
    }
  }

  async function flushPendingIceCandidates(connection) {
    if (!connection.remoteDescription) {
      return;
    }
    const queuedCandidates = [...state.pendingRemoteCandidates];
    state.pendingRemoteCandidates = [];
    for (const candidate of queuedCandidates) {
      try {
        await connection.addIceCandidate(candidate);
        log("signal", "Queued ICE candidate applied");
      } catch (error) {
        logError("signal", "Queued ICE candidate rejected", error);
      }
    }
  }

  function bindDataChannel(channel) {
    state.dataChannel = channel;
    channel.onopen = async () => {
      clearDirectAttemptTimer();
      clearPairingAttemptTimer();
      state.chatReady = true;
      appendChat("system", "Direct peer connection is ready.");
      setSessionStatus("Client connected successfully.", "success");
      renderScreenState();
      scheduleLatencyPing(LATENCY_PING_INITIAL_DELAY_MS);
      await notifyRtcState("Connected");
    };
    channel.onmessage = (event) => {
      handleProtocolMessage(event.data);
    };
    channel.onclose = async () => {
      state.chatReady = false;
      appendChat("system", "Direct peer channel closed.");
      renderScreenState();
      await notifyRtcState("Disconnected");
    };
    channel.onerror = (error) => {
      logError("webrtc", "Data channel error", error);
      appendChat("system", "A peer channel error occurred.");
      setSessionStatus("A peer channel error occurred.", "error");
    };
  }

  function ensurePeerConnection() {
    if (state.peerConnection) {
      return state.peerConnection;
    }

    const selectedIceServers = activeIceServers();
    const connection = new RTCPeerConnection({ iceServers: selectedIceServers, iceTransportPolicy: "all" });
    log("webrtc", "Creating RTCPeerConnection", {
      mode: state.currentIceMode,
      iceServers: selectedIceServers,
    });
    connection.onicecandidate = (event) => {
      if (!event.candidate || !state.socketReady || !state.currentPair) {
        return;
      }
      state.socket.send(JSON.stringify({
        type: "signal",
        target_peer_id: state.currentPair.peerId,
        signal: {
          kind: "ice_candidate",
          candidate: event.candidate,
          ice_mode: state.currentIceMode,
        },
      }));
    };
    connection.ondatachannel = (event) => {
      bindDataChannel(event.channel);
    };
    connection.oniceconnectionstatechange = () => {
      log("webrtc", "ICE connection state changed", connection.iceConnectionState || "unknown");
    };
    connection.onicecandidateerror = (event) => {
      logError("webrtc", "ICE candidate error", event);
    };
    connection.onconnectionstatechange = async () => {
      const nextState = connection.connectionState || "unknown";
      log("webrtc", "Peer connection state changed", nextState);
      if (nextState === "connected") {
        clearDirectAttemptTimer();
        await notifyRtcState("Connected");
      } else if (nextState === "connecting") {
        await notifyRtcState("Connecting");
      } else if (nextState === "disconnected") {
        if (!state.chatReady && state.currentIceMode === "direct" && hasRelayFallback()) {
          await promoteToRelayMode("direct_disconnected");
          return;
        }
        await notifyRtcState("Disconnected");
        setSessionStatus("The client connection was interrupted. Resetting the session.", "error");
      } else if (nextState === "failed") {
        if (!state.chatReady && state.currentIceMode === "direct" && hasRelayFallback()) {
          await promoteToRelayMode("direct_failed");
          return;
        }
        await notifyRtcState("Failed");
        setSessionStatus("Peer connection failed. Resetting the session.", "error");
      } else if (nextState === "closed") {
        await notifyRtcState("Closed");
      }
    };
    state.peerConnection = connection;
    return connection;
  }

  async function handleSignalMessage(payload) {
    log("signal", "Received signal", payload);
    const fromPeerId = payload.from_peer_id || payload.from_browser_id;
    if (!state.currentPair || fromPeerId !== state.currentPair.peerId) {
      return;
    }

    const signal = payload.signal || {};
    const incomingIceMode = signal.ice_mode === "relay" ? "relay" : "direct";
    if (signal.kind === "ice_candidate" && incomingIceMode !== state.currentIceMode) {
      log("webrtc", "Ignoring stale ICE candidate for old mode", {
        activeMode: state.currentIceMode,
        candidateMode: incomingIceMode,
      });
      return;
    }
    if ((signal.kind === "offer" || signal.kind === "answer") && incomingIceMode !== state.currentIceMode) {
      log("webrtc", "Switching ICE mode from remote signal", {
        from: state.currentIceMode,
        to: incomingIceMode,
        kind: signal.kind,
      });
      state.currentIceMode = incomingIceMode;
      teardownPeerConnection();
      renderScreenState();
    }
    let connection = ensurePeerConnection();

    try {
      if (signal.kind === "offer") {
        if (connection.signalingState !== "stable") {
          teardownPeerConnection();
          connection = ensurePeerConnection();
        }
        await connection.setRemoteDescription(new RTCSessionDescription(signal.sdp));
        await flushPendingIceCandidates(connection);
        const answer = await connection.createAnswer();
        await connection.setLocalDescription(answer);
        state.socket.send(JSON.stringify({
          type: "signal",
          target_peer_id: state.currentPair.peerId,
          signal: {
            kind: "answer",
            sdp: answer,
            ice_mode: state.currentIceMode,
          },
        }));
        state.peerState = "Signaling";
        return;
      }

      if (signal.kind === "answer") {
        if (!connection.localDescription) {
          return;
        }
        await connection.setRemoteDescription(new RTCSessionDescription(signal.sdp));
        await flushPendingIceCandidates(connection);
        return;
      }

      if (signal.kind === "ice_candidate" && signal.candidate) {
        if (!connection.remoteDescription) {
          log("signal", "Queueing ICE candidate until remote description is set");
          state.pendingRemoteCandidates.push(signal.candidate);
          return;
        }
        await connection.addIceCandidate(signal.candidate);
      }
    } catch (error) {
      logError("signal", "Failed to process signal", { signal, error });
      setSessionStatus("The direct connection signaling failed.", "error");
      await notifyRtcState("Failed");
    }
  }

  async function handlePairingStarted(payload) {
    log("pairing", "Pairing started", payload);
    teardownPeerConnection();
    state.currentIceMode = "direct";
    resetChatLog("Client connected. Negotiating direct WebRTC channel.");
    state.currentPair = {
      pairId: payload.pair_id,
      peerId: payload.peer_id,
      peerRole: payload.peer_role,
      peerDisplayName: payload.peer_display_name || "Client",
    };
    state.peerState = "Signaling";
    state.chatReady = false;
    setSessionStatus("Client connected. Negotiating secure direct channel.", "success");
    renderScreenState();
    startPairingAttemptTimer();
    startDirectAttemptTimer();
  }

  async function handlePairingCleared(payload) {
    log("pairing", "Pairing cleared", payload);
    teardownPeerConnection();
    state.currentIceMode = "direct";
    state.currentPair = null;
    state.peerState = "Idle";
    state.chatReady = false;
    const reasonLabel = humanizeReason(payload.reason);
    resetChatLog(`Connection ended because ${reasonLabel}.`);
    renderScreenState();
    setWaitingStatus(`Online and waiting. ${payload.reason ? `Last session ended because ${reasonLabel}.` : ""}`.trim(), "neutral");
  }

  function handleProtocolMessage(raw) {
    let payload = null;
    try {
      payload = JSON.parse(raw);
    } catch {
      appendChat("peer", `Client: ${raw}`);
      return;
    }

    if (payload?.type === PROTOCOL_TYPE_CHAT) {
      appendChat("peer", `Client: ${payload.text || ""}`);
      return;
    }
    if (payload?.type === PROTOCOL_TYPE_PING && payload.id) {
      try {
        sendProtocolPayload({ type: PROTOCOL_TYPE_PONG, id: payload.id, sent_at: payload.sent_at });
      } catch (error) {
        logError("webrtc", "Failed to respond to ping", error);
      }
      return;
    }
    if (payload?.type === PROTOCOL_TYPE_PONG && typeof payload.sent_at === "number") {
      state.lastLatencyMs = Math.max(0, Math.round(performance.now() - payload.sent_at));
      renderLatencyMetric();
    }
  }

  async function loadConfig() {
    state.runtime = await window.omniHost.getRuntimeInfo();
    state.config = await window.omniHost.loadConfig();
    const nextConfig = {};
    if (!state.config.display_name) {
      nextConfig.display_name = state.runtime.deviceName;
    }
    if (!state.config.server_url) {
      nextConfig.server_url = state.runtime.defaultServerUrl;
    }
    if (Object.keys(nextConfig).length) {
      state.config = await window.omniHost.saveConfig({
        ...state.config,
        ...nextConfig,
      });
    }
    renderDetails();
  }

  async function persistConfig(nextConfig) {
    state.config = await window.omniHost.saveConfig({
      ...state.config,
      ...nextConfig,
    });
    renderDetails();
    return state.config;
  }

  async function loadBackendConfig() {
    const data = await fetchJson(apiUrl("/api/config"));
    state.directIceServers = data.direct_ice_servers || [];
    state.relayIceServers = data.ice_servers || data.stun_servers || [];
    state.stunServers = state.directIceServers.length ? state.directIceServers : state.relayIceServers;
    state.iceSource = data.ice_source || "unknown";
    log("webrtc", "Loaded ICE config", {
      source: state.iceSource,
      directCount: state.directIceServers.length,
      relayCount: state.relayIceServers.length,
    });
    renderDetails();
  }

  function stopSocket() {
    clearDirectAttemptTimer();
    clearPairingAttemptTimer();
    if (state.socket) {
      try {
        state.socket.onclose = null;
        state.socket.close();
      } catch (error) {
        logError("socket", "Socket close failed", error);
      }
    }
    stopHeartbeat();
    state.socket = null;
    state.socketReady = false;
  }

  async function registerHost() {
    await fetchJson(apiUrl("/api/host-v1/register"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        host_id: state.config.host_id,
        host_code: state.config.host_code,
        display_name: state.config.display_name,
        device_name: state.runtime.deviceName,
      }),
    });
  }

  async function openSocket(forceReconnect = false) {
    log("socket", "Open socket requested", { forceReconnect });
    if (state.socket && state.socketReady && !forceReconnect) {
      return;
    }

    stopSocket();
    const socket = new WebSocket(hostSocketUrl());
    state.socket = socket;

    socket.onopen = () => {
      log("socket", "WebSocket opened");
      clearReconnectTimer();
      state.reconnectDelayMs = 2000;
      state.socketReady = true;
      startHeartbeat();
      setWaitingStatus(`Online and waiting. Share PIN ${state.config.host_code} with the client.`, "success");
      renderDetails();
    };

    socket.onmessage = async (event) => {
      const payload = JSON.parse(event.data);
      if (payload.type === "welcome" || payload.type === "hosts_snapshot") {
        return;
      }
      if (payload.type === "pairing_started") {
        await handlePairingStarted(payload);
        return;
      }
      if (payload.type === "pairing_cleared") {
        await handlePairingCleared(payload);
        return;
      }
      if (payload.type === "signal") {
        await handleSignalMessage(payload);
        return;
      }
      if (payload.type === "error") {
        clearPairingAttemptTimer();
        if (state.currentPair) {
          setSessionStatus(payload.message || "An error occurred.", "error");
        } else {
          setWaitingStatus(payload.message || "An error occurred.", "error");
        }
      }
    };

    socket.onclose = async (event) => {
      log("socket", "WebSocket closed", { code: event.code, reason: event.reason });
      stopHeartbeat();
      state.socketReady = false;
      state.socket = null;
      clearPairingAttemptTimer();
      if (state.currentPair) {
        await handlePairingCleared({ reason: "signaling_socket_closed" });
      }
      setWaitingStatus(`Connection to OmniPortal was lost${event.reason ? `: ${event.reason}` : "."}`, "error");
      scheduleReconnect(event.reason || "signal_lost");
    };

    socket.onerror = (error) => {
      logError("socket", "WebSocket error", error);
      setWaitingStatus("Host signaling channel encountered an error.", "error");
    };
  }

  async function ensureHostOnline(forceReconnect = false) {
    await registerHost();
    await loadBackendConfig();
    await openSocket(forceReconnect);
  }

  function closeOverlay() {
    editOverlay.classList.add("hidden");
    overlayBody.innerHTML = "";
    state.modalMode = null;
    state.modalPinGenerated = false;
  }

  async function openOverlay(mode) {
    state.modalMode = mode;
    state.modalPinGenerated = false;

    if (mode === "display_name") {
      overlayTitle.textContent = "Edit Host Name";
      overlayCopy.textContent = "Choose the name clients see before they connect.";
      overlayBody.innerHTML = `<input id="overlayInput" maxlength="50" value="${state.config.display_name.replace(/"/g, "&quot;")}" placeholder="Gaming PC">`;
      overlaySaveButton.textContent = "Save";
    } else if (mode === "server_url") {
      overlayTitle.textContent = "Edit Server URL";
      overlayCopy.textContent = "Change the OmniPortal backend URL used by this host app. The host will reconnect after you save.";
      overlayBody.innerHTML = `<input id="overlayInput" value="${state.config.server_url.replace(/"/g, "&quot;")}" placeholder="https://omniportal.ronanrocking.com">`;
      overlaySaveButton.textContent = "Save";
    } else if (mode === "host_code") {
      overlayTitle.textContent = "Refresh Host PIN";
      overlayCopy.textContent = "Host PINs stay stable until you explicitly refresh them. Refreshing the PIN disconnects any client using the old one.";
      overlayBody.innerHTML = `
        <div class="pin-preview">
          <div>
            <span class="detail-label">Current PIN</span>
            <div class="detail-value mono" id="overlayPinValue">${state.config.host_code}</div>
          </div>
          <button class="secondary-button" id="overlayGenerateButton">Generate New PIN</button>
        </div>
      `;
      overlaySaveButton.textContent = "Done";
      overlayBody.querySelector("#overlayGenerateButton").addEventListener("click", async () => {
        try {
          state.config = await window.omniHost.regenerateCode();
          state.modalPinGenerated = true;
          overlayBody.querySelector("#overlayPinValue").textContent = state.config.host_code;
          renderDetails();
        } catch (error) {
          logError("settings", "Failed to regenerate host PIN", error);
          setWaitingStatus(error.message, "error");
        }
      });
    }

    editOverlay.classList.remove("hidden");
    const input = overlayBody.querySelector("#overlayInput");
    if (input) {
      input.focus();
      input.select();
    }
  }

  async function saveOverlay() {
    if (!state.modalMode) {
      closeOverlay();
      return;
    }

    try {
      if (state.modalMode === "display_name") {
        const input = overlayBody.querySelector("#overlayInput");
        const nextValue = input.value.trim();
        if (!nextValue) {
          throw new Error("Host name cannot be empty.");
        }
        await persistConfig({ display_name: nextValue });
        await ensureHostOnline(true);
        setWaitingStatus(`Online and waiting. Share PIN ${state.config.host_code} with the client.`, "success");
      } else if (state.modalMode === "server_url") {
        const input = overlayBody.querySelector("#overlayInput");
        const nextValue = validateServerUrl(input.value);
        await persistConfig({ server_url: nextValue });
        await ensureHostOnline(true);
        setWaitingStatus(`Connected to ${state.config.server_url}. Waiting for a client.`, "success");
      } else if (state.modalMode === "host_code" && state.modalPinGenerated) {
        await ensureHostOnline(true);
        setWaitingStatus(`Online with refreshed PIN ${state.config.host_code}. Share it with the client.`, "success");
      }
      closeOverlay();
    } catch (error) {
      logError("settings", "Failed to save edited detail", error);
      setWaitingStatus(error.message, "error");
    }
  }

  function sendMessage() {
    const text = chatInput.value.trim().slice(0, MAX_CHAT_MESSAGE_LENGTH);
    if (!text) {
      return;
    }
    if (!state.chatReady || !state.dataChannel || state.dataChannel.readyState !== "open") {
      setSessionStatus("The direct client channel is not ready yet.", "error");
      return;
    }
    sendProtocolPayload({ type: PROTOCOL_TYPE_CHAT, text });
    appendChat("self", `You: ${text}`);
    chatInput.value = "";
  }

  async function disconnectClient() {
    if (!state.currentPair || !state.socketReady) {
      return;
    }
    state.socket.send(JSON.stringify({ type: "leave_pair" }));
    await handlePairingCleared({ reason: "left_by_user" });
  }

  async function boot() {
    renderScreenState();
    renderDetails();
    try {
      await loadConfig();
      await ensureHostOnline();
    } catch (error) {
      logError("boot", "Host boot failed", error);
      setWaitingStatus(`Could not connect to OmniPortal: ${error.message}`, "error");
      scheduleReconnect("boot_failed");
    }
  }

  document.querySelectorAll("[data-edit]").forEach((button) => {
    button.addEventListener("click", () => {
      openOverlay(button.dataset.edit).catch((error) => {
        logError("overlay", "Failed to open overlay", error);
        setWaitingStatus(error.message, "error");
      });
    });
  });

  overlaySaveButton.addEventListener("click", () => {
    saveOverlay().catch((error) => {
      logError("overlay", "Unhandled overlay save error", error);
      setWaitingStatus(error.message, "error");
    });
  });

  overlayCancelButton.addEventListener("click", closeOverlay);
  overlayCloseButton.addEventListener("click", closeOverlay);
  document.querySelectorAll("[data-close-overlay='true']").forEach((element) => {
    element.addEventListener("click", closeOverlay);
  });

  leavePairButton.addEventListener("click", () => {
    disconnectClient().catch((error) => {
      logError("pairing", "Unhandled disconnect error", error);
      setSessionStatus(error.message, "error");
    });
  });

  chatInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      sendMessage();
    }
  });

  sendMessageButton.addEventListener("click", sendMessage);

  window.addEventListener("beforeunload", () => {
    state.autoConnectEnabled = false;
    clearReconnectTimer();
    stopSocket();
  });

  boot();
})();
