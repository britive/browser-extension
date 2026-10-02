import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { BUILDS, flush, loadBackground, loggedInSession } from "./harness.mjs";

const HOUR = 3600000;
const response = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => "application/json" },
  text: async () => JSON.stringify(body),
  json: async () => body,
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function newLogin(env, tenant = env.settings.tenant) {
  const { token, exp } = env.server.issueAccessToken();
  await env.ext.api.storage.local.set({
    britiveSettings: {
      ...env.settings, tenant, authenticated: true,
      bearerToken: token, refreshToken: env.server.issueRefreshToken(),
      expirationTime: exp, authGeneration: "new-login",
      loginTimestamp: env.clock.now, lastInteractiveLoginAt: env.clock.now,
    },
  });
  await flush();
  env.api.bearerToken = token;
  env.api.baseUrl = `https://${tenant}.britive-app.com`;
  return token;
}

for (const build of BUILDS) {
  describe(`${build}: session race regressions`, () => {
    test("forced recovery does not get lost behind a refresh that is not due", async () => {
      const env = await loadBackground(build, { storageFromServer: loggedInSession() });
      const gate = deferred();
      const entered = deferred();
      const originalGet = env.ext.api.storage.local.get;
      let first = true;
      env.ext.api.storage.local.get = async (keys) => {
        if (keys === "tokenRefreshRetry" && first) {
          first = false;
          entered.resolve();
          await gate.promise;
        }
        return originalGet(keys);
      };
      const normal = env.get("refreshAccessToken()");
      await entered.promise;
      const oldToken = env.api.bearerToken;
      env.server.apiHandler = (req) => req.bearer === oldToken ? { status: 401, body: {} } : undefined;
      const request = env.api.makeRequest("/api/banner");
      await flush();
      gate.resolve();
      await Promise.all([normal, request]);
      assert.equal(env.server.tokenRequests().length, 1);
      assert.notEqual(env.api.bearerToken, oldToken);
    });

    test("legacy sessions without a generation finish refresh and schedule the next one", async () => {
      const env = await loadBackground(build, {
        storageFromServer: (server, clock) => {
          const storage = loggedInSession()(server, clock);
          delete storage.britiveSettings.authGeneration;
          return storage;
        },
      });
      await env.clock.sleep(2 * HOUR);
      await env.api.makeRequest("/api/banner");
      assert.ok(env.server.isAccessTokenValid(env.settings.bearerToken));
      assert.equal(env.api.bearerToken, env.settings.bearerToken);
      assert.equal(env.server.tokenRequests().length, 1);
      await env.advance(56 * 60000);
      assert.equal(env.server.tokenRequests().length, 2);
    });

    for (const status of [200, 401]) {
      for (const tenant of ["acme", "other"]) {
        test(`late ${status} cannot return data or replay a POST after login to ${tenant}`, async () => {
          const env = await loadBackground(build, { storageFromServer: loggedInSession() });
          const original = env.get("globalThis").fetch;
          const gate = deferred();
          const entered = deferred();
          let calls = 0;
          env.get("globalThis").fetch = async (url, options) => {
            if (url.includes("old-profile")) {
              calls++;
              entered.resolve();
              await gate.promise;
              return response(status, { oldSessionData: true });
            }
            return original(url, options);
          };
          const request = env.api.makeRequest("/api/access/old-profile/environments/env", { method: "POST", body: "{}" });
          const rejected = assert.rejects(request, /Session changed/);
          await entered.promise;
          const token = await newLogin(env, tenant);
          gate.resolve();
          await rejected;
          assert.equal(calls, 1);
          assert.equal(env.settings.bearerToken, token);
          assert.equal(env.settings.authenticated, true);
        });
      }
    }

    for (const action of ["logout", "new login"]) {
      test(`a late successful refresh cannot overwrite ${action}`, async () => {
        const env = await loadBackground(build, { storageFromServer: loggedInSession() });
        await env.clock.sleep(2 * HOUR);
        const gate = deferred();
        const entered = deferred();
        const original = env.get("globalThis").fetch;
        // Ignore cancellation deliberately: a response/body may already be in flight.
        env.get("globalThis").fetch = async (url, options) => {
          if (url.endsWith("/oauth2/token")) {
            entered.resolve();
            await gate.promise;
            return response(200, { access_token: env.server.issueAccessToken().token });
          }
          return original(url, options);
        };
        const request = env.api.makeRequest("/api/banner");
        const rejected = assert.rejects(request, /Session changed|Not authenticated/);
        await entered.promise;
        let newToken;
        if (action === "logout") await env.sendMessage({ action: "logout" });
        else newToken = await newLogin(env);
        gate.resolve();
        await rejected;
        assert.equal(env.settings.bearerToken, newToken || null);
        assert.equal(env.settings.authenticated, action !== "logout");
      });
    }

    test("logout wins even when the refresh storage commit has already started", async () => {
      const env = await loadBackground(build, { storageFromServer: loggedInSession() });
      await env.clock.sleep(2 * HOUR);
      const originalSet = env.ext.api.storage.local.set;
      const oldToken = env.settings.bearerToken;
      const entered = deferred();
      const gate = deferred();
      env.ext.api.storage.local.set = async (items) => {
        if (items.britiveSettings?.bearerToken && items.britiveSettings.bearerToken !== oldToken) {
          entered.resolve();
          await gate.promise;
        }
        return originalSet(items);
      };
      const request = assert.rejects(env.api.makeRequest("/api/banner"), /Session changed|Not authenticated/);
      await entered.promise;
      const logout = env.api.clearToken();
      gate.resolve();
      await Promise.all([request, logout]);
      assert.equal(env.settings.authenticated, false);
      assert.equal(env.settings.bearerToken, null);
      assert.equal(env.api.bearerToken, null);
    });

    test("a late 401 on the retry cannot clear a newer login", async () => {
      const env = await loadBackground(build, { storageFromServer: loggedInSession() });
      const original = env.get("globalThis").fetch;
      const gate = deferred();
      const entered = deferred();
      let calls = 0;
      env.get("globalThis").fetch = async (url, options) => {
        if (url.includes("/old-profile")) {
          calls++;
          if (calls === 2) { entered.resolve(); await gate.promise; }
          return response(401, {});
        }
        return original(url, options);
      };
      const rejected = assert.rejects(env.api.makeRequest("/api/access/old-profile"), /Session changed/);
      await entered.promise;
      const token = await newLogin(env);
      gate.resolve();
      await rejected;
      assert.equal(calls, 2);
      assert.equal(env.settings.bearerToken, token);
      assert.equal(env.settings.authenticated, true);
    });

    test("a response body delivered after an account switch is discarded", async () => {
      const env = await loadBackground(build, { storageFromServer: loggedInSession() });
      const gate = deferred();
      const entered = deferred();
      env.get("globalThis").fetch = async () => ({
        ...response(200, {}),
        json: async () => { entered.resolve(); await gate.promise; return { secret: "old-session" }; },
      });
      const rejected = assert.rejects(env.api.makeRequest("/api/secret"), /Session changed/);
      await entered.promise;
      await newLogin(env);
      gate.resolve();
      await rejected;
    });

    for (const status of [503, 429]) {
      test(`${status} enforces a cooldown across requests, status checks, and explicit refresh`, async () => {
        const env = await loadBackground(build, { storageFromServer: loggedInSession() });
        await env.clock.sleep(2 * HOUR);
        env.server.tokenHandler = () => ({ status, body: {}, headers: { "retry-after": "180" } });
        const count = () => env.server.tokenRequests().length;
        for (let i = 0; i < 3; i++) {
          await assert.rejects(env.api.makeRequest("/api/banner"), /temporarily unavailable/);
        }
        await env.sendMessage({ action: "checkAuthenticationStatus" });
        await env.get(build === "chrome" ? "refreshAccessToken({ force: true })" : "refreshAccessToken(null, 'test', { force: true })");
        assert.equal(count(), 1);
        assert.equal(env.ext.local.tokenRefreshRetry.retryAt, env.clock.now + 180000);
        assert.ok(env.settings.refreshToken);
        env.server.tokenHandler = null;
        await env.advance(181000);
        assert.equal(count(), 2);
        assert.ok(env.server.isAccessTokenValid(env.api.bearerToken));
        assert.equal(env.ext.local.tokenRefreshRetry, undefined);
      });
    }

    test("persisted cooldown survives background restart", async () => {
      const env = await loadBackground(build, { storageFromServer: loggedInSession() });
      await env.clock.sleep(2 * HOUR);
      env.server.tokenHandler = () => ({ status: 503, body: {} });
      await assert.rejects(env.api.makeRequest("/api/banner"));
      const restarted = await loadBackground(build, { storage: structuredClone(env.ext.local) });
      await restarted.clock.sleep(2 * HOUR);
      await assert.rejects(restarted.api.makeRequest("/api/banner"));
      assert.equal(restarted.server.tokenRequests().length, 0);
      assert.ok(restarted.settings.refreshToken);
      restarted.server.tokenHandler = () => ({
        status: 200,
        body: { access_token: restarted.server.issueAccessToken().token },
      });
      await restarted.advance(61000);
      assert.equal(restarted.server.tokenRequests().length, 1);
      assert.ok(restarted.server.isAccessTokenValid(restarted.api.bearerToken));
    });

    test("hung refresh times out and releases all callers without discarding the session", async () => {
      const env = await loadBackground(build, { storageFromServer: loggedInSession() });
      await env.clock.sleep(2 * HOUR);
      env.server.holdTokenResponses = true;
      const requests = ["/api/banner", "/api/access"].map((url) =>
        assert.rejects(env.api.makeRequest(url), /temporarily unavailable/));
      await flush();
      assert.equal(env.server.tokenRequests().length, 1);
      await env.clock.advance(15001);
      await Promise.all(requests);
      assert.equal(env.get("activeRefresh"), null);
      assert.ok(env.settings.refreshToken);
      env.server.holdTokenResponses = false;
      env.server.release();
      await env.advance(61000);
      assert.ok(env.server.isAccessTokenValid(env.api.bearerToken));
    });

    test("an obsolete refresh failure cannot clear a newer login", async () => {
      const env = await loadBackground(build, { storageFromServer: loggedInSession() });
      await env.clock.sleep(2 * HOUR);
      const gate = deferred();
      const entered = deferred();
      env.get("globalThis").fetch = async () => {
        entered.resolve();
        await gate.promise;
        return response(400, { error: "invalid_grant" });
      };
      const request = assert.rejects(env.api.makeRequest("/api/banner"), /Session changed/);
      await entered.promise;
      const token = await newLogin(env);
      gate.resolve();
      await request;
      assert.equal(env.settings.bearerToken, token);
    });

    test("the refresh deadline also bounds a stalled response body", async () => {
      const env = await loadBackground(build, { storageFromServer: loggedInSession() });
      await env.clock.sleep(2 * HOUR);
      const entered = deferred();
      env.get("globalThis").fetch = async (_url, options) => ({
        ...response(200, {}),
        json: () => {
          entered.resolve();
          return new Promise((_resolve, reject) => {
            options.signal.addEventListener("abort", () => reject(new Error("Body aborted")), { once: true });
          });
        },
      });
      const rejected = assert.rejects(env.api.makeRequest("/api/banner"), /temporarily unavailable/);
      await entered.promise;
      await env.clock.advance(15001);
      await rejected;
      assert.equal(env.get("activeRefresh"), null);
      assert.ok(env.settings.refreshToken);
      assert.ok(env.ext.local.tokenRefreshRetry);
    });
  });
}
