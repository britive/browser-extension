// Background script for Britive extension
// Uses OAuth 2.0 Authorization Code with PKCE for authentication

// ---- Crypto / PKCE utilities ----

function generateRandomBytes(length) {
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  return array;
}

function base64UrlEncode(bytes) {
  const base64 = btoa(String.fromCharCode(...bytes));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

// Generate a PKCE code_verifier (43-128 unreserved chars, RFC 7636)
function generateCodeVerifier() {
  // 64 random bytes -> base64url gives ~86 chars, well within 43-128 range
  return base64UrlEncode(generateRandomBytes(64));
}

// SHA-256 hash -> base64url (for PKCE code_challenge with S256 method)
async function generateCodeChallenge(verifier) {
  const data = new TextEncoder().encode(verifier);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return base64UrlEncode(new Uint8Array(hash));
}

// SHA-256 hash -> hex string (for client_id derivation)
async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Generate a random state parameter for CSRF protection
function generateState() {
  return base64UrlEncode(generateRandomBytes(32));
}

// Compute the OAuth client_id for a tenant
// client_id = sha256hex("browser-extension-<tenantRoot>")
// tenantRoot = first segment before any dots (e.g. "smdev" from "smdev.dev")
async function computeClientId(tenant) {
  const tenantRoot = tenant.split(".")[0];
  return await sha256Hex("browser-extension-" + tenantRoot);
}

// Tenant name validation - allows subdomains (dots) and hyphens
function isValidTenant(t) {
  return (
    typeof t === "string" &&
    t.length > 0 &&
    /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(t)
  );
}

function getTenantBaseUrl(tenant) {
  if (!isValidTenant(tenant)) throw new Error("Invalid tenant name");
  return `https://${tenant}.britive-app.com`;
}

function getWsCookieUrlForTenant(tenant) {
  return `${getTenantBaseUrl(tenant)}/api/websocket/`;
}

function getWsCookieUrlForBaseUrl(baseUrl) {
  return baseUrl ? `${baseUrl}/api/websocket/` : null;
}

function getTenantHostFromBaseUrl(baseUrl) {
  return new URL(baseUrl).host;
}

function stableStringify(value) {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        acc[key] = sortKeysDeep(value[key]);
        return acc;
      }, {});
  }
  return value;
}

function normalizeError(error, fallback = "Unexpected error") {
  if (typeof error === "string" && error.trim()) return error.trim();
  if (error && typeof error.message === "string" && error.message.trim())
    return error.message.trim();
  return fallback;
}

const APPROVALS_FALLBACK_INTERVAL_SEC = 60;
const POST_LOGIN_REFRESH_COOLDOWN_MS = 2 * 60 * 1000;
const TOKEN_REFRESH_LEAD_TIME_MS = 5 * 60 * 1000;
function generatePendingRequestId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return base64UrlEncode(generateRandomBytes(16));
}

function generateAuthGeneration() {
  return generatePendingRequestId();
}

async function getPendingContainerRequests() {
  const { pendingContainerRequests } = await browser.storage.local.get(
    "pendingContainerRequests",
  );
  const requests = pendingContainerRequests || {};
  const cutoff = Date.now() - 15 * 60 * 1000;
  let changed = false;
  for (const [requestId, request] of Object.entries(requests)) {
    if (!request || (request.createdAt || 0) < cutoff) {
      delete requests[requestId];
      changed = true;
    }
  }
  if (changed) {
    await browser.storage.local.set({ pendingContainerRequests: requests });
  }
  return requests;
}

function hasAuthenticatedTenantSession(settings) {
  return Boolean(
    settings &&
    settings.authenticated &&
    settings.bearerToken &&
    isValidTenant(settings.tenant),
  );
}

function shouldAutoCloseCliAuth(settings) {
  return Boolean(settings?.extensionSettings?.autoCloseCliAuth ?? true);
}

function isConfiguredCliTab(tabUrl, tenant) {
  if (!tabUrl) return false;

  try {
    const url = new URL(tabUrl);
    if (url.protocol !== "https:" || !url.pathname.startsWith("/cli")) {
      return false;
    }
    if (isValidTenant(tenant)) {
      const tenantHost = getTenantHostFromBaseUrl(getTenantBaseUrl(tenant));
      return url.host === tenantHost;
    }
    return url.host.endsWith(".britive-app.com");
  } catch (e) {
    return false;
  }
}

async function reportError(scope, error, meta = null) {
  try {
    const { recentInternalErrors = [] } = await browser.storage.local.get(
      "recentInternalErrors",
    );
    recentInternalErrors.push({
      scope,
      message: normalizeError(error),
      meta,
      timestamp: Date.now(),
    });
    await browser.storage.local.set({
      recentInternalErrors: recentInternalErrors.slice(-25),
    });
  } catch (_) {}
}

// Britive API Client - Uses Bearer token from interactive login
class BritiveAPI {
  constructor() {
    this.baseUrl = null;
    this.bearerToken = null;
    this.vaultId = null;
  }

  async initialize() {
    const settings = await browser.storage.local.get(["britiveSettings"]);
    if (settings.britiveSettings) {
      if (isValidTenant(settings.britiveSettings.tenant)) {
        this.baseUrl = getTenantBaseUrl(settings.britiveSettings.tenant);
      }
      if (settings.britiveSettings.bearerToken) {
        this.bearerToken = settings.britiveSettings.bearerToken;
      }
    }
  }

  async makeRequest(endpoint, options = {}) {
    if (!this.baseUrl || !this.bearerToken) {
      await this.initialize();
    }

    if (!this.baseUrl) {
      throw new Error("Britive tenant not configured");
    }

    if (!this.bearerToken) {
      throw new Error("Not authenticated. Please log in to Britive.");
    }

    const url = `${this.baseUrl}${endpoint}`;
    const extVersion = browser.runtime.getManifest().version;

    // Use Bearer token in Authorization header (like Python SDK)
    const response = await fetch(url, {
      ...options,
      credentials: "omit",
      headers: {
        Authorization: `Bearer ${this.bearerToken}`,
        "Content-Type": "application/json",
        "X-Britive-Extension": extVersion,
        ...options.headers,
      },
    });

    if (!response.ok) {
      // Read the response body once for error handling
      const errorText = await response.text();

      // For 403 responses, only clear the token for PE-0028 step-up (which is
      // actually NOT a session expiry - it just needs OTP). Generic 403 means
      // "permission denied" (e.g. user has no secrets access) and should NOT
      // log the user out. Only 401 reliably means the token is invalid.
      if (response.status === 403) {
        try {
          const errorJson = JSON.parse(errorText);
          if (errorJson.errorCode === "PE-0028") {
            // Step-up auth required - user IS authenticated, don't clear token
            throw new Error(`API Error: ${response.status} - ${errorText}`);
          }
        } catch (e) {
          if (e.message.startsWith("API Error:")) throw e;
        }
        // Permission denied - don't clear the session, just surface the error
        throw new Error(`API Error: ${response.status} - ${errorText}`);
      }

      if (response.status === 401) {
        await this.clearToken();
        throw new Error("Not authenticated. Please log in to Britive again.");
      }

      throw new Error(`API Error: ${response.status} - ${errorText}`);
    }

    // Handle empty responses
    const contentType = response.headers.get("content-type");
    if (contentType && contentType.includes("application/json")) {
      return response.json();
    }

    return response.text();
  }

  async clearToken() {
    this.bearerToken = null;
    this.vaultId = null;
    // Cancel any pending token refresh
    cancelTokenRefresh();
    const settings = await browser.storage.local.get(["britiveSettings"]);
    if (settings.britiveSettings) {
      settings.britiveSettings.bearerToken = null;
      settings.britiveSettings.refreshToken = null;
      settings.britiveSettings.clientId = null;
      settings.britiveSettings.authenticated = false;
      await browser.storage.local.set({
        britiveSettings: settings.britiveSettings,
      });
    }
    await clearSecretsCache();
    await browser.storage.local.remove([
      "secretTemplates",
      "secretUrlMap",
      "pendingContainerRequests",
      "cachedUserProfile",
      "cachedMfaRegistrations",
      "cachedCheckedOutProfiles",
      "accessCache_data",
      "accessCache_collectionId",
      "accessCache_collectionName",
      "accessCollapsedState",
      "pendingApprovals",
      "bannerDismissed",
      "checkoutExpirations",
      "wsNotificationQueue",
    ]);
    wsNotificationQueue = [];
    clearAllCheckoutExpirationNotifications();
    await disconnectNotificationSocket();
    // Clear extension badge
    browser.browserAction.setBadgeText({ text: "" });
    // Notify popup if open so it can return to the login screen
    browser.runtime.sendMessage({ action: "sessionExpired" }).catch(() => {});
  }

  async getVaultId() {
    if (this.vaultId) return this.vaultId;

    try {
      const vault = await this.makeRequest("/api/v1/secretmanager/vault");
      this.vaultId = vault.id;
      return this.vaultId;
    } catch (error) {
      await reportError("getVaultId", error);
      throw new Error("No secrets vault found or access denied");
    }
  }
}

const britiveAPI = new BritiveAPI();

// Track URLs we've already dispatched to a container so we don't intercept them again
const allowedRequests = new Set();

const DEFAULT_INTERCEPT_PATTERNS = [
  "*://signin.aws.amazon.com/*",
  "*://*.awsapps.com/*",
];

// The interception handler shared by all registrations
async function interceptHandler(details) {
  if (allowedRequests.has(details.url)) {
    allowedRequests.delete(details.url);
    return {};
  }

  const storage = await browser.storage.local.get([
    "extensionSettings",
    "britiveSettings",
  ]);
  const settings = storage.extensionSettings || { interceptAwsSts: true };
  const britiveSettings = storage.britiveSettings || {};

  if (!settings.interceptAwsSts) return {};
  if (!hasAuthenticatedTenantSession(britiveSettings)) return {};

  if (isAWSFederationUrl(details.url, settings.customPatterns || [])) {
    const requestId = generatePendingRequestId();
    const pendingContainerRequests = await getPendingContainerRequests();
    pendingContainerRequests[requestId] = {
      url: details.url,
      tabId: details.tabId,
      createdAt: Date.now(),
    };
    await browser.storage.local.set({ pendingContainerRequests });

    return {
      redirectUrl: `${browser.runtime.getURL("picker/picker.html")}?requestId=${encodeURIComponent(requestId)}`,
    };
  }

  return {};
}

// Register the webRequest listener with the current URL filter set
let activeInterceptFilter = null;

function disableInterceptListener() {
  if (activeInterceptFilter) {
    browser.webRequest.onBeforeRequest.removeListener(interceptHandler);
    activeInterceptFilter = null;
  }
}

function registerInterceptListener(urlPatterns) {
  disableInterceptListener();
  activeInterceptFilter = { urls: urlPatterns };
  browser.webRequest.onBeforeRequest.addListener(
    interceptHandler,
    activeInterceptFilter,
    ["blocking"],
  );
}

// Build the URL filter from default patterns + user custom patterns
async function refreshInterceptPatterns() {
  const { extensionSettings, britiveSettings } =
    await browser.storage.local.get(["extensionSettings", "britiveSettings"]);
  const settings = extensionSettings || {};
  if (!hasAuthenticatedTenantSession(britiveSettings || {})) {
    disableInterceptListener();
    return;
  }
  const custom = (settings.customPatterns || []).filter(
    (p) => p.includes("*") || p.includes("://"),
  );

  if (custom.length === 0) {
    registerInterceptListener(DEFAULT_INTERCEPT_PATTERNS);
    return;
  }

  // Custom patterns require <all_urls> permission; check if we have it
  const hasPermission = await browser.permissions.contains({
    origins: ["<all_urls>"],
  });
  if (hasPermission) {
    registerInterceptListener(["<all_urls>"]);
  } else {
    registerInterceptListener(DEFAULT_INTERCEPT_PATTERNS);
  }
}

// Initial registration
refreshInterceptPatterns();

// Re-register when settings change (e.g. user adds/removes custom patterns)
browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.extensionSettings) {
    refreshInterceptPatterns();
  }
});

// Detect AWS federation login URLs
function isAWSFederationUrl(url, customPatterns = []) {
  try {
    const urlObj = new URL(url);

    // Custom patterns
    for (const pattern of customPatterns) {
      if (matchPattern(url, pattern)) return true;
    }

    // Federation login from Britive: signin.aws.amazon.com/federation?Action=login&SigninToken=...&Issuer=...britive-app.com
    if (
      urlObj.hostname === "signin.aws.amazon.com" &&
      urlObj.pathname === "/federation" &&
      urlObj.searchParams.get("Action") === "login" &&
      urlObj.searchParams.has("SigninToken") &&
      (urlObj.searchParams.get("Issuer") || "").includes("britive-app.com")
    ) {
      return true;
    }

    // SSO start URLs
    if (
      urlObj.hostname.endsWith(".awsapps.com") &&
      urlObj.pathname.includes("/start")
    ) {
      return true;
    }

    return false;
  } catch (e) {
    return false;
  }
}

// Match URL against wildcard pattern
function matchPattern(url, pattern) {
  let urlIdx = 0;
  let patternIdx = 0;
  let lastStarIdx = -1;
  let backtrackUrlIdx = -1;

  while (urlIdx < url.length) {
    if (patternIdx < pattern.length && pattern[patternIdx] === url[urlIdx]) {
      urlIdx++;
      patternIdx++;
      continue;
    }

    if (patternIdx < pattern.length && pattern[patternIdx] === "*") {
      lastStarIdx = patternIdx;
      patternIdx++;
      backtrackUrlIdx = urlIdx;
      continue;
    }

    if (lastStarIdx !== -1) {
      patternIdx = lastStarIdx + 1;
      backtrackUrlIdx++;
      urlIdx = backtrackUrlIdx;
      continue;
    }

    return false;
  }

  while (patternIdx < pattern.length && pattern[patternIdx] === "*") {
    patternIdx++;
  }

  return patternIdx === pattern.length;
}

// Append extension identifier to User-Agent on all requests to britive-app.com
browser.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    const extVersion = browser.runtime.getManifest().version;
    for (const header of details.requestHeaders) {
      if (header.name.toLowerCase() === "user-agent") {
        header.value += ` browser-extension-${extVersion}`;
        break;
      }
    }
    return { requestHeaders: details.requestHeaders };
  },
  { urls: ["*://*.britive-app.com/*"] },
  ["blocking", "requestHeaders"],
);

// ── Secret templates ──
// Fetches available secret types and classifies which ones are "web credential" types
// (have both URL and Password parameters)

async function fetchSecretTemplates() {
  try {
    const response = await britiveAPI.makeRequest(
      "/api/v1/secretmanager/secret-templates/static",
    );
    const templates = response.result || response || [];

    const webTypes = [];
    const allTypes = [];

    for (const tpl of templates) {
      const params = tpl.parameters || [];
      const paramNames = params.map((p) => (p.name || "").toLowerCase());
      const hasURL = paramNames.includes("url");
      const hasPassword = paramNames.includes("password");
      const hasOTP = paramNames.includes("otp");

      allTypes.push({
        secretType: tpl.secretType,
        description: tpl.description || tpl.secretType,
        hasOTP,
        isWebType: hasURL && hasPassword,
      });

      if (hasURL && hasPassword) {
        webTypes.push(tpl.secretType);
      }
    }

    const data = { webTypes, allTypes, timestamp: Date.now() };
    await browser.storage.local.set({ secretTemplates: data });
    return data;
  } catch (error) {
    return { error: normalizeError(error) };
  }
}

async function getCachedSecretTemplates() {
  const { secretTemplates } =
    await browser.storage.local.get("secretTemplates");
  if (!secretTemplates || !secretTemplates.timestamp) return null;
  const age = Date.now() - secretTemplates.timestamp;
  if (age > CACHE_MAX_AGE_MS) return null;
  return secretTemplates;
}

// ── Secrets cache ──
const CACHE_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

async function getCachedSecrets() {
  const { secretsCache } = await browser.storage.local.get("secretsCache");
  if (!secretsCache) return null;
  const age = Date.now() - (secretsCache.timestamp || 0);
  if (age > CACHE_MAX_AGE_MS) return null; // stale
  return secretsCache.secrets;
}

async function setCachedSecrets(secrets) {
  await browser.storage.local.set({
    secretsCache: { secrets, timestamp: Date.now() },
  });
}

async function clearSecretsCache() {
  await browser.storage.local.remove("secretsCache");
}

// Handle messages from popup
browser.runtime.onMessage.addListener(async (message, sender, sendResponse) => {
  if (message.action === "cliReady") {
    const settings = await browser.storage.local.get([
      "extensionSettings",
      "britiveSettings",
    ]);
    const senderUrl = sender.url || sender.tab?.url;
    if (!shouldAutoCloseCliAuth(settings)) {
      return { success: false };
    }
    if (
      !sender.tab?.id ||
      !isConfiguredCliTab(senderUrl, settings.britiveSettings?.tenant)
    ) {
      return { success: false };
    }

    await browser.tabs.remove(sender.tab.id).catch(() => {});
    return { success: true };
  }

  if (message.action === "openInContainer") {
    const { url, containerId } = message;

    // Validate URL scheme - only allow http(s)
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
      return { error: "Invalid URL scheme" };
    }

    const requestId = message.requestId;
    const pendingContainerRequests = await getPendingContainerRequests();
    const request = requestId ? pendingContainerRequests[requestId] : null;
    if (!request || url !== request.url) {
      return { error: "URL does not match pending request" };
    }

    // Whitelist this URL so the listener doesn't intercept it again
    allowedRequests.add(url);

    await browser.tabs.create({ url, cookieStoreId: containerId });

    // Close the picker tab (which replaced the original intercepted tab)
    if (sender.tab && sender.tab.id) {
      browser.tabs.remove(sender.tab.id).catch(() => {});
    }

    delete pendingContainerRequests[requestId];
    await browser.storage.local.set({ pendingContainerRequests });
    return { success: true };
  }

  if (message.action === "getSecrets") {
    const forceRefresh = message.forceRefresh === true;

    if (!forceRefresh) {
      const cached = await getCachedSecrets();
      if (cached) {
        return { secrets: cached };
      }
    }

    // Fetch fresh list from API
    const secrets = await fetchBritiveSecrets();
    if (!secrets.error) {
      await setCachedSecrets(secrets);
    }
    return { secrets };
  }

  if (message.action === "refreshBanner") {
    await pollBanner();
    const { britiveBanner } = await browser.storage.local.get("britiveBanner");
    return { banner: britiveBanner || null };
  }

  if (message.action === "getCachedApprovals") {
    // Return in-memory cached approvals without API call
    return { approvals: cachedApprovalsList || [] };
  }

  if (message.action === "drainNotificationQueue") {
    return { notifications: drainWsNotificationQueue() };
  }

  if (message.action === "getApprovals") {
    const approvals = await fetchApprovals();
    // Keep badge and cache in sync when popup fetches approvals
    if (Array.isArray(approvals)) {
      cachedApprovalsList = approvals;
      pendingApprovalCount = approvals.length;
      updateExtensionBadge();
    }
    return { approvals };
  }

  if (message.action === "approveRequest") {
    const result = await handleApprovalAction(
      message.requestId,
      true,
      message.comments,
    );
    if (result.success) {
      pendingApprovalCount = Math.max(0, pendingApprovalCount - 1);
      if (cachedApprovalsList) {
        cachedApprovalsList = cachedApprovalsList.filter(
          (a) => a.requestId !== message.requestId,
        );
      }
      updateExtensionBadge();
    }
    return result;
  }

  if (message.action === "rejectRequest") {
    const result = await handleApprovalAction(
      message.requestId,
      false,
      message.comments,
    );
    if (result.success) {
      pendingApprovalCount = Math.max(0, pendingApprovalCount - 1);
      if (cachedApprovalsList) {
        cachedApprovalsList = cachedApprovalsList.filter(
          (a) => a.requestId !== message.requestId,
        );
      }
      updateExtensionBadge();
    }
    return result;
  }

  if (message.action === "getSecretValue") {
    const result = await fetchSecretValue(message.path);
    return result;
  }

  if (message.action === "startOAuthLogin") {
    return await startOAuthLogin(message.tenant);
  }

  if (message.action === "logout") {
    await britiveAPI.clearToken();
    return { success: true };
  }

  if (message.action === "approvalStatusChanged") {
    return await handleApprovalStatusChanged(
      message.status,
      message.item,
      message.autoCheckout,
    );
  }

  if (message.action === "checkAuthenticationStatus") {
    const result = await checkAuthenticationStatus();
    return result;
  }

  if (message.action === "getUserProfile") {
    return await fetchUserProfile();
  }

  if (message.action === "getSecretTemplates") {
    const cached = await getCachedSecretTemplates();
    if (cached) return cached;
    return await fetchSecretTemplates();
  }

  if (message.action === "refreshSecretTemplates") {
    return await fetchSecretTemplates();
  }

  if (message.action === "getCollections") {
    const collections = await fetchCollections(message.userId);
    return { collections };
  }

  if (message.action === "getAccess") {
    const access = await fetchAccess(
      message.collectionId,
      message.forceRefresh,
      message.favorites,
    );
    return { access };
  }

  if (message.action === "searchAccess") {
    return await searchAccess(message.searchText);
  }

  if (message.action === "addToFavorites") {
    return await addToFavorites(
      message.appContainerId,
      message.environmentId,
      message.papId,
      message.accessType,
    );
  }

  if (message.action === "removeFromFavorites") {
    return await removeFromFavorites(message.papId);
  }

  if (message.action === "getProfileSettings") {
    return await fetchProfileSettings(message.papId, message.environmentId);
  }

  if (message.action === "searchTickets") {
    return await searchTickets(
      message.papId,
      message.environmentId,
      message.ticketType,
      message.query,
    );
  }

  if (message.action === "getApprovers") {
    return await fetchApprovers(message.papId);
  }

  if (message.action === "submitApprovalRequest") {
    return await submitApprovalRequest(
      message.papId,
      message.environmentId,
      message.justification,
      message.ticketId,
      message.ticketType,
    );
  }

  if (message.action === "getApprovalStatus") {
    return await fetchApprovalStatus(message.requestId);
  }

  if (message.action === "setExtensionIcon") {
    const iconPath = message.crt
      ? {
          48: "icons/britive-icon-crt-48.png",
          96: "icons/britive-icon-crt-96.png",
          128: "icons/britive-icon-crt-128.png",
        }
      : {
          48: "icons/britive-icon-48.png",
          96: "icons/britive-icon-96.png",
          128: "icons/britive-icon-128.png",
        };
    browser.browserAction.setIcon({ path: iconPath });
    return { success: true };
  }

  if (message.action === "withdrawApprovalRequest") {
    return await withdrawApprovalRequest(message.papId, message.environmentId);
  }

  if (message.action === "checkoutAccess") {
    return await checkoutAccess(
      message.papId,
      message.environmentId,
      message.justification,
      message.otp,
      message.ticketId,
      message.ticketType,
    );
  }

  if (message.action === "checkinAccess") {
    return await checkinAccess(message.transactionId);
  }

  if (message.action === "getAccessUrl") {
    return await fetchAccessUrl(message.transactionId);
  }

  if (message.action === "getCheckedOutProfiles") {
    return await fetchCheckedOutProfiles();
  }

  if (message.action === "setCheckoutExpiration") {
    const { checkoutExpirations = {} } = await browser.storage.local.get(
      "checkoutExpirations",
    );
    checkoutExpirations[message.key] = message.expiration;
    await browser.storage.local.set({ checkoutExpirations });
    // Schedule expiration notification if profile/env names provided
    if (message.profileName && message.envName) {
      scheduleCheckoutExpirationNotification(
        message.key,
        message.profileName,
        message.envName,
        message.expiration,
      );
    }
    return { success: true };
  }

  if (message.action === "clearCheckoutExpiration") {
    const { checkoutExpirations = {} } = await browser.storage.local.get(
      "checkoutExpirations",
    );
    delete checkoutExpirations[message.key];
    await browser.storage.local.set({ checkoutExpirations });
    clearCheckoutExpirationNotification(message.key);
    return { success: true };
  }

  if (message.action === "getCheckoutExpirations") {
    const { checkoutExpirations = {} } = await browser.storage.local.get(
      "checkoutExpirations",
    );
    return { expirations: checkoutExpirations };
  }
});

browser.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;

  const tabUrl = tab?.url || changeInfo.url;
  const settings = await browser.storage.local.get([
    "extensionSettings",
    "britiveSettings",
  ]);
  if (!shouldAutoCloseCliAuth(settings)) return;
  if (!isConfiguredCliTab(tabUrl, settings.britiveSettings?.tenant)) return;

  await browser.tabs.remove(tabId).catch(() => {});
});

// Interactive login flow (from Python CLI)
function isSafeHttpUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch (e) {
    return false;
  }
}

async function openTabSafely(url) {
  if (!isSafeHttpUrl(url)) return null;
  return browser.tabs.create({ url });
}

function parseOAuthResponseUrl(responseUrl, expectedState) {
  if (!responseUrl) {
    return {
      success: false,
      error: "No redirect URL returned from OAuth flow.",
    };
  }

  const parsedUrl = new URL(responseUrl);
  const responseParams = parsedUrl.searchParams;
  const returnedCode = responseParams.get("code");
  const returnedState = responseParams.get("state");
  const errorParam = responseParams.get("error");

  if (errorParam) {
    const errorDesc = responseParams.get("error_description") || errorParam;
    return {
      success: false,
      error: `Authorization denied: ${errorDesc}`,
      responseUrl,
    };
  }

  if (!returnedCode) {
    return {
      success: false,
      error: "No authorization code received.",
      responseUrl,
      finalUrlHost: parsedUrl.host,
      finalUrlPath: parsedUrl.pathname,
    };
  }

  if (expectedState !== null && returnedState !== expectedState) {
    return {
      success: false,
      error: "State mismatch. Possible CSRF attack. Please try again.",
      responseUrl,
    };
  }

  return { success: true, code: returnedCode, responseUrl };
}

async function completeOAuthAuthorization(authUrl, expectedState, interactive) {
  const responseUrl = await browser.identity.launchWebAuthFlow({
    url: authUrl,
    interactive,
  });
  return parseOAuthResponseUrl(responseUrl, expectedState);
}

async function clearTransientAuthState() {
  await browser.storage.local.remove("britiveAuth");
}

async function startOAuthLogin(tenant) {
  try {
    if (!isValidTenant(tenant)) {
      return { success: false, error: "Invalid tenant name." };
    }

    // Verify tenant exists before starting OAuth
    try {
      const healthResp = await fetch(`${getTenantBaseUrl(tenant)}/api/health`, {
        method: "GET",
        credentials: "omit",
        signal: AbortSignal.timeout(8000),
      });
      if (!healthResp.ok) {
        return {
          success: false,
          error: `Tenant "${tenant}" not found. Check the name and try again.`,
        };
      }
    } catch (healthErr) {
      return {
        success: false,
        error: `Cannot reach tenant "${tenant}". Check the name and try again.`,
      };
    }

    // Stop any pending refresh from an older session so it can't race the new login.
    cancelTokenRefresh();

    // Generate PKCE parameters
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = await generateCodeChallenge(codeVerifier);
    const state = generateState();
    const clientId = await computeClientId(tenant);

    // Get the browser-generated redirect URI for this extension
    const redirectUri = browser.identity.getRedirectURL();

    // Build the authorization URL
    const baseUrl = getTenantBaseUrl(tenant);
    const params = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      state: state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });
    const authUrl = `${baseUrl}/api/auth/sso/oauth2/authorize?${params.toString()}`;

    // Store transient state for verification after redirect
    await browser.storage.local.set({
      britiveAuth: {
        tenant,
        codeVerifier,
        state,
        clientId,
        redirectUri,
        authGeneration: generateAuthGeneration(),
        loginInProgress: true,
        startTime: Date.now(),
      },
    });

    let authResult;
    try {
      authResult = await completeOAuthAuthorization(authUrl, state, true);
    } catch (authErr) {
      await clearTransientAuthState();
      const errMsg = normalizeError(authErr);
      if (
        errMsg.includes("cancelled") ||
        errMsg.includes("canceled") ||
        errMsg.includes("closed") ||
        errMsg.includes("user")
      ) {
        return { success: false, error: "Login cancelled." };
      }
      return { success: false, error: `Authentication failed: ${errMsg}` };
    }

    if (!authResult.success) {
      await clearTransientAuthState();
      await reportError(
        "startOAuthLoginRedirectMissing",
        new Error(authResult.error),
        {
          tenant,
          finalUrlHost: authResult.finalUrlHost || null,
          finalUrlPath: authResult.finalUrlPath || null,
        },
      );
      const fallbackError =
        authResult.error === "No authorization code received."
          ? "Login completed in the tenant UI, but the tenant did not redirect back to the extension. Please try again."
          : authResult.error;
      return { success: false, error: fallbackError };
    }

    const authGeneration =
      (await browser.storage.local.get("britiveAuth")).britiveAuth
        ?.authGeneration || generateAuthGeneration();
    const tokenResult = await exchangeCodeForTokens(
      tenant,
      authResult.code,
      codeVerifier,
      clientId,
      redirectUri,
      authGeneration,
    );
    if (!tokenResult.success) {
      await clearTransientAuthState();
      return tokenResult;
    }

    await clearTransientAuthState();

    // Notify popup if it's open
    browser.runtime
      .sendMessage({
        action: "authenticationComplete",
        success: true,
      })
      .catch(() => {});

    return {
      success: true,
      message: "Authentication successful.",
    };
  } catch (error) {
    await reportError("startOAuthLogin", error, { tenant });
    await browser.storage.local.remove("britiveAuth");
    return {
      success: false,
      error: normalizeError(error),
    };
  }
}

// Exchange authorization code for access + refresh tokens
async function exchangeCodeForTokens(
  tenant,
  code,
  codeVerifier,
  clientId,
  redirectUri,
  authGeneration,
) {
  try {
    const baseUrl = getTenantBaseUrl(tenant);
    const tokenUrl = `${baseUrl}/api/auth/sso/oauth2/token`;
    const extVersion = browser.runtime.getManifest().version;

    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: code,
      code_verifier: codeVerifier,
      client_id: clientId,
      redirect_uri: redirectUri,
    });

    const response = await fetch(tokenUrl, {
      method: "POST",
      credentials: "omit",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Britive-Extension": extVersion,
      },
      body: body.toString(),
    });

    if (!response.ok) {
      let errMsg = `Token exchange failed (HTTP ${response.status})`;
      try {
        const errBody = await response.json();
        if (errBody.error_description) errMsg = errBody.error_description;
        else if (errBody.error) errMsg = errBody.error;
        else if (errBody.message) errMsg = errBody.message;
      } catch (_) {}
      return { success: false, error: errMsg };
    }

    const data = await response.json();
    const accessToken = data.access_token || data.accessToken;
    const refreshToken = data.refresh_token || data.refreshToken;

    if (!accessToken) {
      return { success: false, error: "No access token in response." };
    }

    // Extract expiration from JWT
    let expirationTime;
    try {
      const payload = JSON.parse(atob(accessToken.split(".")[1]));
      expirationTime = payload.exp * 1000; // Convert seconds to ms
    } catch (_) {
      expirationTime = Date.now() + 60 * 60 * 1000; // Default 1 hour
    }

    // Store tokens
    await browser.storage.local.set({
      britiveSettings: {
        tenant,
        bearerToken: accessToken,
        refreshToken: refreshToken || null,
        clientId,
        expirationTime,
        lastInteractiveLoginAt: Date.now(),
        authGeneration,
        authenticated: true,
      },
    });
    await refreshInterceptPatterns();

    // Update API client
    britiveAPI.baseUrl = getTenantBaseUrl(tenant);
    britiveAPI.bearerToken = accessToken;

    // Schedule token refresh (5 min before expiry) instead of expiration notification
    if (refreshToken) {
      scheduleTokenRefresh(expirationTime, authGeneration);
    } else {
      scheduleExpirationNotification(expirationTime);
    }

    // Post-login initialization
    startBannerPolling();
    startApprovalsPolling();
    connectNotificationSocket();
    fetchSecretTemplates().catch(() => {});
    fetchUserProfile(true).catch(() => {});
    fetchMfaRegistrations(true).catch(() => {});

    return { success: true };
  } catch (error) {
    await reportError("exchangeCodeForTokens", error, { tenant });
    return { success: false, error: normalizeError(error) };
  }
}

// ---- Token Refresh ----

let tokenRefreshTimerId = null;
let refreshInProgress = false;

function getPostLoginRefreshCooldownRemaining(settings) {
  const lastInteractiveLoginAt = settings?.lastInteractiveLoginAt || 0;
  if (!lastInteractiveLoginAt) return 0;
  const remaining =
    POST_LOGIN_REFRESH_COOLDOWN_MS - (Date.now() - lastInteractiveLoginAt);
  return Math.max(remaining, 0);
}

function scheduleTokenRefresh(
  expirationTime,
  authGeneration = null,
  source = "timer",
) {
  if (tokenRefreshTimerId) {
    clearTimeout(tokenRefreshTimerId);
    tokenRefreshTimerId = null;
  }

  // Refresh 5 minutes before expiry, or immediately if less than 5 min left
  const refreshAt = expirationTime - TOKEN_REFRESH_LEAD_TIME_MS;
  const delay = Math.max(refreshAt - Date.now(), 0);

  tokenRefreshTimerId = setTimeout(async () => {
    tokenRefreshTimerId = null;
    await refreshAccessToken(authGeneration, source);
  }, delay);
}

function cancelTokenRefresh() {
  if (tokenRefreshTimerId) {
    clearTimeout(tokenRefreshTimerId);
    tokenRefreshTimerId = null;
  }
}

async function shouldIgnoreRefreshFailure(
  attemptedTenant,
  attemptedRefreshToken,
  expectedAuthGeneration = null,
) {
  const storage = await browser.storage.local.get([
    "britiveSettings",
    "britiveAuth",
  ]);
  if (storage.britiveAuth && storage.britiveAuth.loginInProgress) {
    return true;
  }

  const currentSettings = storage.britiveSettings || {};
  if (
    expectedAuthGeneration &&
    currentSettings.authGeneration !== expectedAuthGeneration
  ) {
    return true;
  }
  if (
    !currentSettings.refreshToken ||
    currentSettings.refreshToken !== attemptedRefreshToken
  ) {
    return true;
  }
  if (currentSettings.tenant && currentSettings.tenant !== attemptedTenant) {
    return true;
  }
  return false;
}

async function refreshAccessToken(
  expectedAuthGeneration = null,
  source = "unknown",
) {
  let attemptedTenant = null;
  let attemptedRefreshToken = null;
  let attemptedAuthGeneration = expectedAuthGeneration;
  try {
    if (refreshInProgress) {
      return false;
    }

    const { britiveSettings } =
      await browser.storage.local.get("britiveSettings");
    if (
      !britiveSettings ||
      !britiveSettings.refreshToken ||
      !britiveSettings.tenant
    ) {
      // No refresh token available, session will expire naturally
      return false;
    }

    const cooldownRemaining =
      getPostLoginRefreshCooldownRemaining(britiveSettings);
    if (cooldownRemaining > 0) {
      return Boolean(
        britiveSettings.bearerToken && isValidTenant(britiveSettings.tenant),
      );
    }

    if (britiveSettings.expirationTime) {
      const msUntilRefresh =
        britiveSettings.expirationTime -
        Date.now() -
        TOKEN_REFRESH_LEAD_TIME_MS;
      if (msUntilRefresh > 1000) {
        scheduleTokenRefresh(
          britiveSettings.expirationTime,
          attemptedAuthGeneration || britiveSettings.authGeneration || null,
          "timer",
        );
        return Boolean(
          britiveSettings.bearerToken && isValidTenant(britiveSettings.tenant),
        );
      }
    }

    refreshInProgress = true;

    const tenant = britiveSettings.tenant;
    attemptedTenant = tenant;
    attemptedRefreshToken = britiveSettings.refreshToken;
    attemptedAuthGeneration =
      attemptedAuthGeneration || britiveSettings.authGeneration || null;
    const clientId =
      britiveSettings.clientId || (await computeClientId(tenant));
    const baseUrl = getTenantBaseUrl(tenant);
    const tokenUrl = `${baseUrl}/api/auth/sso/oauth2/token`;
    const extVersion = browser.runtime.getManifest().version;

    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: britiveSettings.refreshToken,
      client_id: clientId,
    });

    const response = await fetch(tokenUrl, {
      method: "POST",
      credentials: "omit",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Britive-Extension": extVersion,
      },
      body: body.toString(),
    });

    if (!response.ok) {
      if (
        await shouldIgnoreRefreshFailure(
          tenant,
          attemptedRefreshToken,
          attemptedAuthGeneration,
        )
      ) {
        return false;
      }
      await britiveAPI.clearToken();
      browser.notifications.create("britive-session-expired", {
        type: "basic",
        iconUrl: browser.runtime.getURL("icons/britive-icon-96.png"),
        title: "Britive Session Expired",
        message: "Your session has expired. Please log in again.",
      });
      return false;
    }

    const data = await response.json();
    const newAccessToken = data.access_token || data.accessToken;
    // Server returns same refresh token, but store whatever comes back
    const newRefreshToken =
      data.refresh_token || data.refreshToken || britiveSettings.refreshToken;

    if (!newAccessToken) {
      if (
        await shouldIgnoreRefreshFailure(
          tenant,
          attemptedRefreshToken,
          attemptedAuthGeneration,
        )
      ) {
        return false;
      }
      await britiveAPI.clearToken();
      return false;
    }

    // Extract new expiration
    let expirationTime;
    try {
      const payload = JSON.parse(atob(newAccessToken.split(".")[1]));
      expirationTime = payload.exp * 1000;
    } catch (_) {
      expirationTime = Date.now() + 60 * 60 * 1000;
    }

    // Update stored tokens
    await browser.storage.local.set({
      britiveSettings: {
        ...britiveSettings,
        bearerToken: newAccessToken,
        refreshToken: newRefreshToken,
        expirationTime,
        clientId,
        authGeneration:
          attemptedAuthGeneration ||
          britiveSettings.authGeneration ||
          generateAuthGeneration(),
      },
    });
    await refreshInterceptPatterns();

    // Update in-memory API client
    britiveAPI.bearerToken = newAccessToken;

    // Refresh the WS auth cookie if socket is connected
    if (
      notificationSocket &&
      notificationSocket.readyState === WebSocket.OPEN
    ) {
      try {
        const wsCookieUrl = getWsCookieUrlForTenant(tenant);
        await browser.cookies.set({
          url: wsCookieUrl,
          name: "auth",
          value: newAccessToken,
          path: "/api/websocket/",
          secure: true,
          httpOnly: true,
          sameSite: "no_restriction",
        });
      } catch (_) {}
    }

    // Schedule the next refresh
    scheduleTokenRefresh(
      expirationTime,
      attemptedAuthGeneration || britiveSettings.authGeneration || null,
      "timer",
    );
    return true;
  } catch (error) {
    await reportError("refreshAccessToken", error, {
      tenant: attemptedTenant,
      source,
      authGeneration: attemptedAuthGeneration,
    });
    try {
      if (
        await shouldIgnoreRefreshFailure(
          attemptedTenant,
          attemptedRefreshToken,
          attemptedAuthGeneration,
        )
      ) {
        return false;
      }
    } catch (_) {}
    tokenRefreshTimerId = setTimeout(
      () => refreshAccessToken(attemptedAuthGeneration, "retry"),
      60000,
    );
    return false;
  } finally {
    refreshInProgress = false;
  }
}

// Check current authentication status
async function checkAuthenticationStatus() {
  try {
    const storage = await browser.storage.local.get([
      "britiveSettings",
      "britiveAuth",
    ]);

    // Check if login is in progress. If the auth flow was abandoned or the tenant
    // failed to redirect back, don't leave the popup stuck forever.
    if (storage.britiveAuth && storage.britiveAuth.loginInProgress) {
      const startedAt = storage.britiveAuth.startTime || 0;
      const stale = !startedAt || Date.now() - startedAt > 10 * 60 * 1000;
      if (stale) {
        await clearTransientAuthState();
      } else {
        return {
          authenticated: false,
          loginInProgress: true,
          message: "Login in progress. Please complete authentication.",
        };
      }
    }

    // Check if we have a valid token
    if (storage.britiveSettings && storage.britiveSettings.bearerToken) {
      const expirationTime = storage.britiveSettings.expirationTime || 0;
      const now = Date.now();

      if (
        now < expirationTime &&
        isValidTenant(storage.britiveSettings.tenant)
      ) {
        // Token is valid
        britiveAPI.baseUrl = getTenantBaseUrl(storage.britiveSettings.tenant);
        britiveAPI.bearerToken = storage.britiveSettings.bearerToken;

        return {
          authenticated: true,
          tenant: storage.britiveSettings.tenant,
        };
      } else if (
        storage.britiveSettings.refreshToken &&
        isValidTenant(storage.britiveSettings.tenant)
      ) {
        // Access token expired but we have a refresh token - try to refresh
        britiveAPI.baseUrl = getTenantBaseUrl(storage.britiveSettings.tenant);
        const refreshed = await refreshAccessToken(
          storage.britiveSettings.authGeneration || null,
          "status_check",
        );
        if (refreshed) {
          return {
            authenticated: true,
            tenant: storage.britiveSettings.tenant,
          };
        }
        // Refresh failed, fall through to expired state
        return {
          authenticated: false,
          message: "Session expired. Please log in again.",
        };
      } else {
        // Token expired, no refresh token
        await browser.storage.local.set({
          britiveSettings: {
            ...storage.britiveSettings,
            bearerToken: null,
            refreshToken: null,
            clientId: null,
            authenticated: false,
          },
        });
        await refreshInterceptPatterns();

        return {
          authenticated: false,
          message: "Session expired. Please log in again.",
        };
      }
    }

    return {
      authenticated: false,
      message: "Not authenticated. Please log in.",
    };
  } catch (error) {
    await reportError("checkAuthenticationStatus", error);
    return {
      authenticated: false,
      error: normalizeError(error),
    };
  }
}

// Fetch Britive secrets list (metadata only, no values)
async function fetchBritiveSecrets() {
  try {
    const settings = await browser.storage.local.get(["britiveSettings"]);
    if (!settings.britiveSettings || !settings.britiveSettings.tenant) {
      return { error: "Tenant not configured" };
    }

    const vaultId = await britiveAPI.getVaultId();

    const params = new URLSearchParams({
      recursiveSecrets: "true",
      getmetadata: "true",
      path: "/",
      type: "secret",
    });

    const response = await britiveAPI.makeRequest(
      `/api/v1/secretmanager/vault/${vaultId}/secrets?${params.toString()}`,
    );

    // API returns { result: [...], pagination: {...} }
    if (Array.isArray(response)) return response;
    if (response.result && Array.isArray(response.result))
      return response.result;
    if (response.data && Array.isArray(response.data)) return response.data;

    return [];
  } catch (error) {
    return { error: normalizeError(error) };
  }
}

// Fetch a specific secret's decrypted value
async function fetchSecretValue(path) {
  try {
    const settings = await browser.storage.local.get(["britiveSettings"]);
    if (!settings.britiveSettings || !settings.britiveSettings.tenant) {
      return { error: "Tenant not configured" };
    }

    const vaultId = await britiveAPI.getVaultId();
    const params = new URLSearchParams({ path });

    const response = await britiveAPI.makeRequest(
      `/api/v1/secretmanager/vault/${vaultId}/accesssecrets?${params.toString()}`,
      { method: "POST", body: JSON.stringify({}) },
    );

    // The API returns the full secret object.  The decrypted payload lives
    // inside response.value which can be:
    //   - a plain string  (for Generic Note / single-field secrets)
    //   - an object like  { "Note": "the secret text" }
    //   - an object like  { "Username": "...", "Password": "...", "URL": "..." }
    // We normalise it into a flat key/value map for the popup to render.

    if (response == null) {
      return { error: "No value returned from API" };
    }

    const raw = response.value !== undefined ? response.value : response;

    if (typeof raw === "string") {
      return { fields: { Value: raw } };
    }

    if (typeof raw === "object" && raw !== null) {
      // Flatten one level – turn each key into a displayable field
      const fields = {};
      for (const [k, v] of Object.entries(raw)) {
        fields[k] = typeof v === "object" ? stableStringify(v) : String(v);
      }
      return { fields };
    }

    return { fields: { Value: String(raw) } };
  } catch (error) {
    return { error: normalizeError(error) };
  }
}

// ── Access / Collections ──

// Validate and encode a single URL path segment to prevent path-traversal attacks.
// Rejects values containing /, \, ?, #, & or the .. sequence.
function safePath(segment) {
  if (
    typeof segment !== "string" ||
    !segment ||
    /[\/\\?#&]|\.\./.test(segment)
  ) {
    throw new Error("Invalid path parameter");
  }
  return encodeURIComponent(segment);
}

async function fetchCollections(userId) {
  try {
    const settings = await browser.storage.local.get(["britiveSettings"]);
    if (!settings.britiveSettings || !settings.britiveSettings.tenant) {
      return { error: "Tenant not configured" };
    }

    const response = await britiveAPI.makeRequest(
      `/api/access/${safePath(userId)}/filters`,
    );
    if (Array.isArray(response)) return response;
    if (response.result && Array.isArray(response.result))
      return response.result;
    if (response.data && Array.isArray(response.data)) return response.data;

    return [];
  } catch (error) {
    return { error: normalizeError(error) };
  }
}

// Access cache
let accessCache = null;
let accessCacheTime = 0;
const ACCESS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function fetchAccess(collectionId, forceRefresh, favorites) {
  try {
    // Determine cache key: use 'favorites' when no collection specified
    const cacheKey = favorites ? "__favorites__" : collectionId;

    // Return cached data if available and not expired
    if (
      !forceRefresh &&
      accessCache &&
      accessCache.collectionId === cacheKey &&
      Date.now() - accessCacheTime < ACCESS_CACHE_TTL
    ) {
      return accessCache.data;
    }

    const settings = await browser.storage.local.get(["britiveSettings"]);
    if (!settings.britiveSettings || !settings.britiveSettings.tenant) {
      return { error: "Tenant not configured" };
    }

    // Build the filter parameter: favorites vs collection-based
    const filterParam = favorites
      ? "filter=favorites"
      : `filter=${encodeURIComponent(`collectionId eq "${collectionId}"`)}`;
    const pageSize = 100;
    let page = 0;
    let allItems = [];
    let totalCount = 0;

    // Paginate until we have all results
    do {
      const response = await britiveAPI.makeRequest(
        `/api/access?page=${page}&size=${pageSize}&${filterParam}`,
      );

      if (response.error) return response;

      if (page === 0) {
        totalCount = response.count || 0;
      }

      const pageItems = response.data || [];
      allItems = allItems.concat(pageItems);

      // If we got fewer than pageSize, we've reached the end
      if (pageItems.length < pageSize) break;
      page++;
    } while (allItems.length < totalCount);

    const result = { items: allItems, count: totalCount };

    // Cache the result
    accessCache = { collectionId: cacheKey, data: result };
    accessCacheTime = Date.now();

    return result;
  } catch (error) {
    return { error: normalizeError(error) };
  }
}

async function searchAccess(searchText) {
  try {
    const q = (searchText || "").trim();
    if (q.length < 3) {
      return { items: [], count: 0 };
    }
    const response = await britiveAPI.makeRequest(
      `/api/access?page=0&size=20&searchText=${encodeURIComponent(q)}`,
    );
    return { items: response.data || [], count: response.count || 0 };
  } catch (error) {
    return { error: normalizeError(error) };
  }
}

async function addToFavorites(
  appContainerId,
  environmentId,
  papId,
  accessType,
) {
  try {
    await britiveAPI.makeRequest("/api/access/favorites", {
      method: "POST",
      body: JSON.stringify({
        appContainerId,
        environmentId,
        papId,
        accessType: accessType || "CONSOLE",
      }),
    });
    // Invalidate access cache so favorites list refreshes
    accessCache = null;
    return { success: true };
  } catch (error) {
    return { error: normalizeError(error) };
  }
}

async function removeFromFavorites(papId) {
  try {
    await britiveAPI.makeRequest(`/api/access/favorites/${safePath(papId)}`, {
      method: "DELETE",
    });
    accessCache = null;
    return { success: true };
  } catch (error) {
    return { error: normalizeError(error) };
  }
}

function parseExpirationMs(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value;
  }
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
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

function extractCheckedOutExpiration(co) {
  const candidates = [
    co && co.expiration,
    co && co.expirationTime,
    co && co.expiresAt,
    co && co.expiry,
    co && co.expiryTime,
    co && co.validUntil,
    co && co.validTill,
    co && co.checkoutExpiration,
    co && co.checkedOutUntil,
  ];
  for (const candidate of candidates) {
    const ms = parseExpirationMs(candidate);
    if (ms && ms > Date.now()) return ms;
  }
  if (co && typeof co === "object") {
    for (const [key, value] of Object.entries(co)) {
      if (
        !/(expir|expire|expires|valid.*until|checkedout.*until|checkout.*until)/i.test(
          key,
        )
      )
        continue;
      const ms = parseExpirationMs(value);
      if (ms && ms > Date.now()) return ms;
    }
  }
  return null;
}

async function upsertCheckoutExpirationsFromCheckedOut(checkedOutList) {
  if (!Array.isArray(checkedOutList) || checkedOutList.length === 0) return;
  const { checkoutExpirations = {} } = await browser.storage.local.get(
    "checkoutExpirations",
  );
  let changed = false;
  checkedOutList.forEach((co) => {
    if (!isActiveConsoleCheckout(co)) return;
    const expiration = extractCheckedOutExpiration(co);
    if (!expiration) return;
    const key = `${co.papId}|${co.environmentId}|CONSOLE`;
    if (!checkoutExpirations[key] || expiration > checkoutExpirations[key]) {
      checkoutExpirations[key] = expiration;
      changed = true;
    }
  });
  if (changed) {
    await browser.storage.local.set({ checkoutExpirations });
  }
}

async function fetchCheckedOutProfiles() {
  try {
    await britiveAPI.initialize();
    if (!britiveAPI.baseUrl || !britiveAPI.bearerToken) {
      const { cachedCheckedOutProfiles = [] } = await browser.storage.local.get(
        "cachedCheckedOutProfiles",
      );
      await upsertCheckoutExpirationsFromCheckedOut(cachedCheckedOutProfiles);
      return {
        checkedOut: Array.isArray(cachedCheckedOutProfiles)
          ? cachedCheckedOutProfiles
          : [],
      };
    }
    const response = await britiveAPI.makeRequest(
      "/api/access/app-access-status",
    );
    await browser.storage.local.set({
      cachedCheckedOutProfiles: response || [],
    });
    await upsertCheckoutExpirationsFromCheckedOut(response || []);
    return { checkedOut: response || [] };
  } catch (error) {
    await reportError("fetchCheckedOutProfiles", error);
    try {
      const { cachedCheckedOutProfiles = [] } = await browser.storage.local.get(
        "cachedCheckedOutProfiles",
      );
      if (
        Array.isArray(cachedCheckedOutProfiles) &&
        cachedCheckedOutProfiles.length
      ) {
        await upsertCheckoutExpirationsFromCheckedOut(cachedCheckedOutProfiles);
        return { checkedOut: cachedCheckedOutProfiles };
      }
    } catch (_) {
      // Ignore cache fallback errors
    }
    return { error: normalizeError(error) };
  }
}

async function fetchAccessUrl(transactionId) {
  try {
    const response = await britiveAPI.makeRequest(
      `/api/access/${safePath(transactionId)}/url`,
    );
    // API may return JSON { url: "..." } or a plain URL string
    const url = typeof response === "string" ? response : response.url || null;
    // Only return URLs with safe schemes to prevent open-redirect via API response
    if (url && !/^https?:\/\//i.test(url)) {
      return { error: "Invalid URL scheme returned by API" };
    }
    return { url };
  } catch (error) {
    return { error: normalizeError(error) };
  }
}

async function fetchProfileSettings(papId, environmentId) {
  try {
    const response = await britiveAPI.makeRequest(
      `/api/access/${safePath(papId)}/environments/${safePath(environmentId)}/settings`,
    );
    return { success: true, settings: response };
  } catch (error) {
    return { error: normalizeError(error) };
  }
}

async function searchTickets(papId, environmentId, ticketType, query) {
  try {
    const endpoint =
      `/api/access/${safePath(papId)}/environments/${safePath(environmentId)}/itsm/${safePath(ticketType)}/search` +
      (query ? `?searchText=${encodeURIComponent(query)}` : "");
    const response = await britiveAPI.makeRequest(endpoint);
    return { success: true, tickets: response.tickets || [] };
  } catch (error) {
    return { error: normalizeError(error), tickets: [] };
  }
}

async function fetchApprovers(papId) {
  try {
    const response = await britiveAPI.makeRequest(
      "/api/v1/policy-admin/policies/approvers",
      {
        method: "POST",
        body: JSON.stringify({
          consumer: "papservice",
          resource: `${papId}/*`,
          action: "papservice.profile.access",
        }),
      },
    );
    return { success: true, approvers: response };
  } catch (error) {
    return { error: normalizeError(error) };
  }
}

async function submitApprovalRequest(
  papId,
  environmentId,
  justification,
  ticketId,
  ticketType,
) {
  try {
    const body = {};
    if (justification) body.justification = justification;
    if (ticketId) body.ticketId = ticketId;
    if (ticketType) body.ticketType = ticketType;

    const response = await britiveAPI.makeRequest(
      `/api/access/${safePath(papId)}/environments/${safePath(environmentId)}/approvalRequest`,
      { method: "POST", body: JSON.stringify(body) },
    );
    // Invalidate cache after approval request
    accessCache = null;
    return { success: true, data: response };
  } catch (error) {
    return { error: normalizeError(error) };
  }
}

async function withdrawApprovalRequest(papId, environmentId) {
  try {
    await britiveAPI.makeRequest(
      `/api/v1/approvals/consumer/papservice/resource?resourceId=${encodeURIComponent(papId)}/${encodeURIComponent(environmentId)}`,
      { method: "DELETE" },
    );
    // Invalidate cache after withdrawal
    accessCache = null;
    return { success: true };
  } catch (error) {
    return { error: normalizeError(error) };
  }
}

async function fetchApprovalStatus(requestId) {
  if (!requestId) {
    return { error: "No request ID provided" };
  }
  try {
    const response = await britiveAPI.makeRequest(
      `/api/v1/approvals/${safePath(requestId)}`,
    );
    return { success: true, approval: response };
  } catch (error) {
    return { error: normalizeError(error) };
  }
}

async function checkoutAccess(
  papId,
  environmentId,
  justification,
  otp,
  ticketId,
  ticketType,
) {
  try {
    // Step-up auth (OTP) must be validated before the checkout POST
    if (otp) {
      try {
        await britiveAPI.makeRequest("/api/step-up/authenticate/TOTP", {
          method: "POST",
          body: JSON.stringify({ otp }),
        });
      } catch (authErr) {
        return {
          error: "Step-up authentication failed. Check your OTP and try again.",
        };
      }
    }

    const body = {};
    if (justification) body.justification = justification;
    if (ticketType) body.ticketType = ticketType;
    if (ticketId) body.ticketId = ticketId;

    const response = await britiveAPI.makeRequest(
      `/api/access/${safePath(papId)}/environments/${safePath(environmentId)}?accessType=CONSOLE`,
      { method: "POST", body: JSON.stringify(body) },
    );
    // Invalidate cache after checkout
    accessCache = null;
    return { success: true, data: response };
  } catch (error) {
    const errMsg = normalizeError(error, "Checkout failed");

    // Detect step-up auth required (403 PE-0028)
    if (
      errMsg.includes("PE-0028") ||
      errMsg.toLowerCase().includes("step up authentication required")
    ) {
      // Check if user has TOTP registered
      const mfaRegs = await fetchMfaRegistrations(false);
      if (hasTotpRegistered(mfaRegs)) {
        return { error: errMsg, stepUpRequired: true };
      } else {
        // Re-fetch MFA registrations in case they changed
        const freshRegs = await fetchMfaRegistrations(true);
        if (hasTotpRegistered(freshRegs)) {
          return { error: errMsg, stepUpRequired: true };
        }
        return {
          error:
            "Step-up authentication required but no TOTP device is registered. Please configure TOTP in your Britive profile.",
        };
      }
    }

    return { error: errMsg };
  }
}

async function checkinAccess(transactionId) {
  try {
    const response = await britiveAPI.makeRequest(
      `/api/access/${safePath(transactionId)}?type=API`,
      { method: "PUT" },
    );
    // Invalidate cache after checkin
    accessCache = null;
    return { success: true, data: response };
  } catch (error) {
    return { error: normalizeError(error) };
  }
}

// ── User profile ──

async function fetchUserProfile(forceRefresh) {
  try {
    // Return cached profile unless force refresh requested
    if (!forceRefresh) {
      const cached = await browser.storage.local.get("cachedUserProfile");
      if (cached.cachedUserProfile) {
        return { profile: cached.cachedUserProfile };
      }
    }

    const settings = await browser.storage.local.get(["britiveSettings"]);
    if (!settings.britiveSettings || !settings.britiveSettings.tenant) {
      return { error: "Tenant not configured" };
    }

    const profile = await britiveAPI.makeRequest("/api/access/users");
    await browser.storage.local.set({ cachedUserProfile: profile });
    return { profile };
  } catch (error) {
    return { error: normalizeError(error) };
  }
}

// ── MFA registrations cache ──

async function fetchMfaRegistrations(forceRefresh) {
  try {
    if (!forceRefresh) {
      const cached = await browser.storage.local.get("cachedMfaRegistrations");
      if (cached.cachedMfaRegistrations) {
        return cached.cachedMfaRegistrations;
      }
    }
    const response = await britiveAPI.makeRequest(
      "/api/mfa/registrations?onlyAllowed=true",
    );
    const data = Array.isArray(response) ? response : [];
    await browser.storage.local.set({ cachedMfaRegistrations: data });
    return data;
  } catch (error) {
    await reportError("fetchMfaRegistrations", error);
    return [];
  }
}

function hasTotpRegistered(mfaRegistrations) {
  return (
    Array.isArray(mfaRegistrations) &&
    mfaRegistrations.some(
      (r) => r.factor === "TOTP" && r.status === "REGISTERED",
    )
  );
}

// ── Approvals ──

async function fetchApprovals() {
  try {
    const settings = await browser.storage.local.get(["britiveSettings"]);
    if (!settings.britiveSettings || !settings.britiveSettings.tenant) {
      return { error: "Tenant not configured" };
    }

    const response = await britiveAPI.makeRequest(
      "/api/v1/approvals/?requestType=myApprovals&filter=status eq PENDING&createdWithinDays=1",
    );

    if (Array.isArray(response)) return response;
    if (response.result && Array.isArray(response.result))
      return response.result;
    if (response.data && Array.isArray(response.data)) return response.data;

    return [];
  } catch (error) {
    return { error: normalizeError(error) };
  }
}

async function handleApprovalAction(requestId, approve, comments = "") {
  try {
    const param = approve ? "yes" : "no";
    await britiveAPI.makeRequest(
      `/api/v1/approvals/${safePath(requestId)}?approveRequest=${param}`,
      {
        method: "PATCH",
        body: JSON.stringify({ approverComment: comments }),
      },
    );
    return { success: true };
  } catch (error) {
    return { error: normalizeError(error) };
  }
}

// ── Token expiration notification ──

let expirationTimerId = null;

function scheduleExpirationNotification(expirationTime) {
  // Clear any existing timer
  if (expirationTimerId) {
    clearTimeout(expirationTimerId);
    expirationTimerId = null;
  }

  const delay = expirationTime - Date.now();
  if (delay <= 0) return; // already expired

  expirationTimerId = setTimeout(async () => {
    expirationTimerId = null;
    browser.notifications.create("britive-session-expired", {
      type: "basic",
      iconUrl: browser.runtime.getURL("icons/britive-icon-96.png"),
      title: "Britive Session Expired",
      message: "Your Britive session has expired. Please log in again.",
    });
  }, delay);
}

// ── Checkout expiration notifications ──

const checkoutExpirationTimers = new Map(); // transactionId -> { warningId, expiryId }

async function scheduleCheckoutExpirationNotification(
  key,
  profileName,
  envName,
  expiresAt,
) {
  // Check if notifications are enabled
  const { extensionSettings } =
    await browser.storage.local.get("extensionSettings");
  if (!(extensionSettings?.checkoutExpiryNotification ?? true)) return;

  clearCheckoutExpirationNotification(key);

  const now = Date.now();
  const timers = {};

  // Parse papId and environmentId from the key (format: "papId|environmentId")
  const [expiryPapId, expiryEnvId] = key.split("|");

  // Warning notification: 5 minutes before expiry
  const warningDelay = expiresAt - now - 5 * 60 * 1000;
  if (warningDelay > 0) {
    timers.warningId = setTimeout(async () => {
      const scopedTarget = await resolveScopedAccessTarget(
        expiryPapId,
        expiryEnvId,
      );
      if (!scopedTarget.inScope) return;

      const warnMsg = `${profileName} in ${envName} expires in 5 minutes.`;
      browser.notifications.create(`britive-checkout-warn-${key}`, {
        type: "basic",
        iconUrl: browser.runtime.getURL("icons/britive-icon-96.png"),
        title: "Checkout Expiring Soon",
        message: warnMsg,
      });
      // Send to popup if open (stopwatch icon)
      browser.runtime
        .sendMessage({
          action: "wsCheckoutExpiring",
          papId: expiryPapId,
          environmentId: expiryEnvId,
          message: warnMsg,
        })
        .catch(() => {});
      // Queue for drain on next popup open
      queueWsNotification({
        type: "checkoutExpiring",
        status: "expiringSoon",
        papId: expiryPapId,
        environmentId: expiryEnvId,
        message: warnMsg,
        title: "Checkout Expiring Soon",
        tone: "warning",
        icon: "\u23F1",
        timestamp: Date.now(),
      });
    }, warningDelay);
  }

  // Expiry notification
  const expiryDelay = expiresAt - now;
  if (expiryDelay > 0) {
    timers.expiryId = setTimeout(async () => {
      const scopedTarget = await resolveScopedAccessTarget(
        expiryPapId,
        expiryEnvId,
      );
      if (!scopedTarget.inScope) return;

      browser.notifications.create(`britive-checkout-expired-${key}`, {
        type: "basic",
        iconUrl: browser.runtime.getURL("icons/britive-icon-96.png"),
        title: "Checkout Expired",
        message: `${profileName} in ${envName} has expired.`,
      });
      checkoutExpirationTimers.delete(key);
    }, expiryDelay);
  }

  if (timers.warningId || timers.expiryId) {
    checkoutExpirationTimers.set(key, timers);
  }
}

function clearCheckoutExpirationNotification(key) {
  const timers = checkoutExpirationTimers.get(key);
  if (timers) {
    if (timers.warningId) clearTimeout(timers.warningId);
    if (timers.expiryId) clearTimeout(timers.expiryId);
    checkoutExpirationTimers.delete(key);
  }
}

function clearAllCheckoutExpirationNotifications() {
  for (const [key, timers] of checkoutExpirationTimers) {
    if (timers.warningId) clearTimeout(timers.warningId);
    if (timers.expiryId) clearTimeout(timers.expiryId);
  }
  checkoutExpirationTimers.clear();
}

// ── Banner polling (auth heartbeat + tenant notifications) ──

let bannerTimerId = null;
let approvalsTimerId = null;

let lastBannerMessage = null;
let pendingApprovalCount = 0;
let cachedApprovalsList = null; // In-memory cache of last fetched approvals

const BANNER_BADGE_COLORS = {
  INFO: "#3E5DE0",
  WARNING: "#ffcb00",
  CAUTION: "#dc3545",
};

function getApprovalTargetLabel(item) {
  if (!item) return "your access request";
  const parts = [item.appName, item.profileName, item.environmentName].filter(
    Boolean,
  );
  return parts.length ? parts.join(" / ") : "your access request";
}

function getAccessScopeKey(item) {
  const raw = item?.raw || item || {};
  const papId = raw.papId || raw.profile?.papId;
  const environmentId = raw.environmentId || raw.environment?.environmentId;
  return papId && environmentId ? `${papId}|${environmentId}` : null;
}

async function getCurrentAccessScope() {
  const itemsByKey = new Map();
  let accessCache_data;
  try {
    ({ accessCache_data } =
      await browser.storage.local.get("accessCache_data"));
  } catch (e) {
    return itemsByKey;
  }
  if (!Array.isArray(accessCache_data)) return itemsByKey;

  accessCache_data.forEach((item) => {
    const key = getAccessScopeKey(item);
    if (key && !itemsByKey.has(key)) itemsByKey.set(key, item);
  });
  return itemsByKey;
}

async function resolveScopedAccessTarget(papId, environmentId) {
  if (!papId || !environmentId) return { inScope: false };
  const itemsByKey = await getCurrentAccessScope();
  const item = itemsByKey.get(`${papId}|${environmentId}`);
  if (!item) return { inScope: false };
  return {
    inScope: true,
    item,
    target: getApprovalTargetLabel(item),
  };
}

async function handleApprovalStatusChanged(status, item, autoCheckout) {
  const normalizedStatus = String(status || "").toLowerCase();

  // Skip if WS already delivered this notification (dedup)
  const dedupKey = `${item?.papId || ""}|${item?.environmentId || ""}|${normalizedStatus}`;
  if (recentWsNotificationKeys.has(dedupKey)) {
    return { success: true, deduplicated: true };
  }

  const target = getApprovalTargetLabel(item);
  let title = "Britive Approval Update";
  let message = `${target} changed status.`;

  if (normalizedStatus === "approved") {
    title = autoCheckout
      ? "Britive Access Approved"
      : "Britive Approval Granted";
    message = autoCheckout
      ? `${target} was approved. Starting checkout.`
      : `${target} was approved.`;
  } else if (normalizedStatus === "rejected") {
    title = "Britive Approval Rejected";
    message = `${target} was rejected.`;
  } else if (
    normalizedStatus === "withdrawn" ||
    normalizedStatus === "cancelled"
  ) {
    title = "Britive Approval Closed";
    message = `${target} is no longer pending.`;
  } else if (normalizedStatus === "revoked") {
    title = "Britive Access Revoked";
    message = `${target} has been revoked.`;
  } else if (normalizedStatus === "expired") {
    title = "Britive Approval Expired";
    message = `${target} expired before it was approved.`;
  }

  const notificationId = `britive-approval-${normalizedStatus}-${Date.now()}`;
  browser.notifications
    .create(notificationId, {
      type: "basic",
      iconUrl: browser.runtime.getURL("icons/britive-icon-96.png"),
      title,
      message,
    })
    .catch(() => {});

  browser.runtime
    .sendMessage({
      action: "approvalStatusNotification",
      status: normalizedStatus,
      title,
      message,
      autoCheckout: !!autoCheckout,
      item,
    })
    .catch(() => {});

  return { success: true };
}

async function pollBanner() {
  try {
    if (!britiveAPI.baseUrl || !britiveAPI.bearerToken) return;

    const banner = await britiveAPI.makeRequest("/api/banner");

    // Store the banner so the popup can display it if needed
    await browser.storage.local.set({ britiveBanner: banner || null });

    // Track banner state and update unified badge
    lastBannerMessage = banner && banner.message ? banner.message : null;
    updateExtensionBadge();
  } catch (error) {
    // makeRequest already clears token on 401/403, so if we land here
    // with no bearerToken the session is dead - notify the user
    if (!britiveAPI.bearerToken) {
      stopBannerPolling();
      stopApprovalsPolling();
      updateExtensionBadge();
      browser.notifications.create("britive-session-expired", {
        type: "basic",
        iconUrl: browser.runtime.getURL("icons/britive-icon-96.png"),
        title: "Britive Session Expired",
        message: "Your Britive session has expired. Please log in again.",
      });
    }
  }
}

async function startBannerPolling() {
  stopBannerPolling();
  const { extensionSettings } =
    await browser.storage.local.get("extensionSettings");
  if ((extensionSettings?.bannerCheck ?? true) === false) return;
  const intervalMs = (extensionSettings?.bannerPollInterval || 60) * 1000;
  // Fire immediately, then at configured interval
  pollBanner();
  bannerTimerId = setInterval(pollBanner, intervalMs);
}

function stopBannerPolling() {
  if (bannerTimerId) {
    clearInterval(bannerTimerId);
    bannerTimerId = null;
  }
}

// ── Approval + checked-out-profiles polling ──

async function pollApprovals() {
  try {
    if (!britiveAPI.baseUrl || !britiveAPI.bearerToken) return;

    const approvals = await fetchApprovals();

    if (Array.isArray(approvals)) {
      cachedApprovalsList = approvals;
      pendingApprovalCount = approvals.length;
    } else {
      cachedApprovalsList = [];
      pendingApprovalCount = 0;
    }

    updateExtensionBadge();
  } catch (error) {
    // Silently ignore - fetchApprovals already logs errors
  }
}

async function pollCheckedOutProfiles() {
  try {
    if (!britiveAPI.baseUrl || !britiveAPI.bearerToken) return;
    const response = await britiveAPI.makeRequest(
      "/api/access/app-access-status",
    );
    await browser.storage.local.set({
      cachedCheckedOutProfiles: response || [],
    });

    // Reconcile checkout expiration cache - remove entries for profiles no longer checked out
    try {
      const { checkoutExpirations } = await browser.storage.local.get(
        "checkoutExpirations",
      );
      if (checkoutExpirations && Object.keys(checkoutExpirations).length > 0) {
        const activeKeys = new Set();
        (response || []).forEach((co) => {
          if (isActiveConsoleCheckout(co)) {
            activeKeys.add(`${co.papId}|${co.environmentId}|CONSOLE`);
          }
        });
        let changed = false;
        for (const key of Object.keys(checkoutExpirations)) {
          if (!activeKeys.has(key)) {
            delete checkoutExpirations[key];
            changed = true;
          }
        }
        if (changed) {
          await browser.storage.local.set({ checkoutExpirations });
        }
      }
    } catch (e) {
      // Expiration cache reconciliation is best-effort
    }
  } catch (error) {
    // Silently ignore
  }
}

async function startApprovalsPolling() {
  // Preserve cache when restarting (e.g. after WS disconnect) so badge
  // does not flicker to 0 while the first REST poll is in flight.
  stopApprovalsPolling(true);
  const intervalMs = APPROVALS_FALLBACK_INTERVAL_SEC * 1000;
  // Fire immediately, then at configured interval
  pollApprovals();
  pollCheckedOutProfiles();
  approvalsTimerId = setInterval(() => {
    pollApprovals();
    pollCheckedOutProfiles();
  }, intervalMs);
}

function stopApprovalsPolling(preserveCache) {
  if (approvalsTimerId) {
    clearInterval(approvalsTimerId);
    approvalsTimerId = null;
  }
  if (!preserveCache) {
    pendingApprovalCount = 0;
    cachedApprovalsList = null;
  }
}

// ── WebSocket notification queue ──
// Stores WS notifications so the popup can show them as toasts when it opens.
// In-memory with storage.local persistence for Firefox MV2.
const WS_NOTIFICATION_QUEUE_CAP = 10;
let wsNotificationQueue = [];

// Restore queue from storage on startup
browser.storage.local
  .get("wsNotificationQueue")
  .then(({ wsNotificationQueue: q }) => {
    if (Array.isArray(q))
      wsNotificationQueue = q.slice(-WS_NOTIFICATION_QUEUE_CAP);
  });

function queueWsNotification(entry) {
  wsNotificationQueue.push(entry);
  if (wsNotificationQueue.length > WS_NOTIFICATION_QUEUE_CAP) {
    wsNotificationQueue = wsNotificationQueue.slice(-WS_NOTIFICATION_QUEUE_CAP);
  }
  browser.storage.local.set({ wsNotificationQueue }).catch(() => {});
  updateExtensionBadge();
}

function drainWsNotificationQueue() {
  const items = wsNotificationQueue.splice(0);
  browser.storage.local.set({ wsNotificationQueue: [] }).catch(() => {});
  updateExtensionBadge();
  return items;
}

// ── WebSocket push notifications ──
// Connects to Britive's Socket.IO v2 endpoint for real-time status events.
// While the WS is active, approval/checkout REST polling is paused.
// On disconnect, REST polling resumes as a fallback.

let notificationSocket = null;
let wsPingTimer = null;
let wsPingTimeoutTimer = null;
let wsReconnectTimer = null;
let wsReconnectDelay = 1000;
const recentWsEventKeys = new Set();
const recentWsNotificationKeys = new Set(); // dedup: tracks WS-delivered events to suppress REST duplicates

// Events that are transient / informational only (log, do not relay)
const WS_TRANSIENT_EVENTS = new Set([
  "checkOutSubmitted",
  "checkOutInProgress",
  "checkInSubmitted",
  "checkInInProgress",
  "Pending",
]);

// Approval terminal event names from the backend
const WS_APPROVAL_EVENTS = new Set([
  "requestApproved",
  "requestRejected",
  "requestRevoked",
  "requestCancelled",
  "requestExpired",
]);

// Checkout lifecycle events we act on
const WS_CHECKOUT_EVENTS = new Set([
  "checkedOut",
  "checkedIn",
  "checkedInExpired",
  "checkOutFailed",
  "checkOutTimeOut",
  "checkInFailed",
  "checkInTimeOut",
]);

// Checkout events that warrant an error notification
const WS_CHECKOUT_ERROR_EVENTS = new Set([
  "checkOutFailed",
  "checkOutTimeOut",
  "checkInFailed",
  "checkInTimeOut",
]);

async function connectNotificationSocket() {
  if (!britiveAPI.baseUrl || !britiveAPI.bearerToken) return;
  if (
    notificationSocket &&
    (notificationSocket.readyState === WebSocket.OPEN ||
      notificationSocket.readyState === WebSocket.CONNECTING)
  )
    return;

  const tenant = getTenantHostFromBaseUrl(britiveAPI.baseUrl);

  // Set the auth cookie scoped to /api/websocket/ so the WS upgrade carries it.
  // The backend authenticates Socket.IO via the 'auth' cookie (JWT value).
  try {
    await browser.cookies.set({
      url: getWsCookieUrlForBaseUrl(britiveAPI.baseUrl),
      name: "auth",
      value: britiveAPI.bearerToken,
      path: "/api/websocket/",
      secure: true,
      httpOnly: true,
      sameSite: "no_restriction",
    });
  } catch (e) {}

  const wsUrl = `wss://${tenant}/api/websocket/push/notifications/?EIO=3&transport=websocket`;

  try {
    notificationSocket = new WebSocket(wsUrl);
  } catch (e) {
    scheduleWsReconnect();
    return;
  }

  notificationSocket.onopen = () => {
    wsReconnectDelay = 1000;
  };

  notificationSocket.onmessage = (event) => {
    const raw = event.data;
    if (typeof raw !== "string" || raw.length === 0) return;

    // Engine.IO v3 framing
    const code = raw.charAt(0);

    if (code === "0") {
      // Handshake: extract pingInterval and pingTimeout
      try {
        const handshake = JSON.parse(raw.substring(1));
        const interval = handshake.pingInterval || 25000;
        const timeout = handshake.pingTimeout || 5000;
        if (wsPingTimer) clearInterval(wsPingTimer);
        if (wsPingTimeoutTimer) clearTimeout(wsPingTimeoutTimer);
        wsPingTimer = setInterval(() => {
          if (
            notificationSocket &&
            notificationSocket.readyState === WebSocket.OPEN
          ) {
            notificationSocket.send("2");
            // Start timeout: if no pong arrives, close as zombie
            if (wsPingTimeoutTimer) clearTimeout(wsPingTimeoutTimer);
            wsPingTimeoutTimer = setTimeout(() => {
              if (notificationSocket) {
                try {
                  notificationSocket.close();
                } catch (e) {
                  /* ignore */
                }
              }
            }, timeout);
          }
        }, interval);
        // Send Socket.IO namespace connect request
        if (
          notificationSocket &&
          notificationSocket.readyState === WebSocket.OPEN
        ) {
          notificationSocket.send("40");
        }
      } catch (e) {}
      return;
    }

    if (code === "1") {
      // Engine.IO close request from server
      if (notificationSocket) {
        try {
          notificationSocket.close();
        } catch (e) {
          /* ignore */
        }
      }
      return;
    }

    if (raw === "3") {
      // Pong ack from server - clear ping timeout
      if (wsPingTimeoutTimer) {
        clearTimeout(wsPingTimeoutTimer);
        wsPingTimeoutTimer = null;
      }
      return;
    }

    if (raw === "40") {
      // Socket.IO namespace connect ack - WS is fully operational
      stopApprovalsPolling(true);
      return;
    }

    if (raw === "41") {
      // Socket.IO namespace disconnect from server
      if (notificationSocket) {
        try {
          notificationSocket.close();
        } catch (e) {
          /* ignore */
        }
      }
      return;
    }

    if (raw.startsWith("44")) {
      // Socket.IO namespace error (e.g. auth failure)
      if (notificationSocket) {
        try {
          notificationSocket.close();
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
          handleSocketEvent(payload[0], payload[1]);
        }
      } catch (e) {}
      return;
    }
  };

  notificationSocket.onclose = (event) => {
    cleanupSocketTimers();
    notificationSocket = null;
    if (britiveAPI.bearerToken) {
      startApprovalsPolling();
      scheduleWsReconnect();
    }
  };

  notificationSocket.onerror = (event) => {
    // onclose fires after onerror, so reconnect logic is there
  };
}

function disconnectNotificationSocket() {
  if (wsReconnectTimer) {
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = null;
  }
  wsReconnectDelay = 1000;
  cleanupSocketTimers();
  if (notificationSocket) {
    try {
      notificationSocket.close();
    } catch (e) {
      /* ignore */
    }
    notificationSocket = null;
  }
  // Clean up the scoped auth cookie
  browser.cookies
    .remove({
      url: britiveAPI.baseUrl || "https://placeholder.britive-app.com",
      name: "auth",
    })
    .catch(() => {});
}

function cleanupSocketTimers() {
  if (wsPingTimer) {
    clearInterval(wsPingTimer);
    wsPingTimer = null;
  }
  if (wsPingTimeoutTimer) {
    clearTimeout(wsPingTimeoutTimer);
    wsPingTimeoutTimer = null;
  }
}

function scheduleWsReconnect() {
  if (wsReconnectTimer) return;
  if (!britiveAPI.bearerToken) return;
  wsReconnectTimer = setTimeout(() => {
    wsReconnectTimer = null;
    connectNotificationSocket();
  }, wsReconnectDelay);
  wsReconnectDelay = Math.min(wsReconnectDelay * 2, 30000);
}

function handleSocketEvent(eventName, payload) {
  // Ignore resource-profile events (different payload shape, not relevant)
  if (payload && payload.consumer === "resourceprofile") return;

  const wsEventKey = `${eventName}|${stableStringify(payload)}`;
  if (recentWsEventKeys.has(wsEventKey)) {
    return;
  }
  recentWsEventKeys.add(wsEventKey);
  setTimeout(() => recentWsEventKeys.delete(wsEventKey), 30000);

  if (WS_TRANSIENT_EVENTS.has(eventName)) return;

  if (WS_APPROVAL_EVENTS.has(eventName)) {
    handleWsApprovalEvent(eventName, payload);
    return;
  }

  if (WS_CHECKOUT_EVENTS.has(eventName)) {
    handleWsCheckoutEvent(eventName, payload);
    return;
  }

  // addNotifications / allNotifications: check for approval-related notifications
  if (eventName === "addNotifications" || eventName === "allNotifications") {
    const items = Array.isArray(payload) ? payload : [];
    const hasApprovalNotif = items.some(
      (n) =>
        n.messageType === "profile-approval" ||
        n.messageType === "profile-approval-status" ||
        n.messageType === "profile-approval-status-approver" ||
        n.messageType === "profile-approval-cancelled",
    );
    if (hasApprovalNotif) pollApprovals();
    return;
  }
}

async function handleWsApprovalEvent(eventName, payload) {
  // Normalize: "requestApproved" -> "approved", "requestRejected" -> "rejected", etc.
  const status = eventName.replace(/^request/i, "").toLowerCase();
  const papId = payload.papId || "";
  const environmentId = payload.environmentId || "";

  const scopedTarget = await resolveScopedAccessTarget(papId, environmentId);
  if (!scopedTarget.inScope) return;

  // Track this event to suppress duplicate REST polling notification
  const dedupKey = `${papId}|${environmentId}|${status}`;
  recentWsNotificationKeys.add(dedupKey);
  setTimeout(() => recentWsNotificationKeys.delete(dedupKey), 30000);

  const target = scopedTarget.target;

  let title = "Britive Approval Update";
  let message = `${target} changed status.`;

  if (status === "approved") {
    title = "Britive Approval Granted";
    message = `${target} was approved.`;
  } else if (status === "rejected") {
    title = "Britive Approval Rejected";
    message = `${target} was rejected.`;
  } else if (status === "revoked") {
    title = "Britive Access Revoked";
    message = `${target} has been revoked.`;
  } else if (status === "cancelled") {
    title = "Britive Approval Closed";
    message = `${target} is no longer pending.`;
  } else if (status === "expired") {
    title = "Britive Approval Expired";
    message = `${target} expired before it was approved.`;
  }

  const notificationId = `britive-ws-approval-${status}-${Date.now()}`;
  browser.notifications
    .create(notificationId, {
      type: "basic",
      iconUrl: browser.runtime.getURL("icons/britive-icon-96.png"),
      title,
      message,
    })
    .catch(() => {});

  const approvalMsg = {
    action: "wsApprovalUpdate",
    status,
    papId,
    environmentId,
    killSession: !!payload.killSession,
    statusText: payload.statusText || status,
    message,
  };
  // Try to deliver to popup; only queue if popup is closed
  browser.runtime.sendMessage(approvalMsg).catch(() => {
    queueWsNotification({
      type: "approval",
      status,
      papId,
      environmentId,
      message,
      title,
      tone:
        status === "approved"
          ? "success"
          : status === "rejected"
            ? "error"
            : status === "expired" ||
                status === "revoked" ||
                status === "cancelled"
              ? "warning"
              : "info",
      timestamp: Date.now(),
    });
  });
}

async function handleWsCheckoutEvent(eventName, payload) {
  const status = payload.status || eventName;
  const statusText = payload.statusText || eventName;
  const papId = payload.papId || "";
  const environmentId = payload.environmentId || "";

  const scopedTarget = await resolveScopedAccessTarget(papId, environmentId);
  if (!scopedTarget.inScope) return;

  // Browser notification for errors and expiration
  if (WS_CHECKOUT_ERROR_EVENTS.has(eventName)) {
    const notificationId = `britive-ws-checkout-err-${Date.now()}`;
    browser.notifications
      .create(notificationId, {
        type: "basic",
        iconUrl: browser.runtime.getURL("icons/britive-icon-96.png"),
        title: statusText,
        message: payload.errorMessage || `${statusText} for your access.`,
      })
      .catch(() => {});
  } else if (eventName === "checkedInExpired") {
    const notificationId = `britive-ws-checkout-expired-${Date.now()}`;
    browser.notifications
      .create(notificationId, {
        type: "basic",
        iconUrl: browser.runtime.getURL("icons/britive-icon-96.png"),
        title: "Checkout Expired",
        message: "Your checked-out access has expired.",
      })
      .catch(() => {});
  }

  const checkoutMsg = {
    action: "wsCheckoutUpdate",
    status,
    statusText,
    papId,
    environmentId,
  };
  // Try to deliver to popup; only queue if popup is closed
  const isError = WS_CHECKOUT_ERROR_EVENTS.has(eventName);
  const isExpired = eventName === "checkedInExpired";
  const shouldQueue =
    isError ||
    isExpired ||
    eventName === "checkedOut" ||
    eventName === "checkedIn";
  browser.runtime.sendMessage(checkoutMsg).catch(() => {
    if (shouldQueue) {
      queueWsNotification({
        type: "checkout",
        status: eventName,
        papId,
        environmentId,
        message: isError
          ? payload.errorMessage || `${statusText} for your access.`
          : isExpired
            ? "Your checked-out access has expired."
            : eventName === "checkedOut"
              ? "Access checked out successfully."
              : "Access checked in successfully.",
        title: isError
          ? statusText
          : isExpired
            ? "Checkout Expired"
            : eventName === "checkedOut"
              ? "Checked Out"
              : "Checked In",
        tone: isError ? "error" : isExpired ? "warning" : "success",
        timestamp: Date.now(),
      });
    }
  });
}

// ── Unified extension badge ──
// Approval count takes priority (number); falls back to banner "!"

async function updateExtensionBadge() {
  const { extensionSettings } =
    await browser.storage.local.get("extensionSettings");
  const isCrt = extensionSettings && extensionSettings.theme === "crt";
  const crtBadgeColor = "#0a0a0a";

  if (pendingApprovalCount > 0) {
    const text =
      pendingApprovalCount > 99 ? "99+" : String(pendingApprovalCount);
    browser.browserAction.setBadgeText({ text });
    browser.browserAction.setBadgeBackgroundColor({
      color: isCrt ? crtBadgeColor : "#CA1ECC",
    });
    browser.browserAction.setBadgeTextColor({
      color: isCrt ? "#aaffcc" : "#ffffff",
    });
  } else if (wsNotificationQueue.length > 0) {
    // Unread WS notifications waiting for popup drain
    const text =
      wsNotificationQueue.length > 99
        ? "99+"
        : String(wsNotificationQueue.length);
    browser.browserAction.setBadgeText({ text });
    browser.browserAction.setBadgeBackgroundColor({
      color: isCrt ? crtBadgeColor : "#CA1ECC",
    });
    browser.browserAction.setBadgeTextColor({
      color: isCrt ? "#aaffcc" : "#ffffff",
    });
  } else if (lastBannerMessage) {
    const { britiveBanner, bannerDismissed } = await browser.storage.local.get([
      "britiveBanner",
      "bannerDismissed",
    ]);
    const key = britiveBanner
      ? (britiveBanner.messageType || "INFO") + ":" + britiveBanner.message
      : null;
    if (bannerDismissed && key === bannerDismissed) {
      // User dismissed this banner - hide badge
      browser.browserAction.setBadgeText({ text: "" });
      return;
    }
    const color = BANNER_BADGE_COLORS[britiveBanner?.messageType] || "#3E5DE0";
    browser.browserAction.setBadgeText({ text: "!" });
    browser.browserAction.setBadgeBackgroundColor({
      color: isCrt ? crtBadgeColor : color,
    });
    browser.browserAction.setBadgeTextColor({
      color: isCrt ? "#aaffcc" : "#ffffff",
    });
  } else {
    browser.browserAction.setBadgeText({ text: "" });
  }
}

// On startup, restore state and start polling if authenticated
(async () => {
  const { britiveSettings } =
    await browser.storage.local.get("britiveSettings");
  if (!britiveSettings || !isValidTenant(britiveSettings.tenant)) return;

  const now = Date.now();
  const tokenValid =
    britiveSettings.bearerToken &&
    britiveSettings.expirationTime &&
    now < britiveSettings.expirationTime;

  if (tokenValid) {
    // Access token still valid
    britiveAPI.baseUrl = getTenantBaseUrl(britiveSettings.tenant);
    britiveAPI.bearerToken = britiveSettings.bearerToken;
    // Schedule refresh if we have a refresh token, otherwise schedule expiration
    if (britiveSettings.refreshToken) {
      scheduleTokenRefresh(
        britiveSettings.expirationTime,
        britiveSettings.authGeneration || null,
        "timer",
      );
    } else {
      scheduleExpirationNotification(britiveSettings.expirationTime);
    }
    startBannerPolling();
    startApprovalsPolling();
    connectNotificationSocket();
    fetchSecretTemplates().catch(() => {});
  } else if (britiveSettings.refreshToken) {
    // Access token expired but refresh token may still be valid
    britiveAPI.baseUrl = getTenantBaseUrl(britiveSettings.tenant);
    const refreshed = await refreshAccessToken(
      britiveSettings.authGeneration || null,
      "startup",
    );
    if (refreshed) {
      startBannerPolling();
      startApprovalsPolling();
      connectNotificationSocket();
      fetchSecretTemplates().catch(() => {});
    }
  }
})();

// ── Watch for tenant changes ──

browser.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "local") return;

  // React to settings changes
  if (changes.extensionSettings && britiveAPI.bearerToken) {
    const oldVal = changes.extensionSettings.oldValue || {};
    const newVal = changes.extensionSettings.newValue || {};

    // Banner check toggle
    const oldBanner = oldVal.bannerCheck ?? true;
    const newBanner = newVal.bannerCheck ?? true;
    if (newBanner && !oldBanner) {
      startBannerPolling();
    } else if (!newBanner && oldBanner) {
      stopBannerPolling();
      lastBannerMessage = null;
      await browser.storage.local.remove("britiveBanner");
      updateExtensionBadge();
    }

    // Restart polling if intervals changed
    const oldBannerInt = oldVal.bannerPollInterval || 60;
    const newBannerInt = newVal.bannerPollInterval || 60;
    if (oldBannerInt !== newBannerInt && bannerTimerId) {
      startBannerPolling();
    }

    refreshInterceptPatterns().catch(() => {});
  }

  // Banner dismissed by user in popup - refresh badge
  if (changes.bannerDismissed) {
    updateExtensionBadge();
  }

  if (!changes.britiveSettings) return;

  const oldTenant = changes.britiveSettings.oldValue?.tenant;
  const newTenant = changes.britiveSettings.newValue?.tenant;
  const authenticated = changes.britiveSettings.newValue?.authenticated;

  refreshInterceptPatterns().catch(() => {});

  if (newTenant && newTenant !== oldTenant) {
    // Tenant changed - clear ALL cached data
    await clearSecretsCache();
    await browser.storage.local.remove([
      "secretTemplates",
      "secretUrlMap",
      "cachedUserProfile",
      "cachedMfaRegistrations",
      "cachedCheckedOutProfiles",
      "accessCache_data",
      "accessCache_collectionId",
      "accessCache_collectionName",
      "accessCollapsedState",
      "pendingApprovals",
      "britiveBanner",
      "checkoutExpirations",
    ]);
    accessCache = null;
    accessCacheTime = 0;
    britiveAPI.vaultId = null;
    britiveAPI.bearerToken = null;

    if (expirationTimerId) {
      clearTimeout(expirationTimerId);
      expirationTimerId = null;
    }
    stopBannerPolling();
    stopApprovalsPolling();
    disconnectNotificationSocket();
    updateExtensionBadge();

    if (!authenticated) {
      browser.notifications.create("britive-tenant-changed", {
        type: "basic",
        iconUrl: browser.runtime.getURL("icons/britive-icon-96.png"),
        title: "Britive Tenant Changed",
        message: `Tenant set to ${newTenant}. Please log in to authenticate.`,
      });
    }
  }
});

// ── Keyboard shortcut command handler ──

browser.commands.onCommand.addListener(async (command) => {
  if (
    command === "open-access-search" ||
    command === "open-approvals-tab" ||
    command === "open-secrets-search"
  ) {
    try {
      const target =
        command === "open-approvals-tab"
          ? "approvals-tab"
          : command === "open-secrets-search"
            ? "secrets-search"
            : "access-search";
      await browser.storage.local.set({
        popupFocusIntent: {
          target,
          ts: Date.now(),
        },
      });
      if (browser.browserAction && browser.browserAction.openPopup) {
        await browser.browserAction.openPopup();
      }
    } catch (e) {
      // If popup cannot be opened programmatically, intent remains for next manual open
    }
    return;
  }
});

// Restore CRT icon on startup if theme is set
browser.storage.local.get("extensionSettings").then(({ extensionSettings }) => {
  if (extensionSettings && extensionSettings.theme === "crt") {
    browser.browserAction.setIcon({
      path: {
        48: "icons/britive-icon-crt-48.png",
        96: "icons/britive-icon-crt-96.png",
        128: "icons/britive-icon-crt-128.png",
      },
    });
  }
});
