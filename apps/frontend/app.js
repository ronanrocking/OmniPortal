import { createLogger, fetchJson, setStatus, socketUrl, startHeartbeat, stopHeartbeat } from "/frontend/shared.js";

const logger = createLogger("OmniPortalApp");
const DIRECT_ATTEMPT_TIMEOUT_MS = 8000;
const PAIRING_ATTEMPT_TIMEOUT_MS = 30000;
const MAX_CHAT_MESSAGE_LENGTH = 400;
const PROTOCOL_TYPE_CHAT = "chat";
const PROTOCOL_TYPE_PING = "ping";
const PROTOCOL_TYPE_PONG = "pong";
const PROTOCOL_TYPE_MODE_REQUEST = "mode_request";
const PROTOCOL_TYPE_MODE_READY = "mode_ready";
const MODE_CHAT = "chat";
const MODE_VOICE = "voice";
const MODE_VIDEO = "video";

const state = {
  me: null,
  directIceServers: [],
  relayIceServers: [],
  currentIceMode: "direct",
  socket: null,
  socketReady: false,
  heartbeatTimer: null,
  reconnectTimer: null,
  reconnectDelayMs: 2000,
  autoConnectEnabled: true,
  currentPair: null,
  pendingCode: "",
  awaitingPairing: false,
  directAttemptTimer: null,
  pairingAttemptTimer: null,
  pendingRemoteCandidates: [],
  peerConnection: null,
  dataChannel: null,
  chatReady: false,
  currentMode: null,
  pendingModeSelection: null,
  localStream: null,
  remoteStream: new MediaStream(),
};

const myCodeValue = document.getElementById("myCodeValue");
const joinCodeInput = document.getElementById("joinCodeInput");
const connectButton = document.getElementById("connectButton");
const disconnectButton = document.getElementById("disconnectButton");
const resetSessionButton = document.getElementById("resetSessionButton");
const peerSummary = document.getElementById("peerSummary");
const statusBox = document.getElementById("statusBox");
const communicationSection = document.getElementById("communicationSection");
const commLockNote = document.getElementById("commLockNote");
const commTitle = document.getElementById("commTitle");
const commSubtitle = document.getElementById("commSubtitle");
const sessionStatusBox = document.getElementById("sessionStatusBox");
const chatModeButton = document.getElementById("chatModeButton");
const voiceModeButton = document.getElementById("voiceModeButton");
const videoModeButton = document.getElementById("videoModeButton");
const emptyModePanel = document.getElementById("emptyModePanel");
const chatPanel = document.getElementById("chatPanel");
const voicePanel = document.getElementById("voicePanel");
const videoPanel = document.getElementById("videoPanel");
const chatLog = document.getElementById("chatLog");
const chatInput = document.getElementById("chatInput");
const sendMessageButton = document.getElementById("sendMessageButton");
const remoteAudio = document.getElementById("remoteAudio");
const localAudio = document.getElementById("localAudio");
const localVideo = document.getElementById("localVideo");
const remoteVideo = document.getElementById("remoteVideo");

remoteAudio.srcObject = state.remoteStream;
remoteVideo.srcObject = state.remoteStream;

function setInitialStatus(message, tone = "neutral") {
  setStatus(statusBox, logger, message, tone);
}

function setSessionStatus(message, tone = "neutral") {
  setStatus(sessionStatusBox, logger, message, tone);
}

function resetChatLog(message = "Choose Chat after the peer connection is ready.") {
  chatLog.innerHTML = "";
  appendChat("system", message);
}

function appendChat(kind, text) {
  const row = document.createElement("div");
  row.className = `chat-row ${kind}`;
  row.textContent = text;
  chatLog.appendChild(row);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function humanizeReason(reason) {
  switch (reason) {
    case "left_by_user":
      return "the session was ended";
    case "peer_disconnected":
      return "the other browser disconnected";
    case "signaling_socket_closed":
      return "the signaling connection was lost";
    case "heartbeat_timeout":
      return "the connection timed out";
    case "host_went_offline":
      return "the other browser went offline";
    case "pairing_timeout":
      return "the connection attempt timed out";
    case "replaced_by_new_pair":
      return "a newer connection replaced this one";
    case "rtc_failed":
      return "the peer connection failed";
    case "rtc_disconnected":
      return "the peer connection was interrupted";
    case "rtc_closed":
      return "the peer connection was closed";
    case "role_changed":
    case "session_reset":
      return "the browser session was reset";
    default:
      return reason ? String(reason).replace(/_/g, " ") : "the session ended";
  }
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

function clearReconnectTimer() {
  if (state.reconnectTimer) {
    window.clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
}

function setModeButtonsDisabled(disabled) {
  for (const button of [chatModeButton, voiceModeButton, videoModeButton]) {
    button.disabled = disabled;
  }
}

function setActiveMode(mode) {
  state.currentMode = mode;
  const buttonMap = new Map([
    [chatModeButton, MODE_CHAT],
    [voiceModeButton, MODE_VOICE],
    [videoModeButton, MODE_VIDEO],
  ]);
  for (const [button, value] of buttonMap.entries()) {
    button.classList.toggle("active-mode", value === mode);
  }

  emptyModePanel.classList.toggle("hidden", Boolean(mode));
  chatPanel.classList.toggle("hidden", mode !== MODE_CHAT);
  voicePanel.classList.toggle("hidden", mode !== MODE_VOICE);
  videoPanel.classList.toggle("hidden", mode !== MODE_VIDEO);
  chatInput.disabled = !(mode === MODE_CHAT && state.chatReady);
  sendMessageButton.disabled = !(mode === MODE_CHAT && state.chatReady);
}

function renderSessionState() {
  const connected = Boolean(state.currentPair);
  const unlocked = connected && state.chatReady;
  communicationSection.classList.toggle("locked", !unlocked);
  communicationSection.setAttribute("aria-disabled", unlocked ? "false" : "true");
  commLockNote.classList.toggle("hidden", unlocked);
  connectButton.disabled = state.awaitingPairing || connected || !state.socketReady;
  disconnectButton.disabled = !connected;
  setModeButtonsDisabled(!unlocked);

  myCodeValue.textContent = state.me?.session?.peer_code || "......";

  if (!connected) {
    peerSummary.textContent = "No browser connected yet.";
    commTitle.textContent = "Choose a mode after pairing";
    commSubtitle.textContent = "The peer connection is not active yet.";
    setActiveMode(null);
    return;
  }

  peerSummary.textContent = `Connected with ${state.currentPair.peerDisplayName || "another browser"}.`;
  commTitle.textContent = state.currentPair.peerDisplayName || "Connected browser";
  commSubtitle.textContent = unlocked
    ? "Peer connection is ready. Choose how you want to communicate."
    : "Negotiating the peer connection now.";
}

async function loadConfig() {
  const data = await fetchJson("/api/config", undefined, logger);
  state.directIceServers = data.direct_ice_servers || [];
  state.relayIceServers = data.ice_servers || data.stun_servers || [];
}

async function loadMe() {
  state.me = await fetchJson("/api/me", undefined, logger);
  renderSessionState();
}

async function ensurePeerMode() {
  await fetchJson("/api/peer/join", { method: "POST" }, logger);
  await loadMe();
}

function stopLocalStream() {
  if (!state.localStream) {
    localAudio.srcObject = null;
    localVideo.srcObject = null;
    return;
  }
  for (const track of state.localStream.getTracks()) {
    track.stop();
  }
  state.localStream = null;
  localAudio.srcObject = null;
  localVideo.srcObject = null;
}

function syncLocalTracks() {
  if (!state.peerConnection) {
    return;
  }

  const desiredTracks = new Map();
  if (state.localStream) {
    for (const track of state.localStream.getTracks()) {
      desiredTracks.set(track.kind, track);
    }
  }

  const mediaSenders = state.peerConnection.getSenders().filter((sender) => sender.track && ["audio", "video"].includes(sender.track.kind));
  for (const sender of mediaSenders) {
    const desiredTrack = desiredTracks.get(sender.track.kind);
    if (!desiredTrack) {
      state.peerConnection.removeTrack(sender);
      continue;
    }
    if (desiredTrack.id !== sender.track.id) {
      sender.replaceTrack(desiredTrack).catch((error) => {
        logger.logError("media", "Failed to replace outgoing track", error);
      });
    }
    desiredTracks.delete(sender.track.kind);
  }

  if (state.localStream) {
    for (const track of desiredTracks.values()) {
      state.peerConnection.addTrack(track, state.localStream);
    }
  }
}

async function ensureLocalMedia(mode) {
  if (mode === MODE_CHAT) {
    stopLocalStream();
    syncLocalTracks();
    return;
  }

  const constraints = {
    audio: true,
    video: mode === MODE_VIDEO,
  };
  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  stopLocalStream();
  state.localStream = stream;
  localAudio.srcObject = stream;
  if (mode === MODE_VIDEO) {
    localVideo.srcObject = stream;
  } else {
    localVideo.srcObject = null;
  }
  syncLocalTracks();
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
  clearDirectAttemptTimer();
  clearPairingAttemptTimer();
  teardownDataChannel();
  if (state.peerConnection) {
    try {
      state.peerConnection.onicecandidate = null;
      state.peerConnection.ondatachannel = null;
      state.peerConnection.ontrack = null;
      state.peerConnection.onconnectionstatechange = null;
      state.peerConnection.oniceconnectionstatechange = null;
      state.peerConnection.onicecandidateerror = null;
      state.peerConnection.close();
    } catch (error) {
      logger.logError("webrtc", "Peer connection close failed", error);
    }
  }
  state.peerConnection = null;
  state.pendingRemoteCandidates = [];
  state.currentIceMode = "direct";
  for (const track of state.remoteStream.getTracks()) {
    state.remoteStream.removeTrack(track);
  }
}

async function notifyRtcState(peerState) {
  if (!state.socketReady || !state.currentPair) {
    return;
  }
  try {
    state.socket.send(JSON.stringify({ type: "rtc_state", state: peerState.toLowerCase() }));
  } catch (error) {
    logger.logError("webrtc", "Failed to report RTC state", error);
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
    } catch (error) {
      logger.logError("signal", "Queued ICE candidate rejected", error);
    }
  }
}

function sendProtocolPayload(payload) {
  if (!state.dataChannel || state.dataChannel.readyState !== "open") {
    throw new Error("The peer data channel is not ready yet.");
  }
  state.dataChannel.send(JSON.stringify(payload));
}

function bindDataChannel(channel) {
  state.dataChannel = channel;
  channel.onopen = async () => {
    clearDirectAttemptTimer();
    clearPairingAttemptTimer();
    state.chatReady = true;
    setSessionStatus("Peer connection is ready.", "success");
    renderSessionState();
    await notifyRtcState("Connected");
  };
  channel.onmessage = (event) => {
    handleProtocolMessage(event.data);
  };
  channel.onclose = async () => {
    state.chatReady = false;
    renderSessionState();
    await notifyRtcState("Disconnected");
  };
  channel.onerror = (error) => {
    logger.logError("webrtc", "Data channel error", error);
    setSessionStatus("A peer channel error occurred.", "error");
  };
}

function ensurePeerConnection() {
  if (state.peerConnection) {
    return state.peerConnection;
  }

  const connection = new RTCPeerConnection({ iceServers: activeIceServers(), iceTransportPolicy: "all" });
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
  connection.ontrack = (event) => {
    for (const track of event.streams[0]?.getTracks() || [event.track]) {
      if (!state.remoteStream.getTracks().some((existing) => existing.id === track.id)) {
        state.remoteStream.addTrack(track);
      }
    }
    remoteAudio.srcObject = state.remoteStream;
    remoteVideo.srcObject = state.remoteStream;
  };
  connection.onconnectionstatechange = async () => {
    const nextState = connection.connectionState || "unknown";
    if (nextState === "connected") {
      clearDirectAttemptTimer();
      await notifyRtcState("Connected");
    } else if (nextState === "connecting") {
      await notifyRtcState("Connecting");
    } else if (nextState === "disconnected") {
      await notifyRtcState("Disconnected");
      if (!state.chatReady && state.currentIceMode === "direct" && hasRelayFallback()) {
        await promoteToRelayMode("direct_disconnected");
        return;
      }
      setSessionStatus("Peer link disconnected. Resetting the session.", "error");
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
  syncLocalTracks();
  return connection;
}

async function startOffer() {
  if (!state.currentPair) {
    return;
  }
  const connection = ensurePeerConnection();
  if (!state.dataChannel) {
    bindDataChannel(connection.createDataChannel("omniportal"));
  }
  const offer = await connection.createOffer();
  await connection.setLocalDescription(offer);
  state.socket.send(JSON.stringify({
    type: "signal",
    target_peer_id: state.currentPair.peerId,
    signal: {
      kind: "offer",
      sdp: offer,
      ice_mode: state.currentIceMode,
    },
  }));
}

async function renegotiateConnection() {
  if (!state.currentPair || !state.socketReady) {
    return;
  }
  await startOffer();
}

async function promoteToRelayMode(reason) {
  if (!state.currentPair || state.chatReady || state.currentIceMode === "relay" || !hasRelayFallback()) {
    return;
  }
  logger.logEvent("webrtc", "Promoting to relay mode", { reason });
  clearDirectAttemptTimer();
  state.currentIceMode = "relay";
  teardownPeerConnection();
  await startOffer();
}

function startPairingAttemptTimer() {
  clearPairingAttemptTimer();
  state.pairingAttemptTimer = window.setTimeout(() => {
    state.pairingAttemptTimer = null;
    if (!state.currentPair || state.chatReady) {
      return;
    }
    setSessionStatus("The other browser did not finish connecting in time.", "error");
    if (state.socketReady) {
      state.socket.send(JSON.stringify({ type: "leave_pair" }));
    }
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
      logger.logError("webrtc", "Relay fallback failed", error);
    });
  }, DIRECT_ATTEMPT_TIMEOUT_MS);
}

async function handleSignalMessage(payload) {
  const fromPeerId = payload.from_peer_id || payload.from_browser_id;
  if (!state.currentPair || fromPeerId !== state.currentPair.peerId) {
    return;
  }

  const signal = payload.signal || {};
  const incomingIceMode = signal.ice_mode === "relay" ? "relay" : "direct";
  if (signal.kind === "ice_candidate" && incomingIceMode !== state.currentIceMode) {
    return;
  }
  if ((signal.kind === "offer" || signal.kind === "answer") && incomingIceMode !== state.currentIceMode) {
    state.currentIceMode = incomingIceMode;
    teardownPeerConnection();
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
        state.pendingRemoteCandidates.push(signal.candidate);
        return;
      }
      await connection.addIceCandidate(signal.candidate);
    }
  } catch (error) {
    logger.logError("signal", "Failed to process signal", error);
    setSessionStatus("Peer signaling failed.", "error");
  }
}

async function handlePairingStarted(payload) {
  teardownPeerConnection();
  state.currentPair = {
    pairId: payload.pair_id,
    peerId: payload.peer_id || payload.peer_browser_id,
    peerDisplayName: payload.peer_display_name || "Connected browser",
  };
  state.awaitingPairing = false;
  state.pendingCode = "";
  joinCodeInput.value = "";
  setSessionStatus("Pairing accepted. Negotiating the peer connection.", "success");
  renderSessionState();
  resetChatLog("Peer selected. Choose a mode when the connection is ready.");
  startPairingAttemptTimer();
  startDirectAttemptTimer();
  if (payload.initiator) {
    await startOffer();
  }
}

async function handlePairingCleared(payload) {
  teardownPeerConnection();
  stopLocalStream();
  state.pendingModeSelection = null;
  state.currentPair = null;
  state.awaitingPairing = false;
  const reasonLabel = humanizeReason(payload.reason);
  resetChatLog(`Connection ended because ${reasonLabel}.`);
  setInitialStatus(`Connection ended because ${reasonLabel}.`, "neutral");
  setSessionStatus("Waiting for a new peer connection.", "neutral");
  renderSessionState();
}

async function applyMode(mode) {
  setActiveMode(mode);
  if (!state.currentPair || !state.chatReady) {
    return;
  }

  try {
    await ensureLocalMedia(mode);
    if (mode === MODE_CHAT) {
      setSessionStatus("Chat mode is active.", "success");
    } else if (mode === MODE_VOICE) {
      setSessionStatus("Voice mode is preparing.", "success");
    } else if (mode === MODE_VIDEO) {
      setSessionStatus("Video mode is preparing.", "success");
    }
  } catch (error) {
    logger.logError("media", "Failed to prepare local media", error);
    setSessionStatus(`Could not start ${mode}: ${error.message}`, "error");
    if (mode !== MODE_CHAT) {
      setActiveMode(null);
    }
    throw error;
  }
}

async function requestMode(mode) {
  if (!state.currentPair || !state.chatReady) {
    return;
  }
  try {
    await applyMode(mode);
    state.pendingModeSelection = mode;
    sendProtocolPayload({ type: PROTOCOL_TYPE_MODE_REQUEST, mode });
  } catch (error) {
    logger.logError("mode", "Mode request failed", error);
  }
}

async function handleProtocolMessage(raw) {
  let payload = null;
  try {
    payload = JSON.parse(raw);
  } catch {
    appendChat("peer", raw);
    return;
  }

  if (payload?.type === PROTOCOL_TYPE_CHAT) {
    appendChat("peer", `Peer: ${payload.text || ""}`);
    return;
  }

  if (payload?.type === PROTOCOL_TYPE_PING && payload.id) {
    try {
      sendProtocolPayload({ type: PROTOCOL_TYPE_PONG, id: payload.id, sent_at: payload.sent_at });
    } catch (error) {
      logger.logError("webrtc", "Failed to respond to ping", error);
    }
    return;
  }

  if (payload?.type === PROTOCOL_TYPE_MODE_REQUEST && payload.mode) {
    try {
      await applyMode(payload.mode);
      sendProtocolPayload({ type: PROTOCOL_TYPE_MODE_READY, mode: payload.mode });
    } catch (error) {
      logger.logError("mode", "Remote mode request failed", error);
    }
    return;
  }

  if (payload?.type === PROTOCOL_TYPE_MODE_READY && payload.mode) {
    if (payload.mode === state.pendingModeSelection) {
      state.pendingModeSelection = null;
      await renegotiateConnection();
    }
  }
}

function stopSocket() {
  clearDirectAttemptTimer();
  clearPairingAttemptTimer();
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

function scheduleReconnect(reason = "signal_lost") {
  if (!state.autoConnectEnabled || state.reconnectTimer) {
    return;
  }
  state.reconnectTimer = window.setTimeout(() => {
    state.reconnectTimer = null;
    ensureBrowserConnected(true).catch((error) => {
      logger.logError("socket", "Reconnect attempt failed", error);
      setInitialStatus(`Reconnecting failed: ${error.message}`, "error");
      state.reconnectDelayMs = Math.min(state.reconnectDelayMs * 2, 15000);
      scheduleReconnect(reason);
    });
  }, state.reconnectDelayMs);
  setInitialStatus("Reconnecting to OmniPortal...", "neutral");
}

async function openSocket(forceReconnect = false) {
  if (state.socket && state.socketReady && !forceReconnect) {
    return;
  }
  stopSocket();

  const socket = new WebSocket(socketUrl());
  state.socket = socket;

  socket.onopen = async () => {
    clearReconnectTimer();
    state.socketReady = true;
    state.reconnectDelayMs = 2000;
    state.heartbeatTimer = startHeartbeat(() => state.socket, logger);
    renderSessionState();
    setInitialStatus("Connected. Share your code or enter another code to connect.", "success");
    if (state.pendingCode.length === 6 && !state.awaitingPairing && !state.currentPair) {
      await startPairing(state.pendingCode);
    }
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
      state.awaitingPairing = false;
      clearPairingAttemptTimer();
      if (!state.currentPair) {
        setInitialStatus(payload.message || "Unable to connect to that code.", "error");
      } else {
        setSessionStatus(payload.message || "An error occurred.", "error");
      }
      renderSessionState();
    }
  };

  socket.onclose = async () => {
    stopHeartbeat(state.heartbeatTimer);
    state.heartbeatTimer = null;
    state.socketReady = false;
    state.socket = null;
    state.awaitingPairing = false;
    clearPairingAttemptTimer();
    if (state.currentPair) {
      await handlePairingCleared({ reason: "signaling_socket_closed" });
    }
    renderSessionState();
    scheduleReconnect();
  };

  socket.onerror = (error) => {
    logger.logError("socket", "WebSocket error", error);
    setInitialStatus("The signaling channel encountered an error.", "error");
  };
}

async function ensureBrowserConnected(forceReconnect = false) {
  await ensurePeerMode();
  await openSocket(forceReconnect);
}

async function startPairing(inputCode) {
  const normalizedCode = String(inputCode || "").replace(/\D/g, "").slice(0, 6);
  joinCodeInput.value = normalizedCode;
  state.pendingCode = normalizedCode;

  if (!/^\d{6}$/.test(normalizedCode)) {
    setInitialStatus("Enter a valid 6-digit browser code.", "error");
    return;
  }
  if (!state.socketReady) {
    setInitialStatus("Connecting first. Your code entry will be submitted automatically.", "neutral");
    return;
  }
  if (state.currentPair || state.awaitingPairing) {
    return;
  }
  if (normalizedCode === state.me?.session?.peer_code) {
    setInitialStatus("You cannot connect to your own code.", "error");
    return;
  }

  state.awaitingPairing = true;
  setInitialStatus("Code submitted. Waiting for the other browser.", "success");
  state.socket.send(JSON.stringify({
    type: "connect_to_host",
    host_code: normalizedCode,
  }));
  renderSessionState();
}

function sendMessage() {
  const text = chatInput.value.trim().slice(0, MAX_CHAT_MESSAGE_LENGTH);
  if (!text) {
    return;
  }
  if (!state.chatReady || !state.dataChannel || state.dataChannel.readyState !== "open") {
    setSessionStatus("The peer channel is not ready yet.", "error");
    return;
  }
  sendProtocolPayload({ type: PROTOCOL_TYPE_CHAT, text });
  appendChat("self", `You: ${text}`);
  chatInput.value = "";
}

async function disconnectPeer() {
  if (!state.currentPair || !state.socketReady) {
    return;
  }
  state.socket.send(JSON.stringify({ type: "leave_pair" }));
  await handlePairingCleared({ reason: "left_by_user" });
}

async function resetSession() {
  try {
    await fetchJson("/api/session/reset", { method: "POST" }, logger);
  } catch (error) {
    logger.logError("session", "Reset failed", error);
  } finally {
    stopSocket();
    teardownPeerConnection();
    stopLocalStream();
    window.location.reload();
  }
}

async function boot() {
  resetChatLog();
  renderSessionState();
  joinCodeInput.focus();
  try {
    await loadConfig();
    await ensureBrowserConnected();
  } catch (error) {
    logger.logError("boot", "Boot failed", error);
    setInitialStatus(`Could not connect to OmniPortal: ${error.message}`, "error");
    scheduleReconnect("boot_failed");
  }
}

joinCodeInput.addEventListener("input", () => {
  const numeric = joinCodeInput.value.replace(/\D/g, "").slice(0, 6);
  if (joinCodeInput.value !== numeric) {
    joinCodeInput.value = numeric;
  }
});

joinCodeInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    startPairing(joinCodeInput.value).catch((error) => {
      logger.logError("pairing", "Unhandled connect error", error);
      state.awaitingPairing = false;
      renderSessionState();
    });
  }
});

connectButton.addEventListener("click", () => {
  startPairing(joinCodeInput.value).catch((error) => {
    logger.logError("pairing", "Unhandled connect error", error);
    state.awaitingPairing = false;
    renderSessionState();
  });
});

disconnectButton.addEventListener("click", () => {
  disconnectPeer().catch((error) => {
    logger.logError("pairing", "Unhandled disconnect error", error);
  });
});

resetSessionButton.addEventListener("click", () => {
  resetSession().catch((error) => {
    logger.logError("session", "Unhandled reset error", error);
  });
});

chatModeButton.addEventListener("click", () => {
  requestMode(MODE_CHAT).catch((error) => {
    logger.logError("mode", "Chat mode failed", error);
  });
});

voiceModeButton.addEventListener("click", () => {
  requestMode(MODE_VOICE).catch((error) => {
    logger.logError("mode", "Voice mode failed", error);
  });
});

videoModeButton.addEventListener("click", () => {
  requestMode(MODE_VIDEO).catch((error) => {
    logger.logError("mode", "Video mode failed", error);
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
  stopLocalStream();
});

await boot();
