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
let pingIntervalMs = 25000;
let pingTimeoutMs = 5000;
let pingTimer = null;
let pingTimeoutTimer = null;
let connected = false;
let connecting = false;
let intentionalDisconnect = false;

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

  const wsUrl = `wss://${tenant}/api/websocket/push/notifications/?EIO=3&transport=websocket`;

  try {
    ws = new WebSocket(wsUrl);
  } catch (e) {
    connecting = false;
    handleDisconnect();
    return;
  }

  ws.onopen = () => {
    connecting = false;
  };

  ws.onmessage = (event) => {
    const raw = event.data;
    if (typeof raw !== "string" || raw.length === 0) return;

    const code = raw.charAt(0);

    if (code === "0") {
      // Engine.IO handshake: extract pingInterval and pingTimeout
      try {
        const handshake = JSON.parse(raw.substring(1));
        pingIntervalMs = handshake.pingInterval || 25000;
        pingTimeoutMs = handshake.pingTimeout || 5000;

        clearPingTimer();
        clearPingTimeout();

        // Start client-side ping interval
        pingTimer = setInterval(() => {
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send("2");
            // Arm pong timeout
            clearPingTimeout();
            pingTimeoutTimer = setTimeout(() => {
              if (ws) {
                try {
                  ws.close();
                } catch (err) {
                  /* ignore */
                }
              }
            }, pingTimeoutMs);
          }
        }, pingIntervalMs);

        // Send Socket.IO namespace connect
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send("40");
        }
      } catch (e) {}
      return;
    }

    if (code === "1") {
      // Engine.IO close request from server
      if (ws) {
        try {
          ws.close();
        } catch (e) {
          /* ignore */
        }
      }
      return;
    }

    if (raw === "3") {
      // Pong from server - clear ping timeout
      clearPingTimeout();
      return;
    }

    if (raw === "40") {
      // Socket.IO namespace connect ack
      if (!connected) {
        connected = true;
        chrome.runtime.sendMessage({ action: "wsConnected" }).catch(() => {});
      }
      return;
    }

    if (raw === "41") {
      // Socket.IO namespace disconnect from server
      if (ws) {
        try {
          ws.close();
        } catch (e) {
          /* ignore */
        }
      }
      return;
    }

    if (raw.startsWith("44")) {
      // Socket.IO namespace error (e.g. auth failure)
      if (ws) {
        try {
          ws.close();
        } catch (e) {
          /* ignore */
        }
      }
      return;
    }

    if (raw.startsWith("42")) {
      try {
        const payload = JSON.parse(raw.substring(2));
        if (Array.isArray(payload) && payload.length >= 2) {
          chrome.runtime
            .sendMessage({
              action: "wsEventFromOffscreen",
              eventName: payload[0],
              payload: payload[1],
            })
            .catch(() => {});
        }
      } catch (e) {}
      return;
    }
  };

  ws.onclose = (event) => {
    connecting = false;
    cleanupTimers();
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
  cleanupTimers();
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
  cleanupTimers();
  connected = false;
  connecting = false;
  ws = null;

  // Always notify the service worker so it can schedule a full reconnect
  // (which includes re-setting the auth cookie before connecting).
  if (!intentionalDisconnect) {
    chrome.runtime.sendMessage({ action: "wsDisconnected" }).catch(() => {});
  }
}

function cleanupTimers() {
  clearPingTimer();
  clearPingTimeout();
}

function clearPingTimer() {
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
}

function clearPingTimeout() {
  if (pingTimeoutTimer) {
    clearTimeout(pingTimeoutTimer);
    pingTimeoutTimer = null;
  }
}
