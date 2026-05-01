let currentSecrets = [];
let currentApprovals = [];
let currentAccess = [];
let activeTab = null; // set dynamically from settings
let initialLoadInProgress = false; // prevents switchTab from triggering duplicate loads during init
let cachedCollectionId = null; // cached collection ID to avoid re-fetching every load
let cachedCollectionName = ""; // the collection name that was resolved to cachedCollectionId
let collapsedState = {}; // persisted collapsed state: { "app:Name": true, "prof:App/Profile": true }
let pendingApprovalRequests = {}; // tracks in-flight approval polls: "papId|environmentId" -> { requestId, timerId }
let loginPending = false; // true while waiting for login to complete
const recentWsToastKeys = new Set(); // dedup: tracks WS-delivered toast keys to suppress REST duplicates

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

function applyTheme(theme) {
  document.documentElement.classList.toggle("light", theme === "light");
  document.documentElement.classList.toggle("crt", theme === "crt");
  const refreshIcon = document.querySelector(".refresh-icon");
  if (refreshIcon) {
    refreshIcon.textContent = theme === "crt" ? "[:r]" : "\u21BB";
  }
  document.querySelectorAll(".access-toggle").forEach((toggle) => {
    if (toggle.classList.contains("on"))
      setElementIcon(toggle, getToggleIcon("on"));
    else if (toggle.classList.contains("pending"))
      setElementIcon(toggle, getToggleIcon("pending"));
    else if (toggle.classList.contains("approval"))
      setElementIcon(toggle, getToggleIcon("approval"));
    else if (toggle.classList.contains("checking-in"))
      setElementIcon(toggle, getToggleIcon("checking-in"));
    else setElementIcon(toggle, getToggleIcon("off"));
  });
  // Swap open/copy button icons (access tab)
  document.querySelectorAll(".btn-open").forEach((btn) => {
    setElementIcon(btn, getOpenIcon(true));
  });
  document.querySelectorAll(".btn-copy").forEach((btn) => {
    setElementIcon(btn, getCopyIcon(true));
  });
  document.querySelectorAll(".copy-btn").forEach((btn) => {
    setElementIcon(btn, getCopyIcon());
  });
  document.querySelectorAll(".show-btn").forEach((btn) => {
    const isVisible = btn.dataset.visible === "true";
    setElementIcon(btn, getShowIcon(isVisible));
  });
  document.querySelectorAll(".btn-add-favorite").forEach((btn) => {
    setElementIcon(btn, getAddItemIcon());
  });
  const debugToggle = document.getElementById("crt-debug-toggle");
  const debugPanel = document.getElementById("crt-debug");
  if (debugToggle) {
    debugToggle.classList.toggle("hidden", theme !== "crt");
    if (theme !== "crt") {
      if (debugPanel) debugPanel.classList.add("hidden");
      debugToggle.classList.remove("active");
    } else {
      if (debugPanel) debugPanel.classList.add("hidden");
      debugToggle.classList.remove("active");
      chrome.storage.local.set({ crtDebugOpen: false });
    }
  }
  const tabNameMap = {
    access: "My Access",
    approvals: "My Approvals",
    secrets: "My Secrets",
  };
  const crtTabNameMap = {
    access: "access>",
    approvals: "approvals>",
    secrets: "secrets>",
  };
  document.querySelectorAll(".tab").forEach((tab) => {
    const key = tab.dataset.tab;
    if (!key) return;
    const nameMap = theme === "crt" ? crtTabNameMap : tabNameMap;
    const badge = tab.querySelector(".tab-badge");
    tab.textContent = nameMap[key] || tab.textContent;
    if (badge) tab.appendChild(badge);
  });
  updateApprovalsBadge(currentApprovals.length);
  const versionEl = document.getElementById("footer-version");
  if (versionEl) {
    const ver = chrome.runtime.getManifest().version;
    versionEl.textContent = theme === "crt" ? "> v" + ver : "v" + ver;
  }
}

function clearElement(el) {
  if (el) el.replaceChildren();
}

function setElementIcon(el, iconMarkup) {
  if (!el) return;
  clearElement(el);
  if (typeof iconMarkup !== "string") {
    el.textContent = String(iconMarkup ?? "");
    return;
  }

  const icon = iconMarkup.trim();
  if (icon.startsWith("<svg")) {
    const svgDoc = new DOMParser().parseFromString(icon, "image/svg+xml");
    const svgEl = svgDoc.documentElement;
    if (svgEl && svgEl.nodeName.toLowerCase() === "svg") {
      el.appendChild(document.importNode(svgEl, true));
      return;
    }
  }

  el.textContent = icon;
}

function setTooltipText(el, text) {
  if (!el) return;
  if (!el.dataset.tooltipBound) {
    el.addEventListener("mouseenter", () => positionActionTooltip(el));
    el.addEventListener("mouseleave", hideActionTooltip);
    el.addEventListener("focus", () => positionActionTooltip(el));
    el.addEventListener("blur", hideActionTooltip);
    el.dataset.tooltipBound = "true";
  }
  const firefoxNativeTooltip =
    navigator.userAgent.includes("Firefox") && !useTextButtons();
  if (text) {
    el.dataset.tooltip = text;
    el.setAttribute("aria-label", text);
    if (firefoxNativeTooltip) el.setAttribute("title", text);
    else el.removeAttribute("title");
  } else {
    delete el.dataset.tooltip;
    el.removeAttribute("aria-label");
    el.removeAttribute("title");
  }
}

function positionActionTooltip(target) {
  const tooltip = document.getElementById("action-tooltip");
  if (useTextButtons()) {
    hideActionTooltip();
    return;
  }
  if (!tooltip || !target || !target.dataset.tooltip) return;
  const isFirefox = navigator.userAgent.includes("Firefox");
  if (isFirefox && target.hasAttribute("title")) {
    target.dataset.nativeTitle = target.getAttribute("title") || "";
    target.removeAttribute("title");
  }
  tooltip.textContent = target.dataset.tooltip;
  tooltip.classList.remove("hidden");
  tooltip.classList.add("visible");
  tooltip.classList.remove("tooltip-left", "tooltip-top");
  tooltip.style.display = "block";
  tooltip.style.visibility = "visible";
  tooltip.style.opacity = "1";

  const rect = target.getBoundingClientRect();
  const tooltipRect = tooltip.getBoundingClientRect();
  const sideGap = 10;
  const viewportGap = 8;
  const leftX = rect.left - sideGap;
  const centeredY = Math.min(
    Math.max(rect.top + rect.height / 2, tooltipRect.height / 2 + viewportGap),
    window.innerHeight - tooltipRect.height / 2 - viewportGap,
  );

  if (leftX - tooltipRect.width >= viewportGap) {
    tooltip.classList.add("tooltip-left");
    tooltip.style.left = leftX + "px";
    tooltip.style.top = centeredY + "px";
    return;
  }

  tooltip.classList.add("tooltip-top");
  const centerX = Math.min(
    Math.max(rect.left + rect.width / 2, tooltipRect.width / 2 + viewportGap),
    window.innerWidth - tooltipRect.width / 2 - viewportGap,
  );
  tooltip.style.left = centerX + "px";
  tooltip.style.top = rect.top + "px";
}

function hideActionTooltip() {
  const tooltip = document.getElementById("action-tooltip");
  if (!tooltip) return;
  const active = document.querySelector("[data-native-title]");
  if (active) {
    active.setAttribute(
      "title",
      active.dataset.nativeTitle || active.dataset.tooltip || "",
    );
    delete active.dataset.nativeTitle;
  }
  tooltip.classList.remove("visible");
  tooltip.classList.remove("tooltip-left", "tooltip-top");
  tooltip.classList.add("hidden");
  tooltip.style.opacity = "";
  tooltip.style.visibility = "";
  tooltip.style.display = "";
}

function getTooltipTarget(node) {
  if (node instanceof Element) return node.closest("[data-tooltip]");
  if (node && node.parentElement)
    return node.parentElement.closest("[data-tooltip]");
  return null;
}

window.addEventListener("scroll", hideActionTooltip, true);
window.addEventListener("resize", hideActionTooltip);

function setStateMessage(container, className, message, detail) {
  if (!container) return;
  clearElement(container);
  const div = document.createElement("div");
  div.className = className;
  div.textContent = message;
  if (detail) {
    div.appendChild(document.createElement("br"));
    const small = document.createElement("small");
    small.textContent = detail;
    div.appendChild(small);
  }
  container.appendChild(div);
}

function isValidTenant(t) {
  return (
    typeof t === "string" &&
    t.length > 0 &&
    /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(t)
  );
}

function getConfiguredTenantHost() {
  const tenant =
    document.getElementById("tenant")?.value.trim().toLowerCase() || "";
  if (!isValidTenant(tenant)) return null;
  return `${tenant}.britive-app.com`;
}

function getApprovedTenantOrigin(tenantUrl) {
  const configuredHost = getConfiguredTenantHost();
  if (!configuredHost) return null;

  try {
    const parsed = new URL(tenantUrl);
    if (parsed.protocol !== "https:" || parsed.host !== configuredHost) {
      return null;
    }
    return parsed.origin;
  } catch (e) {
    return null;
  }
}

function isSafeHttpUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch (e) {
    return false;
  }
}

function openTabSafely(url) {
  if (!isSafeHttpUrl(url)) return false;
  chrome.tabs.create({ url });
  return true;
}

async function writeTextToClipboard(text) {
  if (typeof text !== "string") {
    throw new Error("Nothing to copy to clipboard");
  }

  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch (_) {
      // Fall back to execCommand when async clipboard access is unavailable.
    }
  }

  const input = document.createElement("textarea");
  input.value = text;
  input.setAttribute("readonly", "");
  input.style.position = "fixed";
  input.style.top = "0";
  input.style.left = "0";
  input.style.opacity = "0";
  document.body.appendChild(input);
  input.focus();
  input.select();

  try {
    if (!document.execCommand("copy")) {
      throw new Error("Clipboard copy failed");
    }
  } finally {
    input.remove();
  }
}

function randomInt(max) {
  if (!Number.isInteger(max) || max <= 0) return 0;
  const cryptoObj = globalThis.crypto;
  if (!cryptoObj || typeof cryptoObj.getRandomValues !== "function") return 0;
  const maxUint32 = 0x100000000;
  const limit = maxUint32 - (maxUint32 % max);
  const bytes = new Uint32Array(1);
  do {
    cryptoObj.getRandomValues(bytes);
  } while (bytes[0] >= limit);
  return bytes[0] % max;
}

function getCheckedOutAccessType(co) {
  const rawType =
    co?.accessType ||
    co?.checkoutType ||
    co?.type ||
    co?.checkoutAccessType ||
    "";
  return typeof rawType === "string" ? rawType.toUpperCase() : "";
}

function isActiveConsoleCheckout(co) {
  return Boolean(
    co &&
    (co.checkedIn === null ||
      co.checkedIn === undefined ||
      co.checkedIn === false) &&
    getCheckedOutAccessType(co) === "CONSOLE",
  );
}

const CRT_DEBUG_MAX_LINES = 200;

function crtLog(tag, msg) {
  if (!document.documentElement.classList.contains("crt")) return;
  const logEl = document.getElementById("crt-debug-log");
  if (!logEl) return;
  const now = new Date();
  const ts = [now.getHours(), now.getMinutes(), now.getSeconds()]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
  const line = `> ${ts} [${tag}] ${msg}`;
  logEl.textContent += (logEl.textContent ? "\n" : "") + line;
  // Trim to max lines
  const lines = logEl.textContent.split("\n");
  if (lines.length > CRT_DEBUG_MAX_LINES) {
    logEl.textContent = lines.slice(-CRT_DEBUG_MAX_LINES).join("\n");
  }
  // Auto-scroll to bottom
  logEl.scrollTop = logEl.scrollHeight;
}

function initCrtDebugToggle() {
  const toggle = document.getElementById("crt-debug-toggle");
  const panel = document.getElementById("crt-debug");
  if (!toggle || !panel) return;

  // Restore saved open/close state
  chrome.storage.local.get("crtDebugOpen").then(({ crtDebugOpen }) => {
    if (crtDebugOpen && document.documentElement.classList.contains("crt")) {
      panel.classList.remove("hidden");
      toggle.classList.add("active");
      const logEl = document.getElementById("crt-debug-log");
      if (logEl) logEl.scrollTop = logEl.scrollHeight;
    }
  });

  toggle.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const isOpen = !panel.classList.contains("hidden");
    panel.classList.toggle("hidden", isOpen);
    toggle.classList.toggle("active", !isOpen);
    chrome.storage.local.set({ crtDebugOpen: !isOpen });
    if (!isOpen) {
      const logEl = document.getElementById("crt-debug-log");
      if (logEl) logEl.scrollTop = logEl.scrollHeight;
      crtLog("SYS", "debug console opened");
    }
  });
}

// Apply theme immediately to avoid flash of wrong colors
chrome.storage.local.get("extensionSettings").then(({ extensionSettings }) => {
  const settings = extensionSettings || defaultSettings;
  document.documentElement.dataset.textButtons = String(
    settings.textButtons ?? false,
  );
  applyTheme(settings.theme || "dark");
});

let secretTemplates = null; // { webTypes: [...], allTypes: [...] }

async function applyZoom() {
  const { extensionSettings } =
    await chrome.storage.local.get("extensionSettings");
  const pct = (extensionSettings || defaultSettings).zoomLevel || 100;
  const scale = pct / 100;
  // CSS zoom on body makes content larger, but the browser popup window stays
  // fixed at ~600px. To keep everything fitting, shrink #app dimensions by the
  // inverse of the zoom so the zoomed result equals the original physical size.
  // Content inside gets zoomed (larger text/spacing) while the popup stays 600px.
  const app = document.getElementById("app");
  if (scale === 1) {
    document.body.style.zoom = "";
    if (app) {
      app.style.height = "";
      app.style.width = "";
    }
  } else {
    document.body.style.zoom = scale;
    if (app) {
      app.style.height = Math.round(600 / scale) + "px";
      app.style.width = Math.round(380 / scale) + "px";
    }
  }
  // Keep header tabs at their original physical size regardless of zoom
  const header = document.querySelector(".header");
  if (header) header.style.zoom = scale === 1 ? "" : 1 / scale;
}

document.addEventListener("DOMContentLoaded", async () => {
  await applyZoom();
  initCrtDebugToggle();
  await initializePopup();
});

async function initializePopup() {
  crtLog("SYS", "popup initializing");
  const storage = await chrome.storage.local.get([
    "britiveSettings",
    "britiveAuth",
  ]);

  // Display extension version in footer
  const manifest = chrome.runtime.getManifest();
  const versionEl = document.getElementById("footer-version");
  if (versionEl)
    versionEl.textContent = isCrt()
      ? "> v" + (manifest.version_name || manifest.version)
      : "v" + (manifest.version_name || manifest.version);

  // Open GitHub link (popup can't use target=_blank reliably)
  const footerLink = document.getElementById("footer-link");
  if (footerLink) {
    footerLink.addEventListener("click", (e) => {
      e.preventDefault();
      openTabSafely("https://github.com/britive/browser-extension");
    });
  }

  // Pre-fill tenant from previous session
  if (storage.britiveSettings && storage.britiveSettings.tenant) {
    const tenantInput = document.getElementById("tenant");
    if (tenantInput) tenantInput.value = storage.britiveSettings.tenant;
  }

  if (storage.britiveSettings && storage.britiveSettings.authenticated) {
    crtLog("AUTH", "user authenticated, restoring session");
    showMainView();
    initialLoadInProgress = true;
    await applyTabVisibility();

    // Restore cached access data immediately to avoid blank screen
    const cached = await chrome.storage.local.get([
      "accessCache_data",
      "accessCache_collectionId",
      "accessCache_collectionName",
      "accessCollapsedState",
      "pendingApprovals",
    ]);
    if (cached.accessCollapsedState) {
      collapsedState = cached.accessCollapsedState;
    }
    if (cached.pendingApprovals) {
      Object.keys(cached.pendingApprovals).forEach((key) => {
        pendingApprovalRequests[key] = {
          requestId: cached.pendingApprovals[key],
          timerId: null,
        };
      });
    }
    if (cached.accessCache_data && cached.accessCache_data.length) {
      crtLog(
        "CACHE",
        "restored " + cached.accessCache_data.length + " cached access items",
      );
      currentAccess = cached.accessCache_data;
      displayAccess(currentAccess);
      startExpirationTimer();
    }
    if (cached.accessCache_collectionId) {
      cachedCollectionId = cached.accessCache_collectionId;
      cachedCollectionName = cached.accessCache_collectionName || "";
    }

    await loadUserProfile();
    loadBanner(); // shows cached banner only - no API call
    const { extensionSettings } =
      await chrome.storage.local.get("extensionSettings");
    loadEnabledTabData(extensionSettings);
    initialLoadInProgress = false;
    // Drain queued WS notifications only when authenticated and UI is ready.
    // Must happen AFTER access data is rendered so flashAccessRow can find rows.
    drainQueuedNotifications();
  } else {
    crtLog("AUTH", "not authenticated, showing login");
    showAuthView();
    // If login is already in progress, show the pending indicator
    if (storage.britiveAuth && storage.britiveAuth.loginInProgress) {
      const age = Date.now() - (storage.britiveAuth.startTime || 0);
      if (age < 3 * 60 * 1000) {
        crtLog("AUTH", "OAuth login in progress, showing pending indicator");
        const pendingDiv = document.getElementById("auth-pending");
        const submitBtn = document.querySelector(
          '#auth-form button[type="submit"]',
        );
        if (pendingDiv) pendingDiv.classList.remove("hidden");
        loginPending = true;
        if (submitBtn) {
          submitBtn.disabled = true;
          submitBtn.textContent = "Logging in...";
        }
        // Pre-fill tenant from the in-progress login
        const tenantInput = document.getElementById("tenant");
        if (tenantInput && storage.britiveAuth.tenant)
          tenantInput.value = storage.britiveAuth.tenant;
      }
    }
  }

  setupEventListeners();
  await consumePopupFocusIntent();
}

async function consumePopupFocusIntent() {
  try {
    const { popupFocusIntent } =
      await chrome.storage.local.get("popupFocusIntent");
    if (!popupFocusIntent) return;
    await chrome.storage.local.remove("popupFocusIntent");

    const isRecent =
      typeof popupFocusIntent.ts === "number" &&
      Date.now() - popupFocusIntent.ts < 10000;
    if (!isRecent) return;

    const mainView = document.getElementById("main-view");
    if (!mainView || mainView.classList.contains("hidden")) return;

    if (popupFocusIntent.target === "approvals-tab") {
      const approvalsTabBtn = document.querySelector(
        '.tab[data-tab="approvals"]',
      );
      if (approvalsTabBtn && !approvalsTabBtn.classList.contains("hidden")) {
        switchTab("approvals");
      }
      return;
    }

    if (popupFocusIntent.target === "secrets-search") {
      const secretsTabBtn = document.querySelector('.tab[data-tab="secrets"]');
      if (secretsTabBtn && !secretsTabBtn.classList.contains("hidden")) {
        switchTab("secrets");
        setTimeout(() => {
          const input = document.getElementById("search-secrets");
          if (!input) return;
          input.focus();
          input.select();
        }, 0);
      }
      return;
    }

    const accessTabBtn = document.querySelector('.tab[data-tab="access"]');
    if (accessTabBtn && !accessTabBtn.classList.contains("hidden")) {
      switchTab("access");
      setTimeout(() => {
        const input = document.getElementById("search-access");
        if (!input) return;
        input.focus();
        input.select();
      }, 0);
    }
  } catch (e) {
    // Ignore focus-intent failures
  }
}

let userProfile = null;

async function loadUserProfile() {
  try {
    const response = await chrome.runtime.sendMessage({
      action: "getUserProfile",
    });
    if (response && response.profile) {
      userProfile = response.profile;
      updateAvatarFromProfile(userProfile);
      updateSidebarUser(userProfile);
    } else {
      // Fallback to tenant initial
      const storage = await chrome.storage.local.get(["britiveSettings"]);
      setAvatarFallback(storage.britiveSettings);
    }
  } catch (e) {
    const storage = await chrome.storage.local.get(["britiveSettings"]);
    setAvatarFallback(storage.britiveSettings);
  }
}

function updateAvatarFromProfile(profile) {
  const btn = document.getElementById("open-sidebar");
  if (!btn) return;
  const first = (profile.firstName || "").charAt(0);
  const last = (profile.lastName || "").charAt(0);
  btn.textContent = (first + last).toUpperCase() || "?";
}

function setAvatarFallback(settings) {
  const btn = document.getElementById("open-sidebar");
  if (!btn) return;
  const tenant = settings?.tenant || "";
  btn.textContent = tenant ? tenant.charAt(0).toUpperCase() : "?";
}

function updateSidebarUser(profile) {
  const container = document.getElementById("sidebar-user");
  const avatarEl = document.getElementById("sidebar-avatar");
  const nameEl = document.getElementById("sidebar-user-name");
  const emailEl = document.getElementById("sidebar-user-email");
  if (!container) return;

  const first = (profile.firstName || "").charAt(0);
  const last = (profile.lastName || "").charAt(0);
  avatarEl.textContent = (first + last).toUpperCase() || "?";
  nameEl.textContent =
    [profile.firstName, profile.lastName].filter(Boolean).join(" ") ||
    profile.username ||
    "";
  emailEl.textContent = profile.email || profile.username || "";
  container.classList.remove("hidden");
}

async function loadSecretTemplates() {
  try {
    const response = await chrome.runtime.sendMessage({
      action: "getSecretTemplates",
    });
    if (response && response.webTypes) {
      secretTemplates = response;
    }
  } catch (e) {}
}

function bannerKey(banner) {
  return (banner.messageType || "INFO") + ":" + banner.message;
}

async function loadBanner() {
  const el = document.getElementById("banner");

  // Show cached banner only - background polling handles refreshes on its configured interval
  const { britiveBanner, bannerDismissed } = await chrome.storage.local.get([
    "britiveBanner",
    "bannerDismissed",
  ]);
  renderBanner(el, britiveBanner, bannerDismissed);
}

function renderBanner(el, banner, dismissedKey) {
  if (banner && banner.message) {
    // Stay hidden if user dismissed this exact message+type
    if (dismissedKey && bannerKey(banner) === dismissedKey) {
      el.className = "banner hidden";
      return;
    }
    clearElement(el);
    const msg = document.createElement("span");
    msg.className = "banner-message";
    msg.textContent = banner.message;
    const close = document.createElement("button");
    close.className = "banner-close";
    close.title = "Dismiss";
    setElementIcon(
      close,
      document.documentElement.classList.contains("crt")
        ? "[x]"
        : getWithdrawSvg(),
    );
    close.addEventListener("click", () => {
      el.className = "banner hidden";
      chrome.storage.local.set({ bannerDismissed: bannerKey(banner) });
    });
    el.appendChild(msg);
    el.appendChild(close);
    el.className = "banner " + (banner.messageType || "INFO");
  } else {
    el.className = "banner hidden";
    // Clear dismissed key when there's no banner
    chrome.storage.local.remove("bannerDismissed");
  }
}

function isAccessEventInCurrentScope(papId, environmentId) {
  if (!papId || !environmentId) return false;
  return currentAccess.some(
    (item) =>
      item.raw &&
      item.raw.papId === papId &&
      item.raw.environmentId === environmentId,
  );
}

function isMessageAccessInCurrentScope(message) {
  const item = message.item || {};
  const raw = item.raw || {};
  const papId = message.papId || item.papId || raw.papId;
  const environmentId =
    message.environmentId || item.environmentId || raw.environmentId;
  return isAccessEventInCurrentScope(papId, environmentId);
}

function setupEventListeners() {
  const authForm = document.getElementById("auth-form");
  if (authForm) authForm.addEventListener("submit", handleStartLogin);

  chrome.runtime.onMessage.addListener(async (message) => {
    if (message.action === "authenticationComplete") {
      handleAuthenticationComplete(message);
    }
    if (message.action === "sessionExpired") {
      clearPopupState();
      showAuthView();
    }
    if (message.action === "approvalStatusNotification") {
      // Skip if WS already delivered this notification (dedup)
      const item = message.item || {};
      if (!isMessageAccessInCurrentScope(message)) return;
      const dedupKey = `approval|${item.papId || ""}|${item.environmentId || ""}|${message.status}`;
      if (recentWsToastKeys.has(dedupKey)) return;
      recentWsToastKeys.add(dedupKey);
      setTimeout(() => recentWsToastKeys.delete(dedupKey), 30000);
      const tone =
        message.status === "approved"
          ? "success"
          : message.status === "rejected"
            ? "error"
            : message.status === "expired" ||
                message.status === "revoked" ||
                message.status === "cancelled"
              ? "warning"
              : "info";
      showToast(message.message, tone);
    }
    // WebSocket push: real-time approval status update
    if (message.action === "wsApprovalUpdate") {
      if (!isMessageAccessInCurrentScope(message)) return;
      const pendingKey = `${message.papId}|${message.environmentId}`;
      const status = message.status;
      // Track this event to suppress duplicate REST polling toast
      const dedupKey = `approval|${message.papId}|${message.environmentId}|${status}`;
      const alreadyHandledToast = recentWsToastKeys.has(dedupKey);
      recentWsToastKeys.add(dedupKey);
      setTimeout(() => recentWsToastKeys.delete(dedupKey), 30000);
      if (pendingApprovalRequests[pendingKey]) {
        dismissActivity();
        clearPendingApproval(pendingKey);
        savePendingApprovals();
      }
      const tone =
        status === "approved"
          ? "success"
          : status === "rejected"
            ? "error"
            : status === "expired" ||
                status === "revoked" ||
                status === "cancelled"
              ? "warning"
              : "info";
      if (!alreadyHandledToast) {
        showToast(
          message.message || message.statusText || `Access request ${status}.`,
          tone,
        );
      }
      if (
        status === "rejected" ||
        status === "revoked" ||
        status === "cancelled" ||
        status === "expired" ||
        status === "withdrawn"
      ) {
        resetPendingApprovalRow(message.papId, message.environmentId);
      }
      // Auto-checkout on approval if enabled
      if (status === "approved") {
        try {
          const { extensionSettings } =
            await chrome.storage.local.get("extensionSettings");
          if (extensionSettings?.autoCheckoutOnApproval) {
            const item = currentAccess.find(
              (a) =>
                a.raw.papId === message.papId &&
                a.raw.environmentId === message.environmentId,
            );
            if (item) {
              const rows = document.querySelectorAll(".access-env-row");
              let rowDiv = null;
              for (const r of rows) {
                const pId = r.dataset.papId;
                const eId = r.dataset.environmentId;
                if (pId === message.papId && eId === message.environmentId) {
                  rowDiv = r;
                  break;
                }
              }
              if (rowDiv) {
                const sResp = await chrome.runtime.sendMessage({
                  action: "getProfileSettings",
                  papId: item.raw.papId,
                  environmentId: item.raw.environmentId,
                });
                const sData =
                  (sResp &&
                    sResp.settings &&
                    sResp.settings.approvalRequestData) ||
                  {};
                const checkoutValues = {};
                if (sData.justification)
                  checkoutValues.justification = sData.justification;
                if (sData.ticketType)
                  checkoutValues.ticketType = sData.ticketType;
                if (sData.ticketId) checkoutValues.ticketId = sData.ticketId;
                const label = `${item.appName} / ${item.profileName} / ${item.environmentName}`;
                await performCheckoutWithStepUp(
                  rowDiv,
                  item,
                  checkoutValues,
                  label,
                );
              } else {
                await loadAccess();
              }
            } else {
              await loadAccess();
            }
          } else {
            await loadAccess();
          }
        } catch (e) {
          await loadAccess();
        }
      } else {
        await loadAccess();
      }
      flashAccessRow(message.papId, message.environmentId, tone);
    }
    // WebSocket push: real-time checkout/checkin status update
    if (message.action === "wsCheckoutUpdate") {
      if (!isMessageAccessInCurrentScope(message)) return;
      const isFail = [
        "checkOutFailed",
        "checkOutTimeOut",
        "checkInFailed",
        "checkInTimeOut",
      ].includes(message.status);
      if (isFail) {
        showToast(message.statusText || "An error occurred.", "error");
      }
      await loadAccess();
      flashAccessRow(
        message.papId,
        message.environmentId,
        isFail ? "error" : "success",
      );
    }
    // Checkout expiration warning (5-min countdown)
    if (message.action === "wsCheckoutExpiring") {
      if (!isMessageAccessInCurrentScope(message)) return;
      showToast(
        message.message || "A checkout is expiring soon.",
        "warning",
        "\u23F1",
      );
      flashAccessRow(message.papId, message.environmentId, "warning");
    }
  });

  const searchInput = document.getElementById("search-secrets");
  if (searchInput) searchInput.addEventListener("input", handleSearch);

  const searchAccessInput = document.getElementById("search-access");
  if (searchAccessInput)
    searchAccessInput.addEventListener("input", handleAccessSearch);

  // Refresh button refreshes whichever tab is active
  // Cmd-click (Mac) or Ctrl-click forces a cache-busting refresh
  const refreshBtn = document.getElementById("refresh");
  if (refreshBtn) refreshBtn.addEventListener("click", (e) => handleRefresh(e));

  // Tab switching
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => switchTab(tab.dataset.tab));
  });

  // Sidebar
  const openSidebar = document.getElementById("open-sidebar");
  if (openSidebar) openSidebar.addEventListener("click", openSettingsSidebar);

  const closeSidebar = document.getElementById("close-sidebar");
  if (closeSidebar)
    closeSidebar.addEventListener("click", closeSettingsSidebar);

  const overlay = document.getElementById("sidebar-overlay");
  if (overlay) overlay.addEventListener("click", closeSettingsSidebar);

  const sbSave = document.getElementById("sb-save");
  if (sbSave) sbSave.addEventListener("click", sidebarSaveSettings);

  const sbReset = document.getElementById("sb-reset");
  if (sbReset) sbReset.addEventListener("click", sidebarResetSettings);

  const sbLogout = document.getElementById("sb-logout");
  if (sbLogout) sbLogout.addEventListener("click", handleLogout);

  setupKonamiCode();
}

function setupKonamiCode() {
  const sequence = [
    "ArrowUp",
    "ArrowUp",
    "ArrowDown",
    "ArrowDown",
    "ArrowLeft",
    "ArrowRight",
    "ArrowLeft",
    "ArrowRight",
    "b",
    "a",
  ];
  let position = 0;

  document.addEventListener("keydown", (e) => {
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (key === sequence[position]) {
      position++;
      if (position === sequence.length) {
        position = 0;
        activateCrtEasterEgg();
      }
    } else {
      position = key === sequence[0] ? 1 : 0;
    }
  });
}

async function activateCrtEasterEgg(exitMessage) {
  const storage = await chrome.storage.local.get([
    "extensionSettings",
    "preCrtTheme",
  ]);
  const s = storage.extensionSettings || defaultSettings;
  const isCrtNow = s.theme === "crt";
  crtLog("THEME", isCrtNow ? "exiting CRT mode" : "entering CRT mode");

  const newTheme = isCrtNow ? storage.preCrtTheme || "dark" : "crt";

  if (!isCrtNow) {
    chrome.storage.local.set({ preCrtTheme: s.theme || "dark" });
  } else {
    chrome.storage.local.remove("preCrtTheme");
  }

  const flash = document.createElement("div");
  document.body.appendChild(flash);

  if (isCrtNow) {
    flash.className = "crt-flash";
    flash.textContent = exitMessage || "> LOGGED OUT_";

    setTimeout(() => {
      applyTheme(newTheme);
      chrome.storage.local.set({
        extensionSettings: { ...s, theme: newTheme },
      });
      chrome.runtime.sendMessage({ action: "setExtensionIcon", crt: false });
    }, 600);

    setTimeout(() => {
      if (flash.parentNode) flash.remove();
    }, 1800);
  } else {
    flash.className = "crt-flash boot-sequence";
    const bootLines = [
      "BRITIVE TERMINAL v" + (chrome.runtime.getManifest().version || "1.0"),
      "Copyright (c) 2026 Britive Inc.",
      "",
      "Running POST diagnostics...",
      "Memory check.......... OK",
      "Auth module........... OK",
      "Policy engine......... OK",
      "Access gateway........ ONLINE",
      "",
      "> ACCESS GRANTED_",
    ];

    let lineIndex = 0;
    const typeNextLine = () => {
      if (lineIndex >= bootLines.length) return;
      const line = document.createElement("div");
      line.className = "boot-line";
      if (lineIndex === bootLines.length - 1) {
        line.textContent = bootLines[lineIndex].replace("_", "");
        const cursor = document.createElement("span");
        cursor.className = "boot-cursor";
        cursor.textContent = "_";
        line.appendChild(cursor);
      } else {
        line.textContent = bootLines[lineIndex];
      }
      flash.appendChild(line);
      requestAnimationFrame(() => line.classList.add("visible"));
      lineIndex++;
      if (lineIndex < bootLines.length) {
        setTimeout(
          typeNextLine,
          lineIndex === bootLines.length - 1 ? 400 : 120,
        );
      }
    };
    setTimeout(typeNextLine, 200);

    const themeDelay = 200 + bootLines.length * 140 + 400;
    setTimeout(() => {
      applyTheme(newTheme);
      chrome.storage.local.set({
        extensionSettings: { ...s, theme: newTheme },
      });
      chrome.runtime.sendMessage({ action: "setExtensionIcon", crt: true });
    }, themeDelay);

    setTimeout(() => {
      if (flash.parentNode) flash.remove();
    }, 3600);
  }
}

document.addEventListener("keydown", async (e) => {
  if (e.ctrlKey && e.key === "d") {
    const { extensionSettings } =
      await chrome.storage.local.get("extensionSettings");
    if ((extensionSettings || defaultSettings).theme === "crt") {
      e.preventDefault();
      activateCrtEasterEgg("> END OF TRANSMISSION_");
    }
  }
});

let activeActivity = null;
let modalBackdropHandler = null;

function persistActiveActivity() {
  if (activeActivity && activeActivity.pauseAndSave) {
    activeActivity.pauseAndSave();
  }
}

window.addEventListener("pagehide", persistActiveActivity);
window.addEventListener("beforeunload", persistActiveActivity);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") persistActiveActivity();
});

function getActivityDisplayName(kind) {
  if (kind === "alpha") return ["S", "n", "a", "k", "e"].join("");
  if (kind === "beta") return ["T", "e", "t", "r", "i", "s"].join("");
  return "";
}

async function launchActivityPicker() {
  const modal = document.getElementById("activity-modal");
  const closeBtn = document.getElementById("activity-modal-close");
  const titleEl = document.getElementById("activity-modal-title");
  const scoreEl = document.getElementById("activity-score");
  const picker = document.getElementById("activity-picker");
  const canvas = document.getElementById("activity-canvas");
  const hintEl = document.getElementById("activity-hint");
  const previewCanvas = document.getElementById("activity-preview");
  const previewLabel = document.getElementById("activity-preview-label");

  titleEl.textContent = "WAITING FOR APPROVAL...";
  scoreEl.classList.add("hidden");
  picker.classList.remove("hidden");
  canvas.classList.add("hidden");
  if (previewCanvas) previewCanvas.classList.add("hidden");
  if (previewLabel) previewLabel.classList.add("hidden");
  hintEl.textContent = "";
  modal.classList.remove("hidden");

  function cleanup() {
    if (activeActivity && activeActivity.stop) activeActivity.stop();
    modal.classList.add("hidden");
    activeActivity = null;
  }

  closeBtn.onclick = cleanup;
  if (modalBackdropHandler)
    modal.removeEventListener("click", modalBackdropHandler);
  modalBackdropHandler = (e) => {
    if (e.target === modal) cleanup();
  };
  modal.addEventListener("click", modalBackdropHandler);

  const saved = await chrome.storage.local.get("activityState");
  const state = saved.activityState || null;

  picker.querySelectorAll(".activity-pick-btn").forEach((btn) => {
    const choice = btn.dataset.activity;
    const label = getActivityDisplayName(choice);
    if (!label) return;
    const hasSave = state && state.kind === choice && !state.sessionEnded;
    btn.textContent = hasSave ? label + " (Resume)" : label;
    btn.onclick = () => {
      picker.classList.add("hidden");
      if (choice === "alpha")
        launchAlpha(
          modal,
          canvas,
          scoreEl,
          titleEl,
          hintEl,
          cleanup,
          hasSave ? state : null,
        );
      else if (choice === "beta")
        launchBeta(
          modal,
          canvas,
          scoreEl,
          titleEl,
          hintEl,
          cleanup,
          previewCanvas,
          previewLabel,
          hasSave ? state : null,
        );
    };
  });

  activeActivity = { cleanup };
}

function launchAlpha(
  modal,
  canvas,
  scoreEl,
  titleEl,
  hintEl,
  parentCleanup,
  savedState,
) {
  canvas.width = 280;
  canvas.height = 200;
  canvas.classList.remove("hidden");
  titleEl.textContent = getActivityDisplayName("alpha").toUpperCase();
  scoreEl.classList.remove("hidden");
  hintEl.textContent = "Arrow keys to move \u00b7 Space to pause";
  const ctx = canvas.getContext("2d");

  const cellSize = 10;
  const cols = canvas.width / cellSize;
  const rows = canvas.height / cellSize;
  let chain, dir, nextDir, food, score, paused, sessionEnded, interval;

  function getColors() {
    return isCrt()
      ? {
          bg: "#0a0a0a",
          chain: "#aaffcc",
          food: "#ff3c3c",
          grid: "rgba(51,255,51,0.05)",
          text: "#aaffcc",
        }
      : {
          bg: "#0d0f1a",
          chain: "#7c5cfc",
          food: "#ff6b7a",
          grid: "rgba(255,255,255,0.03)",
          text: "#e0e0e0",
        };
  }

  function init(restored) {
    if (restored) {
      chain = restored.chain;
      dir = restored.dir;
      nextDir = restored.nextDir;
      food = restored.food;
      score = restored.score;
      paused = true;
      sessionEnded = false;
    } else {
      const midY = Math.floor(rows / 2);
      chain = [
        { x: 5, y: midY },
        { x: 4, y: midY },
        { x: 3, y: midY },
      ];
      dir = { x: 1, y: 0 };
      nextDir = { x: 1, y: 0 };
      score = 0;
      paused = false;
      sessionEnded = false;
    }
    scoreEl.textContent = "Score: " + score;
    if (!restored) placeFood();
    if (interval) clearInterval(interval);
    interval = setInterval(tick, 120);
    draw();
  }

  function placeFood() {
    let pos;
    do {
      pos = { x: randomInt(cols), y: randomInt(rows) };
    } while (chain.some((s) => s.x === pos.x && s.y === pos.y));
    food = pos;
  }

  function tick() {
    if (paused || sessionEnded) return;
    dir = { ...nextDir };
    const head = { x: chain[0].x + dir.x, y: chain[0].y + dir.y };
    if (head.x < 0) head.x = cols - 1;
    if (head.x >= cols) head.x = 0;
    if (head.y < 0) head.y = rows - 1;
    if (head.y >= rows) head.y = 0;
    if (chain.some((s) => s.x === head.x && s.y === head.y)) {
      sessionEnded = true;
      draw();
      saveHS(score);
      clearSavedState();
      return;
    }
    chain.unshift(head);
    if (head.x === food.x && head.y === food.y) {
      score++;
      scoreEl.textContent = "Score: " + score;
      placeFood();
    } else {
      chain.pop();
    }
    draw();
  }

  function draw() {
    const c = getColors();
    ctx.fillStyle = c.bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = c.grid;
    ctx.lineWidth = 0.5;
    for (let x = 0; x <= cols; x++) {
      ctx.beginPath();
      ctx.moveTo(x * cellSize, 0);
      ctx.lineTo(x * cellSize, canvas.height);
      ctx.stroke();
    }
    for (let y = 0; y <= rows; y++) {
      ctx.beginPath();
      ctx.moveTo(0, y * cellSize);
      ctx.lineTo(canvas.width, y * cellSize);
      ctx.stroke();
    }
    ctx.fillStyle = c.food;
    ctx.fillRect(
      food.x * cellSize + 1,
      food.y * cellSize + 1,
      cellSize - 2,
      cellSize - 2,
    );
    chain.forEach((seg, i) => {
      ctx.fillStyle = c.chain;
      ctx.globalAlpha = i === 0 ? 1 : 0.7;
      ctx.fillRect(
        seg.x * cellSize + 1,
        seg.y * cellSize + 1,
        cellSize - 2,
        cellSize - 2,
      );
    });
    ctx.globalAlpha = 1;
    if (sessionEnded) {
      ctx.fillStyle = "rgba(0,0,0,0.6)";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = c.text;
      ctx.font = "16px monospace";
      ctx.textAlign = "center";
      ctx.fillText("SESSION ENDED", canvas.width / 2, canvas.height / 2 - 10);
      ctx.font = "11px monospace";
      ctx.fillText(
        "Click to restart",
        canvas.width / 2,
        canvas.height / 2 + 10,
      );
    }
    if (paused && !sessionEnded) {
      ctx.fillStyle = "rgba(0,0,0,0.4)";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = c.text;
      ctx.font = "14px monospace";
      ctx.textAlign = "center";
      ctx.fillText("PAUSED", canvas.width / 2, canvas.height / 2 - 8);
      ctx.font = "10px monospace";
      ctx.fillText("Space to resume", canvas.width / 2, canvas.height / 2 + 8);
    }
  }

  async function saveHS(s) {
    const storage = await chrome.storage.local.get("alphaHighScore");
    if (s > (storage.alphaHighScore || 0)) {
      chrome.storage.local.set({ alphaHighScore: s });
      scoreEl.textContent = "Score: " + s + " (NEW HIGH!)";
    }
  }

  function saveState() {
    if (sessionEnded) {
      clearSavedState();
      return;
    }
    chrome.storage.local.set({
      activityState: {
        kind: "alpha",
        chain,
        dir,
        nextDir,
        food,
        score,
        paused: true,
        sessionEnded,
      },
    });
  }

  function clearSavedState() {
    chrome.storage.local.remove("activityState");
  }

  function handleKey(e) {
    if (modal.classList.contains("hidden")) return;
    const map = {
      ArrowUp: { x: 0, y: -1 },
      ArrowDown: { x: 0, y: 1 },
      ArrowLeft: { x: -1, y: 0 },
      ArrowRight: { x: 1, y: 0 },
    };
    if (map[e.key]) {
      e.preventDefault();
      const nd = map[e.key];
      if (nd.x !== -dir.x || nd.y !== -dir.y) nextDir = nd;
    }
    if (e.key === " ") {
      e.preventDefault();
      if (!sessionEnded) {
        paused = !paused;
        draw();
      }
    }
  }

  function handleClick() {
    if (sessionEnded) {
      clearSavedState();
      init();
    }
  }

  function stop() {
    if (interval) clearInterval(interval);
    document.removeEventListener("keydown", handleKey);
    canvas.removeEventListener("click", handleClick);
    saveHS(score);
    if (!sessionEnded) {
      paused = true;
      saveState();
    }
  }

  function pauseAndSave() {
    if (sessionEnded) return;
    paused = true;
    saveState();
  }

  document.addEventListener("keydown", handleKey);
  canvas.addEventListener("click", handleClick);
  activeActivity = { stop, cleanup: parentCleanup, pauseAndSave };
  init(savedState);
}

function launchBeta(
  modal,
  canvas,
  scoreEl,
  titleEl,
  hintEl,
  parentCleanup,
  previewCanvas,
  previewLabel,
  savedState,
) {
  const cols = 10,
    rows = 20,
    cellSize = 14;
  canvas.width = cols * cellSize;
  canvas.height = rows * cellSize;
  canvas.classList.remove("hidden");
  titleEl.textContent = getActivityDisplayName("beta").toUpperCase();
  scoreEl.classList.remove("hidden");
  hintEl.textContent =
    "Arrow keys \u00b7 Up to rotate \u00b7 Space to drop \u00b7 P to pause";
  const ctx = canvas.getContext("2d");

  const pvSize = 14;
  const pvCols = 4,
    pvRows = 4;
  let pvCtx = null;
  if (previewCanvas) {
    previewCanvas.width = pvCols * pvSize;
    previewCanvas.height = pvRows * pvSize;
    previewCanvas.classList.remove("hidden");
    if (previewLabel) previewLabel.classList.remove("hidden");
    pvCtx = previewCanvas.getContext("2d");
  }

  const pieces = [
    { shape: [[1, 1, 1, 1]], color: "#00bcd4" },
    {
      shape: [
        [1, 1],
        [1, 1],
      ],
      color: "#ffeb3b",
    },
    {
      shape: [
        [0, 1, 0],
        [1, 1, 1],
      ],
      color: "#9c27b0",
    },
    {
      shape: [
        [1, 0, 0],
        [1, 1, 1],
      ],
      color: "#ff9800",
    },
    {
      shape: [
        [0, 0, 1],
        [1, 1, 1],
      ],
      color: "#2196f3",
    },
    {
      shape: [
        [0, 1, 1],
        [1, 1, 0],
      ],
      color: "#4caf50",
    },
    {
      shape: [
        [1, 1, 0],
        [0, 1, 1],
      ],
      color: "#f44336",
    },
  ];

  const crtColor = "#aaffcc";
  let board,
    current,
    currentX,
    currentY,
    score,
    sessionEnded,
    paused,
    interval,
    linesCleared,
    nextPiece;

  function newPiece() {
    const p = pieces[randomInt(pieces.length)];
    return {
      shape: p.shape.map((r) => [...r]),
      color: isCrt() ? crtColor : p.color,
    };
  }

  function rotate(shape) {
    const rows = shape.length,
      cols = shape[0].length;
    const r = [];
    for (let c = 0; c < cols; c++) {
      r.push([]);
      for (let rr = rows - 1; rr >= 0; rr--) r[c].push(shape[rr][c]);
    }
    return r;
  }

  function collides(shape, px, py) {
    for (let r = 0; r < shape.length; r++)
      for (let c = 0; c < shape[r].length; c++)
        if (shape[r][c]) {
          const nx = px + c,
            ny = py + r;
          if (nx < 0 || nx >= cols || ny >= rows) return true;
          if (ny >= 0 && board[ny][nx]) return true;
        }
    return false;
  }

  function lock() {
    for (let r = 0; r < current.shape.length; r++)
      for (let c = 0; c < current.shape[r].length; c++)
        if (current.shape[r][c]) {
          const ny = currentY + r;
          if (ny < 0) {
            sessionEnded = true;
            return;
          }
          board[ny][currentX + c] = current.color;
        }
    let cleared = 0;
    for (let r = rows - 1; r >= 0; r--) {
      if (board[r].every((c) => c)) {
        board.splice(r, 1);
        board.unshift(Array(cols).fill(null));
        cleared++;
        r++;
      }
    }
    if (cleared) {
      linesCleared += cleared;
      score += [0, 100, 300, 500, 800][cleared] || 800;
      scoreEl.textContent = "Score: " + score;
    }
    spawn();
  }

  function spawn() {
    current = nextPiece || newPiece();
    nextPiece = newPiece();
    currentX = Math.floor((cols - current.shape[0].length) / 2);
    currentY = -current.shape.length;
    if (collides(current.shape, currentX, 0)) {
      sessionEnded = true;
    }
    drawPreview();
  }

  function init(restored) {
    if (restored) {
      board = restored.board;
      score = restored.score;
      linesCleared = restored.linesCleared || 0;
      current = restored.current;
      currentX = restored.currentX;
      currentY = restored.currentY;
      nextPiece = restored.nextPiece || newPiece();
      paused = true;
      sessionEnded = false;
      drawPreview();
    } else {
      board = Array.from({ length: rows }, () => Array(cols).fill(null));
      score = 0;
      linesCleared = 0;
      sessionEnded = false;
      paused = false;
      nextPiece = newPiece();
      spawn();
    }
    scoreEl.textContent = "Score: " + score;
    if (interval) clearInterval(interval);
    interval = setInterval(tick, 500);
    draw();
  }

  function tick() {
    if (paused || sessionEnded) return;
    if (!collides(current.shape, currentX, currentY + 1)) {
      currentY++;
    } else {
      lock();
    }
    draw();
  }

  function drawPreview() {
    if (!pvCtx) return;
    const crt = isCrt();
    const bg = crt ? "#0a0a0a" : "#0d0f1a";
    pvCtx.fillStyle = bg;
    pvCtx.fillRect(0, 0, previewCanvas.width, previewCanvas.height);
    if (!nextPiece) return;
    const shape = nextPiece.shape;
    const offX = Math.floor((pvCols - shape[0].length) / 2);
    const offY = Math.floor((pvRows - shape.length) / 2);
    pvCtx.fillStyle = nextPiece.color;
    for (let r = 0; r < shape.length; r++)
      for (let c = 0; c < shape[r].length; c++)
        if (shape[r][c])
          pvCtx.fillRect(
            (offX + c) * pvSize + 1,
            (offY + r) * pvSize + 1,
            pvSize - 2,
            pvSize - 2,
          );
  }

  function draw() {
    const crt = isCrt();
    const bg = crt ? "#0a0a0a" : "#0d0f1a";
    const gridColor = crt ? "rgba(170,255,204,0.05)" : "rgba(255,255,255,0.03)";
    const textColor = crt ? "#aaffcc" : "#e0e0e0";
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 0.5;
    for (let x = 0; x <= cols; x++) {
      ctx.beginPath();
      ctx.moveTo(x * cellSize, 0);
      ctx.lineTo(x * cellSize, canvas.height);
      ctx.stroke();
    }
    for (let y = 0; y <= rows; y++) {
      ctx.beginPath();
      ctx.moveTo(0, y * cellSize);
      ctx.lineTo(canvas.width, y * cellSize);
      ctx.stroke();
    }
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++)
        if (board[r][c]) {
          ctx.fillStyle = board[r][c];
          ctx.fillRect(
            c * cellSize + 1,
            r * cellSize + 1,
            cellSize - 2,
            cellSize - 2,
          );
        }
    if (current) {
      ctx.fillStyle = current.color;
      for (let r = 0; r < current.shape.length; r++)
        for (let c = 0; c < current.shape[r].length; c++)
          if (current.shape[r][c]) {
            const py = currentY + r;
            if (py >= 0)
              ctx.fillRect(
                (currentX + c) * cellSize + 1,
                py * cellSize + 1,
                cellSize - 2,
                cellSize - 2,
              );
          }
    }
    if (sessionEnded) {
      ctx.fillStyle = "rgba(0,0,0,0.6)";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = textColor;
      ctx.font = "16px monospace";
      ctx.textAlign = "center";
      ctx.fillText("SESSION ENDED", canvas.width / 2, canvas.height / 2 - 10);
      ctx.font = "11px monospace";
      ctx.fillText(
        "Click to restart",
        canvas.width / 2,
        canvas.height / 2 + 10,
      );
      saveBetaHS(score);
      clearSavedState();
    }
    if (paused && !sessionEnded) {
      ctx.fillStyle = "rgba(0,0,0,0.4)";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = textColor;
      ctx.font = "14px monospace";
      ctx.textAlign = "center";
      ctx.fillText("PAUSED", canvas.width / 2, canvas.height / 2 - 8);
      ctx.font = "10px monospace";
      ctx.fillText("P to resume", canvas.width / 2, canvas.height / 2 + 8);
    }
  }

  async function saveBetaHS(s) {
    const storage = await chrome.storage.local.get("betaHighScore");
    if (s > (storage.betaHighScore || 0)) {
      chrome.storage.local.set({ betaHighScore: s });
      scoreEl.textContent = "Score: " + s + " (NEW HIGH!)";
    }
  }

  function saveState() {
    if (sessionEnded) {
      clearSavedState();
      return;
    }
    chrome.storage.local.set({
      activityState: {
        kind: "beta",
        board,
        current,
        currentX,
        currentY,
        score,
        linesCleared,
        nextPiece,
        paused: true,
        sessionEnded,
      },
    });
  }

  function clearSavedState() {
    chrome.storage.local.remove("activityState");
  }

  function handleKey(e) {
    if (modal.classList.contains("hidden")) return;
    if (sessionEnded) return;
    if (e.key === " ") {
      e.preventDefault();
      if (!paused) {
        while (!collides(current.shape, currentX, currentY + 1)) currentY++;
        lock();
        draw();
      }
    }
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      if (!paused && !collides(current.shape, currentX - 1, currentY)) {
        currentX--;
        draw();
      }
    }
    if (e.key === "ArrowRight") {
      e.preventDefault();
      if (!paused && !collides(current.shape, currentX + 1, currentY)) {
        currentX++;
        draw();
      }
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!paused && !collides(current.shape, currentX, currentY + 1)) {
        currentY++;
        draw();
      }
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (!paused) {
        const rotated = rotate(current.shape);
        if (!collides(rotated, currentX, currentY)) {
          current.shape = rotated;
          draw();
        }
      }
    }
    if (e.key === "p") {
      e.preventDefault();
      paused = !paused;
      draw();
    }
  }

  function handleClick() {
    if (sessionEnded) {
      clearSavedState();
      init();
    }
  }

  function stop() {
    if (interval) clearInterval(interval);
    document.removeEventListener("keydown", handleKey);
    canvas.removeEventListener("click", handleClick);
    if (previewCanvas) previewCanvas.classList.add("hidden");
    if (previewLabel) previewLabel.classList.add("hidden");
    saveBetaHS(score);
    if (!sessionEnded) {
      paused = true;
      saveState();
    }
  }

  function pauseAndSave() {
    if (sessionEnded) return;
    paused = true;
    saveState();
  }

  document.addEventListener("keydown", handleKey);
  canvas.addEventListener("click", handleClick);
  activeActivity = { stop, cleanup: parentCleanup, pauseAndSave };
  init(savedState);
}

function dismissActivity() {
  if (activeActivity && activeActivity.cleanup) activeActivity.cleanup();
}

function getEnabledTabs(settings) {
  const s = settings || defaultSettings;
  const tabs = [];
  if (s.tabAccess ?? true) tabs.push("access");
  if (s.tabApprovals ?? true) tabs.push("approvals");
  if (s.tabSecrets ?? true) tabs.push("secrets");
  return tabs.length > 0 ? tabs : ["access"]; // fallback: at least one
}

async function applyTabVisibility() {
  const { extensionSettings } =
    await chrome.storage.local.get("extensionSettings");
  const s = extensionSettings || defaultSettings;
  const enabled = getEnabledTabs(s);

  // Show/hide tab buttons
  document.querySelectorAll(".tab").forEach((btn) => {
    const tab = btn.dataset.tab;
    btn.classList.toggle("hidden", !enabled.includes(tab));
  });

  // Show/hide tab content panels for disabled tabs
  document.querySelectorAll(".tab-content").forEach((panel) => {
    const tab = panel.id.replace("tab-", "");
    if (!enabled.includes(tab)) {
      panel.classList.add("hidden");
    }
  });

  // If current active tab is disabled, switch to first enabled
  if (!activeTab || !enabled.includes(activeTab)) {
    switchTab(enabled[0]);
  }
}

function loadEnabledTabData(settings) {
  const s = settings || defaultSettings;
  if (s.tabAccess ?? true) loadAccess();
  // Approvals are loaded from background polling - only show cached data on open
  if (s.tabApprovals ?? true) loadCachedApprovals();
  if (s.tabSecrets ?? true) {
    loadSecretTemplates();
    loadSecrets(false).catch(() => {});
  }
}

async function loadCachedApprovals() {
  // Show whatever the background polling has already fetched - no API call
  try {
    const response = await chrome.runtime.sendMessage({
      action: "getCachedApprovals",
    });
    if (response && response.approvals) {
      currentApprovals = Array.isArray(response.approvals)
        ? response.approvals
        : [];
      displayApprovals(currentApprovals);
      updateApprovalsBadge(currentApprovals.length);
    }
  } catch (e) {
    // Ignore - cached data is fine
  }
}

function switchTab(tabName) {
  crtLog("TAB", "switch to " + tabName);
  activeTab = tabName;

  // Update tab button states
  document.querySelectorAll(".tab").forEach((t) => {
    t.classList.toggle("active", t.dataset.tab === tabName);
  });

  // Show/hide tab content panels
  document.querySelectorAll(".tab-content").forEach((panel) => {
    panel.classList.toggle("hidden", panel.id !== `tab-${tabName}`);
  });

  // Load content if switching to a tab that hasn't been loaded yet
  // Skip during initial load - loadEnabledTabData handles it
  if (!initialLoadInProgress) {
    if (tabName === "approvals") {
      const list = document.getElementById("approvals-list");
      if (list && list.querySelector(".loading")) {
        loadApprovals();
      }
    } else if (tabName === "access") {
      const list = document.getElementById("access-list");
      if (list && list.querySelector(".loading")) {
        loadAccess();
      }
    } else if (tabName === "secrets") {
      const list = document.getElementById("secrets-list");
      if (list && list.querySelector(".loading")) {
        loadSecrets(false);
      }
    }
  }
}

function handleRefresh(e) {
  // Any manual refresh should bypass caches - user expects fresh data
  crtLog("REFRESH", "manual refresh: " + activeTab);
  if (activeTab === "access") {
    loadAccess(true);
  } else if (activeTab === "secrets") {
    loadSecrets(true);
  } else if (activeTab === "approvals") {
    loadApprovals();
  }
}

function updateLastRefreshed() {
  const el = document.getElementById("last-updated");
  if (!el) return;
  const now = new Date();
  const time = now.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const date = now.toLocaleDateString([], { month: "short", day: "numeric" });
  el.textContent = "Last refreshed " + date + " " + time;
}

function clearPopupState() {
  currentSecrets = [];
  currentAccess = [];
  currentApprovals = [];
  cachedCollectionId = null;
  cachedCollectionName = "";
  collapsedState = {};
  userProfile = null;
  for (const key of Object.keys(pendingApprovalRequests)) {
    const entry = pendingApprovalRequests[key];
    if (entry && entry.timerId) clearTimeout(entry.timerId);
  }
  pendingApprovalRequests = {};
  if (expirationTimerInterval) {
    clearInterval(expirationTimerInterval);
    expirationTimerInterval = null;
  }
  const accessList = document.getElementById("access-list");
  const secretsList = document.getElementById("secrets-list");
  const approvalsList = document.getElementById("approvals-list");
  if (accessList) accessList.innerHTML = "";
  if (secretsList) secretsList.innerHTML = "";
  if (approvalsList) approvalsList.innerHTML = "";
  const accessSearch = document.getElementById("search-access");
  const secretsSearch = document.getElementById("search-secrets");
  if (accessSearch) accessSearch.value = "";
  if (secretsSearch) secretsSearch.value = "";
}

function showAuthView() {
  hideAllViews();
  document.getElementById("auth-view").classList.remove("hidden");
  // Reset auth form state
  loginPending = false;
  const errorDiv = document.getElementById("auth-error");
  const successDiv = document.getElementById("auth-success");
  const pendingDiv = document.getElementById("auth-pending");
  const submitBtn = document.querySelector('#auth-form button[type="submit"]');
  if (errorDiv) errorDiv.classList.add("hidden");
  if (successDiv) successDiv.classList.add("hidden");
  if (pendingDiv) pendingDiv.classList.add("hidden");
  if (submitBtn) {
    submitBtn.disabled = false;
    submitBtn.textContent = "Log In";
  }
}

function showMainView() {
  hideAllViews();
  document.getElementById("main-view").classList.remove("hidden");
}

function hideAllViews() {
  document.querySelectorAll(".view").forEach((v) => v.classList.add("hidden"));
}

async function handleStartLogin(e) {
  e.preventDefault();

  if (loginPending) return; // Already in progress

  const tenant = document.getElementById("tenant").value.trim().toLowerCase();
  const errorDiv = document.getElementById("auth-error");
  const successDiv = document.getElementById("auth-success");
  const pendingDiv = document.getElementById("auth-pending");
  const submitBtn = e.target.querySelector('button[type="submit"]');

  errorDiv.classList.add("hidden");
  successDiv.classList.add("hidden");

  if (!tenant) {
    errorDiv.textContent = "Please enter your tenant name";
    errorDiv.classList.remove("hidden");
    return;
  }

  if (!isValidTenant(tenant)) {
    errorDiv.textContent =
      "Invalid tenant name. Use only lowercase letters, numbers, hyphens, and dots.";
    errorDiv.classList.remove("hidden");
    return;
  }

  submitBtn.disabled = true;
  loginPending = true;
  submitBtn.textContent = "Logging in...";
  if (pendingDiv) pendingDiv.classList.remove("hidden");

  try {
    crtLog("AUTH", "OAuth login started for tenant: " + tenant);
    // This blocks until the OAuth flow completes (user authenticates or cancels)
    const response = await chrome.runtime.sendMessage({
      action: "startOAuthLogin",
      tenant,
    });

    if (response.success) {
      handleAuthenticationComplete({ success: true });
      return;
    } else {
      errorDiv.textContent = response.error || "Failed to log in";
      errorDiv.classList.remove("hidden");
    }
  } catch (error) {
    errorDiv.textContent = "Error: " + error.message;
    errorDiv.classList.remove("hidden");
  }
  loginPending = false;
  submitBtn.disabled = false;
  submitBtn.textContent = "Log In";
  if (pendingDiv) pendingDiv.classList.add("hidden");
}

function handleAuthenticationComplete(message) {
  loginPending = false;
  const errorDiv = document.getElementById("auth-error");
  const successDiv = document.getElementById("auth-success");
  const pendingDiv = document.getElementById("auth-pending");
  const submitBtn = document.querySelector('#auth-form button[type="submit"]');

  errorDiv.classList.add("hidden");
  successDiv.classList.add("hidden");
  if (pendingDiv) pendingDiv.classList.add("hidden");
  if (submitBtn) {
    submitBtn.disabled = false;
    submitBtn.textContent = "Log In";
  }

  if (message.success) {
    crtLog("AUTH", "authentication completed successfully");
    successDiv.textContent = "Authenticated!";
    successDiv.classList.remove("hidden");
    setTimeout(async () => {
      showMainView();
      initialLoadInProgress = true;
      await applyTabVisibility();
      await loadUserProfile();
      loadBanner();
      const { extensionSettings } =
        await chrome.storage.local.get("extensionSettings");
      loadEnabledTabData(extensionSettings);
      initialLoadInProgress = false;
    }, 800);
  } else {
    errorDiv.textContent = message.error || "Authentication failed.";
    errorDiv.classList.remove("hidden");
  }
}

// No separate check status function - login-in-progress is auto-detected on popup open

async function handleLogout() {
  crtLog("AUTH", "logout initiated");
  // Delegate full cleanup to background (clears token, caches, badge)
  await chrome.runtime.sendMessage({ action: "logout" });
  clearPopupState();
  closeSettingsSidebar();
  showAuthView();
}

async function openSettingsSidebar() {
  await loadSidebarSettings();
  await checkSidebarAuth();
  if (userProfile) updateSidebarUser(userProfile);

  const sidebar = document.getElementById("sidebar");
  const overlay = document.getElementById("sidebar-overlay");
  overlay.classList.remove("hidden");
  // Trigger reflow so transition plays
  void overlay.offsetWidth;
  overlay.classList.add("visible");
  sidebar.classList.add("open");
  document.body.classList.add("sidebar-open");
  await applyZoom();

  // Populate collection dropdown asynchronously (non-blocking)
  populateCollectionDropdown();
}

function closeSettingsSidebar() {
  const sidebar = document.getElementById("sidebar");
  const overlay = document.getElementById("sidebar-overlay");
  sidebar.classList.remove("open");
  overlay.classList.remove("visible");
  setTimeout(() => {
    overlay.classList.add("hidden");
    document.body.classList.remove("sidebar-open");
    applyZoom();
  }, 250);
}

async function checkSidebarAuth() {
  const logoutBtn = document.getElementById("sb-logout");
  try {
    const response = await chrome.runtime.sendMessage({
      action: "checkAuthenticationStatus",
    });
    if (response.authenticated) {
      logoutBtn.classList.remove("hidden");
    } else {
      logoutBtn.classList.add("hidden");
    }
  } catch (e) {
    logoutBtn.classList.add("hidden");
  }
}

async function populateCollectionDropdown() {
  const select = document.getElementById("sb-collection-name");
  if (!select) return;

  // Remember desired selection (saved value survives even if option not yet present)
  const preferredValue = (
    select.value ||
    select.dataset.savedCollectionName ||
    ""
  ).trim();

  try {
    // Ensure we have a user profile for the userId
    if (!userProfile) {
      const profileResp = await chrome.runtime.sendMessage({
        action: "getUserProfile",
      });
      if (profileResp && profileResp.profile) {
        userProfile = profileResp.profile;
      }
    }
    if (!userProfile || !userProfile.userId) return;

    const resp = await chrome.runtime.sendMessage({
      action: "getCollections",
      userId: userProfile.userId,
    });
    const collections = resp.collections || [];
    if (collections.error || !Array.isArray(collections)) return;

    // Clear existing options and rebuild
    select.length = 0;

    // Favorites is always first
    const favOpt = document.createElement("option");
    favOpt.value = "";
    favOpt.textContent = "Favorites only";
    select.appendChild(favOpt);

    // Sort collections alphabetically by name
    const sorted = collections
      .filter((c) => c.name)
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const col of sorted) {
      const opt = document.createElement("option");
      opt.value = col.name;
      opt.textContent = col.name;
      select.appendChild(opt);
    }

    // Restore previous selection (case-insensitive match)
    if (preferredValue) {
      const match = sorted.find(
        (c) => c.name.toLowerCase() === preferredValue.toLowerCase(),
      );
      select.value = match ? match.name : "";
    }
  } catch (e) {
    // Silently fail - dropdown already has "Favorites" as the default
  }
}

async function loadSidebarSettings() {
  const storage = await chrome.storage.local.get([
    "britiveSettings",
    "extensionSettings",
  ]);
  const tenantDisplay = document.getElementById("sb-tenant-display");
  const tenant = storage.britiveSettings?.tenant || "";
  if (tenantDisplay) {
    tenantDisplay.textContent = tenant
      ? `Tenant: ${tenant}.britive-app.com`
      : "Tenant: not set";
  }

  const s = getStoredSettings(storage.extensionSettings);
  const themeSelect = document.getElementById("sb-theme");
  let crtOpt = themeSelect.querySelector('option[value="crt"]');
  if (s.theme === "crt") {
    if (!crtOpt) {
      crtOpt = document.createElement("option");
      crtOpt.value = "crt";
      crtOpt.textContent = "CRT Terminal";
      themeSelect.appendChild(crtOpt);
    }
  } else if (crtOpt) {
    crtOpt.remove();
  }
  themeSelect.value = s.theme || "dark";
  document.getElementById("sb-zoom-level").value = s.zoomLevel || 100;
  document.getElementById("sb-banner-check").checked = s.bannerCheck ?? true;
  document.getElementById("sb-banner-poll").value = s.bannerPollInterval || 60;
  document.getElementById("sb-tab-access").checked = s.tabAccess ?? true;
  document.getElementById("sb-tab-approvals").checked = s.tabApprovals ?? true;
  document.getElementById("sb-tab-secrets").checked = s.tabSecrets ?? true;
  const collectionSelect = document.getElementById("sb-collection-name");
  collectionSelect.dataset.savedCollectionName = s.collectionName || "";
  collectionSelect.value = s.collectionName || "";
  document.getElementById("sb-checkout-expiry-notification").checked =
    s.checkoutExpiryNotification ?? true;
  document.getElementById("sb-auto-checkout-approval").checked =
    s.autoCheckoutOnApproval ?? false;
  document.getElementById("sb-show-all-types").checked =
    s.showAllSecretTypes ?? false;
  document.getElementById("sb-text-buttons").checked = s.textButtons ?? false;
  document.documentElement.dataset.textButtons = String(s.textButtons ?? false);
  applyTheme(s.theme || "dark");
}

async function sidebarSaveSettings() {
  try {
    const { extensionSettings: storedSettings } =
      await chrome.storage.local.get("extensionSettings");
    const extensionSettings = {
      ...getStoredSettings(storedSettings),
      theme: document.getElementById("sb-theme").value || "dark",
      zoomLevel: Math.max(
        50,
        Math.min(
          200,
          parseInt(document.getElementById("sb-zoom-level").value) || 100,
        ),
      ),
      bannerCheck: document.getElementById("sb-banner-check").checked,
      bannerPollInterval: Math.max(
        60,
        Math.min(
          600,
          parseInt(document.getElementById("sb-banner-poll").value) || 60,
        ),
      ),
      tabAccess: document.getElementById("sb-tab-access").checked,
      tabApprovals: document.getElementById("sb-tab-approvals").checked,
      tabSecrets: document.getElementById("sb-tab-secrets").checked,
      collectionName: document
        .getElementById("sb-collection-name")
        .value.trim(),
      checkoutExpiryNotification: document.getElementById(
        "sb-checkout-expiry-notification",
      ).checked,
      autoCheckoutOnApproval: document.getElementById(
        "sb-auto-checkout-approval",
      ).checked,
      showAllSecretTypes: document.getElementById("sb-show-all-types").checked,
      textButtons: document.getElementById("sb-text-buttons").checked,
    };

    await chrome.storage.local.set({ extensionSettings });
    crtLog(
      "SETTINGS",
      "saved theme=" +
        extensionSettings.theme +
        " collection=" +
        (extensionSettings.collectionName || "favorites"),
    );
    document.documentElement.dataset.textButtons = String(
      extensionSettings.textButtons ?? false,
    );
    applyTheme(extensionSettings.theme);
    chrome.runtime.sendMessage({
      action: "setExtensionIcon",
      crt: extensionSettings.theme === "crt",
    });
    applyZoom();
    await applyTabVisibility();
    // Invalidate collection cache in case the name changed
    cachedCollectionId = null;
    cachedCollectionName = "";
    crtLog("CACHE", "access cache invalidated (settings changed)");
    chrome.storage.local.remove([
      "accessCache_data",
      "accessCache_collectionId",
      "accessCache_collectionName",
      "pendingApprovals",
    ]);
    pendingApprovalRequests = {};
    showSaveTooltip("Saved", "success");
  } catch (error) {
    showSaveTooltip("Error", "error");
  }
}

async function sidebarResetSettings() {
  await chrome.storage.local.set({ extensionSettings: { ...defaultSettings } });
  cachedCollectionId = null;
  cachedCollectionName = "";
  chrome.storage.local.remove([
    "accessCache_data",
    "accessCache_collectionId",
    "accessCache_collectionName",
    "pendingApprovals",
  ]);
  pendingApprovalRequests = {};
  chrome.runtime.sendMessage({ action: "setExtensionIcon", crt: false });
  await loadSidebarSettings();
  showSaveTooltip("Reset", "info");
}

let saveTooltipTimer = null;

function showSaveTooltip(text, type) {
  const el = document.getElementById("sb-save-tooltip");
  if (!el) return;
  if (saveTooltipTimer) clearTimeout(saveTooltipTimer);
  el.textContent = text;
  el.className = "save-tooltip " + type + " visible";
  saveTooltipTimer = setTimeout(() => {
    el.classList.remove("visible");
    saveTooltipTimer = null;
  }, 2000);
}

async function loadSecrets(forceRefresh) {
  crtLog("SECRETS", "loading secrets (force=" + !!forceRefresh + ")");
  const listDiv = document.getElementById("secrets-list");
  const refreshBtn = document.getElementById("refresh");

  // Only show loading spinner on initial load (when list is empty or has the loading placeholder)
  if (!currentSecrets.length) {
    setStateMessage(
      listDiv,
      "loading",
      isCrt() ? "Querying vault..." : "Loading secrets...",
    );
  }
  const refreshIcon = refreshBtn && refreshBtn.querySelector(".refresh-icon");
  if (refreshBtn) refreshBtn.disabled = true;
  startRefreshSpinner(refreshIcon);

  try {
    const response = await chrome.runtime.sendMessage({
      action: "getSecrets",
      forceRefresh: forceRefresh === true,
    });

    if (response && response.secrets) {
      if (response.secrets.error) {
        crtLog("SECRETS", "error: " + response.secrets.error);
        setStateMessage(listDiv, "empty-state", response.secrets.error);
      } else {
        currentSecrets = Array.isArray(response.secrets)
          ? response.secrets
          : [];
        crtLog("SECRETS", "loaded " + currentSecrets.length + " secrets");
        displaySecrets(currentSecrets);
        updateLastRefreshed();
      }
    } else {
      setStateMessage(listDiv, "empty-state", "No response from server");
    }
  } catch (error) {
    crtLog("SECRETS", "error: " + error.message);
    // Only show error if we have no cached data
    if (!currentSecrets.length) {
      setStateMessage(listDiv, "empty-state", "Error: " + error.message);
    }
  } finally {
    stopRefreshSpinner(refreshIcon, () => {
      if (refreshBtn) refreshBtn.disabled = false;
    });
  }
}

async function displaySecrets(secrets) {
  const listDiv = document.getElementById("secrets-list");

  if (!secrets || secrets.length === 0) {
    setStateMessage(
      listDiv,
      "empty-state",
      isCrt() ? "> No records found." : "No secrets found",
    );
    return;
  }

  // Apply type filtering if templates are loaded and showAllSecretTypes is off
  let filtered = secrets;
  const storage = await chrome.storage.local.get("extensionSettings");
  const showAll =
    (storage.extensionSettings || defaultSettings).showAllSecretTypes ?? false;

  if (
    !showAll &&
    secretTemplates &&
    secretTemplates.webTypes &&
    secretTemplates.webTypes.length > 0
  ) {
    filtered = secrets.filter((s) =>
      secretTemplates.webTypes.includes(s.secretType),
    );
  }

  if (filtered.length === 0) {
    setStateMessage(
      listDiv,
      "empty-state",
      "No web credential secrets found.",
      'Enable "Show all secret types" in settings to see all.',
    );
    return;
  }

  // If container has no keyed children (first render or state message), do full build
  const existingItems = listDiv.querySelectorAll(
    ":scope > .secret-item[data-secret-key]",
  );
  if (existingItems.length === 0) {
    clearElement(listDiv);
    filtered.forEach((secret, i) =>
      listDiv.appendChild(createSecretItem(secret, i)),
    );
    return;
  }

  // Reconcile: diff existing items against new data
  reconcileSecrets(listDiv, filtered);
}

function reconcileSecrets(container, secrets) {
  const existingMap = new Map();
  container
    .querySelectorAll(":scope > .secret-item[data-secret-key]")
    .forEach((el) => {
      existingMap.set(el.dataset.secretKey, el);
    });

  const newKeys = new Set(secrets.map((s) => s.name + "|" + (s.path || "")));

  // Remove items no longer in data
  for (const [key, el] of existingMap) {
    if (!newKeys.has(key)) el.remove();
  }

  // Add or update items in order
  let prevSibling = null;
  secrets.forEach((secret, i) => {
    const secretKey = secret.name + "|" + (secret.path || "");
    const existing = existingMap.get(secretKey);
    if (existing) {
      // Update index and search text
      existing.dataset.index = i;
      existing.dataset.searchText = [
        secret.name,
        secret.path,
        secret.secretType,
      ]
        .join(" ")
        .toLowerCase();
      // Update name/path text if changed
      const nameEl = existing.querySelector(".secret-name");
      if (nameEl && nameEl.textContent !== (secret.name || "Unnamed Secret")) {
        nameEl.textContent = secret.name || "Unnamed Secret";
      }
      const pathEl = existing.querySelector(".secret-username");
      if (pathEl && pathEl.textContent !== (secret.path || "")) {
        pathEl.textContent = secret.path || "";
      }
      // Preserve expanded .secret-details - do not touch it
      // Ensure correct order
      if (prevSibling) {
        if (existing.previousElementSibling !== prevSibling) {
          prevSibling.after(existing);
        }
      } else if (existing !== container.firstElementChild) {
        container.prepend(existing);
      }
      prevSibling = existing;
    } else {
      const newEl = createSecretItem(secret, i);
      if (prevSibling) {
        prevSibling.after(newEl);
      } else {
        container.prepend(newEl);
      }
      prevSibling = newEl;
    }
  });
}

function createSecretItem(secret, index) {
  const div = document.createElement("div");
  div.className = "secret-item";
  div.dataset.index = index;
  div.dataset.secretKey = secret.name + "|" + (secret.path || "");
  div.dataset.searchText = [secret.name, secret.path, secret.secretType]
    .join(" ")
    .toLowerCase();

  const name = document.createElement("div");
  name.className = "secret-name";
  name.textContent = secret.name || "Unnamed Secret";

  const path = document.createElement("div");
  path.className = "secret-username";
  path.textContent = secret.path || "";

  div.appendChild(name);
  if (secret.path) div.appendChild(path);

  div.addEventListener("click", () => toggleSecretDetails(div, secret));
  return div;
}

async function toggleSecretDetails(itemDiv, secret) {
  const existing = itemDiv.querySelector(".secret-details");
  if (existing) {
    existing.remove();
    return;
  }

  // Close any other open details
  document.querySelectorAll(".secret-details").forEach((d) => d.remove());

  const details = document.createElement("div");
  details.className = "secret-details";
  setStateMessage(details, "loading", "Retrieving secret...");
  itemDiv.appendChild(details);

  try {
    const response = await chrome.runtime.sendMessage({
      action: "getSecretValue",
      path: secret.path,
    });

    if (response.error) {
      setStateMessage(details, "empty-state", response.error);
      return;
    }

    clearElement(details);

    // response.fields is a flat { key: stringValue } map
    const fields = response.fields || {};
    let otpValue = null;

    // Sort fields: username, password, url, otp first, then the rest alphabetically
    const fieldOrder = ["username", "password", "url", "otp"];
    const sortedEntries = Object.entries(fields).sort((a, b) => {
      const ai = fieldOrder.indexOf(a[0].toLowerCase());
      const bi = fieldOrder.indexOf(b[0].toLowerCase());
      const aw = ai >= 0 ? ai : fieldOrder.length;
      const bw = bi >= 0 ? bi : fieldOrder.length;
      if (aw !== bw) return aw - bw;
      return a[0].localeCompare(b[0]);
    });

    for (const [key, value] of sortedEntries) {
      const isPassword = key.toLowerCase() === "password";
      details.appendChild(createSecretField(key, value, value, isPassword));
      if (key.toLowerCase() === "otp" && value) {
        otpValue = value;
      }
    }

    // Auto-copy OTP to clipboard if setting enabled (time-sensitive codes)
    if (otpValue) {
      const { extensionSettings: otpSettings } =
        await chrome.storage.local.get("extensionSettings");
      if ((otpSettings || defaultSettings).otpAutoCopy) {
        navigator.clipboard.writeText(otpValue).catch(() => {});
        const otpNotice = document.createElement("div");
        otpNotice.style.cssText =
          "font-size: 11px; color: #4ade80; padding: 4px 0 0 0;";
        otpNotice.textContent = "OTP copied to clipboard";
        details.appendChild(otpNotice);
      }
    }

    // If no fields came back, show a note
    if (Object.keys(fields).length === 0) {
      setStateMessage(details, "empty-state", "No value returned");
    }
  } catch (error) {
    setStateMessage(details, "empty-state", "Error: " + error.message);
  }
}

function createSecretField(label, displayValue, copyValue, masked) {
  const field = document.createElement("div");
  field.className = "secret-field";

  const labelSpan = document.createElement("span");
  labelSpan.className = "secret-label";
  labelSpan.textContent = label;

  const valueSpan = document.createElement("span");
  valueSpan.className = "secret-value";

  const textNode = document.createElement("span");
  textNode.textContent = masked ? "••••••••" : displayValue;

  valueSpan.appendChild(textNode);

  if (masked) {
    const showBtn = document.createElement("button");
    showBtn.className = "show-btn";
    showBtn.dataset.visible = "false";
    setElementIcon(showBtn, getShowIcon(false));
    setTooltipText(showBtn, "Show secret");
    let visible = false;
    showBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      visible = !visible;
      showBtn.dataset.visible = String(visible);
      textNode.textContent = visible ? displayValue : "••••••••";
      setElementIcon(showBtn, getShowIcon(visible));
      setTooltipText(showBtn, visible ? "Hide secret" : "Show secret");
    });
    valueSpan.appendChild(showBtn);
  }

  if (copyValue != null) {
    const copyBtn = document.createElement("button");
    copyBtn.className = "copy-btn";
    setElementIcon(copyBtn, getCopyIcon());
    setTooltipText(copyBtn, "Copy secret");
    copyBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      navigator.clipboard.writeText(copyValue);
      copyBtn.textContent = isCrt() ? "[:y!]" : "Copied!";
      setTimeout(() => {
        setElementIcon(copyBtn, getCopyIcon());
        setTooltipText(copyBtn, "Copy secret");
      }, 1500);
    });
    valueSpan.appendChild(copyBtn);
  }

  field.appendChild(labelSpan);
  field.appendChild(valueSpan);
  return field;
}

async function loadAccess(forceRefresh) {
  const listDiv = document.getElementById("access-list");
  const refreshBtn = document.getElementById("refresh");

  // Check if collection name is configured (empty = use favorites)
  const { extensionSettings } =
    await chrome.storage.local.get("extensionSettings");
  const collectionName =
    (extensionSettings || defaultSettings).collectionName || "";
  const useFavorites = !collectionName;
  crtLog(
    "ACCESS",
    "loading (" +
      (useFavorites ? "favorites" : "collection=" + collectionName) +
      ")",
  );

  // Only show loading spinner if we have no data at all yet
  const hasExistingData = currentAccess.length > 0;
  if (!hasExistingData) {
    setStateMessage(
      listDiv,
      "loading",
      isCrt() ? "Fetching access data..." : "Loading access...",
    );
  }
  const refreshIcon = refreshBtn && refreshBtn.querySelector(".refresh-icon");
  if (refreshBtn && activeTab === "access") refreshBtn.disabled = true;
  if (activeTab === "access") startRefreshSpinner(refreshIcon);

  try {
    // Resolve collection ID if a collection name is specified
    let collectionId = null;

    if (!useFavorites) {
      // Get user profile for userId (only if not cached)
      if (!userProfile) {
        const profileResp = await chrome.runtime.sendMessage({
          action: "getUserProfile",
        });
        if (profileResp && profileResp.profile) {
          userProfile = profileResp.profile;
          updateAvatarFromProfile(userProfile);
          updateSidebarUser(userProfile);
        }
      }

      if (!userProfile || !userProfile.userId) {
        if (!hasExistingData) {
          setStateMessage(
            listDiv,
            "empty-state",
            "Could not determine user ID. Please log in again.",
          );
        }
        return;
      }

      // Resolve collection ID (use cache if collection name hasn't changed)
      if (
        cachedCollectionId &&
        cachedCollectionName.toLowerCase() === collectionName.toLowerCase()
      ) {
        crtLog("CACHE", "collection ID cache hit: " + cachedCollectionId);
        collectionId = cachedCollectionId;
      } else {
        const collectionsResp = await chrome.runtime.sendMessage({
          action: "getCollections",
          userId: userProfile.userId,
        });

        if (!collectionsResp || collectionsResp.collections?.error) {
          const errMsg =
            collectionsResp?.collections?.error || "Failed to load collections";
          if (!hasExistingData) {
            setStateMessage(listDiv, "empty-state", errMsg);
          }
          return;
        }

        const collections = collectionsResp.collections || [];
        const match = collections.find(
          (c) =>
            c.name && c.name.toLowerCase() === collectionName.toLowerCase(),
        );

        if (!match) {
          setStateMessage(
            listDiv,
            "empty-state",
            'Collection "' + collectionName + '" not found.',
            "Available: " +
              (collections.map((c) => c.name).join(", ") || "none"),
          );
          cachedCollectionId = null;
          cachedCollectionName = "";
          return;
        }

        collectionId = match.id;
        cachedCollectionId = match.id;
        cachedCollectionName = collectionName;
      }
    }

    // Always fetch favorites; also fetch collection if a non-Favorites collection is selected
    const favMsg = {
      action: "getAccess",
      favorites: true,
      forceRefresh: forceRefresh === true,
    };
    const fetches = [
      chrome.runtime.sendMessage(favMsg),
      chrome.runtime
        .sendMessage({ action: "getCheckedOutProfiles" })
        .catch(() => ({})),
    ];
    const hasCollection = !useFavorites && collectionId;
    if (hasCollection) {
      fetches.push(
        chrome.runtime.sendMessage({
          action: "getAccess",
          collectionId,
          forceRefresh: forceRefresh === true,
        }),
      );
    }
    const results = await Promise.all(fetches);
    const favResp = results[0];
    const coResp = results[1];
    const colResp = hasCollection ? results[2] : null;

    if (!favResp || favResp.access?.error) {
      const errMsg = favResp?.access?.error || "Failed to load access";
      if (!hasExistingData) {
        setStateMessage(listDiv, "empty-state", errMsg);
      }
      return;
    }

    // Merge favorites + collection items (favorites take priority, dedup by papId|environmentId)
    const favData = favResp.access || {};
    const favItems = Array.isArray(favData.items) ? favData.items : [];
    let mergedItems = favItems;

    if (colResp && !colResp.access?.error) {
      const colData = colResp.access || {};
      const colItems = Array.isArray(colData.items) ? colData.items : [];
      const seen = new Set();
      favItems.forEach((item) => {
        const papId = item.papId || (item.profile && item.profile.papId);
        const envId =
          item.environmentId ||
          (item.environment && item.environment.environmentId);
        seen.add(papId + "|" + envId);
      });
      const additional = colItems.filter((item) => {
        const papId = item.papId || (item.profile && item.profile.papId);
        const envId =
          item.environmentId ||
          (item.environment && item.environment.environmentId);
        return !seen.has(papId + "|" + envId);
      });
      mergedItems = favItems.concat(additional);
    }

    const accessData = { items: mergedItems, count: mergedItems.length };
    const checkedOutList =
      coResp && Array.isArray(coResp.checkedOut) ? coResp.checkedOut : [];

    // Build a flat list from the access response
    currentAccess = buildAccessList(accessData, checkedOutList);
    crtLog(
      "ACCESS",
      "loaded " +
        currentAccess.length +
        " items (" +
        checkedOutList.length +
        " checked out)",
    );

    // Show merge info note when viewing Favorites + a collection
    const oldNote = listDiv.querySelector(".merge-info-note");
    if (oldNote) oldNote.remove();
    if (hasCollection) {
      const note = document.createElement("div");
      note.className = "merge-info-note";
      note.textContent = "Showing Favorites + " + collectionName;
      listDiv.prepend(note);
    }

    displayAccess(currentAccess);
    startExpirationTimer();
    updateLastRefreshed();

    // Restart polls for any cached pending approvals that don't have active timers
    restartPendingApprovalPolls();

    // Persist to storage so next popup open shows data instantly
    chrome.storage.local.set({
      accessCache_data: currentAccess,
      accessCache_collectionId: useFavorites
        ? "__favorites__"
        : "__merged__|" + cachedCollectionId,
      accessCache_collectionName: useFavorites ? "" : cachedCollectionName,
    });
  } catch (error) {
    crtLog("ACCESS", "error: " + error.message);
    if (!hasExistingData) {
      setStateMessage(listDiv, "empty-state", "Error: " + error.message);
    }
  } finally {
    stopRefreshSpinner(refreshIcon, () => {
      if (refreshBtn) refreshBtn.disabled = false;
    });
  }
}

function buildAccessList(data, checkedOutList) {
  // Build a lookup of checked-out profiles keyed to CONSOLE entries
  const checkedOutMap = {};
  if (Array.isArray(checkedOutList)) {
    checkedOutList.forEach((co) => {
      if (isActiveConsoleCheckout(co)) {
        const key = `${co.papId}|${co.environmentId}|CONSOLE`;
        checkedOutMap[key] = co.transactionId;
      }
    });
  }

  // New API format: data.items[] each have nested application, profile, environment, myAccessDetails[]
  const items = Array.isArray(data.items) ? data.items : [];
  const result = [];

  items.forEach((item) => {
    const app = item.application || {};
    const prof = item.profile || {};
    const env = item.environment || {};
    const details = Array.isArray(item.myAccessDetails)
      ? item.myAccessDetails
      : [];

    // Find the CONSOLE access detail entry (skip PROGRAMMATIC-only items)
    const consoleDetail = details.find(
      (d) => (d.accessType || "").toUpperCase() === "CONSOLE",
    );
    if (!consoleDetail) return; // no console access for this item

    const papId = item.papId || prof.papId || "";
    const environmentId = item.environmentId || env.environmentId || "";
    const coKey = `${papId}|${environmentId}|CONSOLE`;
    const isCheckedOut = coKey in checkedOutMap;

    const status = consoleDetail.status || "";
    const statusLower = status.toLowerCase();
    const approvalRequired =
      statusLower === "approvalrequired" && !consoleDetail.approvalValidityTime;
    const approvalPending = statusLower === "pending";

    result.push({
      transactionId: isCheckedOut ? checkedOutMap[coKey] : "",
      appName: app.appName || "Unknown App",
      appType: app.applicationType || "",
      profileName: prof.papName || "",
      environmentName: env.environmentName || "",
      status,
      checkedOut: isCheckedOut,
      approvalRequired,
      approvalPending,
      accessType: "CONSOLE",
      raw: {
        papId,
        environmentId,
        appId: item.appId || app.appId || "",
        accessType: "CONSOLE",
      },
    });
  });

  return result;
}

function displayAccess(accessItems) {
  const listDiv = document.getElementById("access-list");

  if (!accessItems || accessItems.length === 0) {
    setStateMessage(
      listDiv,
      "empty-state",
      isCrt()
        ? "> No access profiles found."
        : "No access found in this collection",
    );
    return;
  }

  // Group items: App > Profile > Environments
  const grouped = groupAccessItems(accessItems);

  // If container has no keyed children (first render or was showing a state message), do a full build
  const existingGroups = listDiv.querySelectorAll(
    ":scope > .access-group[data-app-key]",
  );
  if (existingGroups.length === 0) {
    clearElement(listDiv);
    grouped.forEach((appGroup) =>
      listDiv.appendChild(createAccessGroup(appGroup)),
    );
    return;
  }

  // Reconcile: diff existing groups against new data
  reconcileAccessGroups(listDiv, grouped);
}

function reconcileAccessGroups(container, groups) {
  const existingMap = new Map();
  container
    .querySelectorAll(":scope > .access-group[data-app-key]")
    .forEach((el) => {
      existingMap.set(el.dataset.appKey, el);
    });

  const newKeys = new Set(groups.map((g) => g.appName));

  // Remove groups no longer in data
  for (const [key, el] of existingMap) {
    if (!newKeys.has(key)) el.remove();
  }

  // Add or update groups in order
  let prevSibling = null;
  for (const appGroup of groups) {
    const existing = existingMap.get(appGroup.appName);
    if (existing) {
      // Update profiles within this group
      const appBody = existing.querySelector(":scope > .access-group-body");
      if (appBody) reconcileProfiles(appBody, appGroup);
      // Ensure correct order
      if (prevSibling) {
        if (existing.previousElementSibling !== prevSibling) {
          prevSibling.after(existing);
        }
      } else if (existing !== container.firstElementChild) {
        container.prepend(existing);
      }
      prevSibling = existing;
    } else {
      // New group - create and insert in correct position
      const newEl = createAccessGroup(appGroup);
      if (prevSibling) {
        prevSibling.after(newEl);
      } else {
        container.prepend(newEl);
      }
      prevSibling = newEl;
    }
  }
}

function reconcileProfiles(appBody, appGroup) {
  const existingMap = new Map();
  appBody
    .querySelectorAll(":scope > .access-profile-section[data-prof-key]")
    .forEach((el) => {
      existingMap.set(el.dataset.profKey, el);
    });

  const newKeys = new Set(
    appGroup.profiles.map((p) => appGroup.appName + "/" + p.profileName),
  );

  // Remove profiles no longer in data
  for (const [key, el] of existingMap) {
    if (!newKeys.has(key)) el.remove();
  }

  // Add or update profiles in order
  let prevSibling = null;
  for (const prof of appGroup.profiles) {
    const profKey = appGroup.appName + "/" + prof.profileName;
    const existing = existingMap.get(profKey);
    if (existing) {
      // Update env rows within this profile
      const profBody = existing.querySelector(":scope > .access-profile-body");
      if (profBody) reconcileEnvRows(profBody, prof.envs);
      // Ensure correct order
      if (prevSibling) {
        if (existing.previousElementSibling !== prevSibling) {
          prevSibling.after(existing);
        }
      } else if (existing !== appBody.firstElementChild) {
        appBody.prepend(existing);
      }
      prevSibling = existing;
    } else {
      // New profile - build the profile section from scratch
      const appCollapsedKey = "app:" + appGroup.appName;
      const profCollapsedKey = "prof:" + profKey;
      const profCollapsed = !!collapsedState[profCollapsedKey];

      const profileSection = document.createElement("div");
      profileSection.className = "access-profile-section";
      profileSection.dataset.profKey = profKey;

      const profileHeader = document.createElement("div");
      profileHeader.className =
        "access-profile-header collapsible" +
        (profCollapsed ? " collapsed" : "");
      setElementIcon(profileHeader, getChevronSvg());
      const profileLabel = document.createElement("span");
      profileLabel.className = "access-profile-name";
      profileLabel.textContent = prof.profileName;
      profileHeader.appendChild(profileLabel);
      profileSection.appendChild(profileHeader);

      const profileBody = document.createElement("div");
      profileBody.className =
        "access-profile-body" + (profCollapsed ? " collapsed" : "");
      prof.envs.forEach((item) => profileBody.appendChild(createEnvRow(item)));
      profileSection.appendChild(profileBody);

      profileHeader.addEventListener("click", (e) => {
        e.stopPropagation();
        const nowCollapsed = !profileHeader.classList.contains("collapsed");
        profileHeader.classList.toggle("collapsed");
        profileBody.classList.toggle("collapsed");
        if (nowCollapsed) {
          collapsedState[profCollapsedKey] = true;
        } else {
          delete collapsedState[profCollapsedKey];
        }
        saveCollapsedState();
      });

      if (prevSibling) {
        prevSibling.after(profileSection);
      } else {
        appBody.prepend(profileSection);
      }
      prevSibling = profileSection;
    }
  }
}

function reconcileEnvRows(profBody, envItems) {
  const existingMap = new Map();
  profBody
    .querySelectorAll(":scope > .access-env-row[data-env-key]")
    .forEach((el) => {
      existingMap.set(el.dataset.envKey, el);
    });

  const newKeys = new Set(
    envItems.map((item) => item.raw.papId + "|" + item.raw.environmentId),
  );

  // Remove rows no longer in data
  for (const [key, el] of existingMap) {
    if (!newKeys.has(key)) el.remove();
  }

  // Add or update rows in order
  let prevSibling = null;
  for (const item of envItems) {
    const envKey = item.raw.papId + "|" + item.raw.environmentId;
    const existing = existingMap.get(envKey);
    if (existing) {
      updateEnvRow(existing, item);
      // Ensure correct order
      if (prevSibling) {
        if (existing.previousElementSibling !== prevSibling) {
          prevSibling.after(existing);
        }
      } else if (existing !== profBody.firstElementChild) {
        profBody.prepend(existing);
      }
      prevSibling = existing;
    } else {
      const newRow = createEnvRow(item);
      if (prevSibling) {
        prevSibling.after(newRow);
      } else {
        profBody.prepend(newRow);
      }
      prevSibling = newRow;
    }
  }
}

function updateEnvRow(row, item) {
  // Update search text
  row.dataset.searchText = [
    item.appName,
    item.profileName,
    item.environmentName,
  ]
    .join(" ")
    .toLowerCase();

  // Update environment name
  const envNameEl = row.querySelector(".access-env-name");
  if (envNameEl) envNameEl.textContent = item.environmentName || "Default";

  // Determine new toggle state
  const pendingKey = `${item.raw.papId}|${item.raw.environmentId}`;

  // Server-detected pending: seed local state so withdrawal works
  if (item.approvalPending && !pendingApprovalRequests[pendingKey]) {
    pendingApprovalRequests[pendingKey] = { requestId: null, timerId: null };
    savePendingApprovals();
  }

  // Clean up stale pending state: if the server no longer reports pending
  // but we have a local pending entry, the approval was already processed.
  if (
    !item.approvalPending &&
    !item.checkedOut &&
    pendingApprovalRequests[pendingKey]
  ) {
    clearPendingApproval(pendingKey);
    savePendingApprovals();
  }

  const isPending =
    !!pendingApprovalRequests[pendingKey] || item.approvalPending;
  let toggleState, toggleTitle;
  if (item.checkedOut) {
    toggleState = "on";
    toggleTitle = "Check in";
  } else if (isPending) {
    toggleState = "pending";
    toggleTitle = "Withdraw approval";
  } else if (item.approvalRequired) {
    toggleState = "approval";
    toggleTitle = "Requires approval";
  } else {
    toggleState = "off";
    toggleTitle = "Check out";
  }

  // Rebuild actions container - simpler and safer than patching individual buttons
  const oldActions = row.querySelector(".access-env-actions");
  const actions = document.createElement("div");
  actions.className = "access-env-actions";

  if (item.checkedOut) {
    const openBtn = document.createElement("button");
    openBtn.className = "btn-open";
    setTooltipText(openBtn, "Open console");
    setElementIcon(openBtn, getOpenIcon(true));
    openBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      handleAccessOpen(row, item);
    });
    actions.appendChild(openBtn);

    const copyBtn = document.createElement("button");
    copyBtn.className = "btn-copy";
    setTooltipText(copyBtn, "Copy console URL");
    setElementIcon(copyBtn, getCopyIcon(true));
    copyBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      handleAccessCopyUrl(row, item);
    });
    actions.appendChild(copyBtn);

    const timerBadge = document.createElement("span");
    timerBadge.className = "expiration-badge";
    timerBadge.dataset.expirationKey = `${item.raw.papId}|${item.raw.environmentId}|${(item.accessType || "CONSOLE").toUpperCase()}`;
    actions.appendChild(timerBadge);
  }

  const toggle = document.createElement("button");
  toggle.className = "access-toggle " + toggleState;
  setTooltipText(
    toggle,
    isPending ? "Pending Approval - click to withdraw" : toggleTitle,
  );
  setElementIcon(toggle, getToggleIcon(toggleState));
  toggle.addEventListener("click", (e) => {
    e.stopPropagation();
    if (
      (pendingApprovalRequests[pendingKey] || item.approvalPending) &&
      e.shiftKey &&
      e.altKey
    ) {
      launchActivityPicker();
      return;
    }
    if (item.checkedOut) {
      handleAccessCheckin(row, item);
    } else if (pendingApprovalRequests[pendingKey] || item.approvalPending) {
      handleWithdrawApproval(row, item, pendingKey);
    } else {
      handleAccessCheckout(row, item);
    }
  });
  actions.appendChild(toggle);

  if (oldActions) {
    oldActions.replaceWith(actions);
  } else {
    row.appendChild(actions);
  }
}

function groupAccessItems(items) {
  const appMap = new Map();

  items.forEach((item) => {
    const appKey = item.appName || "Unknown App";
    if (!appMap.has(appKey)) {
      appMap.set(appKey, {
        appName: appKey,
        appType: item.appType || "",
        profiles: new Map(),
      });
    }
    const app = appMap.get(appKey);
    const profileKey = item.profileName || "Unknown Profile";
    if (!app.profiles.has(profileKey)) {
      app.profiles.set(profileKey, { profileName: profileKey, envs: [] });
    }
    app.profiles.get(profileKey).envs.push(item);
  });

  // Convert to array, sort apps and profiles alphabetically
  const result = [];
  for (const app of [...appMap.values()].sort((a, b) =>
    a.appName.localeCompare(b.appName),
  )) {
    const profiles = [];
    for (const prof of [...app.profiles.values()].sort((a, b) =>
      a.profileName.localeCompare(b.profileName),
    )) {
      prof.envs.sort((a, b) =>
        (a.environmentName || "").localeCompare(b.environmentName || ""),
      );
      profiles.push(prof);
    }
    result.push({ appName: app.appName, appType: app.appType, profiles });
  }
  return result;
}

function getChevronSvg() {
  return '<svg class="collapse-chevron" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
}

function saveCollapsedState() {
  chrome.storage.local.set({ accessCollapsedState: collapsedState });
}

function createAccessGroup(appGroup) {
  const group = document.createElement("div");
  group.className = "access-group";
  group.dataset.appKey = appGroup.appName;

  const appKey = "app:" + appGroup.appName;
  const appCollapsed = !!collapsedState[appKey];

  // App header (clickable to collapse/expand)
  const appHeader = document.createElement("div");
  appHeader.className =
    "access-group-header collapsible" + (appCollapsed ? " collapsed" : "");
  setElementIcon(appHeader, getChevronSvg());
  const appTitle = document.createElement("div");
  appTitle.className = "access-group-title";
  appTitle.textContent = appGroup.appName;
  appHeader.appendChild(appTitle);
  if (appGroup.appType) {
    const appType = document.createElement("span");
    appType.className = "access-group-type";
    appType.textContent = appGroup.appType;
    appHeader.appendChild(appType);
  }
  group.appendChild(appHeader);

  // App body (collapsible container for all profiles)
  const appBody = document.createElement("div");
  appBody.className = "access-group-body" + (appCollapsed ? " collapsed" : "");

  // Profiles
  appGroup.profiles.forEach((prof) => {
    const profKey = "prof:" + appGroup.appName + "/" + prof.profileName;
    const profCollapsed = !!collapsedState[profKey];

    const profileSection = document.createElement("div");
    profileSection.className = "access-profile-section";
    profileSection.dataset.profKey = appGroup.appName + "/" + prof.profileName;

    const profileHeader = document.createElement("div");
    profileHeader.className =
      "access-profile-header collapsible" + (profCollapsed ? " collapsed" : "");
    setElementIcon(profileHeader, getChevronSvg());
    const profileLabel = document.createElement("span");
    profileLabel.className = "access-profile-name";
    profileLabel.textContent = prof.profileName;
    profileHeader.appendChild(profileLabel);
    profileSection.appendChild(profileHeader);

    // Environment rows (collapsible container)
    const profileBody = document.createElement("div");
    profileBody.className =
      "access-profile-body" + (profCollapsed ? " collapsed" : "");
    prof.envs.forEach((item) => {
      profileBody.appendChild(createEnvRow(item));
    });
    profileSection.appendChild(profileBody);

    // Toggle collapse on profile header click
    profileHeader.addEventListener("click", (e) => {
      e.stopPropagation();
      const nowCollapsed = !profileHeader.classList.contains("collapsed");
      profileHeader.classList.toggle("collapsed");
      profileBody.classList.toggle("collapsed");
      if (nowCollapsed) {
        collapsedState[profKey] = true;
      } else {
        delete collapsedState[profKey];
      }
      saveCollapsedState();
    });

    appBody.appendChild(profileSection);
  });

  group.appendChild(appBody);

  // Toggle collapse on app header click
  appHeader.addEventListener("click", () => {
    const nowCollapsed = !appHeader.classList.contains("collapsed");
    appHeader.classList.toggle("collapsed");
    appBody.classList.toggle("collapsed");
    if (nowCollapsed) {
      collapsedState[appKey] = true;
    } else {
      delete collapsedState[appKey];
    }
    saveCollapsedState();
  });

  return group;
}

function getCheckoutSvg() {
  return '<svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path opacity="0.4" d="M16.65 3.85986H7.35C3.25 3.85986 2 5.10986 2 9.20986V14.7899C2 18.8899 3.25 20.1399 7.35 20.1399H16.65C20.75 20.1399 22 18.8899 22 14.7899V9.20986C22 5.10986 20.75 3.85986 16.65 3.85986Z"/><path d="M10.7898 7.58008H8.55977C6.30977 7.58008 5.25977 8.63008 5.25977 10.8801V13.1101C5.25977 15.3601 6.30977 16.4101 8.55977 16.4101H10.7898C13.0398 16.4101 14.0898 15.3601 14.0898 13.1101V10.8801C14.0898 8.63008 13.0398 7.58008 10.7898 7.58008Z"/></svg>';
}

function getCheckinSvg() {
  return '<svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path opacity="0.4" d="M7.35 3.85986H16.65C20.75 3.85986 22 5.10986 22 9.20986V14.7899C22 18.8899 20.75 20.1399 16.65 20.1399H7.35C3.25 20.1399 2 18.8899 2 14.7899V9.20986C2 5.10986 3.25 3.85986 7.35 3.85986Z"/><path d="M13.2102 7.58008H15.4402C17.6902 7.58008 18.7402 8.63008 18.7402 10.8801V13.1101C18.7402 15.3601 17.6902 16.4101 15.4402 16.4101H13.2102C10.9602 16.4101 9.91016 15.3601 9.91016 13.1101V10.8801C9.91016 8.63008 10.9602 7.58008 13.2102 7.58008Z"/></svg>';
}

function getOpenSvg() {
  return '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M7 7H17M17 7V17M17 7L7 17" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
}

function getWithdrawSvg() {
  return '<svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path opacity="0.4" d="M16.19 2H7.81C4.17 2 2 4.17 2 7.81V16.18C2 19.83 4.17 22 7.81 22H16.18C19.82 22 21.99 19.83 21.99 16.19V7.81C22 4.17 19.83 2 16.19 2Z"/><path d="M13.0594 12.0001L15.3594 9.70011C15.6494 9.41011 15.6494 8.93011 15.3594 8.64011C15.0694 8.35011 14.5894 8.35011 14.2994 8.64011L11.9994 10.9401L9.69937 8.64011C9.40937 8.35011 8.92937 8.35011 8.63938 8.64011C8.34938 8.93011 8.34938 9.41011 8.63938 9.70011L10.9394 12.0001L8.63938 14.3001C8.34938 14.5901 8.34938 15.0701 8.63938 15.3601C8.78938 15.5101 8.97937 15.5801 9.16937 15.5801C9.35937 15.5801 9.54937 15.5101 9.69937 15.3601L11.9994 13.0601L14.2994 15.3601C14.4494 15.5101 14.6394 15.5801 14.8294 15.5801C15.0194 15.5801 15.2094 15.5101 15.3594 15.3601C15.6494 15.0701 15.6494 14.5901 15.3594 14.3001L13.0594 12.0001Z"/></svg>';
}

function getAddItemSvg() {
  return '<svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path opacity="0.4" d="M18.5703 22H14.0003C11.7103 22 10.5703 20.86 10.5703 18.57V11.43C10.5703 9.14 11.7103 8 14.0003 8H18.5703C20.8603 8 22.0003 9.14 22.0003 11.43V18.57C22.0003 20.86 20.8603 22 18.5703 22Z"/><path d="M13.43 5.43V6.77C10.81 6.98 9.32 8.66 9.32 11.43V16H5.43C3.14 16 2 14.86 2 12.57V5.43C2 3.14 3.14 2 5.43 2H10C12.29 2 13.43 3.14 13.43 5.43Z"/><path d="M18.1291 14.2501H17.2491V13.3701C17.2491 12.9601 16.9091 12.6201 16.4991 12.6201C16.0891 12.6201 15.7491 12.9601 15.7491 13.3701V14.2501H14.8691C14.4591 14.2501 14.1191 14.5901 14.1191 15.0001C14.1191 15.4101 14.4591 15.7501 14.8691 15.7501H15.7491V16.6301C15.7491 17.0401 16.0891 17.3801 16.4991 17.3801C16.9091 17.3801 17.2491 17.0401 17.2491 16.6301V15.7501H18.1291C18.5391 15.7501 18.8791 15.4101 18.8791 15.0001C18.8791 14.5901 18.5391 14.2501 18.1291 14.2501Z"/></svg>';
}

function isCrt() {
  return document.documentElement.classList.contains("crt");
}

function useTextButtons() {
  return document.documentElement.dataset.textButtons === "true";
}

function getWithdrawIcon() {
  if (useTextButtons()) return "Withdraw";
  return isCrt() ? "[:u]" : getWithdrawSvg();
}

function getToggleIcon(state) {
  if (useTextButtons()) {
    switch (state) {
      case "off":
        return "Check Out";
      case "on":
        return "Check In";
      case "approval":
        return "Request Approval";
      case "pending":
        return "Pending Approval";
      case "checking-in":
        return "Check In";
      default:
        return "Check Out";
    }
  }
  if (!isCrt()) {
    if (state === "on") return getCheckinSvg();
    if (state === "pending") return getCheckoutSvg(); // toggle-off in red (color via CSS)
    return getCheckoutSvg(); // off, approval, checking-in
  }
  switch (state) {
    case "off":
      return "[:e]";
    case "on":
      return "[:q]";
    case "approval":
      return "[:i]";
    case "pending":
      return "[:u]";
    case "checking-in":
      return "[:q]";
    default:
      return "[:e]";
  }
}

function getOpenIcon(forceIcon) {
  if (useTextButtons() && !forceIcon) return "Open";
  return isCrt() ? "[:tabnew]" : getOpenSvg();
}

function getCopyIcon(forceIcon) {
  if (useTextButtons() && !forceIcon) return "Copy";
  return isCrt() ? "[:y]" : getCopySvg();
}

function getAddItemIcon() {
  if (useTextButtons()) return "Add + Check Out";
  return isCrt() ? "[:a]" : getAddItemSvg();
}

function getShowIcon(visible) {
  if (useTextButtons()) return visible ? "Hide" : "Show";
  if (isCrt()) return visible ? "[:z-]" : "[:z]";
  const eyeOpen =
    '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" width="14" height="14"><path d="M12 5C5.636 5 2 12 2 12s3.636 7 10 7 10-7 10-7-3.636-7-10-7Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const eyeClosed =
    '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" width="14" height="14"><path d="M20 14.834C21.308 13.332 22 12 22 12s-3.636-7-10-7c-.341 0-.675.02-1 .058-.342.04-.676.1-1 .177M12 9c.35 0 .687.06 1 .17.852.302 1.528.978 1.83 1.83.11.313.17.65.17 1M3 3l18 18M12 15c-.35 0-.687-.06-1-.17-.852-.302-1.528-.978-1.83-1.83a3.07 3.07 0 0 1-.128-.5M4.147 9a16.7 16.7 0 0 0-.829 1c-.866 1.128-1.318 2-1.318 2s3.636 7 10 7c.341 0 .675-.02 1-.058" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  return visible ? eyeClosed : eyeOpen;
}

let crtSpinnerInterval = null;
const crtSpinnerFrames = ["[/]", "[-]", "[\\]", "[|]"];
let refreshSpinnerStartTime = 0;
const SPINNER_MIN_DURATION = 800;

let crtCheckinInterval = null;

function startCrtCheckinSpinner(el) {
  if (!document.documentElement.classList.contains("crt")) return;
  if (crtCheckinInterval) {
    clearInterval(crtCheckinInterval);
    crtCheckinInterval = null;
  }
  let frame = 0;
  el.textContent = crtSpinnerFrames[0];
  crtCheckinInterval = setInterval(() => {
    frame = (frame + 1) % crtSpinnerFrames.length;
    el.textContent = crtSpinnerFrames[frame];
  }, 150);
}

function stopCrtCheckinSpinner() {
  if (crtCheckinInterval) {
    clearInterval(crtCheckinInterval);
    crtCheckinInterval = null;
  }
}

function startCrtSpinner(el) {
  if (!document.documentElement.classList.contains("crt")) return;
  // Clear any existing spinner to prevent orphaned intervals
  if (crtSpinnerInterval) {
    clearInterval(crtSpinnerInterval);
    crtSpinnerInterval = null;
  }
  let frame = 0;
  el.textContent = crtSpinnerFrames[0];
  crtSpinnerInterval = setInterval(() => {
    frame = (frame + 1) % crtSpinnerFrames.length;
    el.textContent = crtSpinnerFrames[frame];
  }, 150);
}

function stopCrtSpinner(el) {
  if (crtSpinnerInterval) {
    clearInterval(crtSpinnerInterval);
    crtSpinnerInterval = null;
  }
  if (document.documentElement.classList.contains("crt")) {
    el.textContent = "[:r]";
  }
}

function startRefreshSpinner(el) {
  if (!el) return;
  refreshSpinnerStartTime = Date.now();
  el.classList.add("spinning");
  startCrtSpinner(el);
}

function stopRefreshSpinner(el, callback) {
  if (!el) {
    if (callback) callback();
    return;
  }
  const elapsed = Date.now() - refreshSpinnerStartTime;
  const remaining = SPINNER_MIN_DURATION - elapsed;
  const doStop = () => {
    el.classList.remove("spinning");
    stopCrtSpinner(el);
    if (callback) callback();
  };
  if (remaining > 0) {
    setTimeout(doStop, remaining);
  } else {
    doStop();
  }
}

function getCopySvg() {
  return '<svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M16 12.9V17.1C16 20.6 14.6 22 11.1 22H6.9C3.4 22 2 20.6 2 17.1V12.9C2 9.4 3.4 8 6.9 8H11.1C14.6 8 16 9.4 16 12.9Z"/><path opacity="0.4" d="M17.0998 2H12.8998C9.44976 2 8.04977 3.37 8.00977 6.75H11.0998C15.2998 6.75 17.2498 8.7 17.2498 12.9V15.99C20.6298 15.95 21.9998 14.55 21.9998 11.1V6.9C21.9998 3.4 20.5998 2 17.0998 2Z"/></svg>';
}

function createEnvRow(item) {
  const row = document.createElement("div");
  row.className = "access-env-row";
  row.dataset.envKey = item.raw.papId + "|" + item.raw.environmentId;
  row.dataset.papId = item.raw.papId;
  row.dataset.environmentId = item.raw.environmentId;
  row.dataset.searchText = [
    item.appName,
    item.profileName,
    item.environmentName,
  ]
    .join(" ")
    .toLowerCase();

  const envName = document.createElement("span");
  envName.className = "access-env-name";
  envName.textContent = item.environmentName || "Default";
  row.appendChild(envName);

  // Action buttons
  const actions = document.createElement("div");
  actions.className = "access-env-actions";

  // Open console + copy link buttons (only when checked out)
  if (item.checkedOut) {
    const openBtn = document.createElement("button");
    openBtn.className = "btn-open";
    setTooltipText(openBtn, "Open console");
    setElementIcon(openBtn, getOpenIcon(true));
    openBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      handleAccessOpen(row, item);
    });
    actions.appendChild(openBtn);

    const copyBtn = document.createElement("button");
    copyBtn.className = "btn-copy";
    setTooltipText(copyBtn, "Copy console URL");
    setElementIcon(copyBtn, getCopyIcon(true));
    copyBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      handleAccessCopyUrl(row, item);
    });
    actions.appendChild(copyBtn);
  }

  // Expiration timer badge (only for checked-out profiles)
  if (item.checkedOut) {
    const timerBadge = document.createElement("span");
    timerBadge.className = "expiration-badge";
    timerBadge.dataset.expirationKey = `${item.raw.papId}|${item.raw.environmentId}|${(item.accessType || "CONSOLE").toUpperCase()}`;
    actions.appendChild(timerBadge);
  }

  // Toggle icon for check out / check in / pending
  const pendingKey = `${item.raw.papId}|${item.raw.environmentId}`;

  // Server-detected pending: seed local state so withdrawal works
  if (item.approvalPending && !pendingApprovalRequests[pendingKey]) {
    pendingApprovalRequests[pendingKey] = { requestId: null, timerId: null };
    savePendingApprovals();
  }

  // Clean up stale pending state: if the server no longer reports pending
  // but we have a local pending entry, the approval was already processed.
  if (
    !item.approvalPending &&
    !item.checkedOut &&
    pendingApprovalRequests[pendingKey]
  ) {
    clearPendingApproval(pendingKey);
    savePendingApprovals();
  }

  const isPending =
    !!pendingApprovalRequests[pendingKey] || item.approvalPending;
  let toggleState;
  let toggleTitle;
  if (item.checkedOut) {
    toggleState = "on";
    toggleTitle = "Check in";
  } else if (isPending) {
    toggleState = "pending";
    toggleTitle = "Withdraw approval";
  } else if (item.approvalRequired) {
    toggleState = "approval";
    toggleTitle = "Requires approval";
  } else {
    toggleState = "off";
    toggleTitle = "Check out";
  }

  const toggle = document.createElement("button");
  toggle.className = "access-toggle " + toggleState;
  setTooltipText(
    toggle,
    isPending ? "Pending Approval - click to withdraw" : toggleTitle,
  );

  setElementIcon(toggle, getToggleIcon(toggleState));

  toggle.addEventListener("click", (e) => {
    e.stopPropagation();
    if (
      (pendingApprovalRequests[pendingKey] || item.approvalPending) &&
      e.shiftKey &&
      e.altKey
    ) {
      launchActivityPicker();
      return;
    }
    if (item.checkedOut) {
      handleAccessCheckin(row, item);
    } else if (pendingApprovalRequests[pendingKey] || item.approvalPending) {
      handleWithdrawApproval(row, item, pendingKey);
    } else {
      handleAccessCheckout(row, item);
    }
  });
  actions.appendChild(toggle);

  row.appendChild(actions);
  return row;
}

function findAccessEnvRow(papId, environmentId) {
  return (
    Array.from(document.querySelectorAll(".access-env-row")).find(
      (row) =>
        row.dataset.papId === papId &&
        row.dataset.environmentId === environmentId,
    ) || null
  );
}

function showCheckoutModal(
  profileLabel,
  fields,
  onSubmit,
  infoText,
  submitLabel,
  opts,
) {
  const modal = document.getElementById("checkout-modal");
  const profileEl = document.getElementById("checkout-modal-profile");
  const errorEl = document.getElementById("checkout-modal-error");
  const submitBtn = document.getElementById("checkout-modal-submit");
  const cancelBtn = document.getElementById("checkout-modal-cancel");
  const closeBtn = document.getElementById("checkout-modal-close");
  const defaults = (opts && opts.defaults) || {};
  const ticketTypes = (opts && opts.ticketTypes) || [];

  profileEl.textContent = profileLabel;
  errorEl.classList.add("hidden");
  errorEl.textContent = "";

  // Show or remove info text (e.g. approver names)
  let infoEl = modal.querySelector(".modal-info");
  if (infoText) {
    if (!infoEl) {
      infoEl = document.createElement("p");
      infoEl.className = "modal-info";
      profileEl.parentNode.insertBefore(infoEl, profileEl.nextSibling);
    }
    infoEl.textContent = infoText;
    infoEl.classList.remove("hidden");
  } else if (infoEl) {
    infoEl.classList.add("hidden");
  }

  // Populate ticket type dropdown if types are available
  const ticketTypeSelect = document.getElementById("checkout-ticket-type");
  const ticketTypeWrapper = document.getElementById(
    "checkout-field-ticketType",
  );
  if (ticketTypeSelect) {
    clearElement(ticketTypeSelect);
    const defaultTicketOption = document.createElement("option");
    defaultTicketOption.value = "";
    defaultTicketOption.textContent = "Select ticket type...";
    ticketTypeSelect.appendChild(defaultTicketOption);
    ticketTypes.forEach((t) => {
      const opt = document.createElement("option");
      opt.value = t;
      opt.textContent = t.charAt(0).toUpperCase() + t.slice(1);
      ticketTypeSelect.appendChild(opt);
    });
    // Auto-select and hide if only one ticket type
    if (ticketTypes.length === 1) {
      ticketTypeSelect.value = ticketTypes[0];
      if (ticketTypeWrapper) ticketTypeWrapper.classList.add("hidden");
    }
  }

  // Clear ticket search dropdown
  const ticketSearchResults = document.getElementById("ticket-search-results");
  if (ticketSearchResults) {
    clearElement(ticketSearchResults);
    ticketSearchResults.classList.add("hidden");
  }

  // Show/hide fields based on what's required, pre-fill from defaults
  const fieldIds = ["justification", "ticketType", "ticketId", "otp"];
  fieldIds.forEach((id) => {
    const wrapper = document.getElementById("checkout-field-" + id);
    const input = wrapper.querySelector("input, textarea, select");
    if (fields[id]) {
      // Don't re-show ticketType if auto-hidden (single type)
      if (id === "ticketType" && ticketTypes.length === 1) {
        // already set above, keep hidden
      } else {
        wrapper.classList.remove("hidden");
      }
      if (input) {
        // Don't overwrite auto-selected ticket type (single type case)
        if (id === "ticketType" && ticketTypes.length === 1 && input.value) {
          // already set above, keep value
        } else {
          const defaultVal = defaults[id] || "";
          if (input.tagName === "SELECT" && defaultVal) {
            const match = Array.from(input.options).find(
              (o) => o.value.toLowerCase() === defaultVal.toLowerCase(),
            );
            input.value = match ? match.value : defaultVal;
          } else {
            input.value = defaultVal;
          }
        }
      }
    } else {
      wrapper.classList.add("hidden");
      if (input) input.value = "";
    }
  });

  modal.classList.remove("hidden");

  // Wire up ticket search typeahead
  const papId = opts && opts.papId;
  const environmentId = opts && opts.environmentId;
  const ticketIdInput = document.getElementById("checkout-ticket-id");
  let ticketSearchDebounce = null;
  let ticketDropdownOpen = false;

  if (ticketIdInput && ticketSearchResults && papId && environmentId) {
    const getTicketType = () =>
      ticketTypeSelect ? ticketTypeSelect.value : "";

    // Load initial results when field is shown (empty search)
    const loadInitialTickets = async () => {
      const tt = getTicketType();
      if (!tt) return;
      setStateMessage(
        ticketSearchResults,
        "ticket-search-loading",
        "Loading tickets...",
      );
      ticketSearchResults.classList.remove("hidden");
      ticketDropdownOpen = true;
      try {
        const resp = await chrome.runtime.sendMessage({
          action: "searchTickets",
          papId,
          environmentId,
          ticketType: tt,
          query: "",
        });
        renderTicketResults(resp.tickets || []);
      } catch (e) {
        setStateMessage(
          ticketSearchResults,
          "ticket-search-hint",
          "Failed to load tickets",
        );
      }
    };

    const renderTicketResults = (tickets) => {
      clearElement(ticketSearchResults);
      if (tickets.length === 0) {
        setStateMessage(
          ticketSearchResults,
          "ticket-search-hint",
          "No tickets found - type an ID manually",
        );
        ticketSearchResults.classList.remove("hidden");
        ticketDropdownOpen = true;
        return;
      }
      tickets.forEach((t) => {
        const div = document.createElement("div");
        div.className = "ticket-option";
        const numberSpan = document.createElement("span");
        numberSpan.className = "ticket-number";
        numberSpan.textContent = t.number;
        const titleSpan = document.createElement("span");
        titleSpan.className = "ticket-title";
        titleSpan.textContent = t.title || "";
        div.appendChild(numberSpan);
        div.appendChild(titleSpan);
        div.addEventListener("click", () => {
          ticketIdInput.value = t.number;
          ticketSearchResults.classList.add("hidden");
          ticketDropdownOpen = false;
        });
        ticketSearchResults.appendChild(div);
      });
      ticketSearchResults.classList.remove("hidden");
      ticketDropdownOpen = true;
      ticketSearchResults.scrollIntoView({
        block: "nearest",
        behavior: "smooth",
      });
    };

    // Debounced search on input
    ticketIdInput.addEventListener("input", () => {
      clearTimeout(ticketSearchDebounce);
      ticketSearchDebounce = setTimeout(async () => {
        const tt = getTicketType();
        if (!tt) return;
        const query = ticketIdInput.value.trim();
        setStateMessage(
          ticketSearchResults,
          "ticket-search-loading",
          "Searching...",
        );
        ticketSearchResults.classList.remove("hidden");
        ticketDropdownOpen = true;
        try {
          const resp = await chrome.runtime.sendMessage({
            action: "searchTickets",
            papId,
            environmentId,
            ticketType: tt,
            query,
          });
          renderTicketResults(resp.tickets || []);
        } catch (e) {
          setStateMessage(
            ticketSearchResults,
            "ticket-search-hint",
            "Search failed",
          );
        }
      }, 300);
    });

    // Show dropdown on focus
    ticketIdInput.addEventListener("focus", () => {
      if (!ticketIdInput.value.trim() && !ticketDropdownOpen) {
        loadInitialTickets();
      } else if (ticketSearchResults.children.length > 0) {
        ticketSearchResults.classList.remove("hidden");
        ticketDropdownOpen = true;
      }
    });

    // Hide dropdown on click outside
    const hideDropdown = (e) => {
      if (
        !ticketSearchResults.contains(e.target) &&
        e.target !== ticketIdInput
      ) {
        ticketSearchResults.classList.add("hidden");
        ticketDropdownOpen = false;
      }
    };
    modal.addEventListener("click", hideDropdown);

    // Tickets load on focus/click of the ticket ID input - not on modal open
  }

  // Focus the first visible input
  for (const id of fieldIds) {
    if (fields[id] && !(id === "ticketType" && ticketTypes.length === 1)) {
      const wrapper = document.getElementById("checkout-field-" + id);
      const input = wrapper.querySelector("input, textarea, select");
      if (input) {
        input.focus();
        break;
      }
    }
  }

  // Enter key in any input/select triggers submit (unless ticket dropdown is open)
  const modalInputs = modal.querySelectorAll("input, textarea, select");
  modalInputs.forEach((input) => {
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && input.tagName !== "TEXTAREA") {
        if (input.id === "checkout-ticket-id" && ticketDropdownOpen) {
          // Close dropdown instead of submitting
          if (ticketSearchResults) {
            ticketSearchResults.classList.add("hidden");
            ticketDropdownOpen = false;
          }
          e.preventDefault();
          return;
        }
        e.preventDefault();
        document.getElementById("checkout-modal-submit").click();
      }
      // Escape closes ticket dropdown
      if (
        e.key === "Escape" &&
        input.id === "checkout-ticket-id" &&
        ticketDropdownOpen
      ) {
        if (ticketSearchResults) {
          ticketSearchResults.classList.add("hidden");
          ticketDropdownOpen = false;
        }
        e.preventDefault();
        e.stopPropagation();
      }
    });
  });

  // Clean up previous listeners
  const newSubmit = submitBtn.cloneNode(true);
  submitBtn.parentNode.replaceChild(newSubmit, submitBtn);
  const newCancel = cancelBtn.cloneNode(true);
  cancelBtn.parentNode.replaceChild(newCancel, cancelBtn);
  const newClose = closeBtn.cloneNode(true);
  closeBtn.parentNode.replaceChild(newClose, closeBtn);

  // Reset disabled state - cloneNode copies stale disabled attribute from prior usage
  newSubmit.disabled = false;

  const btnLabel = submitLabel || "Check Out";
  const btnBusyLabel = submitLabel ? "Submitting..." : "Checking out...";
  newSubmit.textContent = btnLabel;

  const close = () => {
    modal.classList.add("hidden");
  };

  newCancel.addEventListener("click", close);
  newClose.addEventListener("click", close);

  newSubmit.addEventListener("click", async () => {
    // Gather values
    const values = {};
    if (fields.justification) {
      values.justification = document
        .getElementById("checkout-justification")
        .value.trim();
      if (!values.justification) {
        errorEl.textContent = "Justification is required.";
        errorEl.classList.remove("hidden");
        return;
      }
      if (values.justification.length > 255) {
        errorEl.textContent = "Justification cannot exceed 255 characters.";
        errorEl.classList.remove("hidden");
        return;
      }
    }
    if (fields.ticketType) {
      values.ticketType = document
        .getElementById("checkout-ticket-type")
        .value.trim();
      if (!values.ticketType) {
        errorEl.textContent = "Ticket type is required.";
        errorEl.classList.remove("hidden");
        return;
      }
    }
    if (fields.ticketId) {
      values.ticketId = document
        .getElementById("checkout-ticket-id")
        .value.trim();
      if (!values.ticketId) {
        errorEl.textContent = "Ticket ID is required.";
        errorEl.classList.remove("hidden");
        return;
      }
    }
    if (fields.otp) {
      values.otp = document.getElementById("checkout-otp").value.trim();
      if (!values.otp) {
        errorEl.textContent = "One-time passcode is required.";
        errorEl.classList.remove("hidden");
        return;
      }
    }

    errorEl.classList.add("hidden");
    newSubmit.disabled = true;
    newSubmit.textContent = btnBusyLabel;

    try {
      await onSubmit(values);
      close();
    } catch (err) {
      errorEl.textContent = err.message || "Action failed.";
      errorEl.classList.remove("hidden");
      newSubmit.disabled = false;
      newSubmit.textContent = btnLabel;
    }
  });
}

async function performCheckout(rowDiv, item, extraParams) {
  const response = await chrome.runtime.sendMessage({
    action: "checkoutAccess",
    papId: item.raw.papId,
    environmentId: item.raw.environmentId,
    justification: extraParams.justification || undefined,
    otp: extraParams.otp || undefined,
    ticketId: extraParams.ticketId || undefined,
    ticketType: extraParams.ticketType || undefined,
  });

  if (response.error) {
    throw new Error(response.error);
  }

  await postCheckoutSuccess(rowDiv, item, response);
}

async function postCheckoutSuccess(rowDiv, item, checkoutResponse) {
  crtLog("CHECKOUT", "polling for checked-out status");
  const toggle = rowDiv.querySelector(".access-toggle");

  // Cache checkout expiration if provided in the response
  if (
    checkoutResponse &&
    checkoutResponse.data &&
    checkoutResponse.data.expiration
  ) {
    const expirationKey = `${item.raw.papId}|${item.raw.environmentId}|CONSOLE`;
    const expiration = new Date(checkoutResponse.data.expiration).getTime();
    if (!isNaN(expiration)) {
      chrome.runtime
        .sendMessage({
          action: "setCheckoutExpiration",
          key: expirationKey,
          expiration,
          profileName: item.profileName,
          envName: item.environmentName,
        })
        .catch(() => {});
    }
  }

  // Swap to checkin icon and 'on' state
  if (toggle) {
    toggle.style.opacity = "1";
    toggle.disabled = false;
    toggle.classList.remove("off", "approval");
    toggle.classList.add("on");
    setElementIcon(toggle, getToggleIcon("on"));
  }

  // Auto-open console after checkout
  // Checkout is async - poll until status is 'checkedOut' before fetching URL
  try {
    const maxAttempts = 15;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const coResp = await chrome.runtime.sendMessage({
        action: "getCheckedOutProfiles",
      });
      const coList = coResp.checkedOut || [];
      const match = coList.find(
        (c) =>
          c.papId === item.raw.papId &&
          c.environmentId === item.raw.environmentId &&
          isActiveConsoleCheckout(c),
      );
      if (match && match.transactionId) {
        if (match.status === "checkOutSubmitted") {
          await new Promise((r) => setTimeout(r, 1000));
          continue;
        }
        crtLog("CHECKOUT", "profile ready, fetching console URL");
        const urlResp = await chrome.runtime.sendMessage({
          action: "getAccessUrl",
          transactionId: match.transactionId,
        });
        if (urlResp.url) {
          crtLog("CHECKOUT", "opening console URL");
          openTabSafely(urlResp.url);
        }
        break;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  } catch (e) {
    // Silently ignore - console open is best-effort
  }

  await loadAccess(true);
}

async function handleAccessCheckout(rowDiv, item) {
  crtLog(
    "CHECKOUT",
    item.appName + "/" + item.profileName + "/" + item.environmentName,
  );
  const toggle = rowDiv.querySelector(".access-toggle");
  if (!toggle) return;

  toggle.disabled = true;
  toggle.style.opacity = "0.5";

  try {
    // Fetch profile settings to determine what fields are required
    const settingsResp = await chrome.runtime.sendMessage({
      action: "getProfileSettings",
      papId: item.raw.papId,
      environmentId: item.raw.environmentId,
    });

    const settings = (settingsResp && settingsResp.settings) || {};
    const justSetting = settings.justificationSetting || {};
    const itsmSetting = settings.itsmSetting || {};

    const label = `${item.appName} / ${item.profileName} / ${item.environmentName}`;

    if (item.approvalRequired) {
      crtLog("CHECKOUT", "approval required, entering approval flow");
      const pendingKey = `${item.raw.papId}|${item.raw.environmentId}`;

      // Block if there's already a pending approval poll for this profile
      if (pendingApprovalRequests[pendingKey]) {
        toggle.disabled = true;
        toggle.style.opacity = "0.5";
        showInlineError(rowDiv, "Approval already pending for this profile");
        return;
      }

      // Fetch approvers to show in the modal
      const approversResp = await chrome.runtime.sendMessage({
        action: "getApprovers",
        papId: item.raw.papId,
      });

      const approverData = (approversResp && approversResp.approvers) || {};
      const approverUsers =
        (approverData.approvers && approverData.approvers.users) || [];
      const approverNames = approverUsers.map((u) => u.name).join(", ");

      // Determine required fields for approval request
      const fields = { justification: true }; // justification always required for approval requests
      if (itsmSetting.isITSMEnabled) {
        fields.ticketType = true;
        fields.ticketId = true;
      }

      const supportedTicketTypes = itsmSetting.supportedTicketTypes || [];
      toggle.disabled = false;
      toggle.style.opacity = "1";

      showCheckoutModal(
        label,
        fields,
        async (values) => {
          toggle.disabled = true;
          toggle.style.opacity = "0.5";
          try {
            const resp = await chrome.runtime.sendMessage({
              action: "submitApprovalRequest",
              papId: item.raw.papId,
              environmentId: item.raw.environmentId,
              justification: values.justification || undefined,
              ticketId: values.ticketId || undefined,
              ticketType: values.ticketType || undefined,
            });
            if (resp.error) throw new Error(resp.error);

            const requestId = resp.data && resp.data.requestId;
            if (!requestId) throw new Error("No request ID returned");
            crtLog(
              "APPROVAL",
              "submitted requestId=" + requestId + ", polling started",
            );

            // Start polling for approval status - toggle goes red
            pollApprovalStatus(rowDiv, item, requestId, pendingKey, label);
          } catch (err) {
            toggle.disabled = false;
            toggle.style.opacity = "1";
            throw err;
          }
        },
        approverNames ? "Approvers: " + approverNames : null,
        "Request Approval",
        {
          ticketTypes: supportedTicketTypes,
          papId: item.raw.papId,
          environmentId: item.raw.environmentId,
        },
      );
    } else {
      const fields = {};
      if (justSetting.isJustificationRequiredAtCheckout) {
        fields.justification = true;
      }
      if (itsmSetting.isITSMEnabled) {
        fields.ticketType = true;
        fields.ticketId = true;
      }

      // Pre-fill from previous approval request data if available
      const approvalData = settings.approvalRequestData || {};
      const checkoutDefaults = {};
      if (approvalData.justification)
        checkoutDefaults.justification = approvalData.justification;
      if (approvalData.ticketType)
        checkoutDefaults.ticketType = approvalData.ticketType;
      if (approvalData.ticketId)
        checkoutDefaults.ticketId = approvalData.ticketId;
      const supportedTicketTypes = itsmSetting.supportedTicketTypes || [];

      const needsModal = Object.keys(fields).length > 0;

      if (needsModal) {
        toggle.disabled = false;
        toggle.style.opacity = "1";

        showCheckoutModal(
          label,
          fields,
          async (values) => {
            toggle.disabled = true;
            toggle.style.opacity = "0.5";
            try {
              await performCheckoutWithStepUp(rowDiv, item, values, label);
            } catch (err) {
              toggle.disabled = false;
              toggle.style.opacity = "1";
              throw err;
            }
          },
          null,
          null,
          {
            defaults: checkoutDefaults,
            ticketTypes: supportedTicketTypes,
            papId: item.raw.papId,
            environmentId: item.raw.environmentId,
          },
        );
      } else {
        // No extra fields needed - checkout directly (may still trigger step-up)
        await performCheckoutWithStepUp(rowDiv, item, {}, label);
      }
    }
  } catch (error) {
    toggle.disabled = false;
    toggle.style.opacity = "1";
    showInlineError(rowDiv, error.message);
  }
}

// Poll approval status every 5 seconds after submitting an approval request.
// When approved, automatically proceeds to checkout. Stops on reject/timeout/error.
function pollApprovalStatus(rowDiv, item, requestId, pendingKey, label) {
  // Store and persist immediately
  pendingApprovalRequests[pendingKey] = {
    requestId,
    timerId: null,
    inFlight: false,
    finished: false,
  };
  savePendingApprovals();

  // Set toggle to pending state
  const toggle = rowDiv ? rowDiv.querySelector(".access-toggle") : null;
  if (toggle) {
    toggle.classList.remove("off", "approval", "on");
    toggle.classList.add("pending");
    setTooltipText(toggle, "Pending Approval - click to withdraw");
    setElementIcon(toggle, getToggleIcon("pending"));
    toggle.disabled = false;
    toggle.style.opacity = "1";
  }

  const pollInterval = 5000;
  const timerId = setInterval(async () => {
    const pending = pendingApprovalRequests[pendingKey];
    if (!pending || pending.inFlight || pending.finished) {
      return;
    }
    pending.inFlight = true;
    try {
      const resp = await chrome.runtime.sendMessage({
        action: "getApprovalStatus",
        requestId,
      });

      if (resp.error) {
        pending.finished = true;
        clearPendingApproval(pendingKey);
        savePendingApprovals();
        await loadAccess();
        return;
      }

      const approval = resp.approval || {};
      const status = (approval.status || "").toLowerCase();

      if (status === "approved") {
        const { extensionSettings } =
          await chrome.storage.local.get("extensionSettings");
        const autoCheckoutOnApproval =
          extensionSettings?.autoCheckoutOnApproval ?? false;
        crtLog(
          "APPROVAL",
          autoCheckoutOnApproval
            ? "APPROVED - auto-proceeding to checkout"
            : "APPROVED",
        );
        dismissActivity();
        pending.finished = true;
        clearPendingApproval(pendingKey);
        savePendingApprovals();
        await chrome.runtime
          .sendMessage({
            action: "approvalStatusChanged",
            status: "approved",
            autoCheckout: autoCheckoutOnApproval,
            item: item
              ? {
                  appName: item.appName,
                  profileName: item.profileName,
                  environmentName: item.environmentName,
                  papId: item.raw?.papId,
                  environmentId: item.raw?.environmentId,
                }
              : null,
          })
          .catch(() => {});
        if (autoCheckoutOnApproval && rowDiv && item) {
          try {
            const sResp = await chrome.runtime.sendMessage({
              action: "getProfileSettings",
              papId: item.raw.papId,
              environmentId: item.raw.environmentId,
            });
            const sData =
              (sResp && sResp.settings && sResp.settings.approvalRequestData) ||
              {};
            const checkoutValues = {};
            if (sData.justification)
              checkoutValues.justification = sData.justification;
            if (sData.ticketType) checkoutValues.ticketType = sData.ticketType;
            if (sData.ticketId) checkoutValues.ticketId = sData.ticketId;
            await performCheckoutWithStepUp(
              rowDiv,
              item,
              checkoutValues,
              label,
            );
          } catch (e) {
            await loadAccess();
          }
        } else {
          await loadAccess();
        }
        return;
      }

      if (
        status === "rejected" ||
        status === "revoked" ||
        status === "withdrawn" ||
        status === "cancelled"
      ) {
        crtLog("APPROVAL", status.toUpperCase() + " - stopping poll");
        dismissActivity();
        pending.finished = true;
        clearPendingApproval(pendingKey);
        savePendingApprovals();
        await chrome.runtime
          .sendMessage({
            action: "approvalStatusChanged",
            status,
            autoCheckout: false,
            item: item
              ? {
                  appName: item.appName,
                  profileName: item.profileName,
                  environmentName: item.environmentName,
                  papId: item.raw?.papId,
                  environmentId: item.raw?.environmentId,
                }
              : null,
          })
          .catch(() => {});
        await loadAccess();
        return;
      }

      if (approval.expirationTimeForApproveRequest) {
        const expiry = new Date(
          approval.expirationTimeForApproveRequest,
        ).getTime();
        if (Date.now() > expiry) {
          pending.finished = true;
          clearPendingApproval(pendingKey);
          savePendingApprovals();
          await chrome.runtime
            .sendMessage({
              action: "approvalStatusChanged",
              status: "expired",
              autoCheckout: false,
              item: item
                ? {
                    appName: item.appName,
                    profileName: item.profileName,
                    environmentName: item.environmentName,
                    papId: item.raw?.papId,
                    environmentId: item.raw?.environmentId,
                  }
                : null,
            })
            .catch(() => {});
          await loadAccess();
          return;
        }
      }
    } catch (e) {
      pending.finished = true;
      clearPendingApproval(pendingKey);
      savePendingApprovals();
    } finally {
      const currentPending = pendingApprovalRequests[pendingKey];
      if (currentPending) {
        currentPending.inFlight = false;
      }
    }
  }, pollInterval);

  pendingApprovalRequests[pendingKey].timerId = timerId;
}

function clearPendingApproval(pendingKey) {
  const pending = pendingApprovalRequests[pendingKey];
  if (pending && pending.timerId) {
    clearInterval(pending.timerId);
  }
  delete pendingApprovalRequests[pendingKey];
}

function resetPendingApprovalRow(papId, environmentId) {
  if (!papId || !environmentId) return;
  const pendingKey = `${papId}|${environmentId}`;
  clearPendingApproval(pendingKey);
  savePendingApprovals();

  const rowDiv = document.querySelector(
    `.access-env-row[data-env-key="${pendingKey}"]`,
  );
  const item = currentAccess.find(
    (a) => a.raw.papId === papId && a.raw.environmentId === environmentId,
  );
  if (!rowDiv || !item) return;

  item.approvalPending = false;
  item.checkedOut = false;
  item.approvalRequired = true;
  updateEnvRow(rowDiv, item);
}

function restartPendingApprovalPolls() {
  for (const [key, val] of Object.entries(pendingApprovalRequests)) {
    if (val.timerId) continue;
    if (!val.requestId) continue; // server-detected pending with no requestId - don't poll

    const [papId, environmentId] = key.split("|");
    const item = currentAccess.find(
      (a) => a.raw.papId === papId && a.raw.environmentId === environmentId,
    );
    const label = item
      ? `${item.appName} / ${item.profileName} / ${item.environmentName}`
      : "";

    const rows = document.querySelectorAll(".access-env-row");
    let rowDiv = null;
    for (const r of rows) {
      const toggle = r.querySelector(".access-toggle.pending");
      if (toggle) {
        rowDiv = r;
        break;
      }
    }

    pollApprovalStatus(rowDiv, item || null, val.requestId, key, label);
  }
}

function savePendingApprovals() {
  const toSave = {};
  for (const [key, val] of Object.entries(pendingApprovalRequests)) {
    toSave[key] = val.requestId;
  }
  chrome.storage.local.set({ pendingApprovals: toSave });
}

// Wrapper that handles step-up auth reactively: attempt checkout, and if
// the API returns stepUpRequired, show OTP modal and retry with the OTP.
async function performCheckoutWithStepUp(rowDiv, item, params, label) {
  crtLog("CHECKOUT", "POST checkout papId=" + item.raw.papId);
  const toggle = rowDiv.querySelector(".access-toggle");
  const response = await chrome.runtime.sendMessage({
    action: "checkoutAccess",
    papId: item.raw.papId,
    environmentId: item.raw.environmentId,
    justification: params.justification || undefined,
    ticketId: params.ticketId || undefined,
    ticketType: params.ticketType || undefined,
  });

  if (response.stepUpRequired) {
    crtLog("STEPUP", "OTP required, showing modal");
    // Need OTP - show modal with just the OTP field
    if (toggle) {
      toggle.disabled = false;
      toggle.style.opacity = "1";
    }
    showCheckoutModal(label, { otp: true }, async (otpValues) => {
      if (toggle) {
        toggle.disabled = true;
        toggle.style.opacity = "0.5";
      }
      try {
        await performCheckout(rowDiv, item, { ...params, otp: otpValues.otp });
      } catch (err) {
        if (toggle) {
          toggle.disabled = false;
          toggle.style.opacity = "1";
        }
        throw err;
      }
    });
    return;
  }

  if (response.error) {
    throw new Error(response.error);
  }

  // Success - proceed with post-checkout flow
  crtLog("CHECKOUT", "checkout succeeded, entering post-checkout flow");
  await postCheckoutSuccess(rowDiv, item, response);
}

async function handleAccessOpen(rowDiv, item) {
  const btn = rowDiv.querySelector(".btn-open");
  if (!btn) return;

  btn.disabled = true;
  btn.style.opacity = "0.3";

  try {
    // Get the console URL
    const urlResp = await chrome.runtime.sendMessage({
      action: "getAccessUrl",
      transactionId: item.transactionId,
    });

    if (urlResp.error) {
      btn.disabled = false;
      btn.style.opacity = "1";
      showInlineError(rowDiv, urlResp.error);
      return;
    }

    if (urlResp.url) {
      openTabSafely(urlResp.url);
    }

    // Refresh list to reflect checked-out state
    await loadAccess();
  } catch (error) {
    btn.disabled = false;
    btn.style.opacity = "1";
    showInlineError(rowDiv, error.message);
  }
}

async function handleAccessCopyUrl(rowDiv, item) {
  const btn = rowDiv.querySelector(".btn-copy");
  if (!btn) return;

  btn.disabled = true;
  btn.style.opacity = "0.3";

  try {
    const urlResp = await chrome.runtime.sendMessage({
      action: "getAccessUrl",
      transactionId: item.transactionId,
    });

    if (urlResp.error) {
      btn.disabled = false;
      btn.style.opacity = "1";
      showInlineError(rowDiv, urlResp.error);
      return;
    }

    if (urlResp.url) {
      await writeTextToClipboard(urlResp.url);
      showToast("Console URL copied to clipboard", "success");
    }
  } catch (error) {
    showInlineError(rowDiv, error.message);
  } finally {
    btn.disabled = false;
    btn.style.opacity = "1";
  }
}

async function handleWithdrawApproval(rowDiv, item, pendingKey) {
  crtLog("APPROVAL", "withdrawing papId=" + item.raw.papId);
  const toggle = rowDiv.querySelector(".access-toggle");
  if (!toggle) return;

  // Stop the approval status poll immediately so it can't rebuild the DOM mid-flight
  const pending = pendingApprovalRequests[pendingKey];
  if (pending && pending.timerId) {
    clearInterval(pending.timerId);
    pending.timerId = null;
  }

  if (document.documentElement.classList.contains("crt")) {
    toggle.classList.add("crt-withdraw-flash");
    await new Promise((r) => setTimeout(r, 300));
    toggle.classList.remove("crt-withdraw-flash");
  }

  // Update UI to "withdrawing" state
  toggle.disabled = true;
  toggle.style.opacity = "0.5";
  setTooltipText(toggle, "Withdrawing approval...");

  try {
    const resp = await chrome.runtime.sendMessage({
      action: "withdrawApprovalRequest",
      papId: item.raw.papId,
      environmentId: item.raw.environmentId,
    });

    if (resp.error) {
      toggle.disabled = false;
      toggle.style.opacity = "1";
      setTooltipText(toggle, "Pending Approval - click to withdraw");
      showInlineError(rowDiv, resp.error);
      return;
    }

    // Clear the pending state
    clearPendingApproval(pendingKey);
    savePendingApprovals();

    showInlineSuccess(rowDiv, "Approval request withdrawn");
    await loadAccess();

    // Brief cooldown: disable the newly-rebuilt toggle so the user
    // can't immediately re-open the approval modal while the success
    // toast is still showing.
    const freshRow = document.querySelector(
      `.access-env-row[data-env-key="${pendingKey}"]`,
    );
    const freshToggle = freshRow && freshRow.querySelector(".access-toggle");
    if (freshToggle) {
      freshToggle.disabled = true;
      freshToggle.style.opacity = "0.5";
      setTimeout(() => {
        freshToggle.disabled = false;
        freshToggle.style.opacity = "1";
      }, 2000);
    }
  } catch (error) {
    toggle.disabled = false;
    toggle.style.opacity = "1";
    setTooltipText(toggle, "Pending Approval - click to withdraw");
    showInlineError(rowDiv, error.message);
  }
}

async function handleAccessCheckin(rowDiv, item) {
  crtLog("CHECKIN", "starting for transactionId=" + item.transactionId);
  const toggle = rowDiv.querySelector(".access-toggle");
  if (!toggle) return;

  toggle.disabled = true;
  toggle.style.opacity = "0.5";

  try {
    const response = await chrome.runtime.sendMessage({
      action: "checkinAccess",
      transactionId: item.transactionId,
    });

    if (response.success || !response.error) {
      // Clear cached expiration for this checkout
      const expirationKey = `${item.raw.papId}|${item.raw.environmentId}|${(item.accessType || "CONSOLE").toUpperCase()}`;
      chrome.runtime
        .sendMessage({ action: "clearCheckoutExpiration", key: expirationKey })
        .catch(() => {});

      // Set toggle to gray "checking in" state
      toggle.classList.remove("on", "off", "approval", "pending");
      toggle.classList.add("checking-in");
      setTooltipText(toggle, "Checking in...");
      setElementIcon(toggle, getToggleIcon("checking-in"));
      toggle.disabled = true;
      toggle.style.opacity = "1";
      startCrtCheckinSpinner(toggle);

      // Poll until checkin completes (transaction gone or status checkedIn)
      const maxAttempts = 15;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        await new Promise((r) => setTimeout(r, 2000));
        try {
          const coResp = await chrome.runtime.sendMessage({
            action: "getCheckedOutProfiles",
          });
          const coList = coResp.checkedOut || [];
          const match = coList.find(
            (c) => c.transactionId === item.transactionId && !c.checkedIn,
          );
          if (!match) {
            // Checkin complete - force refresh to get fresh state
            crtLog("CHECKIN", "complete, profile no longer checked out");
            stopCrtCheckinSpinner();
            await loadAccess(true);
            return;
          }
          // Still active, keep polling
        } catch (e) {
          // Ignore poll errors
        }
      }
      // Timed out - force refresh anyway
      stopCrtCheckinSpinner();
      await loadAccess(true);
    } else {
      stopCrtCheckinSpinner();
      toggle.disabled = false;
      toggle.style.opacity = "1";
      showInlineError(rowDiv, response.error || "Check in failed");
    }
  } catch (error) {
    stopCrtCheckinSpinner();
    toggle.disabled = false;
    toggle.style.opacity = "1";
    showInlineError(rowDiv, error.message);
  }
}

let accessSearchTimer = null;

function handleAccessSearch(e) {
  const q = e.target.value.toLowerCase().trim();
  const listDiv = document.getElementById("access-list");

  // Client-side filter: show/hide env rows based on search text
  const envRows = listDiv.querySelectorAll(".access-env-row[data-search-text]");
  envRows.forEach((row) => {
    row.style.display = !q || row.dataset.searchText.includes(q) ? "" : "none";
  });

  // Show/hide profile sections: visible if any child env row is visible
  listDiv.querySelectorAll(".access-profile-section").forEach((section) => {
    const profBody = section.querySelector(".access-profile-body");
    if (!profBody) return;
    const hasVisible = profBody.querySelector(
      '.access-env-row:not([style*="display: none"])',
    );
    section.style.display = hasVisible ? "" : "none";
  });

  // Show/hide app groups: visible if any child profile section is visible
  listDiv.querySelectorAll(".access-group").forEach((group) => {
    const body = group.querySelector(".access-group-body");
    if (!body) return;
    const hasVisible = body.querySelector(
      '.access-profile-section:not([style*="display: none"])',
    );
    group.style.display = hasVisible ? "" : "none";
  });

  // Remove previous search results section
  const oldResults = listDiv.querySelector(".search-results-section");
  if (oldResults) oldResults.remove();

  // Debounced API search for cross-collection results
  if (accessSearchTimer) clearTimeout(accessSearchTimer);
  if (q.length >= 3) {
    accessSearchTimer = setTimeout(() => performAccessSearch(q), 300);
  }
}

async function performAccessSearch(query) {
  const normalizedQuery = (query || "").toLowerCase().trim();
  if (normalizedQuery.length < 3) return;
  const listDiv = document.getElementById("access-list");

  // Build a set of keys for profiles already in the local list
  const localKeys = new Set();
  currentAccess.forEach((item) => {
    localKeys.add(`${item.raw.papId}|${item.raw.environmentId}`);
  });

  try {
    const resp = await chrome.runtime.sendMessage({
      action: "searchAccess",
      searchText: normalizedQuery,
    });
    if (resp.error || !resp.items) return;

    // Filter to only items NOT already in the local list
    const additional = resp.items.filter((item) => {
      const papId = item.papId || item.profile?.papId;
      const envId = item.environmentId || item.environment?.environmentId;
      return !localKeys.has(`${papId}|${envId}`);
    });

    if (additional.length === 0) return;

    // Check the search box still has the same query (user may have changed it)
    const currentQuery = (document.getElementById("search-access").value || "")
      .toLowerCase()
      .trim();
    if (currentQuery !== normalizedQuery) return;

    // Remove any existing search results section
    const oldResults = listDiv.querySelector(".search-results-section");
    if (oldResults) oldResults.remove();

    // Build search results section
    const section = document.createElement("div");
    section.className = "search-results-section";

    const header = document.createElement("div");
    header.className = "search-results-header";
    header.textContent = "Other Results";
    section.appendChild(header);

    additional.forEach((item) => {
      const appName = item.application?.appName || item.appName || "";
      const profileName = item.profile?.papName || item.papName || "";
      const envName =
        item.environment?.environmentName || item.environmentName || "";
      const papId = item.papId || item.profile?.papId || "";
      const envId = item.environmentId || item.environment?.environmentId || "";
      const appContainerId =
        item.appContainerId ||
        item.application?.appContainerId ||
        item.appId ||
        item.application?.appId ||
        "";

      const row = document.createElement("div");
      row.className = "search-result-row";

      const info = document.createElement("div");
      info.className = "search-result-info";

      const nameLine = document.createElement("span");
      nameLine.className = "search-result-name";
      nameLine.textContent = `${profileName} - ${envName}`;
      info.appendChild(nameLine);

      const appLine = document.createElement("span");
      appLine.className = "search-result-app";
      appLine.textContent = appName;
      info.appendChild(appLine);

      row.appendChild(info);

      const addBtn = document.createElement("button");
      addBtn.className = "btn-add-favorite";
      setTooltipText(addBtn, "Add to Favorites and check out");
      setElementIcon(addBtn, getAddItemIcon());
      addBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!appContainerId || !papId || !envId) {
          showToast(
            "Missing profile metadata. Try refreshing and searching again.",
            "error",
          );
          return;
        }
        addBtn.disabled = true;
        try {
          const addResp = await chrome.runtime.sendMessage({
            action: "addToFavorites",
            appContainerId,
            environmentId: envId,
            papId: papId,
            accessType: "CONSOLE",
          });
          if (addResp.error) {
            showToast(addResp.error, "error");
            addBtn.disabled = false;
            return;
          }

          // Refresh access list to show the newly added favorite
          await loadAccess(true);

          // Immediately begin checkout for the newly added favorite
          const refreshedItem = currentAccess.find(
            (a) => a.raw.papId === papId && a.raw.environmentId === envId,
          );
          const refreshedRow = findAccessEnvRow(papId, envId);
          if (refreshedItem && refreshedRow) {
            showToast("Added to Favorites, starting checkout...", "info");
            await handleAccessCheckout(refreshedRow, refreshedItem);
          } else {
            showToast(
              "Added to Favorites. Use refresh if it does not appear yet.",
              "info",
            );
          }

          // Remove the search results section since the list has been rebuilt
          const results = listDiv.querySelector(".search-results-section");
          if (results) results.remove();
        } catch (err) {
          showToast(err.message || "Failed to add favorite", "error");
          addBtn.disabled = false;
        }
      });
      row.appendChild(addBtn);

      section.appendChild(row);
    });

    listDiv.appendChild(section);
  } catch (e) {
    // Search is best-effort
  }
}

let expirationTimerInterval = null;

function formatTimeRemaining(ms) {
  if (ms <= 0) return "Expired";
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
  return `${seconds}s`;
}

function getExpirationClass(ms) {
  if (ms <= 0) return "expiration-expired";
  if (ms <= 5 * 60 * 1000) return "expiration-critical";
  if (ms <= 15 * 60 * 1000) return "expiration-warn";
  return "expiration-safe";
}

async function updateExpirationBadges() {
  const badges = document.querySelectorAll(
    ".expiration-badge[data-expiration-key]",
  );
  if (badges.length === 0) return;

  let expirations;
  try {
    const resp = await chrome.runtime.sendMessage({
      action: "getCheckoutExpirations",
    });
    expirations = resp.expirations || {};
  } catch (e) {
    return;
  }

  const now = Date.now();
  badges.forEach((badge) => {
    const key = badge.dataset.expirationKey;
    const expiration = expirations[key];
    if (!expiration) {
      badge.textContent = "";
      badge.className = "expiration-badge";
      return;
    }
    const remaining = expiration - now;
    badge.textContent = formatTimeRemaining(remaining);
    badge.className = "expiration-badge " + getExpirationClass(remaining);
  });
}

function startExpirationTimer() {
  stopExpirationTimer();
  // Update immediately, then every second
  updateExpirationBadges();
  expirationTimerInterval = setInterval(updateExpirationBadges, 1000);
}

function stopExpirationTimer() {
  if (expirationTimerInterval) {
    clearInterval(expirationTimerInterval);
    expirationTimerInterval = null;
  }
}

function handleSearch(e) {
  const q = e.target.value.toLowerCase();
  const listDiv = document.getElementById("secrets-list");

  // Show/hide secret items based on search text
  listDiv.querySelectorAll(".secret-item[data-search-text]").forEach((item) => {
    item.style.display =
      !q || item.dataset.searchText.includes(q) ? "" : "none";
  });
}

async function loadApprovals() {
  crtLog("APPROVALS", "loading approvals");
  const listDiv = document.getElementById("approvals-list");
  const refreshBtn = document.getElementById("refresh");

  // Only show loading spinner on initial load (when list is empty)
  if (!currentApprovals.length) {
    setStateMessage(
      listDiv,
      "loading",
      isCrt() ? "Polling approval queue..." : "Loading approvals...",
    );
  }
  const refreshIcon = refreshBtn && refreshBtn.querySelector(".refresh-icon");
  if (refreshBtn && activeTab === "approvals") refreshBtn.disabled = true;
  if (activeTab === "approvals") startRefreshSpinner(refreshIcon);

  try {
    const response = await chrome.runtime.sendMessage({
      action: "getApprovals",
    });

    if (response && response.approvals) {
      if (response.approvals.error) {
        setStateMessage(listDiv, "empty-state", response.approvals.error);
        updateApprovalsBadge(0);
      } else {
        currentApprovals = Array.isArray(response.approvals)
          ? response.approvals
          : [];
        crtLog(
          "APPROVALS",
          "loaded " + currentApprovals.length + " pending approvals",
        );
        displayApprovals(currentApprovals);
        updateApprovalsBadge(currentApprovals.length);
        updateLastRefreshed();
      }
    } else {
      setStateMessage(listDiv, "empty-state", "No response from server");
      updateApprovalsBadge(0);
    }
  } catch (error) {
    // Only show error if we have no cached data
    if (!currentApprovals.length) {
      setStateMessage(listDiv, "empty-state", "Error: " + error.message);
      updateApprovalsBadge(0);
    }
  } finally {
    stopRefreshSpinner(refreshIcon, () => {
      if (refreshBtn) refreshBtn.disabled = false;
    });
  }
}

function updateApprovalsBadge(count) {
  const badge = document.getElementById("approvals-badge");
  if (!badge) return;

  if (count > 0) {
    const n = count > 99 ? "99+" : count;
    badge.textContent = isCrt() ? "[" + n + "]" : n;
    badge.classList.remove("hidden");
  } else {
    badge.classList.add("hidden");
  }
}

function displayApprovals(approvals) {
  const listDiv = document.getElementById("approvals-list");

  if (!approvals || approvals.length === 0) {
    setStateMessage(
      listDiv,
      "empty-state",
      isCrt() ? "> Approval queue empty." : "No pending approvals",
    );
    return;
  }

  // If container has no keyed children (first render or state message), do full build
  const existingItems = listDiv.querySelectorAll(
    ":scope > .approval-item[data-id]",
  );
  if (existingItems.length === 0) {
    clearElement(listDiv);
    approvals.forEach((approval) =>
      listDiv.appendChild(createApprovalItem(approval)),
    );
    return;
  }

  // Reconcile: diff existing items against new data
  reconcileApprovals(listDiv, approvals);
}

function reconcileApprovals(container, approvals) {
  const existingMap = new Map();
  container
    .querySelectorAll(":scope > .approval-item[data-id]")
    .forEach((el) => {
      existingMap.set(el.dataset.id, el);
    });

  const newKeys = new Set(approvals.map((a) => a.requestId || ""));

  // Remove approvals no longer in data
  for (const [key, el] of existingMap) {
    if (!newKeys.has(key)) el.remove();
  }

  // Add new approvals in order (existing ones keep their DOM state - comments, button states)
  let prevSibling = null;
  for (const approval of approvals) {
    const key = approval.requestId || "";
    const existing = existingMap.get(key);
    if (existing) {
      // Keep existing DOM node - preserve user's typed comments and button states
      // Just update the time display if it changed
      const timeEl = existing.querySelector(".approval-time");
      if (timeEl && approval.createdAt) {
        timeEl.textContent = formatApprovalTime(approval.createdAt);
      }
      // Ensure correct order
      if (prevSibling) {
        if (existing.previousElementSibling !== prevSibling) {
          prevSibling.after(existing);
        }
      } else if (existing !== container.firstElementChild) {
        container.prepend(existing);
      }
      prevSibling = existing;
    } else {
      const newEl = createApprovalItem(approval);
      if (prevSibling) {
        prevSibling.after(newEl);
      } else {
        container.prepend(newEl);
      }
      prevSibling = newEl;
    }
  }
}

function createApprovalItem(approval) {
  const ctx = approval.context || {};
  const div = document.createElement("div");
  div.className = "approval-item";
  div.dataset.id = approval.requestId || "";

  // Helper to add a labeled detail row
  const addDetail = (label, value, opts) => {
    if (!value && !opts?.element) return null;
    const row = document.createElement("div");
    row.className =
      "approval-detail" + (opts?.className ? " " + opts.className : "");
    const labelSpan = document.createElement("span");
    labelSpan.className = "approval-label";
    labelSpan.textContent = label;
    const valueSpan = document.createElement("span");
    valueSpan.className = "approval-value";
    if (opts?.element) {
      valueSpan.appendChild(opts.element);
    } else {
      valueSpan.textContent = value || "";
      valueSpan.title = value || ""; // tooltip for truncated text
    }
    row.appendChild(labelSpan);
    row.appendChild(valueSpan);
    div.appendChild(row);
    return row;
  };

  // Header row: tracking ID (as link) + time
  const header = document.createElement("div");
  header.className = "approval-header";

  const tenantOrigin = getApprovedTenantOrigin(ctx.tenantUrl || "");
  const trackingText = approval.trackingId || approval.requestId || "";

  if (tenantOrigin && approval.requestId) {
    const tracking = document.createElement("a");
    tracking.className = "approval-name approval-link";
    tracking.textContent = trackingText;
    tracking.href = "#";
    tracking.title = "Open in Britive";
    tracking.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        const trackingUrl = new URL(
          "/my-approvals/view/" + encodeURIComponent(approval.requestId),
          tenantOrigin,
        ).toString();
        openTabSafely(trackingUrl);
      } catch (err) {
        // no-op when tenant URL is malformed
      }
    });
    header.appendChild(tracking);
  } else {
    const tracking = document.createElement("div");
    tracking.className = "approval-name";
    tracking.textContent = trackingText;
    header.appendChild(tracking);
  }

  const headerRight = document.createElement("div");
  headerRight.className = "approval-header-right";

  // Time
  if (approval.createdAt) {
    const time = document.createElement("div");
    time.className = "approval-time";
    time.textContent = formatApprovalTime(approval.createdAt);
    headerRight.appendChild(time);
  }

  // High risk badge inline with title
  if (approval.highRisk) {
    const badge = document.createElement("span");
    badge.className = "approval-high-risk";
    badge.textContent = isCrt() ? "HIGH RISK" : "High Risk";
    header.appendChild(badge);
  }
  header.appendChild(headerRight);
  div.appendChild(header);

  // Requester
  addDetail("Requester", approval.userId || "");

  // Resource
  addDetail("Resource", approval.resourceName || ctx.profileName || "");

  // Justification
  if (approval.justification) {
    addDetail("Justification", approval.justification);
  }

  // Validity
  if (approval.validFor) {
    addDetail(
      "Valid for",
      approval.validFor + (approval.validForInDays ? " days" : " minutes"),
    );
  }

  // Ticket info
  if (ctx.ticketNumber) {
    const ticketLabel = ctx.itsmTypeName || ctx.ticketTypeName || "Ticket";
    if (ctx.ticketUrl) {
      const link = document.createElement("a");
      link.className = "ticket-link";
      link.textContent = ctx.ticketNumber;
      link.title = ctx.ticketUrl;
      link.href = /^https?:\/\//i.test(ctx.ticketUrl) ? ctx.ticketUrl : "#";
      link.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (/^https?:\/\//i.test(ctx.ticketUrl)) {
          openTabSafely(ctx.ticketUrl);
        }
      });
      addDetail(ticketLabel, "", { element: link });
    } else {
      addDetail(ticketLabel, ctx.ticketNumber);
    }
  }

  // Comment textarea (hidden until user clicks approve/reject)
  const comment = document.createElement("textarea");
  comment.className = "approval-comment";
  comment.placeholder = "Optional comment...";
  comment.rows = 2;
  div.appendChild(comment);

  // Action buttons
  const actions = document.createElement("div");
  actions.className = "approval-actions";

  const approveBtn = document.createElement("button");
  approveBtn.className = "btn-approve";
  approveBtn.textContent = "Approve";
  approveBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!comment.classList.contains("visible")) {
      comment.classList.add("visible");
      comment.focus();
      return;
    }
    handleApproval(div, approval, true, comment.value.trim());
  });

  const rejectBtn = document.createElement("button");
  rejectBtn.className = "btn-reject";
  rejectBtn.textContent = "Reject";
  rejectBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!comment.classList.contains("visible")) {
      comment.classList.add("visible");
      comment.focus();
      return;
    }
    handleApproval(div, approval, false, comment.value.trim());
  });

  actions.appendChild(approveBtn);
  actions.appendChild(rejectBtn);
  div.appendChild(actions);

  return div;
}

async function handleApproval(itemDiv, approval, approve, comments) {
  const requestId = approval.requestId;
  const action = approve ? "approveRequest" : "rejectRequest";

  // Disable buttons while processing
  const buttons = itemDiv.querySelectorAll(".btn-approve, .btn-reject");
  buttons.forEach((b) => {
    b.disabled = true;
    b.style.opacity = "0.5";
  });

  const activeBtn = approve
    ? itemDiv.querySelector(".btn-approve")
    : itemDiv.querySelector(".btn-reject");
  const origText = activeBtn.textContent;
  activeBtn.textContent = approve ? "Approving..." : "Rejecting...";

  try {
    const response = await chrome.runtime.sendMessage({
      action,
      requestId,
      comments,
    });

    if (response.success) {
      // Show brief success feedback then remove the item
      itemDiv.style.opacity = "0.5";
      activeBtn.textContent = approve ? "Approved" : "Rejected";
      setTimeout(() => {
        itemDiv.remove();
        // Update the list and badge
        currentApprovals = currentApprovals.filter(
          (a) => a.requestId !== requestId,
        );
        updateApprovalsBadge(currentApprovals.length);
        if (currentApprovals.length === 0) {
          const listDiv = document.getElementById("approvals-list");
          setStateMessage(
            listDiv,
            "empty-state",
            isCrt() ? "> Approval queue empty." : "No pending approvals",
          );
        }
      }, 600);
    } else {
      activeBtn.textContent = origText;
      buttons.forEach((b) => {
        b.disabled = false;
        b.style.opacity = "1";
      });
      // Show error inline
      showInlineError(itemDiv, response.error || "Action failed");
    }
  } catch (error) {
    activeBtn.textContent = origText;
    buttons.forEach((b) => {
      b.disabled = false;
      b.style.opacity = "1";
    });
    showInlineError(itemDiv, error.message);
  }
}

function showToast(message, type, icon) {
  const container = document.getElementById("toast-container");
  if (!container) return;

  const toast = document.createElement("div");
  toast.className = "toast " + type;

  if (icon) {
    const iconEl = document.createElement("span");
    iconEl.className = "toast-icon";
    iconEl.textContent = icon;
    toast.appendChild(iconEl);
  }

  const msg = document.createElement("span");
  msg.className = "toast-message";
  msg.textContent = message;

  toast.appendChild(msg);
  container.appendChild(toast);

  const dismiss = () => {
    toast.classList.add("removing");
    setTimeout(() => {
      if (toast.parentNode) toast.remove();
    }, 200);
  };

  toast.addEventListener("click", dismiss);

  // Auto-dismiss after 5 seconds
  setTimeout(dismiss, 5000);
}

// Flash-highlight an access row by papId + environmentId
function flashAccessRow(papId, environmentId, tone) {
  if (!papId || !environmentId) return;
  const key = `${papId}|${environmentId}`;
  const row = document.querySelector(`.access-env-row[data-env-key="${key}"]`);
  if (!row) return;

  const cls =
    tone === "success"
      ? "ws-flash-success"
      : tone === "error"
        ? "ws-flash-error"
        : tone === "warning"
          ? "ws-flash-warning"
          : "ws-flash";

  // Reset animation if already playing
  row.classList.remove(
    "ws-flash",
    "ws-flash-success",
    "ws-flash-error",
    "ws-flash-warning",
  );
  // Force reflow to restart animation
  void row.offsetWidth;
  row.classList.add(cls);
  row.addEventListener("animationend", () => row.classList.remove(cls), {
    once: true,
  });

  // Scroll into view if needed, ensure parent groups are expanded
  const profileBody = row.closest(".access-profile-body");
  const groupBody = row.closest(".access-group-body");
  if (profileBody) profileBody.classList.remove("collapsed");
  if (groupBody) groupBody.classList.remove("collapsed");
  row.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// Drain queued WS notifications from background and display as toasts
async function drainQueuedNotifications() {
  try {
    const resp = await chrome.runtime.sendMessage({
      action: "drainNotificationQueue",
    });
    if (
      !resp ||
      !Array.isArray(resp.notifications) ||
      resp.notifications.length === 0
    )
      return;

    // Filter to only recent notifications (last 5 minutes)
    const cutoff = Date.now() - 5 * 60 * 1000;
    const recent = resp.notifications.filter(
      (n) => n.timestamp > cutoff && isMessageAccessInCurrentScope(n),
    );
    if (recent.length === 0) return;

    // Short delay to let the UI finish rendering
    await new Promise((r) => setTimeout(r, 300));

    for (const n of recent) {
      showToast(n.message, n.tone, n.icon || null);
      flashAccessRow(n.papId, n.environmentId, n.tone);
    }
  } catch (e) {
    /* popup may have closed */
  }
}

function showInlineError(_parentDiv, message) {
  showToast(message, "error");
}

function showInlineSuccess(_parentDiv, message) {
  showToast(message, "success");
}

function formatApprovalTime(dateStr) {
  if (!dateStr) return "";
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    const now = new Date();
    const diffMs = now - d;
    const diffMins = Math.floor(diffMs / 60000);

    if (diffMins < 1) return "just now";
    if (diffMins < 60) return diffMins + "m ago";

    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return diffHours + "h ago";

    const diffDays = Math.floor(diffHours / 24);
    if (diffDays < 7) return diffDays + "d ago";

    return d.toLocaleDateString();
  } catch {
    return dateStr;
  }
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
