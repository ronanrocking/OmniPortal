export function createLogger(scopePrefix) {
  function stamp() {
    return new Date().toISOString();
  }

  function logEvent(scope, message, extra) {
    if (typeof extra === "undefined") {
      console.log(`[${scopePrefix}][${stamp()}][${scope}] ${message}`);
      return;
    }
    console.log(`[${scopePrefix}][${stamp()}][${scope}] ${message}`, extra);
  }

  function logError(scope, message, error) {
    console.error(`[${scopePrefix}][${stamp()}][${scope}] ${message}`, error);
  }

  return { logEvent, logError };
}

export function formatTime(iso) {
  if (!iso) {
    return "Unknown";
  }
  return new Date(iso).toLocaleString();
}

export function socketUrl() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws`;
}

export async function fetchJson(url, options, logger) {
  const method = options?.method || "GET";
  logger?.logEvent("http", `Starting ${method} ${url}`, options || {});
  const response = await fetch(url, options);
  const data = await response.json();
  logger?.logEvent("http", `Completed ${method} ${url}`, { status: response.status, ok: response.ok, data });
  if (!response.ok) {
    throw new Error(data.detail || "Request failed.");
  }
  return data;
}

export function setStatus(element, logger, message, tone = "neutral") {
  logger?.logEvent("ui", `Status changed (${tone})`, message);
  const label = tone === "error" ? "Attention:" : tone === "success" ? "Ready:" : "Status:";
  element.innerHTML = `<strong>${label}</strong> ${message}`;
}

export function startHeartbeat(socketGetter, logger) {
  const timer = window.setInterval(() => {
    const socket = socketGetter();
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }
    logger?.logEvent("socket", "Sending heartbeat");
    socket.send(JSON.stringify({ type: "heartbeat" }));
  }, 15000);
  return timer;
}

export function stopHeartbeat(timerId) {
  if (timerId) {
    window.clearInterval(timerId);
  }
}
