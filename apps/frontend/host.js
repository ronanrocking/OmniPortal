import { createLogger, fetchJson, formatTime, setStatus, socketUrl, startHeartbeat, stopHeartbeat } from "/frontend/shared.js";

const logger = createLogger("OmniPortalHost");
const state = {
  me: null,
  stunServers: [],
  socket: null,
  socketReady: false,
  heartbeatTimer: null,
  currentPair: null,
  peerState: "Idle",
  chatReady: false,
  peerConnection: null,
  dataChannel: null,
};

const currentRoleMetric = document.getElementById("currentRoleMetric");
const socketMetric = document.getElementById("socketMetric");
const peerMetric = document.getElementById("peerMetric");
const statusBox = document.getElementById("statusBox");
const hostNameInput = document.getElementById("hostNameInput");
const startHostButton = document.getElementById("startHostButton");
const resetSessionButton = document.getElementById("resetSessionButton");
const mePanel = document.getElementById("mePanel");
const connectionPanel = document.getElementById("connectionPanel");
const leavePairButton = document.getElementById("leavePairButton");
const chatCaption = document.getElementById("chatCaption");
const chatLog = document.getElementById("chatLog");
const chatInput = document.getElementById("chatInput");
const sendMessageButton = document.getElementById("sendMessageButton");

function renderMetrics() {
  currentRoleMetric.textContent = state.me?.session?.role ? state.me.session.role.toUpperCase() : "Not hosting";
  socketMetric.textContent = state.socketReady ? "Connected" : "Disconnected";
  peerMetric.textContent = state.peerState;
  leavePairButton.classList.toggle("hidden", !state.currentPair);
  chatInput.disabled = !state.chatReady;
  sendMessageButton.disabled = !state.chatReady;
  chatCaption.textContent = state.chatReady
    ? `Direct WebRTC chat is active with ${state.currentPair?.peerRole || "client"}.`
    : "A client must connect before messages can be sent.";
  logger.logEvent("ui", "Metrics refreshed", {
    role: state.me?.session?.role,
    socketReady: state.socketReady,
    peerState: state.peerState,
    chatReady: state.chatReady,
  });
}

function appendChat(kind, text) {
  logger.logEvent("chat", `Appending ${kind} row`, text);
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
  logger.logEvent("chat", "Resetting chat log", message);
  chatLog.innerHTML = "";
  appendChat("system", message);
}

function renderMe() {
  const session = state.me?.session;
  if (!session) {
    mePanel.innerHTML = '<div class="empty-card">This browser is not hosting yet.</div>';
    return;
  }

  const hostName = session.host_name ? `<div class="tiny-note">Host name: ${session.host_name}</div>` : "";
  mePanel.innerHTML = `
    <div class="item-card">
      <strong>Browser Identity</strong>
      <div class="tiny-note mono">${session.browser_id}</div>
      <div class="pill-row">
        <span class="pill host">${session.role.toUpperCase()}</span>
        <span class="pill ${session.online ? "ok" : "warn"}">${session.online ? "Online" : "Offline"}</span>
      </div>
      ${hostName}
    </div>
  `;
}

function renderConnection() {
  if (!state.currentPair) {
    connectionPanel.innerHTML = '<div class="empty-card">No client is connected right now.</div>';
    return;
  }
  connectionPanel.innerHTML = `
    <div class="item-card">
      <strong>Connected Client</strong>
      <div class="tiny-note mono">${state.currentPair.peerBrowserId}</div>
      <div class="pill-row">
        <span class="pill client">${state.currentPair.peerRole.toUpperCase()}</span>
        <span class="pill ok">${state.peerState}</span>
      </div>
    </div>
  `;
}

function renderAll() {
  renderMe();
  renderConnection();
  renderMetrics();
}

async function loadConfig() {
  const data = await fetchJson("/api/config", undefined, logger);
  state.stunServers = data.stun_servers || [];
}

async function loadMe() {
  state.me = await fetchJson("/api/me", undefined, logger);
  if (state.me.session?.host_name) {
    hostNameInput.value = state.me.session.host_name;
  }
  renderAll();
}

function teardownDataChannel() {
  if (!state.dataChannel) {
    return;
  }
  logger.logEvent("webrtc", "Tearing down data channel", { readyState: state.dataChannel.readyState });
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
    logger.logEvent("webrtc", "Tearing down peer connection", { state: state.peerConnection.connectionState });
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
  renderMetrics();
}

async function notifyRtcState(peerState) {
  state.peerState = peerState;
  renderMetrics();
  if (!state.socketReady || !state.currentPair) {
    return;
  }
  try {
    logger.logEvent("webrtc", "Reporting RTC state", peerState);
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
    await notifyRtcState("Connected");
  };
  channel.onmessage = (event) => {
    logger.logEvent("webrtc", "Message received", event.data);
    appendChat("peer", `Client: ${event.data}`);
  };
  channel.onclose = async () => {
    state.chatReady = false;
    appendChat("system", "Direct peer channel closed.");
    await notifyRtcState("Disconnected");
    renderMetrics();
  };
  channel.onerror = (error) => {
    logger.logError("webrtc", "Data channel error", error);
    appendChat("system", "A peer channel error occurred.");
  };
}

function ensurePeerConnection() {
  if (state.peerConnection) {
    return state.peerConnection;
  }
  logger.logEvent("webrtc", "Creating RTCPeerConnection", state.stunServers);
  const connection = new RTCPeerConnection({ iceServers: state.stunServers });
  connection.onicecandidate = (event) => {
    if (!event.candidate || !state.socketReady || !state.currentPair) {
      return;
    }
    logger.logEvent("webrtc", "Generated ICE candidate", event.candidate);
    state.socket.send(JSON.stringify({
      type: "signal",
      target_browser_id: state.currentPair.peerBrowserId,
      signal: {
        kind: "ice_candidate",
        candidate: event.candidate,
      },
    }));
  };
  connection.ondatachannel = (event) => {
    logger.logEvent("webrtc", "Remote data channel received", { label: event.channel.label });
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
    } else if (nextState === "failed") {
      await notifyRtcState("Failed");
      setStatus(statusBox, logger, "Direct peer connection failed. Wait for the client to reconnect.", "error");
    } else if (nextState === "closed") {
      await notifyRtcState("Closed");
    }
  };
  state.peerConnection = connection;
  return connection;
}

async function handleSignalMessage(payload) {
  logger.logEvent("signal", "Received signal", payload);
  if (!state.currentPair || payload.from_browser_id !== state.currentPair.peerBrowserId) {
    logger.logEvent("signal", "Ignoring signal from non-current peer", payload);
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
      target_browser_id: state.currentPair.peerBrowserId,
      signal: {
        kind: "answer",
        sdp: answer,
      },
    }));
    state.peerState = "Signaling";
    renderMetrics();
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
  resetChatLog("Client connected. Negotiating direct WebRTC channel.");
  state.currentPair = {
    pairId: payload.pair_id,
    peerBrowserId: payload.peer_browser_id,
    peerRole: payload.peer_role,
  };
  state.peerState = "Signaling";
  state.chatReady = false;
  renderAll();
}

async function handlePairingCleared(payload) {
  logger.logEvent("pairing", "Pairing cleared", payload);
  teardownPeerConnection();
  state.currentPair = null;
  state.peerState = "Idle";
  state.chatReady = false;
  resetChatLog(`Connection ended: ${payload.reason || "peer left"}.`);
  renderAll();
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
  if (state.me?.session?.role !== "host") {
    return;
  }
  if (state.socket && state.socketReady && !forceReconnect) {
    return;
  }

  stopSocket();
  renderMetrics();
  const socket = new WebSocket(socketUrl());
  state.socket = socket;

  socket.onopen = () => {
    logger.logEvent("socket", "WebSocket opened");
    state.socketReady = true;
    state.heartbeatTimer = startHeartbeat(() => state.socket, logger);
    setStatus(statusBox, logger, "Host signaling channel connected.", "success");
    renderMetrics();
  };

  socket.onmessage = async (event) => {
    logger.logEvent("socket", "WebSocket message received", event.data);
    const payload = JSON.parse(event.data);
    if (payload.type === "welcome") {
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
    if (payload.type === "host_deleted") {
      state.me = { session: null };
      stopSocket();
      renderAll();
      setStatus(statusBox, logger, payload.message || "This host session was removed.", "error");
      return;
    }
    if (payload.type === "error") {
      setStatus(statusBox, logger, payload.message || "An error occurred.", "error");
    }
  };

  socket.onclose = async (event) => {
    logger.logEvent("socket", "WebSocket closed", { code: event.code, reason: event.reason });
    stopHeartbeat(state.heartbeatTimer);
    state.heartbeatTimer = null;
    state.socketReady = false;
    state.socket = null;
    if (state.currentPair) {
      await handlePairingCleared({ reason: "signaling_socket_closed" });
    }
    renderMetrics();
    setStatus(statusBox, logger, "Host signaling channel disconnected.", "error");
  };

  socket.onerror = (error) => {
    logger.logError("socket", "WebSocket error", error);
    setStatus(statusBox, logger, "Host signaling channel encountered an error.", "error");
  };
}

async function startHosting() {
  logger.logEvent("click", "Start hosting button clicked", { hostName: hostNameInput.value });
  const hostName = hostNameInput.value.trim();
  if (!hostName) {
    setStatus(statusBox, logger, "A host name is required before hosting starts.", "error");
    return;
  }
  try {
    await fetchJson("/api/host/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ host_name: hostName }),
    }, logger);
    await loadMe();
    await openSocket(true);
    setStatus(statusBox, logger, "This browser is now hosting.", "success");
  } catch (error) {
    logger.logError("host", "Failed to start hosting", error);
    setStatus(statusBox, logger, error.message, "error");
  }
}

async function resetSession() {
  logger.logEvent("click", "Reset session button clicked");
  try {
    await fetchJson("/api/session/reset", { method: "POST" }, logger);
  } catch (error) {
    logger.logError("session", "Reset request failed", error);
  } finally {
    stopSocket();
    teardownPeerConnection();
    state.me = null;
    state.currentPair = null;
    renderAll();
    window.location.reload();
  }
}

function sendMessage() {
  const text = chatInput.value.trim();
  logger.logEvent("click", "Send message button clicked", { textLength: text.length });
  if (!text) {
    return;
  }
  if (!state.chatReady || !state.dataChannel || state.dataChannel.readyState !== "open") {
    setStatus(statusBox, logger, "The direct client channel is not ready yet.", "error");
    return;
  }
  state.dataChannel.send(text);
  appendChat("self", `You: ${text}`);
  chatInput.value = "";
}

async function disconnectClient() {
  logger.logEvent("click", "Disconnect client button clicked", state.currentPair);
  if (!state.currentPair || !state.socketReady) {
    return;
  }
  state.socket.send(JSON.stringify({ type: "leave_pair" }));
  await handlePairingCleared({ reason: "left_by_user" });
}

async function boot() {
  logger.logEvent("boot", "Host page boot started");
  try {
    await loadConfig();
    await loadMe();
    if (state.me?.session?.role === "host") {
      setStatus(statusBox, logger, `Recovered existing host session: ${state.me.session.host_name}.`, "success");
      await openSocket();
    } else if (state.me?.session?.role === "client") {
      setStatus(statusBox, logger, "This browser is currently a client. Starting host mode here will replace that session.", "neutral");
    }
    renderAll();
    logger.logEvent("boot", "Host page boot completed");
  } catch (error) {
    logger.logError("boot", "Host page boot failed", error);
    setStatus(statusBox, logger, error.message, "error");
  }
}

startHostButton.addEventListener("click", () => {
  startHosting().catch((error) => {
    logger.logError("host", "Unhandled hosting error", error);
    setStatus(statusBox, logger, error.message, "error");
  });
});
resetSessionButton.addEventListener("click", () => {
  resetSession().catch((error) => {
    logger.logError("session", "Unhandled reset error", error);
    setStatus(statusBox, logger, error.message, "error");
  });
});
leavePairButton.addEventListener("click", () => {
  disconnectClient().catch((error) => {
    logger.logError("pairing", "Unhandled disconnect error", error);
    setStatus(statusBox, logger, error.message, "error");
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
hostNameInput.addEventListener("input", (event) => {
  logger.logEvent("input", "Host name changed", event.target.value);
});
window.addEventListener("beforeunload", () => {
  stopSocket();
});

await boot();
