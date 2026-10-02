const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Run the shipped functions in an isolated browser/storage/network harness.
// Top-level extension listeners are excluded; no test-only production exports.
function functionSource(source, name) {
  const match = new RegExp(`^(?:async )?function ${name}\\(`, "m").exec(source);
  assert.ok(match, `Missing function ${name}`);
  return source.slice(match.index, source.indexOf("\n}", match.index) + 2);
}

function harness(browserName, state) {
  const source = fs.readFileSync(path.join(__dirname, "..", browserName, "background.js"), "utf8");
  const data = state || {
    britiveSettings: { tenant: "example", authenticated: true, bearerToken: "token", loginTimestamp: 1, authGeneration: "login-1" },
  };
  const calls = [];
  let now = Date.now();
  let respond = async () => ({ result: [], pagination: {} });
  const local = {
    async get(keys) {
      return Object.fromEntries([].concat(keys).map((key) => [key, structuredClone(data[key])]));
    },
    async set(values) { Object.assign(data, structuredClone(values)); },
    async remove(keys) { for (const key of [].concat(keys)) delete data[key]; },
  };
  const api = { storage: { local } };
  const context = vm.createContext({
    chrome: api, browser: api, URL, URLSearchParams,
    Date: class extends Date { static now() { return now; } },
    Math: Object.assign(Object.create(Math), { random: () => 0.5 }),
    isValidTenant: () => true,
    britiveAPI: {
      baseUrl: "https://example.britive-app.com",
      getVaultId: async () => "vault",
      makeRequest: async (url) => { calls.push(url); return respond(url); },
    },
  });
  const functions = [
    "hasAuthenticatedTenantSession", "normalizeError", "getSecretsScope",
    "authSnapshot", "authSessionKey", "isCurrentAuth", "requireCurrentAuth", "getTenantBaseUrl",
    "getCachedSecrets", "setCachedSecrets", "clearSecretsCache", "getSecrets",
    "fetchBritiveSecrets", "getPasswordManagerCandidatesForUrl",
    "getSecretMetadataValue", "getHostname", "getPasswordManagerMatch",
  ];
  const constants = source.slice(source.indexOf("const CACHE_MAX_AGE_MS"), source.indexOf("async function getSecretsScope"));
  vm.runInContext("let authEpoch = 0;\n" + constants + functions.map((name) => functionSource(source, name)).join("\n"), context);
  return {
    context, api, calls, data,
    respondWith(fn) { respond = fn; },
    advance(ms) { now += ms; },
    now: () => now,
  };
}

for (const browserName of ["chrome", "firefox"]) {
  test(`${browserName}: HTTP rate-limit response preserves Retry-After`, async () => {
    const h = harness(browserName);
    const source = fs.readFileSync(path.join(__dirname, "..", browserName, "background.js"), "utf8");
    const start = source.indexOf("class BritiveAPI {");
    vm.runInContext(source.slice(start, source.indexOf("\n}", start) + 2) +
      "\nglobalThis.client = new BritiveAPI();", h.context);
    h.context.client.baseUrl = "https://example.britive-app.com";
    h.context.client.bearerToken = "token";
    h.api.runtime = { getManifest: () => ({ version: "1.2.2" }) };
    h.context.fetch = async () => ({
      ok: false, status: 429, text: async () => "rate limited",
      headers: { get: (key) => key === "Retry-After" ? "180" : null },
    });
    await assert.rejects(h.context.client.makeRequest("/secrets"), (error) => {
      assert.equal(error.retryAfter, "180");
      assert.match(error.message, /429/);
      return true;
    });
  });

  test(`${browserName}: concurrent consumers share all pages and cache empty results`, async () => {
    const h = harness(browserName);
    h.respondWith(async (url) => url.includes("pageToken=")
      ? { result: [], pagination: {} }
      : { result: [], pagination: { next: "?pageToken=second" } });
    const results = await Promise.all(Array.from({ length: 20 }, () => h.context.getSecrets(true)));
    assert.equal(h.calls.length, 2);
    assert.ok(results.every((result) => result.length === 0));
    await h.context.getSecrets();
    assert.equal(h.calls.length, 2);
    h.advance(3600001);
    await h.context.getSecrets();
    assert.equal(h.calls.length, 4);
  });

  test(`${browserName}: missing URL metadata does not trigger repeated downloads`, async () => {
    const h = harness(browserName);
    h.respondWith(async () => [{ secretType: "Password Manager", path: "/missing-url" }]);
    for (let i = 0; i < 10; i++) {
      const result = await h.context.getPasswordManagerCandidatesForUrl("https://example.com", false);
      assert.equal(result.candidates.length, 0);
    }
    assert.equal(h.calls.length, 1);
  });

  test(`${browserName}: disabled autofill and logged-out sessions make no list requests`, async () => {
    const h = harness(browserName);
    h.data.extensionSettings = { passwordManagerAutofill: false };
    await h.context.getPasswordManagerCandidatesForUrl("https://example.com", true);
    assert.equal(h.calls.length, 0);
    h.data.britiveSettings.authenticated = false;
    assert.ok((await h.context.getSecrets(true)).error);
    assert.equal(h.calls.length, 0);
  });

  test(`${browserName}: failures back off, survive restart, and respect Retry-After`, async () => {
    const h = harness(browserName);
    h.respondWith(async () => { throw Object.assign(new Error("API Error: 503"), { retryAfter: "120" }); });
    const first = await h.context.getSecrets();
    assert.equal(first.retryAt, h.now() + 120000);
    assert.equal(h.data.secretsCache, undefined);
    await h.context.getSecrets(true);
    assert.equal(h.calls.length, 1);
    const restarted = harness(browserName, h.data);
    await restarted.context.getSecrets(true);
    assert.equal(restarted.calls.length, 0);
    h.advance(120001);
    h.respondWith(async () => { throw new Error("Network error"); });
    const second = await h.context.getSecrets();
    assert.equal(second.retryAt, h.now() + 54000);
    h.advance(54001);
    h.respondWith(async () => []);
    assert.equal((await h.context.getSecrets()).length, 0);
    assert.equal(h.data.secretsRetry, undefined);
  });

  test(`${browserName}: partial pagination failure never caches an incomplete list`, async () => {
    const h = harness(browserName);
    h.respondWith(async (url) => {
      if (url.includes("pageToken=")) throw new Error("API Error: 500");
      return { result: [{ path: "/first" }], pagination: { next: "?pageToken=second" } };
    });
    assert.ok((await h.context.getSecrets()).error);
    assert.equal(h.calls.length, 2);
    assert.equal(h.data.secretsCache, undefined);
    await h.context.getSecrets();
    assert.equal(h.calls.length, 2);
  });

  test(`${browserName}: Retry-After dates and maximum backoff are honored`, async () => {
    const h = harness(browserName);
    const until = Math.floor(h.now() / 1000) * 1000 + 600000;
    h.respondWith(async () => {
      throw Object.assign(new Error("API Error: 503"), { retryAfter: new Date(until).toUTCString() });
    });
    assert.equal((await h.context.getSecrets()).retryAt, until);
    h.advance(600001);
    h.respondWith(async () => { throw new Error("API Error: 500"); });
    for (let i = 0; i < 8; i++) {
      const result = await h.context.getSecrets(true);
      assert.ok(result.retryAt - h.now() <= 300000);
      h.advance(300001);
    }
    assert.equal(h.data.secretsRetry.failures, 6);
  });

  test(`${browserName}: manual refresh still fetches while another caller reads cache`, async () => {
    const h = harness(browserName);
    await h.context.getSecrets();
    await Promise.all([h.context.getSecrets(), h.context.getSecrets(true)]);
    assert.equal(h.calls.length, 2);
  });

  test(`${browserName}: repeated pagination token stops instead of looping`, async () => {
    const h = harness(browserName);
    h.respondWith(async () => ({ result: [], pagination: { next: "?pageToken=repeated" } }));
    assert.match((await h.context.getSecrets()).error, /pagination token/);
    assert.equal(h.calls.length, 2);
  });

  test(`${browserName}: session changes discard in-flight metadata and stop pagination`, async () => {
    const h = harness(browserName);
    let release;
    let started;
    const waiting = new Promise((resolve) => { started = resolve; });
    h.respondWith(() => new Promise((resolve) => { release = resolve; started(); }));
    const load = h.context.getSecrets();
    await waiting;
    h.data.britiveSettings.loginTimestamp = 2;
    h.data.britiveSettings.authGeneration = "login-2";
    await h.context.clearSecretsCache();
    release({ result: [{ path: "/old-session" }], pagination: { next: "?pageToken=second" } });
    assert.match((await load).error, /Session changed/);
    assert.equal(h.calls.length, 1);
    assert.equal(h.data.secretsCache, undefined);
    assert.equal(h.data.secretsRetry, undefined);
  });

  test(`${browserName}: cache is isolated between logins but survives token rotation`, async () => {
    const h = harness(browserName);
    await h.context.getSecrets();
    h.data.britiveSettings.bearerToken = "rotated";
    await h.context.getSecrets();
    assert.equal(h.calls.length, 1);
    h.data.britiveSettings.loginTimestamp = 2;
    h.data.britiveSettings.authGeneration = "login-2";
    await h.context.getSecrets();
    assert.equal(h.calls.length, 2);
  });

  test(`${browserName}: actual popup refresh and autofill use one download`, async () => {
    const h = harness(browserName);
    const popup = fs.readFileSync(path.join(__dirname, "..", browserName, "popup/popup.js"), "utf8");
    h.api.runtime = {
      async sendMessage(message) {
        if (message.action === "getSecrets") return { secrets: await h.context.getSecrets(message.forceRefresh) };
        assert.equal(message.action, "getPasswordManagerCandidates");
        return h.context.getPasswordManagerCandidatesForUrl("https://example.com", message.forceRefresh);
      },
    };
    Object.assign(h.context, {
      document: { getElementById: () => null },
      crtLog() {}, isCrt: () => false, getStoredSettings: (settings) => settings || {},
      setStateMessage() {}, startRefreshSpinner() {}, stopRefreshSpinner: (_, done) => done(),
      renderVisibleSecretTypeOptions() {}, displaySecrets() {}, updateLastRefreshed() {},
    });
    vm.runInContext("let currentSecrets = []; let autofillCandidates;\n" +
      functionSource(popup, "loadAutofillCandidates") + "\n" + functionSource(popup, "loadSecrets"), h.context);
    await h.context.loadSecrets(true);
    assert.equal(h.calls.length, 1);
  });
}
