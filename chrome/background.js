// Background service worker for Britive Chrome extension (Manifest V3)
// Uses OAuth 2.0 Authorization Code with PKCE for authentication

// ---- Crypto / PKCE utilities ----

function generateRandomBytes(length) {
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  return array;
}

function base64UrlEncode(bytes) {
  const base64 = btoa(String.fromCharCode(...bytes));
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

// Generate a PKCE code_verifier (43-128 unreserved chars, RFC 7636)
function generateCodeVerifier() {
  return base64UrlEncode(generateRandomBytes(64));
}

// SHA-256 hash -> base64url (for PKCE code_challenge with S256 method)
async function generateCodeChallenge(verifier) {
  const data = new TextEncoder().encode(verifier);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return base64UrlEncode(new Uint8Array(hash));
}

// SHA-256 hash -> hex string (for client_id derivation)
async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Generate a random state parameter for CSRF protection
function generateState() {
  return base64UrlEncode(generateRandomBytes(32));
}

// Compute the OAuth client_id for a tenant
// client_id = sha256hex("browser-extension-<tenantRoot>")
// tenantRoot = first segment before any dots (e.g. "smdev" from "smdev.dev")
async function computeClientId(tenant) {
  const tenantRoot = tenant.split('.')[0];
  return await sha256Hex('browser-extension-' + tenantRoot);
}

// Tenant name validation - allows subdomains (dots) and hyphens
function isValidTenant(t) {
  return typeof t === 'string' && t.length > 0 && /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(t);
}

function getTenantBaseUrl(tenant) {
  if (!isValidTenant(tenant)) throw new Error('Invalid tenant name');
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
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((acc, key) => {
      acc[key] = sortKeysDeep(value[key]);
      return acc;
    }, {});
  }
  return value;
}

function normalizeError(error, fallback = 'Unexpected error') {
  if (typeof error === 'string' && error.trim()) return error.trim();
  if (error && typeof error.message === 'string' && error.message.trim()) return error.message.trim();
  return fallback;
}

const APPROVALS_FALLBACK_INTERVAL_SEC = 60;

async function reportError(scope, error, meta = null) {
  try {
    const { recentInternalErrors = [] } = await chrome.storage.local.get('recentInternalErrors');
    recentInternalErrors.push({
      scope,
      message: normalizeError(error),
      meta,
      timestamp: Date.now()
    });
    await chrome.storage.local.set({ recentInternalErrors: recentInternalErrors.slice(-25) });
  } catch (_) {}
}

// ── Britive API Client ──
// In a service worker, the instance may be recreated on each wake.
// We rehydrate from storage on first use via initialize().

class BritiveAPI {
  constructor() {
    this.baseUrl = null;
    this.bearerToken = null;
    this.vaultId = null;
  }

  async initialize() {
    const settings = await chrome.storage.local.get(['britiveSettings']);
    if (settings.britiveSettings) {
      if (isValidTenant(settings.britiveSettings.tenant)) {
        this.baseUrl = getTenantBaseUrl(settings.britiveSettings.tenant);
      }
      if (settings.britiveSettings.bearerToken) {
        this.bearerToken = settings.britiveSettings.bearerToken;
      }
    }
  }

  async ensureInitialized() {
    if (!this.baseUrl || !this.bearerToken) {
      await this.initialize();
    }
  }

  async makeRequest(endpoint, options = {}) {
    await this.ensureInitialized();

    if (!this.baseUrl) {
      throw new Error('Britive tenant not configured');
    }

    if (!this.bearerToken) {
      throw new Error('Not authenticated. Please log in to Britive.');
    }

    const url = `${this.baseUrl}${endpoint}`;
    const extVersion = chrome.runtime.getManifest().version;

    const response = await fetch(url, {
      ...options,
      headers: {
        'Authorization': `Bearer ${this.bearerToken}`,
        'Content-Type': 'application/json',
        'X-Britive-Extension': extVersion,
        ...options.headers
      }
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
          if (errorJson.errorCode === 'PE-0028') {
            // Step-up auth required - user IS authenticated, don't clear token
            throw new Error(`API Error: ${response.status} - ${errorText}`);
          }
        } catch (e) {
          if (e.message.startsWith('API Error:')) throw e;
        }
        // Permission denied - don't clear the session, just surface the error
        throw new Error(`API Error: ${response.status} - ${errorText}`);
      }

      if (response.status === 401) {
        await this.clearToken();
        throw new Error('Not authenticated. Please log in to Britive again.');
      }

      throw new Error(`API Error: ${response.status} - ${errorText}`);
    }

    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      return response.json();
    }

    return response.text();
  }

  async clearToken() {
    // Don't clear if token was just set (< 15s ago) - prevents post-login 403 race
    const settings = await chrome.storage.local.get(['britiveSettings']);
    if (settings.britiveSettings?.loginTimestamp &&
      (Date.now() - settings.britiveSettings.loginTimestamp) < 15000) {
      return;
    }
    this.bearerToken = null;
    this.vaultId = null;
    // Cancel any pending token refresh alarm
    chrome.alarms.clear('britive-token-refresh');
    if (settings.britiveSettings) {
      settings.britiveSettings.bearerToken = null;
      settings.britiveSettings.refreshToken = null;
      settings.britiveSettings.clientId = null;
      settings.britiveSettings.authenticated = false;
      settings.britiveSettings.loginTimestamp = null;
      await chrome.storage.local.set({ britiveSettings: settings.britiveSettings });
    }
    await clearSecretsCache();
    await chrome.storage.local.remove([
      'secretTemplates', 'secretUrlMap',
      'cachedUserProfile', 'cachedMfaRegistrations', 'cachedCheckedOutProfiles',
      'accessCache_data', 'accessCache_collectionId', 'accessCache_collectionName',
      'accessCollapsedState', 'pendingApprovals', 'bannerDismissed',
      'checkoutExpirations'
    ]);
    chrome.storage.session.set({ wsNotificationQueue: [] }).catch(() => {});
    clearAllCheckoutExpirationNotifications();
    await disconnectNotificationSocket();
    // Clear extension badge
    chrome.action.setBadgeText({ text: '' });
    // Notify popup if open so it can return to the login screen
    chrome.runtime.sendMessage({ action: 'sessionExpired' }).catch(() => {});
  }

  async getVaultId() {
    if (this.vaultId) return this.vaultId;

    try {
      const vault = await this.makeRequest('/api/v1/secretmanager/vault');
      this.vaultId = vault.id;
      return this.vaultId;
    } catch (error) {
      await reportError('getVaultId', error);
      throw new Error('No secrets vault found or access denied');
    }
  }
}

const britiveAPI = new BritiveAPI();

// Append extension identifier to User-Agent on all requests to britive-app.com
const extVersion = chrome.runtime.getManifest().version;
chrome.declarativeNetRequest.updateDynamicRules({
  removeRuleIds: [1],
  addRules: [{
    id: 1,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [{
        header: 'User-Agent',
        operation: 'append',
        value: ` browser-extension-${extVersion}`
      }]
    },
    condition: {
      urlFilter: '*.britive-app.com/*',
      resourceTypes: ['xmlhttprequest', 'other']
    }
  }]
});

// ── Secrets cache ──

const CACHE_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

async function getCachedSecrets() {
  const { secretsCache } = await chrome.storage.local.get('secretsCache');
  if (!secretsCache) return null;
  const age = Date.now() - (secretsCache.timestamp || 0);
  if (age > CACHE_MAX_AGE_MS) return null;
  return secretsCache.secrets;
}

async function setCachedSecrets(secrets) {
  await chrome.storage.local.set({
    secretsCache: { secrets, timestamp: Date.now() }
  });
}

async function clearSecretsCache() {
  await chrome.storage.local.remove('secretsCache');
}

// ── Secret templates ──
// Fetches available secret types and classifies which ones are "web credential" types
// (have both URL and Password parameters)

async function fetchSecretTemplates() {
  try {
    const response = await britiveAPI.makeRequest('/api/v1/secretmanager/secret-templates/static');
    const templates = response.result || response || [];

    const webTypes = [];
    const allTypes = [];

    for (const tpl of templates) {
      const params = tpl.parameters || [];
      const paramNames = params.map(p => (p.name || '').toLowerCase());
      const hasURL = paramNames.includes('url');
      const hasPassword = paramNames.includes('password');
      const hasOTP = paramNames.includes('otp');

      allTypes.push({
        secretType: tpl.secretType,
        description: tpl.description || tpl.secretType,
        hasOTP,
        isWebType: hasURL && hasPassword
      });

      if (hasURL && hasPassword) {
        webTypes.push(tpl.secretType);
      }
    }

    const data = { webTypes, allTypes, timestamp: Date.now() };
    await chrome.storage.local.set({ secretTemplates: data });
    return data;
  } catch (error) {
    return { error: normalizeError(error) };
  }
}

async function getCachedSecretTemplates() {
  const { secretTemplates } = await chrome.storage.local.get('secretTemplates');
  if (!secretTemplates || !secretTemplates.timestamp) return null;
  const age = Date.now() - secretTemplates.timestamp;
  if (age > CACHE_MAX_AGE_MS) return null;
  return secretTemplates;
}

// ── Message handler ──
// Chrome MV3: cannot return a Promise from onMessage listener.
// Must use sendResponse callback + return true for async.

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(sendResponse);
  return true; // keep the message channel open for async response
});

async function handleMessage(message, sender) {
  // WebSocket offscreen relay events
  if (message.action === 'wsEventFromOffscreen') {
    handleSocketEvent(message.eventName, message.payload);
    return;
  }
  if (message.action === 'wsConnected') {
    wsConnecting = false;
    wsReconnectDelay = 1000;
    stopApprovalsPolling(true);
    return;
  }
  if (message.action === 'wsDisconnected') {
    wsConnecting = false;
    if (britiveAPI.bearerToken) {
      startApprovalsPolling();
      scheduleWsReconnect();
    }
    return;
  }

  if (message.action === 'getSecrets') {
    const forceRefresh = message.forceRefresh === true;

    if (!forceRefresh) {
      const cached = await getCachedSecrets();
      if (cached) {
        return { secrets: cached };
      }
    }

    const secrets = await fetchBritiveSecrets();
    if (!secrets.error) {
      await setCachedSecrets(secrets);
    }
    return { secrets };
  }

  if (message.action === 'refreshBanner') {
    await pollBanner();
    const { britiveBanner } = await chrome.storage.local.get('britiveBanner');
    return { banner: britiveBanner || null };
  }

  if (message.action === 'getCachedApprovals') {
    // Return cached approvals without API call
    const session = await chrome.storage.session.get('cachedApprovalsList');
    return { approvals: session.cachedApprovalsList || [] };
  }

  if (message.action === 'drainNotificationQueue') {
    return { notifications: await drainWsNotificationQueue() };
  }

  if (message.action === 'getApprovals') {
    const approvals = await fetchApprovals();
    if (Array.isArray(approvals)) {
      await chrome.storage.session.set({
        pendingApprovalCount: approvals.length,
        cachedApprovalsList: approvals
      });
      await refreshBadge();
    }
    return { approvals };
  }

  if (message.action === 'approveRequest') {
    const result = await handleApprovalAction(message.requestId, true, message.comments);
    if (result.success) {
      const session = await chrome.storage.session.get(['pendingApprovalCount', 'cachedApprovalsList']);
      const newCount = Math.max(0, (session.pendingApprovalCount || 0) - 1);
      const filtered = (session.cachedApprovalsList || []).filter(a => a.requestId !== message.requestId);
      await chrome.storage.session.set({ pendingApprovalCount: newCount, cachedApprovalsList: filtered });
      await refreshBadge();
    }
    return result;
  }

  if (message.action === 'rejectRequest') {
    const result = await handleApprovalAction(message.requestId, false, message.comments);
    if (result.success) {
      const session = await chrome.storage.session.get(['pendingApprovalCount', 'cachedApprovalsList']);
      const newCount = Math.max(0, (session.pendingApprovalCount || 0) - 1);
      const filtered = (session.cachedApprovalsList || []).filter(a => a.requestId !== message.requestId);
      await chrome.storage.session.set({ pendingApprovalCount: newCount, cachedApprovalsList: filtered });
      await refreshBadge();
    }
    return result;
  }

  if (message.action === 'getSecretValue') {
    return await fetchSecretValue(message.path);
  }

  if (message.action === 'startOAuthLogin') {
    return await startOAuthLogin(message.tenant);
  }

  if (message.action === 'logout') {
    const settings = await chrome.storage.local.get(['britiveSettings']);
    if (settings.britiveSettings?.loginTimestamp) {
      settings.britiveSettings.loginTimestamp = null;
      await chrome.storage.local.set({ britiveSettings: settings.britiveSettings });
    }
    await britiveAPI.clearToken();
    return { success: true };
  }

  if (message.action === 'approvalStatusChanged') {
    return await handleApprovalStatusChanged(message.status, message.item, message.autoCheckout);
  }

  if (message.action === 'checkAuthenticationStatus') {
    return await checkAuthenticationStatus();
  }

  if (message.action === 'getUserProfile') {
    return await fetchUserProfile();
  }

  if (message.action === 'getSecretTemplates') {
    const cached = await getCachedSecretTemplates();
    if (cached) return cached;
    return await fetchSecretTemplates();
  }

  if (message.action === 'refreshSecretTemplates') {
    return await fetchSecretTemplates();
  }

  if (message.action === 'getCollections') {
    const collections = await fetchCollections(message.userId);
    return { collections };
  }

  if (message.action === 'getAccess') {
    const access = await fetchAccess(message.collectionId, message.forceRefresh, message.favorites);
    return { access };
  }

  if (message.action === 'searchAccess') {
    return await searchAccess(message.searchText);
  }

  if (message.action === 'addToFavorites') {
    return await addToFavorites(message.appContainerId, message.environmentId, message.papId, message.accessType);
  }

  if (message.action === 'removeFromFavorites') {
    return await removeFromFavorites(message.papId);
  }

  if (message.action === 'getProfileSettings') {
    return await fetchProfileSettings(message.papId, message.environmentId);
  }

  if (message.action === 'searchTickets') {
    return await searchTickets(message.papId, message.environmentId, message.ticketType, message.query);
  }

  if (message.action === 'getApprovers') {
    return await fetchApprovers(message.papId);
  }

  if (message.action === 'submitApprovalRequest') {
    return await submitApprovalRequest(message.papId, message.environmentId, message.justification, message.ticketId, message.ticketType);
  }

  if (message.action === 'getApprovalStatus') {
    return await fetchApprovalStatus(message.requestId);
  }

  if (message.action === 'setExtensionIcon') {
    const iconPath = message.crt
      ? { 48: 'icons/britive-icon-crt-48.png', 96: 'icons/britive-icon-crt-96.png', 128: 'icons/britive-icon-crt-128.png' }
      : { 48: 'icons/britive-icon-48.png', 96: 'icons/britive-icon-96.png', 128: 'icons/britive-icon-128.png' };
    chrome.action.setIcon({ path: iconPath });
    return { success: true };
  }

  if (message.action === 'withdrawApprovalRequest') {
    return await withdrawApprovalRequest(message.papId, message.environmentId);
  }

  if (message.action === 'checkoutAccess') {
    return await checkoutAccess(message.papId, message.environmentId, message.justification, message.otp, message.ticketId, message.ticketType);
  }

  if (message.action === 'checkinAccess') {
    return await checkinAccess(message.transactionId);
  }

  if (message.action === 'getAccessUrl') {
    return await fetchAccessUrl(message.transactionId);
  }

  if (message.action === 'getCheckedOutProfiles') {
    return await fetchCheckedOutProfiles();
  }

  if (message.action === 'setCheckoutExpiration') {
    const { checkoutExpirations = {} } = await chrome.storage.local.get('checkoutExpirations');
    checkoutExpirations[message.key] = message.expiration;
    await chrome.storage.local.set({ checkoutExpirations });
    // Schedule expiration notification if profile/env names provided
    if (message.profileName && message.envName) {
      scheduleCheckoutExpirationNotification(message.key, message.profileName, message.envName, message.expiration);
    }
    return { success: true };
  }

  if (message.action === 'clearCheckoutExpiration') {
    const { checkoutExpirations = {} } = await chrome.storage.local.get('checkoutExpirations');
    delete checkoutExpirations[message.key];
    await chrome.storage.local.set({ checkoutExpirations });
    clearCheckoutExpirationNotification(message.key);
    return { success: true };
  }

  if (message.action === 'getCheckoutExpirations') {
    const { checkoutExpirations = {} } = await chrome.storage.local.get('checkoutExpirations');
    return { expirations: checkoutExpirations };
  }

  return {};
}

// ── Interactive login flow (from Python CLI) ──

function isSafeHttpUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch (e) {
    return false;
  }
}

async function openTabSafely(url) {
  if (!isSafeHttpUrl(url)) return null;
  return chrome.tabs.create({ url });
}

async function startOAuthLogin(tenant) {
  try {
    if (!isValidTenant(tenant)) {
      return { success: false, error: 'Invalid tenant name.' };
    }

    // Verify tenant exists before starting OAuth
    try {
      const healthResp = await fetch(`${getTenantBaseUrl(tenant)}/api/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(8000)
      });
      if (!healthResp.ok) {
        return { success: false, error: `Tenant "${tenant}" not found. Check the name and try again.` };
      }
    } catch (healthErr) {
      return { success: false, error: `Cannot reach tenant "${tenant}". Check the name and try again.` };
    }

    // Generate PKCE parameters
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = await generateCodeChallenge(codeVerifier);
    const state = generateState();
    const clientId = await computeClientId(tenant);

    // Get the browser-generated redirect URI for this extension
    const redirectUri = chrome.identity.getRedirectURL();

    // Build the authorization URL
    const baseUrl = getTenantBaseUrl(tenant);
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      state: state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256'
    });
    const authUrl = `${baseUrl}/api/auth/sso/oauth2/authorize?${params.toString()}`;

    // Store transient state for verification after redirect
    await chrome.storage.local.set({
      britiveAuth: {
        tenant,
        codeVerifier,
        state,
        clientId,
        redirectUri,
        loginInProgress: true,
        startTime: Date.now()
      }
    });

    // Launch the browser auth flow
    let responseUrl;
    try {
      responseUrl = await chrome.identity.launchWebAuthFlow({
        url: authUrl,
        interactive: true
      });
    } catch (authErr) {
      await chrome.storage.local.remove('britiveAuth');
      const errMsg = normalizeError(authErr);
      if (errMsg.includes('cancelled') || errMsg.includes('canceled') || errMsg.includes('closed') || errMsg.includes('user')) {
        return { success: false, error: 'Login cancelled.' };
      }
      return { success: false, error: `Authentication failed: ${errMsg}` };
    }

    // Parse the authorization code and state from the redirect URL
    const responseParams = new URL(responseUrl).searchParams;
    const returnedCode = responseParams.get('code');
    const returnedState = responseParams.get('state');
    const errorParam = responseParams.get('error');

    if (errorParam) {
      await chrome.storage.local.remove('britiveAuth');
      const errorDesc = responseParams.get('error_description') || errorParam;
      return { success: false, error: `Authorization denied: ${errorDesc}` };
    }

    if (!returnedCode) {
      await chrome.storage.local.remove('britiveAuth');
      return { success: false, error: 'No authorization code received.' };
    }

    // Verify state matches to prevent CSRF
    if (returnedState !== state) {
      await chrome.storage.local.remove('britiveAuth');
      return { success: false, error: 'State mismatch. Possible CSRF attack. Please try again.' };
    }

    // Exchange the authorization code for tokens
    const tokenResult = await exchangeCodeForTokens(tenant, returnedCode, codeVerifier, clientId, redirectUri);
    if (!tokenResult.success) {
      await chrome.storage.local.remove('britiveAuth');
      return tokenResult;
    }

    // Clear transient auth state
    await chrome.storage.local.remove('britiveAuth');

    // Notify popup if it's open
    chrome.runtime.sendMessage({
      action: 'authenticationComplete',
      success: true
    }).catch(() => {});

    return {
      success: true,
      message: 'Authentication successful.'
    };
  } catch (error) {
    await reportError('startOAuthLogin', error, { tenant });
    await chrome.storage.local.remove('britiveAuth');
    return {
      success: false,
      error: normalizeError(error)
    };
  }
}

// Exchange authorization code for access + refresh tokens
async function exchangeCodeForTokens(tenant, code, codeVerifier, clientId, redirectUri) {
  try {
    const baseUrl = getTenantBaseUrl(tenant);
    const tokenUrl = `${baseUrl}/api/auth/sso/oauth2/token`;
    const extVersion = chrome.runtime.getManifest().version;

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: code,
      code_verifier: codeVerifier,
      client_id: clientId,
      redirect_uri: redirectUri
    });

    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Britive-Extension': extVersion
      },
      body: body.toString()
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
      return { success: false, error: 'No access token in response.' };
    }

    // Extract expiration from JWT
    let expirationTime;
    try {
      const payload = JSON.parse(atob(accessToken.split('.')[1]));
      expirationTime = payload.exp * 1000;
    } catch (_) {
      expirationTime = Date.now() + (60 * 60 * 1000);
    }

    // Store tokens
    await chrome.storage.local.set({
      britiveSettings: {
        tenant,
        bearerToken: accessToken,
        refreshToken: refreshToken || null,
        clientId,
        expirationTime,
        authenticated: true,
        loginTimestamp: Date.now()
      }
    });

    // Update API client
    britiveAPI.baseUrl = getTenantBaseUrl(tenant);
    britiveAPI.bearerToken = accessToken;

    // Schedule token refresh (alarm-based for MV3 service worker survival)
    if (refreshToken) {
      scheduleTokenRefreshAlarm(expirationTime);
    } else {
      scheduleExpirationAlarm(expirationTime);
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
    await reportError('exchangeCodeForTokens', error, { tenant });
    return { success: false, error: normalizeError(error) };
  }
}

// ---- Token Refresh (alarm-based for MV3 service worker) ----

function scheduleTokenRefreshAlarm(expirationTime) {
  // Refresh 5 minutes before expiry
  const refreshAt = expirationTime - (5 * 60 * 1000);
  const now = Date.now();

  if (refreshAt <= now) {
    // Already past refresh time, refresh immediately
    refreshAccessToken();
    return;
  }

  // Chrome alarms require delayInMinutes >= ~0.08 (about 5 seconds)
  const delayMs = refreshAt - now;
  const delayMin = Math.max(delayMs / 60000, 0.08);
  chrome.alarms.create('britive-token-refresh', { delayInMinutes: delayMin });
}

async function refreshAccessToken() {
  try {
    const { britiveSettings } = await chrome.storage.local.get('britiveSettings');
    if (!britiveSettings || !britiveSettings.refreshToken || !britiveSettings.tenant) {
      return false;
    }

    const tenant = britiveSettings.tenant;
    const clientId = britiveSettings.clientId || await computeClientId(tenant);
    const baseUrl = getTenantBaseUrl(tenant);
    const tokenUrl = `${baseUrl}/api/auth/sso/oauth2/token`;
    const extVersion = chrome.runtime.getManifest().version;

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: britiveSettings.refreshToken,
      client_id: clientId
    });

    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Britive-Extension': extVersion
      },
      body: body.toString()
    });

    if (!response.ok) {
      await britiveAPI.clearToken();
      chrome.notifications.create('britive-session-expired', {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/britive-icon-96.png'),
        title: 'Britive Session Expired',
        message: 'Your session has expired. Please log in again.'
      });
      return false;
    }

    const data = await response.json();
    const newAccessToken = data.access_token || data.accessToken;
    const newRefreshToken = data.refresh_token || data.refreshToken || britiveSettings.refreshToken;

    if (!newAccessToken) {
      await britiveAPI.clearToken();
      return false;
    }

    let expirationTime;
    try {
      const payload = JSON.parse(atob(newAccessToken.split('.')[1]));
      expirationTime = payload.exp * 1000;
    } catch (_) {
      expirationTime = Date.now() + (60 * 60 * 1000);
    }

    await chrome.storage.local.set({
      britiveSettings: {
        ...britiveSettings,
        bearerToken: newAccessToken,
        refreshToken: newRefreshToken,
        expirationTime,
        clientId
      }
    });

    britiveAPI.bearerToken = newAccessToken;

    // Refresh the WS auth cookie if socket is connected
    try {
      const wsCookieUrl = getWsCookieUrlForTenant(tenant);
      await chrome.cookies.set({
        url: wsCookieUrl,
        name: 'auth',
        value: newAccessToken,
        path: '/api/websocket/',
        secure: true,
        httpOnly: true,
        sameSite: 'no_restriction'
      });
    } catch (_) {}

    // Schedule the next refresh
    scheduleTokenRefreshAlarm(expirationTime);
    return true;
  } catch (error) {
    await reportError('refreshAccessToken', error);
    // Retry in 60 seconds via alarm rather than giving up
    chrome.alarms.create('britive-token-refresh', { delayInMinutes: 1 });
    return false;
  }
}

// ── Check current authentication status ──

async function checkAuthenticationStatus() {
  try {
    const storage = await chrome.storage.local.get(['britiveSettings', 'britiveAuth']);

    if (storage.britiveAuth && storage.britiveAuth.loginInProgress) {
      return {
        authenticated: false,
        loginInProgress: true,
        message: 'Login in progress. Please complete authentication.'
      };
    }

    if (storage.britiveSettings && storage.britiveSettings.bearerToken) {
      const expirationTime = storage.britiveSettings.expirationTime || 0;
      const now = Date.now();

      if (now < expirationTime && isValidTenant(storage.britiveSettings.tenant)) {
        britiveAPI.baseUrl = getTenantBaseUrl(storage.britiveSettings.tenant);
        britiveAPI.bearerToken = storage.britiveSettings.bearerToken;

        return {
          authenticated: true,
          tenant: storage.britiveSettings.tenant
        };
      } else if (storage.britiveSettings.refreshToken && isValidTenant(storage.britiveSettings.tenant)) {
        // Access token expired but we have a refresh token - try to refresh
        britiveAPI.baseUrl = getTenantBaseUrl(storage.britiveSettings.tenant);
        const refreshed = await refreshAccessToken();
        if (refreshed) {
          return {
            authenticated: true,
            tenant: storage.britiveSettings.tenant
          };
        }
        return {
          authenticated: false,
          message: 'Session expired. Please log in again.'
        };
      } else {
        await chrome.storage.local.set({
          britiveSettings: {
            ...storage.britiveSettings,
            bearerToken: null,
            refreshToken: null,
            clientId: null,
            authenticated: false
          }
        });

        return {
          authenticated: false,
          message: 'Session expired. Please log in again.'
        };
      }
    }

    return {
      authenticated: false,
      message: 'Not authenticated. Please log in.'
    };
  } catch (error) {
    await reportError('checkAuthenticationStatus', error);
    return { authenticated: false, error: normalizeError(error) };
  }
}

// ── Fetch Britive secrets list (metadata only) ──

async function fetchBritiveSecrets() {
  try {
    const settings = await chrome.storage.local.get(['britiveSettings']);
    if (!settings.britiveSettings || !settings.britiveSettings.tenant) {
      return { error: 'Tenant not configured' };
    }

    const vaultId = await britiveAPI.getVaultId();

    const params = new URLSearchParams({
      recursiveSecrets: 'true',
      getmetadata: 'true',
      path: '/',
      type: 'secret'
    });

    const response = await britiveAPI.makeRequest(
      `/api/v1/secretmanager/vault/${vaultId}/secrets?${params.toString()}`
    );

    if (Array.isArray(response)) return response;
    if (response.result && Array.isArray(response.result)) return response.result;
    if (response.data && Array.isArray(response.data)) return response.data;

    return [];
  } catch (error) {
    return { error: normalizeError(error) };
  }
}

// ── Fetch a specific secret's decrypted value ──

async function fetchSecretValue(path) {
  try {
    const settings = await chrome.storage.local.get(['britiveSettings']);
    if (!settings.britiveSettings || !settings.britiveSettings.tenant) {
      return { error: 'Tenant not configured' };
    }

    const vaultId = await britiveAPI.getVaultId();
    const params = new URLSearchParams({ path });

    const response = await britiveAPI.makeRequest(
      `/api/v1/secretmanager/vault/${vaultId}/accesssecrets?${params.toString()}`,
      { method: 'POST', body: JSON.stringify({}) }
    );

    if (response == null) {
      return { error: 'No value returned from API' };
    }

    const raw = response.value !== undefined ? response.value : response;

    if (typeof raw === 'string') {
      return { fields: { 'Value': raw } };
    }

    if (typeof raw === 'object' && raw !== null) {
      const fields = {};
      for (const [k, v] of Object.entries(raw)) {
        fields[k] = typeof v === 'object' ? stableStringify(v) : String(v);
      }
      return { fields };
    }

    return { fields: { 'Value': String(raw) } };
  } catch (error) {
    return { error: normalizeError(error) };
  }
}

// ── Access / Collections ──

// Validate and encode a single URL path segment to prevent path-traversal attacks.
// Rejects values containing /, \, ?, #, & or the .. sequence.
function safePath(segment) {
  if (typeof segment !== 'string' || !segment || /[\/\\?#&]|\.\./.test(segment)) {
    throw new Error('Invalid path parameter');
  }
  return encodeURIComponent(segment);
}

async function fetchCollections(userId) {
  try {
    const settings = await chrome.storage.local.get(['britiveSettings']);
    if (!settings.britiveSettings || !settings.britiveSettings.tenant) {
      return { error: 'Tenant not configured' };
    }

    const response = await britiveAPI.makeRequest(`/api/access/${safePath(userId)}/filters`);
    if (Array.isArray(response)) return response;
    if (response.result && Array.isArray(response.result)) return response.result;
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
    const cacheKey = favorites ? '__favorites__' : collectionId;

    // Return cached data if available and not expired
    if (!forceRefresh && accessCache && accessCache.collectionId === cacheKey &&
      (Date.now() - accessCacheTime) < ACCESS_CACHE_TTL) {
      return accessCache.data;
    }

    const settings = await chrome.storage.local.get(['britiveSettings']);
    if (!settings.britiveSettings || !settings.britiveSettings.tenant) {
      return { error: 'Tenant not configured' };
    }

    // Build the filter parameter: favorites vs collection-based
    const filterParam = favorites
      ? 'filter=favorites'
      : `filter=${encodeURIComponent(`collectionId eq "${collectionId}"`)}`;
    const pageSize = 100;
    let page = 0;
    let allItems = [];
    let totalCount = 0;

    // Paginate until we have all results
    do {
      const response = await britiveAPI.makeRequest(
        `/api/access?page=${page}&size=${pageSize}&${filterParam}`
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
    const q = (searchText || '').trim();
    if (q.length < 3) {
      return { items: [], count: 0 };
    }
    const response = await britiveAPI.makeRequest(
      `/api/access?page=0&size=20&searchText=${encodeURIComponent(q)}`
    );
    return { items: response.data || [], count: response.count || 0 };
  } catch (error) {
    return { error: normalizeError(error) };
  }
}

async function addToFavorites(appContainerId, environmentId, papId, accessType) {
  try {
    await britiveAPI.makeRequest('/api/access/favorites', {
      method: 'POST',
      body: JSON.stringify({ appContainerId, environmentId, papId, accessType: accessType || 'CONSOLE' })
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
      method: 'DELETE'
    });
    accessCache = null;
    return { success: true };
  } catch (error) {
    return { error: normalizeError(error) };
  }
}

function parseExpirationMs(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value;
  }
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
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
    co && co.checkedOutUntil
  ];
  for (const candidate of candidates) {
    const ms = parseExpirationMs(candidate);
    if (ms && ms > Date.now()) return ms;
  }
  if (co && typeof co === 'object') {
    for (const [key, value] of Object.entries(co)) {
      if (!/(expir|expire|expires|valid.*until|checkedout.*until|checkout.*until)/i.test(key)) continue;
      const ms = parseExpirationMs(value);
      if (ms && ms > Date.now()) return ms;
    }
  }
  return null;
}

async function upsertCheckoutExpirationsFromCheckedOut(checkedOutList) {
  if (!Array.isArray(checkedOutList) || checkedOutList.length === 0) return;
  const { checkoutExpirations = {} } = await chrome.storage.local.get('checkoutExpirations');
  let changed = false;
  checkedOutList.forEach(co => {
    if (!(co && (co.checkedIn === null || co.checkedIn === undefined || co.checkedIn === false))) return;
    const expiration = extractCheckedOutExpiration(co);
    if (!expiration) return;
    const key = `${co.papId}|${co.environmentId}|CONSOLE`;
    if (!checkoutExpirations[key] || expiration > checkoutExpirations[key]) {
      checkoutExpirations[key] = expiration;
      changed = true;
    }
  });
  if (changed) {
    await chrome.storage.local.set({ checkoutExpirations });
  }
}

async function fetchCheckedOutProfiles() {
  try {
    await britiveAPI.ensureInitialized();
    if (!britiveAPI.baseUrl || !britiveAPI.bearerToken) {
      const { cachedCheckedOutProfiles = [] } = await chrome.storage.local.get('cachedCheckedOutProfiles');
      await upsertCheckoutExpirationsFromCheckedOut(cachedCheckedOutProfiles);
      return { checkedOut: Array.isArray(cachedCheckedOutProfiles) ? cachedCheckedOutProfiles : [] };
    }
    const response = await britiveAPI.makeRequest('/api/access/app-access-status');
    await chrome.storage.local.set({ cachedCheckedOutProfiles: response || [] });
    await upsertCheckoutExpirationsFromCheckedOut(response || []);
    return { checkedOut: response || [] };
  } catch (error) {
    await reportError('fetchCheckedOutProfiles', error);
    try {
      const { cachedCheckedOutProfiles = [] } = await chrome.storage.local.get('cachedCheckedOutProfiles');
      if (Array.isArray(cachedCheckedOutProfiles) && cachedCheckedOutProfiles.length) {
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
      `/api/access/${safePath(transactionId)}/url`
    );
    // API may return JSON { url: "..." } or a plain URL string
    const url = typeof response === 'string' ? response : (response.url || null);
    // Only return URLs with safe schemes to prevent open-redirect via API response
    if (url && !/^https?:\/\//i.test(url)) {
      return { error: 'Invalid URL scheme returned by API' };
    }
    return { url };
  } catch (error) {
    return { error: normalizeError(error) };
  }
}

async function fetchProfileSettings(papId, environmentId) {
  try {
    const response = await britiveAPI.makeRequest(
      `/api/access/${safePath(papId)}/environments/${safePath(environmentId)}/settings`
    );
    return { success: true, settings: response };
  } catch (error) {
    return { error: normalizeError(error) };
  }
}

async function searchTickets(papId, environmentId, ticketType, query) {
  try {
    const endpoint = `/api/access/${safePath(papId)}/environments/${safePath(environmentId)}/itsm/${safePath(ticketType)}/search` +
      (query ? `?searchText=${encodeURIComponent(query)}` : '');
    const response = await britiveAPI.makeRequest(endpoint);
    return { success: true, tickets: response.tickets || [] };
  } catch (error) {
    return { error: normalizeError(error), tickets: [] };
  }
}

async function fetchApprovers(papId) {
  try {
    const response = await britiveAPI.makeRequest(
      '/api/v1/policy-admin/policies/approvers',
      {
        method: 'POST',
        body: JSON.stringify({
          consumer: 'papservice',
          resource: `${papId}/*`,
          action: 'papservice.profile.access'
        })
      }
    );
    return { success: true, approvers: response };
  } catch (error) {
    return { error: normalizeError(error) };
  }
}

async function submitApprovalRequest(papId, environmentId, justification, ticketId, ticketType) {
  try {
    const body = {};
    if (justification) body.justification = justification;
    if (ticketId) body.ticketId = ticketId;
    if (ticketType) body.ticketType = ticketType;

    const response = await britiveAPI.makeRequest(
      `/api/access/${safePath(papId)}/environments/${safePath(environmentId)}/approvalRequest`,
      { method: 'POST', body: JSON.stringify(body) }
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
      { method: 'DELETE' }
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
    return { error: 'No request ID provided' };
  }
  try {
    const response = await britiveAPI.makeRequest(
      `/api/v1/approvals/${safePath(requestId)}`
    );
    return { success: true, approval: response };
  } catch (error) {
    return { error: normalizeError(error) };
  }
}

async function checkoutAccess(papId, environmentId, justification, otp, ticketId, ticketType) {
  try {
    // Step-up auth (OTP) must be validated before the checkout POST
    if (otp) {
      try {
        await britiveAPI.makeRequest(
          '/api/step-up/authenticate/TOTP',
          { method: 'POST', body: JSON.stringify({ otp }) }
        );
      } catch (authErr) {
        return { error: 'Step-up authentication failed. Check your OTP and try again.' };
      }
    }

    const body = {};
    if (justification) body.justification = justification;
    if (ticketType) body.ticketType = ticketType;
    if (ticketId) body.ticketId = ticketId;

    const response = await britiveAPI.makeRequest(
      `/api/access/${safePath(papId)}/environments/${safePath(environmentId)}?accessType=CONSOLE`,
      { method: 'POST', body: JSON.stringify(body) }
    );
    // Invalidate cache after checkout
    accessCache = null;
    return { success: true, data: response };
  } catch (error) {
    const errMsg = normalizeError(error, 'Checkout failed');

    // Detect step-up auth required (403 PE-0028)
    if (errMsg.includes('PE-0028') || errMsg.toLowerCase().includes('step up authentication required')) {
      const mfaRegs = await fetchMfaRegistrations(false);
      if (hasTotpRegistered(mfaRegs)) {
        return { error: errMsg, stepUpRequired: true };
      } else {
        const freshRegs = await fetchMfaRegistrations(true);
        if (hasTotpRegistered(freshRegs)) {
          return { error: errMsg, stepUpRequired: true };
        }
        return { error: 'Step-up authentication required but no TOTP device is registered. Please configure TOTP in your Britive profile.' };
      }
    }

    return { error: errMsg };
  }
}

async function checkinAccess(transactionId) {
  try {
    const response = await britiveAPI.makeRequest(
      `/api/access/${safePath(transactionId)}?type=API`,
      { method: 'PUT' }
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
    if (!forceRefresh) {
      const cached = await chrome.storage.local.get('cachedUserProfile');
      if (cached.cachedUserProfile) {
        return { profile: cached.cachedUserProfile };
      }
    }

    const settings = await chrome.storage.local.get(['britiveSettings']);
    if (!settings.britiveSettings || !settings.britiveSettings.tenant) {
      return { error: 'Tenant not configured' };
    }

    const profile = await britiveAPI.makeRequest('/api/access/users');
    await chrome.storage.local.set({ cachedUserProfile: profile });
    return { profile };
  } catch (error) {
    return { error: normalizeError(error) };
  }
}

// ── MFA registrations cache ──

async function fetchMfaRegistrations(forceRefresh) {
  try {
    if (!forceRefresh) {
      const cached = await chrome.storage.local.get('cachedMfaRegistrations');
      if (cached.cachedMfaRegistrations) {
        return cached.cachedMfaRegistrations;
      }
    }
    const response = await britiveAPI.makeRequest('/api/mfa/registrations?onlyAllowed=true');
    const data = Array.isArray(response) ? response : [];
    await chrome.storage.local.set({ cachedMfaRegistrations: data });
    return data;
  } catch (error) {
    await reportError('fetchMfaRegistrations', error);
    return [];
  }
}

function hasTotpRegistered(mfaRegistrations) {
  return Array.isArray(mfaRegistrations) && mfaRegistrations.some(
    r => r.factor === 'TOTP' && r.status === 'REGISTERED'
  );
}

// ── Approvals ──

async function fetchApprovals() {
  try {
    const settings = await chrome.storage.local.get(['britiveSettings']);
    if (!settings.britiveSettings || !settings.britiveSettings.tenant) {
      return { error: 'Tenant not configured' };
    }

    const response = await britiveAPI.makeRequest(
      '/api/v1/approvals/?requestType=myApprovals&filter=status eq PENDING&createdWithinDays=1'
    );

    if (Array.isArray(response)) return response;
    if (response.result && Array.isArray(response.result)) return response.result;
    if (response.data && Array.isArray(response.data)) return response.data;

    return [];
  } catch (error) {
    return { error: normalizeError(error) };
  }
}

async function handleApprovalAction(requestId, approve, comments = '') {
  try {
    const param = approve ? 'yes' : 'no';
    await britiveAPI.makeRequest(
      `/api/v1/approvals/${safePath(requestId)}?approveRequest=${param}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ approverComment: comments })
      }
    );
    return { success: true };
  } catch (error) {
    return { error: normalizeError(error) };
  }
}

// ── Token expiration alarm ──

function scheduleExpirationAlarm(expirationTime) {
  chrome.alarms.clear('britive-token-expiry');

  const delay = expirationTime - Date.now();
  if (delay <= 0) return;

  chrome.alarms.create('britive-token-expiry', {
    when: expirationTime
  });
}

// ── Checkout expiration notifications (via chrome.alarms) ──

async function scheduleCheckoutExpirationNotification(key, profileName, envName, expiresAt) {
  // Check if notifications are enabled
  const { extensionSettings } = await chrome.storage.local.get('extensionSettings');
  if (!(extensionSettings?.checkoutExpiryNotification ?? true)) return;

  clearCheckoutExpirationNotification(key);

  const now = Date.now();

  // Warning alarm: 5 minutes before expiry
  const warningTime = expiresAt - (5 * 60 * 1000);
  if (warningTime > now) {
    chrome.alarms.create(`britive-checkout-warn|${key}`, { when: warningTime });
  }

  // Expiry alarm
  if (expiresAt > now) {
    chrome.alarms.create(`britive-checkout-expired|${key}`, { when: expiresAt });
  }

  // Store profile/env names for the alarm handler to use
  const { checkoutNotificationMeta = {} } = await chrome.storage.session.get('checkoutNotificationMeta');
  checkoutNotificationMeta[key] = { profileName, envName };
  await chrome.storage.session.set({ checkoutNotificationMeta });
}

function clearCheckoutExpirationNotification(key) {
  chrome.alarms.clear(`britive-checkout-warn|${key}`);
  chrome.alarms.clear(`britive-checkout-expired|${key}`);
}

async function clearAllCheckoutExpirationNotifications() {
  const allAlarms = await chrome.alarms.getAll();
  for (const alarm of allAlarms) {
    if (alarm.name.startsWith('britive-checkout-warn|') || alarm.name.startsWith('britive-checkout-expired|')) {
      chrome.alarms.clear(alarm.name);
    }
  }
  await chrome.storage.session.remove('checkoutNotificationMeta');
}

// ── Banner polling via chrome.alarms ──

const BANNER_BADGE_COLORS = {
  INFO: '#3E5DE0',
  WARNING: '#ffcb00',
  CAUTION: '#dc3545',
};

function getApprovalTargetLabel(item) {
  if (!item) return 'your access request';
  const parts = [item.appName, item.profileName, item.environmentName].filter(Boolean);
  return parts.length ? parts.join(' / ') : 'your access request';
}

async function handleApprovalStatusChanged(status, item, autoCheckout) {
  const normalizedStatus = String(status || '').toLowerCase();

  // Skip if WS already delivered this notification (dedup)
  const dedupKey = `${item?.papId || ''}|${item?.environmentId || ''}|${normalizedStatus}`;
  if (recentWsNotificationKeys.has(dedupKey)) {
    return { success: true, deduplicated: true };
  }

  const target = getApprovalTargetLabel(item);
  let title = 'Britive Approval Update';
  let message = `${target} changed status.`;

  if (normalizedStatus === 'approved') {
    title = autoCheckout ? 'Britive Access Approved' : 'Britive Approval Granted';
    message = autoCheckout
      ? `${target} was approved. Starting checkout.`
      : `${target} was approved.`;
  } else if (normalizedStatus === 'rejected') {
    title = 'Britive Approval Rejected';
    message = `${target} was rejected.`;
  } else if (normalizedStatus === 'withdrawn' || normalizedStatus === 'cancelled') {
    title = 'Britive Approval Closed';
    message = `${target} is no longer pending.`;
  } else if (normalizedStatus === 'revoked') {
    title = 'Britive Access Revoked';
    message = `${target} has been revoked.`;
  } else if (normalizedStatus === 'expired') {
    title = 'Britive Approval Expired';
    message = `${target} expired before it was approved.`;
  }

  const notificationId = `britive-approval-${normalizedStatus}-${Date.now()}`;
  chrome.notifications.create(notificationId, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/britive-icon-96.png'),
    title,
    message
  }).catch(() => {});

  chrome.runtime.sendMessage({
    action: 'approvalStatusNotification',
    status: normalizedStatus,
    title,
    message,
    autoCheckout: !!autoCheckout,
    item
  }).catch(() => {});

  return { success: true };
}

async function pollBanner() {
  try {
    await britiveAPI.ensureInitialized();
    if (!britiveAPI.baseUrl || !britiveAPI.bearerToken) return;

    const banner = await britiveAPI.makeRequest('/api/banner');
    await chrome.storage.local.set({ britiveBanner: banner || null });

    const hasBanner = !!(banner && banner.message);
    await chrome.storage.session.set({ lastBannerActive: hasBanner });

    await refreshBadge();
  } catch (error) {
    if (!britiveAPI.bearerToken) {
      stopBannerPolling();
      stopApprovalsPolling();
      await refreshBadge();
      chrome.notifications.create('britive-session-expired', {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/britive-icon-96.png'),
        title: 'Britive Session Expired',
        message: 'Your Britive session has expired. Please log in again.'
      });
    }
  }
}

async function startBannerPolling() {
  stopBannerPolling();
  const { extensionSettings } = await chrome.storage.local.get('extensionSettings');
  if ((extensionSettings?.bannerCheck ?? true) === false) return;

  // chrome.alarms minimum period is 1 minute
  const intervalSec = Math.max(60, extensionSettings?.bannerPollInterval || 60);
  const periodInMinutes = intervalSec / 60;

  pollBanner();
  chrome.alarms.create('britive-banner-poll', { periodInMinutes });
}

function stopBannerPolling() {
  chrome.alarms.clear('britive-banner-poll');
}

// ── Approval + checked-out-profiles polling via chrome.alarms ──

async function pollApprovals() {
  try {
    await britiveAPI.ensureInitialized();
    if (!britiveAPI.baseUrl || !britiveAPI.bearerToken) return;

    const approvals = await fetchApprovals();
    const list = Array.isArray(approvals) ? approvals : [];
    await chrome.storage.session.set({
      pendingApprovalCount: list.length,
      cachedApprovalsList: list
    });
    await refreshBadge();
  } catch (error) {
    // Silently ignore
  }
}

async function pollCheckedOutProfiles() {
  try {
    await britiveAPI.ensureInitialized();
    if (!britiveAPI.baseUrl || !britiveAPI.bearerToken) return;
    const response = await britiveAPI.makeRequest('/api/access/app-access-status');
    await chrome.storage.local.set({ cachedCheckedOutProfiles: response || [] });

    // Reconcile checkout expiration cache - remove entries for profiles no longer checked out
    try {
      const { checkoutExpirations } = await chrome.storage.local.get('checkoutExpirations');
      if (checkoutExpirations && Object.keys(checkoutExpirations).length > 0) {
        const activeKeys = new Set();
        (response || []).forEach(co => {
          if (co.checkedIn === null || co.checkedIn === undefined || co.checkedIn === false) {
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
          await chrome.storage.local.set({ checkoutExpirations });
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
  const periodInMinutes = APPROVALS_FALLBACK_INTERVAL_SEC / 60;

  pollApprovals();
  pollCheckedOutProfiles();
  chrome.alarms.create('britive-approvals-poll', { periodInMinutes });
}

function stopApprovalsPolling(preserveCache) {
  chrome.alarms.clear('britive-approvals-poll');
  if (!preserveCache) {
    chrome.storage.session.set({ pendingApprovalCount: 0, cachedApprovalsList: [] });
  }
}

// ── WebSocket notification queue ──
// Stores WS notifications so the popup can show them as toasts when it opens.
// Uses chrome.storage.session (survives service worker restarts within session).
const WS_NOTIFICATION_QUEUE_CAP = 10;
const recentWsEventKeys = new Set();
const recentWsNotificationKeys = new Set(); // dedup: tracks WS-delivered events to suppress REST duplicates

async function queueWsNotification(entry) {
  try {
    const { wsNotificationQueue = [] } = await chrome.storage.session.get('wsNotificationQueue');
    wsNotificationQueue.push(entry);
    const capped = wsNotificationQueue.slice(-WS_NOTIFICATION_QUEUE_CAP);
    await chrome.storage.session.set({ wsNotificationQueue: capped });
    refreshBadge();
  } catch (e) { /* best effort */ }
}

async function drainWsNotificationQueue() {
  try {
    const { wsNotificationQueue = [] } = await chrome.storage.session.get('wsNotificationQueue');
    await chrome.storage.session.set({ wsNotificationQueue: [] });
    refreshBadge();
    return wsNotificationQueue;
  } catch (e) { return []; }
}

// ── WebSocket push notifications (via offscreen document) ──
// The WS client lives in offscreen.js. The service worker manages the
// offscreen document lifecycle and routes events from it.

// Approval terminal event names from the backend
const WS_APPROVAL_EVENTS = new Set([
  'requestApproved', 'requestRejected', 'requestRevoked',
  'requestCancelled', 'requestExpired'
]);

// Checkout lifecycle events we act on
const WS_CHECKOUT_EVENTS = new Set([
  'checkedOut', 'checkedIn', 'checkedInExpired',
  'checkOutFailed', 'checkOutTimeOut',
  'checkInFailed', 'checkInTimeOut'
]);

// Checkout events that warrant an error notification
const WS_CHECKOUT_ERROR_EVENTS = new Set([
  'checkOutFailed', 'checkOutTimeOut',
  'checkInFailed', 'checkInTimeOut'
]);

// Transient events (log only)
const WS_TRANSIENT_EVENTS = new Set([
  'checkOutSubmitted', 'checkOutInProgress',
  'checkInSubmitted', 'checkInInProgress',
  'Pending'
]);

async function isPopupOpen() {
  try {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['POPUP']
    });
    return contexts.length > 0;
  } catch (e) {
    return false;
  }
}

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT']
  });
  if (contexts.length > 0) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['WORKERS'],
    justification: 'WebSocket connection for push notifications'
  });
}

let wsReconnectTimer = null;
let wsReconnectDelay = 1000;
let wsConnecting = false;

function scheduleWsReconnect() {
  if (wsReconnectTimer) return;
  if (!britiveAPI.bearerToken) return;
  wsReconnectTimer = setTimeout(() => {
    wsReconnectTimer = null;
    connectNotificationSocket();
  }, wsReconnectDelay);
  wsReconnectDelay = Math.min(wsReconnectDelay * 2, 30000);
}

function clearWsReconnectTimer() {
  if (wsReconnectTimer) {
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = null;
  }
}

async function connectNotificationSocket() {
  if (!britiveAPI.baseUrl || !britiveAPI.bearerToken) return;
  if (wsConnecting) return;
  wsConnecting = true;

  const tenant = getTenantHostFromBaseUrl(britiveAPI.baseUrl);

  // Set the auth cookie scoped to /api/websocket/ so the offscreen WS upgrade
  // carries it. The backend authenticates Socket.IO via the 'auth' cookie.
  try {
    await chrome.cookies.set({
      url: getWsCookieUrlForBaseUrl(britiveAPI.baseUrl),
      name: 'auth',
      value: britiveAPI.bearerToken,
      path: '/api/websocket/',
      secure: true,
      httpOnly: true,
      sameSite: 'no_restriction'
    });
  } catch (e) {}

  try {
    await ensureOffscreen();
    chrome.runtime.sendMessage({
      action: 'connectWs',
      tenant,
      bearerToken: britiveAPI.bearerToken,
      extensionVersion: chrome.runtime.getManifest().version
    }).catch(() => {});
    // wsConnecting stays true until wsConnected or wsDisconnected arrives
  } catch (e) {
    wsConnecting = false;
  }
}

async function disconnectNotificationSocket() {
  clearWsReconnectTimer();
  wsReconnectDelay = 1000;
  wsConnecting = false;
  const closeTasks = [
    chrome.runtime.sendMessage({ action: 'disconnectWs' }).catch(() => {}),
    chrome.offscreen.closeDocument().catch(() => {})
  ];
  if (britiveAPI.baseUrl) {
    closeTasks.push(
      chrome.cookies.remove({
        url: getWsCookieUrlForBaseUrl(britiveAPI.baseUrl),
        name: 'auth'
      }).catch(() => {})
    );
  }
  await Promise.all(closeTasks);
}

function handleSocketEvent(eventName, payload) {
  // Ignore resource-profile events
  if (payload && payload.consumer === 'resourceprofile') return;

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
  if (eventName === 'addNotifications' || eventName === 'allNotifications') {
    const items = Array.isArray(payload) ? payload : [];
    const hasApprovalNotif = items.some(n =>
      n.messageType === 'profile-approval' ||
      n.messageType === 'profile-approval-status' ||
      n.messageType === 'profile-approval-status-approver' ||
      n.messageType === 'profile-approval-cancelled'
    );
    if (hasApprovalNotif) pollApprovals();
    return;
  }
}

async function handleWsApprovalEvent(eventName, payload) {
  const status = eventName.replace(/^request/i, '').toLowerCase();
  const papId = payload.papId || '';
  const environmentId = payload.environmentId || '';

  // Track this event to suppress duplicate REST polling notification
  const dedupKey = `${papId}|${environmentId}|${status}`;
  recentWsNotificationKeys.add(dedupKey);
  setTimeout(() => recentWsNotificationKeys.delete(dedupKey), 30000);

  // Resolve human-readable names from the access cache
  let target = 'your access request';
  try {
    const { accessCache_data } = await chrome.storage.local.get('accessCache_data');
    if (Array.isArray(accessCache_data)) {
      const match = accessCache_data.find(a =>
        a.raw && a.raw.papId === papId && a.raw.environmentId === environmentId);
      if (match) {
        const parts = [match.appName, match.profileName, match.environmentName].filter(Boolean);
        if (parts.length) target = parts.join(' / ');
      }
    }
  } catch (e) { /* best effort */ }

  let title = 'Britive Approval Update';
  let message = `${target} changed status.`;

  if (status === 'approved') {
    title = 'Britive Approval Granted';
    message = `${target} was approved.`;
  } else if (status === 'rejected') {
    title = 'Britive Approval Rejected';
    message = `${target} was rejected.`;
  } else if (status === 'revoked') {
    title = 'Britive Access Revoked';
    message = `${target} has been revoked.`;
  } else if (status === 'cancelled') {
    title = 'Britive Approval Closed';
    message = `${target} is no longer pending.`;
  } else if (status === 'expired') {
    title = 'Britive Approval Expired';
    message = `${target} expired before it was approved.`;
  }

  const notificationId = `britive-ws-approval-${status}-${Date.now()}`;
  chrome.notifications.create(notificationId, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/britive-icon-96.png'),
    title,
    message
  }).catch(() => {});

  const approvalMsg = {
    action: 'wsApprovalUpdate',
    status,
    papId,
    environmentId,
    killSession: !!payload.killSession,
    statusText: payload.statusText || status,
    message
  };
  const queueEntry = {
    type: 'approval',
    status,
    papId,
    environmentId,
    message,
    title,
    tone: status === 'approved' ? 'success'
      : status === 'rejected' ? 'error'
        : (status === 'expired' || status === 'revoked' || status === 'cancelled') ? 'warning'
          : 'info',
    timestamp: Date.now()
  };
  // Check if popup is open; if so deliver directly, otherwise queue.
  // chrome.runtime.sendMessage goes to ALL extension pages including offscreen,
  // so we cannot rely on .catch() to detect a closed popup.
  const popupOpen = await isPopupOpen();
  if (popupOpen) {
    chrome.runtime.sendMessage(approvalMsg).catch(() => {
      queueWsNotification(queueEntry);
    });
  } else {
    queueWsNotification(queueEntry);
  }
}

async function handleWsCheckoutEvent(eventName, payload) {
  const status = payload.status || eventName;
  const statusText = payload.statusText || eventName;
  const papId = payload.papId || '';
  const environmentId = payload.environmentId || '';

  if (WS_CHECKOUT_ERROR_EVENTS.has(eventName)) {
    const notificationId = `britive-ws-checkout-err-${Date.now()}`;
    chrome.notifications.create(notificationId, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/britive-icon-96.png'),
      title: statusText,
      message: payload.errorMessage || `${statusText} for your access.`
    }).catch(() => {});
  } else if (eventName === 'checkedInExpired') {
    const notificationId = `britive-ws-checkout-expired-${Date.now()}`;
    chrome.notifications.create(notificationId, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/britive-icon-96.png'),
      title: 'Checkout Expired',
      message: 'Your checked-out access has expired.'
    }).catch(() => {});
  }

  const checkoutMsg = {
    action: 'wsCheckoutUpdate',
    status,
    statusText,
    papId,
    environmentId
  };
  // Check if popup is open; if so deliver directly, otherwise queue.
  // chrome.runtime.sendMessage goes to ALL extension pages including offscreen,
  // so we cannot rely on .catch() to detect a closed popup.
  const isError = WS_CHECKOUT_ERROR_EVENTS.has(eventName);
  const isExpired = eventName === 'checkedInExpired';
  const shouldQueue = isError || isExpired || eventName === 'checkedOut' || eventName === 'checkedIn';
  const queueEntry = shouldQueue ? {
    type: 'checkout',
    status: eventName,
    papId,
    environmentId,
    message: isError ? (payload.errorMessage || `${statusText} for your access.`)
      : isExpired ? 'Your checked-out access has expired.'
        : eventName === 'checkedOut' ? 'Access checked out successfully.'
          : 'Access checked in successfully.',
    title: isError ? statusText
      : isExpired ? 'Checkout Expired'
        : eventName === 'checkedOut' ? 'Checked Out'
          : 'Checked In',
    tone: isError ? 'error'
      : isExpired ? 'warning'
        : 'success',
    timestamp: Date.now()
  } : null;

  const popupOpen = await isPopupOpen();
  if (popupOpen) {
    chrome.runtime.sendMessage(checkoutMsg).catch(() => {
      if (queueEntry) queueWsNotification(queueEntry);
    });
  } else {
    if (queueEntry) queueWsNotification(queueEntry);
  }
}

// ── Unified extension badge ──
// Reads state from session storage (service-worker-safe).
// Approval count takes priority; falls back to banner "!".

async function refreshBadge() {
  const session = await chrome.storage.session.get(['pendingApprovalCount', 'lastBannerActive', 'wsNotificationQueue']);
  const count = session.pendingApprovalCount || 0;
  const hasBanner = session.lastBannerActive || false;
  const queueLen = Array.isArray(session.wsNotificationQueue) ? session.wsNotificationQueue.length : 0;

  const { extensionSettings } = await chrome.storage.local.get('extensionSettings');
  const isCrt = extensionSettings && extensionSettings.theme === 'crt';
  const crtBadgeColor = '#0a0a0a';

  if (count > 0) {
    const text = count > 99 ? '99+' : String(count);
    chrome.action.setBadgeText({ text });
    chrome.action.setBadgeBackgroundColor({ color: isCrt ? crtBadgeColor : '#CA1ECC' });
    chrome.action.setBadgeTextColor({ color: isCrt ? '#aaffcc' : '#ffffff' });
  } else if (queueLen > 0) {
    // Unread WS notifications waiting for popup drain
    const text = queueLen > 99 ? '99+' : String(queueLen);
    chrome.action.setBadgeText({ text });
    chrome.action.setBadgeBackgroundColor({ color: isCrt ? crtBadgeColor : '#CA1ECC' });
    chrome.action.setBadgeTextColor({ color: isCrt ? '#aaffcc' : '#ffffff' });
  } else if (hasBanner) {
    const { britiveBanner, bannerDismissed } = await chrome.storage.local.get(['britiveBanner', 'bannerDismissed']);
    const key = britiveBanner ? (britiveBanner.messageType || 'INFO') + ':' + britiveBanner.message : null;
    if (bannerDismissed && key === bannerDismissed) {
      // User dismissed this banner - hide badge
      chrome.action.setBadgeText({ text: '' });
      return;
    }
    const color = BANNER_BADGE_COLORS[britiveBanner?.messageType] || '#3E5DE0';
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: isCrt ? crtBadgeColor : color });
    chrome.action.setBadgeTextColor({ color: isCrt ? '#aaffcc' : '#ffffff' });
  } else {
    chrome.action.setBadgeText({ text: '' });
  }
}

// ── Alarm listener ──

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'britive-token-refresh') {
    await refreshAccessToken();
    return;
  } else if (alarm.name === 'britive-banner-poll') {
    await pollBanner();
  } else if (alarm.name === 'britive-approvals-poll') {
    await pollApprovals();
    await pollCheckedOutProfiles();
  } else if (alarm.name === 'britive-token-expiry') {
    chrome.notifications.create('britive-session-expired', {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/britive-icon-96.png'),
      title: 'Britive Session Expired',
      message: 'Your Britive session has expired. Please log in again.'
    });
  } else if (alarm.name.startsWith('britive-checkout-warn|') || alarm.name.startsWith('britive-checkout-expired|')) {
    const isWarning = alarm.name.startsWith('britive-checkout-warn|');
    const key = alarm.name.split('|').slice(1).join('|');
    const { checkoutNotificationMeta = {} } = await chrome.storage.session.get('checkoutNotificationMeta');
    const meta = checkoutNotificationMeta[key] || {};
    const profileName = meta.profileName || 'Profile';
    const envName = meta.envName || 'environment';

    // Parse papId and environmentId from the key (format: "papId|environmentId")
    const [expiryPapId, expiryEnvId] = key.split('|');

    if (isWarning) {
      const warnMsg = `${profileName} in ${envName} expires in 5 minutes.`;
      chrome.notifications.create(`britive-checkout-warn-${key}`, {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/britive-icon-96.png'),
        title: 'Checkout Expiring Soon',
        message: warnMsg
      });
      // Send to popup if open (stopwatch icon)
      chrome.runtime.sendMessage({
        action: 'wsCheckoutExpiring',
        papId: expiryPapId,
        environmentId: expiryEnvId,
        message: warnMsg
      }).catch(() => {});
      // Queue for drain on next popup open
      queueWsNotification({
        type: 'checkoutExpiring',
        status: 'expiringSoon',
        papId: expiryPapId,
        environmentId: expiryEnvId,
        message: warnMsg,
        title: 'Checkout Expiring Soon',
        tone: 'warning',
        icon: '\u23F1',
        timestamp: Date.now()
      });
    } else {
      chrome.notifications.create(`britive-checkout-expired-${key}`, {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/britive-icon-96.png'),
        title: 'Checkout Expired',
        message: `${profileName} in ${envName} has expired.`
      });
      // Clean up meta for this key
      delete checkoutNotificationMeta[key];
      await chrome.storage.session.set({ checkoutNotificationMeta });
    }
  }
});

// ── On startup / service worker wake - restore state and start polling ──

chrome.runtime.onStartup.addListener(initializeOnWake);
chrome.runtime.onInstalled.addListener(initializeOnWake);

// Also run on initial script load (service worker first load)
initializeOnWake();

async function initializeOnWake() {
  const { britiveSettings, extensionSettings } = await chrome.storage.local.get(['britiveSettings', 'extensionSettings']);

  // Restore CRT icon if theme is set
  if (extensionSettings && extensionSettings.theme === 'crt') {
    chrome.action.setIcon({ path: { 48: 'icons/britive-icon-crt-48.png', 96: 'icons/britive-icon-crt-96.png', 128: 'icons/britive-icon-crt-128.png' } });
  }

  // Clean up stale login-in-progress state
  const { britiveAuth } = await chrome.storage.local.get('britiveAuth');
  if (britiveAuth && britiveAuth.loginInProgress) {
    const age = Date.now() - (britiveAuth.startTime || 0);
    if (age > 5 * 60 * 1000) {
      await chrome.storage.local.remove('britiveAuth');
    }
  }

  if (!britiveSettings || !isValidTenant(britiveSettings.tenant)) return;

  const now = Date.now();
  const tokenValid = britiveSettings.bearerToken && britiveSettings.expirationTime && now < britiveSettings.expirationTime;

  if (tokenValid) {
    // Access token still valid
    britiveAPI.baseUrl = getTenantBaseUrl(britiveSettings.tenant);
    britiveAPI.bearerToken = britiveSettings.bearerToken;
    if (britiveSettings.refreshToken) {
      scheduleTokenRefreshAlarm(britiveSettings.expirationTime);
    } else {
      scheduleExpirationAlarm(britiveSettings.expirationTime);
    }
    startBannerPolling();
    startApprovalsPolling();
    connectNotificationSocket();
    fetchSecretTemplates().catch(() => {});
  } else if (britiveSettings.refreshToken) {
    // Access token expired but refresh token may still be valid
    britiveAPI.baseUrl = getTenantBaseUrl(britiveSettings.tenant);
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      startBannerPolling();
      startApprovalsPolling();
      connectNotificationSocket();
      fetchSecretTemplates().catch(() => {});
    }
  }
}

// ── Watch for settings / tenant changes ──

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local') return;

  if (changes.extensionSettings) {
    await britiveAPI.ensureInitialized();
    if (!britiveAPI.bearerToken) return;

    const oldVal = changes.extensionSettings.oldValue || {};
    const newVal = changes.extensionSettings.newValue || {};

    // Banner check toggle
    const oldBanner = oldVal.bannerCheck ?? true;
    const newBanner = newVal.bannerCheck ?? true;
    if (newBanner && !oldBanner) {
      startBannerPolling();
    } else if (!newBanner && oldBanner) {
      stopBannerPolling();
      await chrome.storage.session.set({ lastBannerActive: false });
      await chrome.storage.local.remove('britiveBanner');
      await refreshBadge();
    }

    // Restart polling if intervals changed
    const oldBannerInt = oldVal.bannerPollInterval || 60;
    const newBannerInt = newVal.bannerPollInterval || 60;
    if (oldBannerInt !== newBannerInt) {
      const bannerAlarm = await chrome.alarms.get('britive-banner-poll');
      if (bannerAlarm) startBannerPolling();
    }

  }

  // Banner dismissed by user in popup - refresh badge
  if (changes.bannerDismissed) {
    await refreshBadge();
  }

  if (!changes.britiveSettings) return;

  const oldTenant = changes.britiveSettings.oldValue?.tenant;
  const newTenant = changes.britiveSettings.newValue?.tenant;
  const authenticated = changes.britiveSettings.newValue?.authenticated;

  if (newTenant && newTenant !== oldTenant) {
    await clearSecretsCache();
    await chrome.storage.local.remove([
      'secretTemplates', 'secretUrlMap',
      'cachedUserProfile', 'cachedMfaRegistrations', 'cachedCheckedOutProfiles',
      'accessCache_data', 'accessCache_collectionId', 'accessCache_collectionName',
      'accessCollapsedState', 'pendingApprovals', 'britiveBanner',
      'checkoutExpirations'
    ]);
    accessCache = null;
    accessCacheTime = 0;
    britiveAPI.vaultId = null;
    britiveAPI.bearerToken = null;

    chrome.alarms.clear('britive-token-expiry');
    stopBannerPolling();
    stopApprovalsPolling();
    await disconnectNotificationSocket();
    await refreshBadge();

    if (!authenticated) {
      chrome.notifications.create('britive-tenant-changed', {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/britive-icon-96.png'),
        title: 'Britive Tenant Changed',
        message: `Tenant set to ${newTenant}. Please log in to authenticate.`
      });
    }
  }
});

// ── Keyboard shortcut command handler ──

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'open-access-search' || command === 'open-approvals-tab' || command === 'open-secrets-search') {
    try {
      const target = command === 'open-approvals-tab'
        ? 'approvals-tab'
        : command === 'open-secrets-search'
          ? 'secrets-search'
          : 'access-search';
      await chrome.storage.local.set({
        popupFocusIntent: {
          target,
          ts: Date.now()
        }
      });
      if (chrome.action && chrome.action.openPopup) {
        await chrome.action.openPopup();
      }
    } catch (e) {
      // If popup cannot be opened programmatically, intent remains for next manual open
    }
    return;
  }

});
