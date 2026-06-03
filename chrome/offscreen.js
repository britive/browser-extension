// Britive offscreen document - WebSocket push notifications
// This runs in an offscreen document (Chrome MV3) because the service worker
// cannot hold a long-lived WebSocket connection. Auth relies on the 'auth'
// cookie set by the service worker via chrome.cookies.set() before connecting.
// The WS upgrade request carries this cookie to authenticate with the backend.

"use strict";

let currentTenant = null;
let currentBearerToken = null;
let currentExtensionVersion = "unknown";
let ws = null;
let connected = false;
let connecting = false;
let intentionalDisconnect = false;
let pingTimer = null;
const PING_INTERVAL_MS = 5 * 60 * 1000;

chrome.runtime.onMessage.addListener((message) => {
  if (message.action === "connectWs") {
    currentTenant = message.tenant;
    currentBearerToken = message.bearerToken || null;
    currentExtensionVersion = message.extensionVersion || "unknown";
    intentionalDisconnect = false;
    connectSocket(message.tenant);
  }
  if (message.action === "disconnectWs") {
    disconnectSocket();
  }
});

function connectSocket(tenant) {
  if (connecting || connected) return;
  if (!tenant) return;

  connecting = true;
  currentTenant = tenant;

  const wsUrl = `wss://${tenant}/api/websocket/v2`;

  try {
    ws = new WebSocket(wsUrl);
  } catch (e) {
    connecting = false;
    handleDisconnect();
    return;
  }

  ws.onopen = () => {
    connecting = false;
    startPingTimer();
    if (!connected) {
      connected = true;
      chrome.runtime.sendMessage({ action: "wsConnected" }).catch(() => {});
    }
  };

  ws.onmessage = (event) => {
    const message = parseSocketMessage(event.data);
    if (!message) return;
    chrome.runtime
      .sendMessage({
        action: "wsEventFromOffscreen",
        eventName: message.eventName,
        payload: message.payload,
      })
      .catch(() => {});
  };

  ws.onclose = (event) => {
    connecting = false;
    clearPingTimer();
    ws = null;
    handleDisconnect();
  };

  ws.onerror = (event) => {
    // onclose fires after onerror, so reconnect logic is there
  };
}

function disconnectSocket() {
  intentionalDisconnect = true;
  currentTenant = null;
  currentBearerToken = null;
  clearPingTimer();
  if (ws) {
    try {
      ws.close();
    } catch (e) {
      /* ignore */
    }
    ws = null;
  }
  const wasConnected = connected;
  connected = false;
  connecting = false;
  if (wasConnected) {
    chrome.runtime.sendMessage({ action: "wsDisconnected" }).catch(() => {});
  }
}

function handleDisconnect() {
  const wasConnected = connected;
  clearPingTimer();
  connected = false;
  connecting = false;
  ws = null;

  // Always notify the service worker so it can schedule a full reconnect
  // (which includes re-setting the auth cookie before connecting).
  if (!intentionalDisconnect || wasConnected) {
    chrome.runtime.sendMessage({ action: "wsDisconnected" }).catch(() => {});
  }
}

function startPingTimer() {
  clearPingTimer();
  sendPing();
  pingTimer = setInterval(sendPing, PING_INTERVAL_MS);
}

function clearPingTimer() {
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
}

function sendPing() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(["ping"]));
  } catch (e) {
    try {
      ws.close();
    } catch (_) {}
  }
}

function parseSocketMessage(raw) {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && typeof parsed[0] === "string") {
      return { eventName: parsed[0], payload: parsed[1] };
    }
    if (parsed && typeof parsed === "object") {
      const eventName = parsed.eventName || parsed.event || parsed.type;
      if (typeof eventName === "string") {
        return {
          eventName,
          payload: parsed.payload ?? parsed.data ?? parsed.message,
        };
      }
    }
  } catch (e) {}
  return null;
}
