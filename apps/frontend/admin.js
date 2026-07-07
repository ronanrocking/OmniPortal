import { createLogger, fetchJson, formatTime, setStatus } from "/frontend/shared.js";

const logger = createLogger("OmniPortalAdmin");
const statusBox = document.getElementById("statusBox");
const refreshAdminButton = document.getElementById("refreshAdminButton");
const hostsCount = document.getElementById("hostsCount");
const clientsCount = document.getElementById("clientsCount");
const connectionsCount = document.getElementById("connectionsCount");
const sessionsCount = document.getElementById("sessionsCount");
const hostsList = document.getElementById("hostsList");
const clientsList = document.getElementById("clientsList");
const connectionsList = document.getElementById("connectionsList");
const sessionsList = document.getElementById("sessionsList");

let refreshTimer = null;

function renderEmpty(element, message) {
  element.innerHTML = `<div class="empty-card">${message}</div>`;
}

function renderHosts(hosts) {
  if (!hosts.length) {
    renderEmpty(hostsList, "No reachable browsers yet.");
    return;
  }
  hostsList.innerHTML = hosts.map((host) => `
    <div class="item-card">
      <strong>${host.display_name}</strong>
      <div class="tiny-note">Registered: ${formatTime(host.created_at)}</div>
      ${host.device_name ? `<div class="tiny-note">${host.device_name}</div>` : ""}
      <div class="tiny-note mono">${host.connect_id}</div>
      <div class="pill-row">
        ${host.host_code ? `<span class="pill host">Code ${host.host_code}</span>` : ""}
        <span class="pill ${host.status === "connected" ? "client" : host.status === "connecting" ? "warn" : "ok"}">${host.status}</span>
        <span class="pill ${host.available ? "ok" : "warn"}">${host.available ? "Available" : "Busy"}</span>
      </div>
    </div>
  `).join("");
}

function renderClients(clients) {
  if (!clients.length) {
    renderEmpty(clientsList, "No live browser sessions yet.");
    return;
  }
  clientsList.innerHTML = clients.map((client) => `
    <div class="item-card">
      <strong>Browser Session</strong>
      <div class="tiny-note">Connected: ${formatTime(client.connected_at)}</div>
      <div class="tiny-note mono">${client.browser_id}</div>
      <div class="pill-row">
        ${client.peer_code ? `<span class="pill host">Code ${client.peer_code}</span>` : ""}
        <span class="pill client">${client.paired ? "Paired" : "Idle"}</span>
        ${client.peer_display_name ? `<span class="pill host">${client.peer_display_name}</span>` : ""}
      </div>
    </div>
  `).join("");
}

function renderConnections(connections) {
  if (!connections.length) {
    renderEmpty(connectionsList, "No browser pairings are active.");
    return;
  }
  connectionsList.innerHTML = connections.map((connection) => `
    <div class="item-card">
      <strong>${connection.host_display_name}</strong>
      <div class="tiny-note">Started: ${formatTime(connection.created_at)}</div>
      <div class="tiny-note mono">Host: ${connection.host_connect_id}</div>
      <div class="tiny-note mono">Client: ${connection.client_browser_id}</div>
      <div class="pill-row">
        ${connection.host_code ? `<span class="pill host">Code ${connection.host_code}</span>` : ""}
        <span class="pill warn">${connection.state}</span>
      </div>
    </div>
  `).join("");
}

function renderSessions(sessions) {
  if (!sessions.length) {
    renderEmpty(sessionsList, "No active sessions yet.");
    return;
  }
  sessionsList.innerHTML = sessions.map((session) => `
    <div class="item-card">
      <strong>${session.role.toUpperCase()}</strong>
      <div class="tiny-note">Updated: ${formatTime(session.updated_at)}</div>
      <div class="tiny-note mono">${session.session_key}</div>
      <div class="pill-row">
        <span class="pill ${session.online ? "ok" : "warn"}">${session.online ? "Online" : "Offline"}</span>
        ${session.paired ? '<span class="pill client">Paired</span>' : ""}
        ${session.display_name ? `<span class="pill host">${session.display_name}</span>` : ""}
        ${session.host_code ? `<span class="pill host">Code ${session.host_code}</span>` : ""}
        <span class="pill admin">${session.transport}</span>
      </div>
    </div>
  `).join("");
}

async function refreshOverview() {
  logger.logEvent("admin", "Refreshing overview");
  try {
    const data = await fetchJson("/api/admin/overview", undefined, logger);
    hostsCount.textContent = String(data.stats.connected_hosts);
    clientsCount.textContent = String(data.stats.connected_clients);
    connectionsCount.textContent = String(data.stats.active_connections);
    sessionsCount.textContent = String(data.stats.active_sessions);
    renderHosts(data.hosts || []);
    renderClients(data.clients || []);
    renderConnections(data.connections || []);
    renderSessions(data.sessions || []);
    setStatus(statusBox, logger, `Admin snapshot refreshed at ${new Date().toLocaleTimeString()}.`, "success");
  } catch (error) {
    logger.logError("admin", "Failed to refresh overview", error);
    setStatus(statusBox, logger, error.message, "error");
  }
}

refreshAdminButton.addEventListener("click", () => {
  refreshOverview().catch((error) => {
    logger.logError("admin", "Unhandled refresh error", error);
    setStatus(statusBox, logger, error.message, "error");
  });
});

window.addEventListener("beforeunload", () => {
  if (refreshTimer) {
    window.clearInterval(refreshTimer);
  }
});

await refreshOverview();
refreshTimer = window.setInterval(() => {
  refreshOverview().catch((error) => {
    logger.logError("admin", "Polling refresh failed", error);
  });
}, 2000);
