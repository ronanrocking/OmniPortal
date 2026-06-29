import { createLogger, fetchJson, setStatus, socketUrl, startHeartbeat, stopHeartbeat } from "/frontend/shared.js";

const logger = createLogger("OmniPortalClient");
const state = {
  me: null,
  stunServers: [],
  socket: null,
  socketReady: false,
  heartbeatTimer: null,
  hosts: [],
  currentPair: null,
  peerState: "Idle",
  chatReady: false,
  peerConnection: null,
  dataChannel: null,
  reconnectTimer: null,
  reconnectDelayMs: 2000,
  autoConnectEnabled: true,
  pendingPin: "",
  awaitingPairing: false,
};

const connectScreen = document.getElementById("connectScreen");
const chatScreen = document.getElementById("chatScreen");
const statusBox = document.getElementById("statusBox");
const sessionStatusBox = document.getElementById("sessionStatusBox");
const sessionTitle = document.getElementById("sessionTitle");
const sessionSubtitle = document.getElementById("sessionSubtitle");
const hostCodeInput = document.getElementById("hostCodeInput");
const leavePairButton = document.getElementById("leavePairButton");
const chatLog = document.getElementById("chatLog");
const chatInput = document.getElementById("chatInput");
const sendMessageButton = document.getElementById("sendMessageButton");

function normalizeHost(host) {
  const hostId = host.host_id || host.hostId || null;
  const connectId = host.connect_id || host.connectId || host.browser_id || host.browserId || (hostId ? `host:${hostId}` : null);
  return {
    connectId,
    displayName: host.display_name || host.displayName || host.host_name || host.hostName || "Unnamed host",
    hostCode: host.host_code || host.hostCode || "",
    deviceName: host.device_name || host.deviceName || "",
    online: Boolean(host.online),
    available: Boolean(host.available),
    paired: Boolean(host.paired),
    status: host.status || (host.online ? "online" : "offline"),
  };
}

function setInitialStatus(message, tone = "neutral") {
  setStatus(statusBox, logger, message, tone);
}

function setSessionStatus(message, tone = "neutral") {
  setStatus(sessionStatusBox, logger, message, tone);
}

function showConnectScreen() {
  connectScreen.classList.remove("hidden");
  chatScreen.classList.add("hidden");
  hostCodeInput.focus();
}

function showChatScreen() {
  connectScreen.classList.add("hidden");
  chatScreen.classList.remove("hidden");
}

function renderSessionState() {
  const connected = Boolean(state.currentPair);
  chatInput.disabled = !state.chatReady;
  sendMessageButton.disabled = !state.chatReady;
  leavePairButton.disabled = !connected;
  if (connected) {
    sessionTitle.textContent = state.currentPair.peerDisplayName || "Connected Host";
    sessionSubtitle.textContent = state.chatReady
      ? "Direct WebRTC chat is active."
      : "Negotiating the direct peer connection.";
    showChatScreen();
    return;
  }
  sessionTitle.textContent = "OmniPortal Chat";
  sessionSubtitle.textContent = "Connected to the selected host.";
  showConnectScreen();
}

function appendChat(kind, text) {
  logger.logEvent("chat", `Appending ${kind} row`, text);
  if (chatLog.children.length === 1 && chatLog.textContent.includes("Waiting for the host to connect.")) {
    chatLog.innerHTML = "";
  }
  const row = document.createElement("div");
  row.className = `chat-row ${kind}`;
  row.textContent = text;
  chatLog.appendChild(row);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function resetChatLog(message = "Waiting for the host to connect.") {
  logger.logEvent("chat", "Resetting chat log", message);
  chatLog.innerHTML = "";
  appendChat("system", message);
}

async function loadConfig() {
  const data = await fetchJson("/api/config", undefined, logger);
  state.stunServers = data.stun_servers || [];
}

async function ensureClientMode() {
  await fetchJson("/api/client/join", { method: "POST" }, logger);
  state.me = await fetchJson("/api/me", undefined, logger);
}

function teardownDataChannel() {
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
    logger.logError("webrtc", "Data channel close failed", error);
  }
  state.dataChannel = null;
  state.chatReady = false;
}

function teardownPeerConnection() {
  teardownDataChannel();
  if (state.peerConnection) {
    try {
      state.peerConnection.onicecandidate = null;
      state.peerConnection.ondatachannel = null;
      state.peerConnection.onconnectionstatechange = null;
      state.peerConnection.close();
    } catch (error) {
      logger.logError("webrtc", "Peer connection close failed", error);
    }
  }
  state.peerConnection = null;
  state.peerState = state.currentPair ? "Connecting" : "Idle";
}

async function notifyRtcState(peerState) {
  state.peerState = peerState;
  if (!state.socketReady || !state.currentPair) {
    return;
  }
  try {
    state.socket.send(JSON.stringify({ type: "rtc_state", state: peerState.toLowerCase() }));
  } catch (error) {
    logger.logError("webrtc", "Failed to report RTC state", error);
  }
}

function bindDataChannel(channel) {
  logger.logEvent("webrtc", "Binding data channel", { label: channel.label, readyState: channel.readyState });
  state.dataChannel = channel;
  channel.onopen = async () => {
    state.chatReady = true;
    appendChat("system", "Direct peer connection is ready.");
    setSessionStatus("Host connected successfully.", "success");
    renderSessionState();
    await notifyRtcState("Connected");
  };
  channel.onmessage = (event) => {
    logger.logEvent("webrtc", "Message received", event.data);
    appendChat("peer", `Host: ${event.data}`);
  };
  channel.onclose = async () => {
    state.chatReady = false;
    appendChat("system", "Direct peer channel closed.");
    renderSessionState();
    await notifyRtcState("Disconnected");
  };
  channel.onerror = (error) => {
    logger.logError("webrtc", "Data channel error", error);
    appendChat("system", "A peer channel error occurred.");
    setSessionStatus("A peer channel error occurred.", "error");
  };
}

function ensurePeerConnection() {
  if (state.peerConnection) {
    return state.peerConnection;
  }
  const connection = new RTCPeerConnection({ iceServers: state.stunServers });
  logger.logEvent("webrtc", "Creating RTCPeerConnection", state.stunServers);
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
      },
    }));
  };
  connection.ondatachannel = (event) => {
    bindDataChannel(event.channel);
  };
  connection.onconnectionstatechange = async () => {
    const nextState = connection.connectionState || "unknown";
    logger.logEvent("webrtc", "Peer connection state changed", nextState);
    if (nextState === "connected") {
      await notifyRtcState("Connected");
    } else if (nextState === "connecting") {
      await notifyRtcState("Connecting");
    } else if (nextState === "disconnected") {
      await notifyRtcState("Disconnected");
      setSessionStatus("Peer link disconnected. Returning to PIN entry.", "error");
    } else if (nextState === "failed") {
      await notifyRtcState("Failed");
      setSessionStatus("Direct peer connection failed. Returning to PIN entry.", "error");
    } else if (nextState === "closed") {
      await notifyRtcState("Closed");
    }
  };
  state.peerConnection = connection;
  return connection;
}

async function startOffer() {
  if (!state.currentPair) {
    return;
  }
  const connection = ensurePeerConnection();
  if (!state.dataChannel) {
    bindDataChannel(connection.createDataChannel("chat"));
  }
  const offer = await connection.createOffer();
  await connection.setLocalDescription(offer);
  state.socket.send(JSON.stringify({
    type: "signal",
    target_peer_id: state.currentPair.peerId,
    signal: {
      kind: "offer",
      sdp: offer,
    },
  }));
  state.peerState = "Signaling";
}

async function handleSignalMessage(payload) {
  logger.logEvent("signal", "Received signal", payload);
  const fromPeerId = payload.from_peer_id || payload.from_browser_id;
  if (!state.currentPair || fromPeerId !== state.currentPair.peerId) {
    return;
  }

  const signal = payload.signal || {};
  let connection = ensurePeerConnection();

  if (signal.kind === "offer") {
    if (connection.signalingState !== "stable") {
      teardownPeerConnection();
      connection = ensurePeerConnection();
    }
    await connection.setRemoteDescription(new RTCSessionDescription(signal.sdp));
    const answer = await connection.createAnswer();
    await connection.setLocalDescription(answer);
    state.socket.send(JSON.stringify({
      type: "signal",
      target_peer_id: state.currentPair.peerId,
      signal: {
        kind: "answer",
        sdp: answer,
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
    return;
  }

  if (signal.kind === "ice_candidate" && signal.candidate) {
    try {
      await connection.addIceCandidate(signal.candidate);
    } catch (error) {
      logger.logError("signal", "ICE candidate rejected", error);
    }
  }
}

async function handlePairingStarted(payload) {
  logger.logEvent("pairing", "Pairing started", payload);
  teardownPeerConnection();
  resetChatLog("Host selected. Negotiating direct WebRTC channel.");
  state.currentPair = {
    pairId: payload.pair_id,
    peerId: payload.peer_id || payload.peer_browser_id,
    peerRole: payload.peer_role,
    peerDisplayName: payload.peer_display_name || "Connected Host",
  };
  state.awaitingPairing = false;
  state.pendingPin = "";
  hostCodeInput.value = "";
  state.peerState = "Signaling";
  setSessionStatus("Pairing accepted. Negotiating direct connection.", "success");
  renderSessionState();
  if (payload.initiator) {
    await startOffer();
  }
}

async function handlePairingCleared(payload) {
  logger.logEvent("pairing", "Pairing cleared", payload);
  teardownPeerConnection();
  state.currentPair = null;
  state.awaitingPairing = false;
  state.peerState = "Idle";
  state.chatReady = false;
  resetChatLog(`Connection ended: ${payload.reason || "peer left"}.`);
  renderSessionState();
  setInitialStatus(`Connection ended: ${payload.reason || "peer left"}. Enter a host PIN to connect again.`, "neutral");
}

function clearReconnectTimer() {
  if (state.reconnectTimer) {
    window.clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
}

async function loadHosts() {
  const data = await fetchJson("/api/hosts", undefined, logger);
  state.hosts = (data.hosts || []).map(normalizeHost);
}

async function attemptPendingPin() {
  if (state.pendingPin && state.pendingPin.length === 6 && state.socketReady && !state.awaitingPairing && !state.currentPair) {
    await startPairing(state.pendingPin);
  }
}

function scheduleReconnect(reason = "signal_lost") {
  if (!state.autoConnectEnabled || state.reconnectTimer) {
    return;
  }
  const delay = state.reconnectDelayMs;
  state.reconnectTimer = window.setTimeout(() => {
    state.reconnectTimer = null;
    ensureClientConnected(true).catch((error) => {
      logger.logError("socket", "Reconnect attempt failed", error);
      setInitialStatus(`Reconnecting to OmniPortal failed: ${error.message}`, "error");
      state.reconnectDelayMs = Math.min(state.reconnectDelayMs * 2, 15000);
      scheduleReconnect(reason);
    });
  }, delay);
  setInitialStatus("Reconnecting to OmniPortal...", reason === "signal_lost" ? "neutral" : "error");
}

function stopSocket() {
  if (state.socket) {
    try {
      state.socket.onclose = null;
      state.socket.close();
    } catch (error) {
      logger.logError("socket", "Socket close failed", error);
    }
  }
  stopHeartbeat(state.heartbeatTimer);
  state.heartbeatTimer = null;
  state.socket = null;
  state.socketReady = false;
}

async function openSocket(forceReconnect = false) {
  logger.logEvent("socket", "Open socket requested", { forceReconnect });
  if (state.socket && state.socketReady && !forceReconnect) {
    return;
  }

  stopSocket();
  const socket = new WebSocket(socketUrl());
  state.socket = socket;

  socket.onopen = async () => {
    logger.logEvent("socket", "WebSocket opened");
    clearReconnectTimer();
    state.reconnectDelayMs = 2000;
    state.socketReady = true;
    state.heartbeatTimer = startHeartbeat(() => state.socket, logger);
    setInitialStatus("Connected to OmniPortal. Enter the 6-digit host PIN.", "success");
    await loadHosts();
    await attemptPendingPin();
  };

  socket.onmessage = async (event) => {
    logger.logEvent("socket", "WebSocket message received", event.data);
    const payload = JSON.parse(event.data);
    if (payload.type === "welcome") {
      return;
    }
    if (payload.type === "hosts_snapshot") {
      state.hosts = (payload.hosts || []).map(normalizeHost);
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
      state.awaitingPairing = false;
      if (!state.currentPair) {
        setInitialStatus(payload.message || "Unable to connect to that host PIN.", "error");
      } else {
        setSessionStatus(payload.message || "An error occurred.", "error");
      }
    }
  };

  socket.onclose = async (event) => {
    logger.logEvent("socket", "WebSocket closed", { code: event.code, reason: event.reason });
    stopHeartbeat(state.heartbeatTimer);
    state.heartbeatTimer = null;
    state.socketReady = false;
    state.socket = null;
    state.awaitingPairing = false;
    if (state.currentPair) {
      await handlePairingCleared({ reason: "signaling_socket_closed" });
    }
    scheduleReconnect(event.reason || "signal_lost");
  };

  socket.onerror = (error) => {
    logger.logError("socket", "WebSocket error", error);
    setInitialStatus("Client signaling channel encountered an error.", "error");
  };
}

async function ensureClientConnected(forceReconnect = false) {
  await ensureClientMode();
  await openSocket(forceReconnect);
}

async function startPairing(hostCode) {
  const normalizedPin = String(hostCode || "").replace(/\D/g, "").slice(0, 6);
  logger.logEvent("pairing", "Client requested pairing", { hostCode: normalizedPin });
  hostCodeInput.value = normalizedPin;
  state.pendingPin = normalizedPin;

  if (!/^\d{6}$/.test(normalizedPin)) {
    setInitialStatus("Enter a valid 6-digit host PIN.", "error");
    return;
  }
  if (!state.socketReady) {
    setInitialStatus("Connecting to OmniPortal first. Your PIN will be submitted automatically.", "neutral");
    return;
  }
  if (state.currentPair || state.awaitingPairing) {
    return;
  }

  const matchingHost = state.hosts.find((host) => host.hostCode === normalizedPin);
  state.awaitingPairing = true;
  resetChatLog("Requested host pairing. Waiting for signaling to start.");
  state.socket.send(JSON.stringify({
    type: "connect_to_host",
    connect_id: matchingHost?.connectId || null,
    host_code: normalizedPin,
  }));
  setInitialStatus("PIN submitted. Waiting for the host to respond.", "success");
}

function sendMessage() {
  const text = chatInput.value.trim();
  logger.logEvent("click", "Send message button clicked", { textLength: text.length });
  if (!text) {
    return;
  }
  if (!state.chatReady || !state.dataChannel || state.dataChannel.readyState !== "open") {
    setSessionStatus("The direct host channel is not ready yet.", "error");
    return;
  }
  state.dataChannel.send(text);
  appendChat("self", `You: ${text}`);
  chatInput.value = "";
}

async function disconnectHost() {
  logger.logEvent("click", "Disconnect host button clicked", state.currentPair);
  if (!state.currentPair || !state.socketReady) {
    return;
  }
  state.socket.send(JSON.stringify({ type: "leave_pair" }));
  await handlePairingCleared({ reason: "left_by_user" });
}

async function boot() {
  logger.logEvent("boot", "Client page boot started");
  renderSessionState();
  hostCodeInput.focus();
  try {
    await loadConfig();
    await ensureClientConnected();
    logger.logEvent("boot", "Client page boot completed");
  } catch (error) {
    logger.logError("boot", "Client page boot failed", error);
    setInitialStatus(`Could not connect to OmniPortal: ${error.message}`, "error");
    scheduleReconnect("boot_failed");
  }
}

hostCodeInput.addEventListener("input", () => {
  const numeric = hostCodeInput.value.replace(/\D/g, "").slice(0, 6);
  if (hostCodeInput.value !== numeric) {
    hostCodeInput.value = numeric;
  }
  if (numeric.length === 6) {
    startPairing(numeric).catch((error) => {
      logger.logError("pairing", "Unhandled connect error", error);
      setInitialStatus(error.message, "error");
      state.awaitingPairing = false;
    });
  }
});

hostCodeInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    startPairing(hostCodeInput.value).catch((error) => {
      logger.logError("pairing", "Unhandled connect error", error);
      setInitialStatus(error.message, "error");
      state.awaitingPairing = false;
    });
  }
});

leavePairButton.addEventListener("click", () => {
  disconnectHost().catch((error) => {
    logger.logError("pairing", "Unhandled disconnect error", error);
    setSessionStatus(error.message, "error");
  });
});

chatInput.addEventListener("keydown", (event) => {
  logger.logEvent("input", "Chat keydown", { key: event.key });
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

await boot();
