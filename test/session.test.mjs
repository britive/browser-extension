// Session lifetime: token refresh, 401 handling, sleep/wake, and logout.
// Every test runs against both the Firefox and Chrome builds.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  BASE_URL,
  BUILDS,
  loadBackground,
  loggedInSession,
} from "./harness.mjs";

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

function assertLoggedIn(env) {
  assert.ok(env.settings.refreshToken, "refresh token should be kept");
  assert.ok(env.api.bearerToken, "in-memory access token should be set");
  assert.notEqual(env.settings.authenticated, false);
  assert.ok(
    env.server.isAccessTokenValid(env.api.bearerToken),
    "access token should be one the server accepts",
  );
}

function assertLoggedOut(env) {
  assert.equal(env.settings.refreshToken, null);
  assert.equal(env.settings.bearerToken, null);
  assert.equal(env.settings.authenticated, false);
  assert.equal(env.api.bearerToken, null);
}

const expiredNotifications = (env) =>
  env.ext.notifications.filter((n) => n.id === "britive-session-expired");

const refreshGrants = (env) =>
  env.server
    .tokenRequests()
    .filter((r) => r.form.grant_type === "refresh_token");

for (const build of BUILDS) {
  describe(`${build}: session`, () => {
    test("restores a valid session on startup without refreshing", async () => {
      const env = await loadBackground(build, {
        storageFromServer: loggedInSession(),
      });
      assertLoggedIn(env);
      assert.equal(refreshGrants(env).length, 0);
      const status = await env.sendMessage({
        action: "checkAuthenticationStatus",
      });
      assert.equal(status.authenticated, true);
    });

    test("refreshes ahead of expiry while the machine is awake", async () => {
      const env = await loadBackground(build, {
        storageFromServer: loggedInSession(),
      });
      const original = env.api.bearerToken;

      await env.advance(56 * MIN);

      assert.equal(refreshGrants(env).length, 1);
      assert.notEqual(env.api.bearerToken, original);
      assertLoggedIn(env);
      // Stays healthy across several more token lifetimes.
      await env.advance(3 * HOUR);
      assert.equal(refreshGrants(env).length, 4);
      assertLoggedIn(env);
      assert.equal(expiredNotifications(env).length, 0);
    });

    // Regression: a user report. The laptop slept past the access token's expiry,
    // the first banner poll after wake got a 401, and the extension discarded
    // a refresh token that was still valid for 13 days.
    test("stays logged in after sleeping past access-token expiry", async () => {
      const env = await loadBackground(build, {
        storageFromServer: loggedInSession(),
      });
      await env.advance(20 * MIN);

      await env.sleep(2 * HOUR);
      await env.advance(2 * MIN); // pollers fire after wake

      assertLoggedIn(env);
      assert.ok(refreshGrants(env).length >= 1, "should have refreshed");
      assert.equal(expiredNotifications(env).length, 0);
      const status = await env.sendMessage({
        action: "checkAuthenticationStatus",
      });
      assert.equal(status.authenticated, true);
    });

    test("concurrent requests with an expired token share one refresh", async () => {
      const env = await loadBackground(build, {
        storageFromServer: loggedInSession(),
      });
      await env.clock.sleep(2 * HOUR);
      env.server.holdTokenResponses = true;

      const pending = ["/api/banner", "/api/v1/approvals/", "/api/access"].map(
        (p) => env.api.makeRequest(p),
      );
      await env.clock.advance(0);
      assert.equal(env.server.tokenRequests().length, 1);
      env.server.holdTokenResponses = false;
      env.server.release();

      const results = await Promise.allSettled(pending);
      assert.deepEqual(
        results.map((r) => r.status),
        ["fulfilled", "fulfilled", "fulfilled"],
      );
      assert.equal(refreshGrants(env).length, 1);
      assertLoggedIn(env);
    });

    test("status check during an in-flight refresh waits for it", async () => {
      const env = await loadBackground(build, {
        storageFromServer: loggedInSession(),
      });
      await env.clock.sleep(2 * HOUR);
      env.server.holdTokenResponses = true;

      const request = env.api.makeRequest("/api/banner");
      await env.clock.advance(0);
      const status = env.sendMessage({ action: "checkAuthenticationStatus" });
      await env.clock.advance(0);
      env.server.holdTokenResponses = false;
      env.server.release();

      assert.equal((await status).authenticated, true);
      await request;
      assert.equal(refreshGrants(env).length, 1);
    });

    test("a 401 on a token the client thinks is valid refreshes and retries", async () => {
      const env = await loadBackground(build, {
        storageFromServer: loggedInSession(),
      });
      const original = env.api.bearerToken;
      // e.g. clock skew or server-side token revocation
      env.server.apiHandler = (req) =>
        req.bearer === original ? { status: 401, body: {} } : undefined;

      const body = await env.api.makeRequest("/api/banner");

      assert.deepEqual(body, {});
      assert.equal(refreshGrants(env).length, 1);
      const banners = env.server
        .apiRequests()
        .filter((r) => r.path === "/api/banner");
      assert.equal(banners.at(-2).bearer, original);
      assert.notEqual(banners.at(-1).bearer, original);
      assertLoggedIn(env);
    });

    test("logs out, without looping, if the refreshed token is also rejected", async () => {
      const env = await loadBackground(build, {
        storageFromServer: loggedInSession(),
      });
      env.server.apiHandler = () => ({ status: 401, body: {} });

      await assert.rejects(
        env.api.makeRequest("/api/banner"),
        /Not authenticated/,
      );
      assert.equal(refreshGrants(env).length, 1);
      assertLoggedOut(env);
    });

    test("logs out when the refresh token is rejected", async () => {
      const env = await loadBackground(build, {
        storageFromServer: loggedInSession(),
      });
      env.server.revokeRefreshToken(env.settings.refreshToken);
      await env.clock.sleep(2 * HOUR);

      await assert.rejects(
        env.api.makeRequest("/api/banner"),
        /Not authenticated/,
      );
      assertLoggedOut(env);
      assert.equal(expiredNotifications(env).length, 1);
    });

    for (const status of [500, 502, 503, 429]) {
      test(`a ${status} from the token endpoint keeps the session and retries`, async () => {
        const env = await loadBackground(build, {
          storageFromServer: loggedInSession(),
        });
        await env.clock.sleep(2 * HOUR);
        env.server.tokenHandler = () => ({ status, body: { error: "busy" } });

        await assert.rejects(env.api.makeRequest("/api/banner"));
        assert.ok(env.settings.refreshToken, "refresh token should be kept");
        assert.equal(expiredNotifications(env).length, 0);

        // Token endpoint recovers; the scheduled retry picks it up.
        env.server.tokenHandler = null;
        await env.advance(2 * MIN);
        assertLoggedIn(env);
      });
    }

    test("a network error during refresh keeps the session", async () => {
      const env = await loadBackground(build, {
        storageFromServer: loggedInSession(),
      });
      await env.clock.sleep(2 * HOUR);
      env.server.tokenHandler = () => {
        throw new TypeError("NetworkError when attempting to fetch resource.");
      };

      await assert.rejects(env.api.makeRequest("/api/banner"));
      assert.ok(env.settings.refreshToken);

      env.server.tokenHandler = null;
      await env.advance(2 * MIN);
      assertLoggedIn(env);
    });

    test("a 403 permission error does not log out", async () => {
      const env = await loadBackground(build, {
        storageFromServer: loggedInSession(),
      });
      env.server.apiHandler = (req) =>
        req.path.startsWith("/api/v1/secretmanager")
          ? { status: 403, body: { message: "Access denied" } }
          : undefined;

      await assert.rejects(
        env.api.makeRequest("/api/v1/secretmanager/vault"),
        /403/,
      );
      assertLoggedIn(env);
      assert.equal(refreshGrants(env).length, 0);
    });

    test("a 403 step-up challenge (PE-0028) does not log out", async () => {
      const env = await loadBackground(build, {
        storageFromServer: loggedInSession(),
      });
      env.server.apiHandler = (req) =>
        req.method === "POST" && req.path.startsWith("/api/access/")
          ? {
              status: 403,
              body: {
                errorCode: "PE-0028",
                message: "Step up authentication required",
              },
            }
          : undefined;

      await env.sendMessage({
        action: "checkoutAccess",
        papId: "pap1",
        environmentId: "env1",
      });
      assertLoggedIn(env);
    });

    test("a rejected OTP is not replayed and does not log out", async () => {
      const env = await loadBackground(build, {
        storageFromServer: loggedInSession(),
      });
      env.server.apiHandler = (req) =>
        req.path === "/api/step-up/authenticate/TOTP"
          ? { status: 401, body: { message: "Invalid OTP" } }
          : undefined;

      const result = await env.sendMessage({
        action: "checkoutAccess",
        papId: "pap1",
        environmentId: "env1",
        otp: "123456",
      });

      assert.match(result.error, /Step-up authentication failed/);
      const otpPosts = env.server
        .apiRequests()
        .filter((r) => r.path === "/api/step-up/authenticate/TOTP");
      assert.equal(otpPosts.length, 1);
      assert.equal(refreshGrants(env).length, 0);
      assertLoggedIn(env);
    });

    test("startup with an expired access token refreshes and restores", async () => {
      const env = await loadBackground(build, {
        storageFromServer: (server, clock) => {
          const storage = loggedInSession()(server, clock);
          storage.britiveSettings.expirationTime = clock.now - MIN;
          return storage;
        },
      });
      await env.advance(0);
      assert.equal(refreshGrants(env).length, 1);
      assertLoggedIn(env);
    });

    test("logout clears the session and only the WebSocket auth cookie", async () => {
      const env = await loadBackground(build, {
        storageFromServer: loggedInSession(),
      });
      await env.ext.api.cookies.set({
        url: `${BASE_URL}/`,
        name: "auth",
        value: "web-ui-session",
        path: "/",
      });
      await env.ext.api.cookies.set({
        url: `${BASE_URL}/api/websocket/`,
        name: "auth",
        value: env.api.bearerToken,
        path: "/api/websocket/",
      });

      const result = await env.sendMessage({ action: "logout" });

      assert.equal(result.success, true);
      assertLoggedOut(env);
      assert.deepEqual(
        env.ext.cookies.map((c) => [c.path, c.value]),
        [["/", "web-ui-session"]],
      );
    });
  });
}
