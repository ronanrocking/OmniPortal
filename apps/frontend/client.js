import { createLogger, fetchJson, formatTime, setStatus, socketUrl, startHeartbeat, stopHeartbeat } from "/frontend/shared.js";

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
};

const currentRoleMetric = document.getElementById("currentRoleMetric");
const socketMetric = document.getElementById("socketMetric");
const peerMetric = document.getElementById("peerMetric");
const statusBox = document.getElementById("statusBox");
const joinClientButton = document.getElementById("joinClientButton");
const refreshHostsButton = document.getElementById("refreshHostsButton");
const resetSessionButton = document.getElementById("resetSessionButton");
const mePanel = document.getElementById("mePanel");
const hostList = document.getElementById("hostList");
const connectionPanel = document.getElementById("connectionPanel");
const leavePairButton = document.getElementById("leavePairButton");
const chatCaption = document.getElementById("chatCaption");
const chatLog = document.getElementById("chatLog");
const chatInput = document.getElementById("chatInput");
const sendMessageButton = document.getElementById("sendMessageButton");

function renderMetrics() {
  currentRoleMetric.textContent = state.me?.session?.role ? state.me.session.role.toUpperCase() : "Not a client";
  socketMetric.textContent = state.socketReady ? "Connected" : "Disconnected";
  peerMetric.textContent = state.peerState;
  leavePairButton.classList.toggle("hidden", !state.currentPair);
  chatInput.disabled = !state.chatReady;
  sendMessageButton.disabled = !state.chatReady;
  chatCaption.textContent = state.chatReady
    ? `Direct WebRTC chat is active with ${state.currentPair?.peerRole || "host"}.`
    : "A host must be connected before messages can be sent.";
  logger.logEvent("ui", "Metrics refreshed", {
    role: state.me?.session?.role,
    socketReady: state.socketReady,
    peerState: state.peerState,
    chatReady: state.chatReady,
  });
}

function appendChat(kind, text) {
  logger.logEvent("chat", `Appending ${kind} row`, text);
  if (chatLog.children.length === 1 && chatLog.textContent.includes("Waiting for a host to connect.")) {
    chatLog.innerHTML = "";
  }
  const row = document.createElement("div");
  row.className = `chat-row ${kind}`;
  row.textContent = text;
  chatLog.appendChild(row);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function resetChatLog(message = "Waiting for a host to connect.") {
  logger.logEvent("chat", "Resetting chat log", message);
  chatLog.innerHTML = "";
  appendChat("system", message);
}

function renderMe() {
  const session = state.me?.session;
  if (!session) {
    mePanel.innerHTML = '<div class="empty-card">This browser is not acting as a client yet.</div>';
    return;
  }

  mePanel.innerHTML = `
    <div class="item-card">
      <strong>Browser Identity</strong>
      <div class="tiny-note mono">${session.browser_id}</div>
      <div class="pill-row">
        <span class="pill client">${session.role.toUpperCase()}</span>
        <span class="pill ${session.online ? "ok" : "warn"}">${session.online ? "Online" : "Offline"}</span>
      </div>
    </div>
  `;
}

function renderConnection() {
  if (!state.currentPair) {
    connectionPanel.innerHTML = '<div class="empty-card">No host is connected right now.</div>';
    return;
  }
  connectionPanel.innerHTML = `
    <div class="item-card">
      <strong>Connected Host</strong>
      <div class="tiny-note mono">${state.currentPair.peerBrowserId}</div>
      <div class="pill-row">
        <span class="pill host">${state.currentPair.peerRole.toUpperCase()}</span>
        <span class="pill ok">${state.peerState}</span>
      </div>
    </div>
  `;
}

function renderHosts() {
  logger.logEvent("render", "Rendering host list", { hostCount: state.hosts.length, clientReady: state.me?.session?.role === "client" });
  if (!state.hosts.length) {
    hostList.innerHTML = '<div class="empty-card">No connected hosts are visible right now.</div>';
    return;
  }

  const isClient = state.me?.session?.role === "client";
  hostList.innerHTML = state.hosts.map((host) => {
    const busyText = host.paired ? "Busy" : "Available";
    const canConnect = isClient && host.available && !state.currentPair;
    return `
      <div class="item-card">
        <strong>${host.host_name}</strong>
        <div class="tiny-note">Registered: ${formatTime(host.created_at)}</div>
        <div class="tiny-note mono">${host.browser_id}</div>
        <div class="pill-row">
          <span class="pill ok">${host.online ? "Online" : "Offline"}</span>
          <span class="pill ${host.available ? "ok" : "warn"}">${busyText}</span>
        </div>
        ${canConnect ? `<button class="primary-button connect-host-button" data-host-id="${host.browser_id}">Connect to this host</button>` : ""}
      </div>
    `;
  }).join("");

  document.querySelectorAll(".connect-host-button").forEach((button) => {
    button.addEventListener("click", () => {
      logger.logEvent("click", "Connect host button clicked", { hostBrowserId: button.dataset.hostId });
      startPairing(button.dataset.hostId).catch((error) => {
        logger.logError("pairing", "Unhandled connect error", error);
        setStatus(statusBox, logger, error.message, "error");
      });
    });
  });
}

function renderAll() {
  renderMe();
  renderConnection();
  renderHosts();
  renderMetrics();
}

async function loadConfig() {
  const data = await fetchJson("/api/config", undefined, logger);
  state.stunServers = data.stun_servers || [];
}

async function loadMe() {
  state.me = await fetchJson("/api/me", undefined, logger);
  renderAll();
}

async function loadHosts() {
  const data = await fetchJson("/api/hosts", undefined, logger);
  state.hosts = data.hosts || [];
  renderHosts();
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
  renderMetrics();
}

async function notifyRtcState(peerState) {
  state.peerState = peerState;
  renderMetrics();
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
    await notifyRtcState("Connected");
  };
  channel.onmessage = (event) => {
    logger.logEvent("webrtc", "Message received", event.data);
    appendChat("peer", `Host: ${event.data}`);
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
  const connection = new RTCPeerConnection({ iceServers: state.stunServers });
  logger.logEvent("webrtc", "Creating RTCPeerConnection", state.stunServers);
  connection.onicecandidate = (event) => {
    if (!event.candidate || !state.socketReady || !state.currentPair) {
      return;
    }
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
      setStatus(statusBox, logger, "Direct peer connection failed. Try selecting the host again.", "error");
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
    target_browser_id: state.currentPair.peerBrowserId,
    signal: {
      kind: "offer",
      sdp: offer,
    },
  }));
  state.peerState = "Signaling";
  renderMetrics();
}

async function handleSignalMessage(payload) {
  logger.logEvent("signal", "Received signal", payload);
  if (!state.currentPair || payload.from_browser_id !== state.currentPair.peerBrowserId) {
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
  resetChatLog("Host selected. Negotiating direct WebRTC channel.");
  state.currentPair = {
    pairId: payload.pair_id,
    peerBrowserId: payload.peer_browser_id,
    peerRole: payload.peer_role,
  };
  state.peerState = "Signaling";
  state.chatReady = false;
  renderAll();
  if (payload.initiator) {
    await startOffer();
  }
}

async function handlePairingCleared(payload) {
  logger.logEvent("pairing", "Pairing cleared", payload);
  teardownPeerConnection();
  state.currentPair = null;
  state.peerState = "Idle";
  state.chatReady = false;
  resetChatLog(`Connection ended: ${payload.reason || "peer left"}.`);
  await loadHosts();
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
  if (state.me?.session?.role !== "client") {
    return;
  }
  if (state.socket && state.socketReady && !forceReconnect) {
    return;
  }

  stopSocket();
  renderMetrics();
  const socket = new WebSocket(socketUrl());
  state.socket = socket;

  socket.onopen = async () => {
    logger.logEvent("socket", "WebSocket opened");
    state.socketReady = true;
    state.heartbeatTimer = startHeartbeat(() => state.socket, logger);
    setStatus(statusBox, logger, "Client signaling channel connected.", "success");
    renderMetrics();
    await loadHosts();
  };

  socket.onmessage = async (event) => {
    logger.logEvent("socket", "WebSocket message received", event.data);
    const payload = JSON.parse(event.data);
    if (payload.type === "welcome") {
      return;
    }
    if (payload.type === "hosts_snapshot") {
      state.hosts = payload.hosts || [];
      renderHosts();
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
    setStatus(statusBox, logger, "Client signaling channel disconnected.", "error");
  };

  socket.onerror = (error) => {
    logger.logError("socket", "WebSocket error", error);
    setStatus(statusBox, logger, "Client signaling channel encountered an error.", "error");
  };
}

async function enableClientMode() {
  logger.logEvent("click", "Enable client mode button clicked");
  try {
    await fetchJson("/api/client/join", { method: "POST" }, logger);
    await loadMe();
    await openSocket(true);
    await loadHosts();
    setStatus(statusBox, logger, "This browser is now acting as a client.", "success");
  } catch (error) {
    logger.logError("client", "Failed to enable client mode", error);
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
    state.hosts = [];
    renderAll();
    window.location.reload();
  }
}

async function startPairing(hostBrowserId) {
  logger.logEvent("pairing", "Client requested pairing", { hostBrowserId });
  if (state.me?.session?.role !== "client") {
    setStatus(statusBox, logger, "Enable client mode before selecting a host.", "error");
    return;
  }
  if (!state.socketReady) {
    setStatus(statusBox, logger, "The signaling socket is not connected yet.", "error");
    return;
  }
  if (state.currentPair) {
    setStatus(statusBox, logger, "Disconnect the current host before selecting a new one.", "error");
    return;
  }
  resetChatLog("Requested host pairing. Waiting for signaling to start.");
  state.socket.send(JSON.stringify({
    type: "connect_to_host",
    host_browser_id: hostBrowserId,
  }));
  setStatus(statusBox, logger, "Pairing request sent to the signaling server.", "success");
}

function sendMessage() {
  const text = chatInput.value.trim();
  logger.logEvent("click", "Send message button clicked", { textLength: text.length });
  if (!text) {
    return;
  }
  if (!state.chatReady || !state.dataChannel || state.dataChannel.readyState !== "open") {
    setStatus(statusBox, logger, "The direct host channel is not ready yet.", "error");
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
  try {
    await loadConfig();
    await loadMe();
    await loadHosts();
    if (state.me?.session?.role === "client") {
      setStatus(statusBox, logger, "Recovered existing client session.", "success");
      await openSocket();
    } else if (state.me?.session?.role === "host") {
      setStatus(statusBox, logger, "This browser is currently a host. Enabling client mode here will replace that session.", "neutral");
    }
    renderAll();
    logger.logEvent("boot", "Client page boot completed");
  } catch (error) {
    logger.logError("boot", "Client page boot failed", error);
    setStatus(statusBox, logger, error.message, "error");
  }
}

joinClientButton.addEventListener("click", () => {
  enableClientMode().catch((error) => {
    logger.logError("client", "Unhandled enable client mode error", error);
    setStatus(statusBox, logger, error.message, "error");
  });
});
refreshHostsButton.addEventListener("click", () => {
  logger.logEvent("click", "Refresh hosts button clicked");
  loadHosts().catch((error) => {
    logger.logError("hosts", "Refresh hosts failed", error);
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
  disconnectHost().catch((error) => {
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
window.addEventListener("beforeunload", () => {
  stopSocket();
});

await boot();
