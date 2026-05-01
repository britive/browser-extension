// Options page script

const defaultSettings = {
  bannerCheck: true,
  bannerPollInterval: 60,
  showAllSecretTypes: false,
  zoomLevel: 100,
  theme: "dark",
  collectionName: "",
  tabAccess: true,
  tabApprovals: true,
  tabSecrets: true,
  otpAutoCopy: false,
  checkoutExpiryNotification: true,
  textButtons: false,
  autoCheckoutOnApproval: false,
};

function getStoredSettings(settings) {
  return { ...defaultSettings, ...(settings || {}) };
}

let resetDialogResolver = null;

function isValidTenant(t) {
  return (
    typeof t === "string" &&
    t.length > 0 &&
    /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(t)
  );
}

function applyTheme(theme) {
  document.documentElement.classList.toggle("light", theme === "light");
}

// Apply theme immediately to avoid flash of wrong colors
chrome.storage.local.get("extensionSettings").then(({ extensionSettings }) => {
  applyTheme((extensionSettings || defaultSettings).theme || "dark");
});

document.addEventListener("DOMContentLoaded", async () => {
  await loadSettings();
  await checkAuthOnOpen();
  setupEventListeners();
  setupResetDialog();
});

function setupEventListeners() {
  document
    .getElementById("save-settings")
    .addEventListener("click", saveSettings);
  document
    .getElementById("reset-settings")
    .addEventListener("click", resetSettings);
  document
    .getElementById("auth-action")
    .addEventListener("click", handleAuthAction);

  // Listen for auth completion from background script
  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === "authenticationComplete") {
      if (message.success) {
        updateAuthStatus(true);
        showStatus("connection-status", "Authenticated!", "success");
      } else {
        updateAuthStatus(false);
        showStatus(
          "connection-status",
          message.error || "Authentication failed.",
          "error",
        );
      }
    }
  });
}

// ── Auth status ──

async function checkAuthOnOpen() {
  try {
    const response = await chrome.runtime.sendMessage({
      action: "checkAuthenticationStatus",
    });
    updateAuthStatus(response.authenticated);
  } catch (e) {
    updateAuthStatus(false);
  }
}

function updateAuthStatus(authenticated) {
  const statusEl = document.getElementById("auth-status");
  const btn = document.getElementById("auth-action");
  const tenantInput = document.getElementById("tenant");

  if (authenticated) {
    statusEl.textContent = "Authenticated";
    statusEl.className = "help-text authenticated";
    btn.textContent = "Logout";
    btn.className = "btn btn-danger";
    if (tenantInput) tenantInput.disabled = true;
  } else {
    statusEl.textContent = "Not authenticated";
    statusEl.className = "help-text";
    btn.textContent = "Login";
    btn.className = "btn btn-secondary";
    if (tenantInput) tenantInput.disabled = false;
  }
}

async function handleAuthAction() {
  const btn = document.getElementById("auth-action");
  const isAuthenticated = btn.textContent === "Logout";

  if (isAuthenticated) {
    await handleLogout();
  } else {
    await handleLogin();
  }
}

async function handleLogin() {
  const tenant = document.getElementById("tenant").value.trim().toLowerCase();
  const btn = document.getElementById("auth-action");

  if (!tenant) {
    showStatus("connection-status", "Please enter your tenant name.", "error");
    return;
  }

  if (!isValidTenant(tenant)) {
    showStatus(
      "connection-status",
      "Invalid tenant name. Use only lowercase letters, numbers, hyphens, and dots.",
      "error",
    );
    return;
  }

  btn.disabled = true;
  btn.textContent = "Logging in...";

  try {
    const response = await chrome.runtime.sendMessage({
      action: "startOAuthLogin",
      tenant,
    });

    if (response.success) {
      showStatus("connection-status", "Authenticated successfully.", "success");
    } else {
      showStatus(
        "connection-status",
        response.error || "Failed to log in.",
        "error",
      );
    }
  } catch (error) {
    showStatus("connection-status", "Error: " + error.message, "error");
  } finally {
    btn.disabled = false;
    // Re-check to set correct button label
    await checkAuthOnOpen();
  }
}

async function handleLogout() {
  // Delegate full cleanup to background (clears token, caches, badge)
  await chrome.runtime.sendMessage({ action: "logout" });
  updateAuthStatus(false);
  showStatus("connection-status", "Logged out.", "info");
}

// ── Settings load/save ──

async function loadSettings() {
  const storage = await chrome.storage.local.get([
    "britiveSettings",
    "extensionSettings",
  ]);

  if (storage.britiveSettings) {
    document.getElementById("tenant").value =
      storage.britiveSettings.tenant || "";
  }

  const settings = getStoredSettings(storage.extensionSettings);

  document.getElementById("theme").value = settings.theme || "dark";
  document.getElementById("zoom-level").value = settings.zoomLevel || 100;
  applyTheme(settings.theme || "dark");
  document.getElementById("banner-check").checked =
    settings.bannerCheck ?? true;
  document.getElementById("banner-poll-interval").value =
    settings.bannerPollInterval || 60;
  document.getElementById("auto-checkout-on-approval").checked =
    settings.autoCheckoutOnApproval ?? false;
  document.getElementById("show-all-secret-types").checked =
    settings.showAllSecretTypes ?? false;
  document.getElementById("text-buttons").checked =
    settings.textButtons ?? false;
}

async function saveSettings() {
  try {
    const tenantInput = document.getElementById("tenant");
    const tenant = tenantInput.value.trim().toLowerCase();

    if (tenant && !tenantInput.disabled) {
      if (!isValidTenant(tenant)) {
        showStatus(
          "save-status",
          "Invalid tenant name. Use only lowercase letters, numbers, hyphens, and dots.",
          "error",
        );
        return;
      }
      const storage = await chrome.storage.local.get(["britiveSettings"]);
      await chrome.storage.local.set({
        britiveSettings: {
          ...storage.britiveSettings,
          tenant,
        },
      });
    }

    const storage = await chrome.storage.local.get(["extensionSettings"]);
    const extensionSettings = {
      ...getStoredSettings(storage.extensionSettings),
      theme: document.getElementById("theme").value || "dark",
      zoomLevel: Math.max(
        50,
        Math.min(
          200,
          parseInt(document.getElementById("zoom-level").value) || 100,
        ),
      ),
      bannerCheck: document.getElementById("banner-check").checked,
      bannerPollInterval: Math.max(
        60,
        Math.min(
          600,
          parseInt(document.getElementById("banner-poll-interval").value) || 60,
        ),
      ),
      autoCheckoutOnApproval: document.getElementById(
        "auto-checkout-on-approval",
      ).checked,
      showAllSecretTypes: document.getElementById("show-all-secret-types")
        .checked,
      textButtons: document.getElementById("text-buttons").checked,
    };

    await chrome.storage.local.set({ extensionSettings });
    applyTheme(extensionSettings.theme);
    chrome.runtime.sendMessage({
      action: "setExtensionIcon",
      crt: extensionSettings.theme === "crt",
    });
    showStatus("save-status", "Settings saved.", "success");
  } catch (error) {
    showStatus("save-status", "Error: " + error.message, "error");
  }
}

async function resetSettings() {
  const shouldReset = await confirmResetSettings();
  if (!shouldReset) return;

  await chrome.storage.local.set({ extensionSettings: { ...defaultSettings } });
  applyTheme(defaultSettings.theme);
  chrome.runtime.sendMessage({
    action: "setExtensionIcon",
    crt: defaultSettings.theme === "crt",
  });
  await loadSettings();
  showStatus("save-status", "Settings reset to defaults.", "info");
}

function setupResetDialog() {
  const dialog = document.getElementById("reset-confirm-dialog");
  const cancel = document.getElementById("reset-confirm-cancel");
  const confirm = document.getElementById("reset-confirm-confirm");

  const close = (approved) => {
    if (!resetDialogResolver) return;
    dialog.hidden = true;
    const resolver = resetDialogResolver;
    resetDialogResolver = null;
    resolver(approved);
  };

  cancel.addEventListener("click", () => close(false));
  confirm.addEventListener("click", () => close(true));
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) {
      close(false);
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !dialog.hidden) {
      close(false);
    }
  });
}

function confirmResetSettings() {
  const dialog = document.getElementById("reset-confirm-dialog");
  const cancel = document.getElementById("reset-confirm-cancel");

  if (resetDialogResolver) {
    return Promise.resolve(false);
  }

  dialog.hidden = false;
  cancel.focus();

  return new Promise((resolve) => {
    resetDialogResolver = resolve;
  });
}

// ── Helpers ──

function showStatus(id, text, type) {
  const el = document.getElementById(id);
  el.textContent = text;
  el.className = "status-message " + type;
  el.style.display = "block";
  setTimeout(() => {
    el.style.display = "none";
  }, 3000);
}
