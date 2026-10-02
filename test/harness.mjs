// Loads a build's background.js into an isolated VM context with a fake
// WebExtension API, a fake Britive tenant behind fetch(), and a virtual clock.
//
// The clock models how the browser behaves across a laptop sleep: wall-clock
// time jumps forward, but pending timers are pushed back by the same amount
// because they only count time the machine was awake.

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const BUILDS = ["firefox", "chrome"];
export const TENANT = "acme";
export const BASE_URL = `https://${TENANT}.britive-app.com`;
const HOUR = 60 * 60 * 1000;

// ── Clock ──

export function createClock(start) {
  let now = start;
  let nextId = 1;
  const timers = new Map(); // id -> { due, fn, args, interval }

  function schedule(fn, delay, args, interval) {
    const id = nextId++;
    const ms = Math.max(Number(delay) || 0, 0);
    timers.set(id, { due: now + ms, fn, args, interval: interval ? ms : 0 });
    return id;
  }

  return {
    get now() {
      return now;
    },
    setTimeout: (fn, delay, ...args) => schedule(fn, delay, args, false),
    setInterval: (fn, delay, ...args) => schedule(fn, delay, args, true),
    clearTimeout: (id) => timers.delete(id),
    clearInterval: (id) => timers.delete(id),
    pending: () => [...timers.values()].map((t) => t.due - now),
    // Advance wall-clock time and run every timer that comes due, in order.
    async advance(ms) {
      const target = now + ms;
      for (;;) {
        await flush();
        let nextIdKey = null;
        let next = null;
        for (const [id, t] of timers) {
          if (t.due <= target && (!next || t.due < next.due)) {
            nextIdKey = id;
            next = t;
          }
        }
        if (!next) break;
        now = Math.max(now, next.due);
        if (next.interval) next.due = now + Math.max(next.interval, 1);
        else timers.delete(nextIdKey);
        next.fn(...next.args);
      }
      now = target;
      await flush();
    },
    // Wall clock jumps; timers don't fire and are delayed by the sleep length.
    async sleep(ms) {
      now += ms;
      for (const t of timers.values()) t.due += ms;
      await flush();
    },
  };
}

// Let promise chains and async storage/fetch mocks settle.
export async function flush(rounds = 20) {
  for (let i = 0; i < rounds; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

// ── Fake Britive tenant ──

// Standard base64 (not base64url) so the extension's atob() can decode it.
function b64(obj) {
  return Buffer.from(JSON.stringify(obj)).toString("base64").replace(/=+$/, "");
}

export function makeJwt(payload) {
  return `${b64({ alg: "RS256", typ: "JWT" })}.${b64(payload)}.signature`;
}

function createServer(clock) {
  let seq = 0;
  const accessTokens = new Map(); // token -> exp ms
  const refreshTokens = new Set();

  const server = {
    requests: [],
    accessTokenLifetimeMs: HOUR,
    // Override to change how the token endpoint responds, e.g. to return a
    // 503 or invalid_grant. Receives the parsed form body.
    tokenHandler: null,
    // Override to change how API requests respond. Return undefined to fall
    // through to the default (401 for an unknown or expired bearer token).
    apiHandler: null,
    // Hold token responses until release() is called, to test concurrency.
    holdTokenResponses: false,
    held: [],

    issueAccessToken() {
      const exp = clock.now + server.accessTokenLifetimeMs;
      const token = makeJwt({
        type: "browser-extension",
        iat: Math.floor(clock.now / 1000),
        exp: Math.floor(exp / 1000),
        jti: `a${++seq}`,
      });
      accessTokens.set(token, exp);
      return { token, exp: Math.floor(exp / 1000) * 1000 };
    },
    issueRefreshToken() {
      const token = `refresh-${++seq}`;
      refreshTokens.add(token);
      return token;
    },
    revokeRefreshToken(token) {
      refreshTokens.delete(token);
    },
    isAccessTokenValid(token) {
      const exp = accessTokens.get(token);
      return exp !== undefined && clock.now < exp;
    },
    release() {
      const held = server.held.splice(0);
      for (const fn of held) fn();
    },
    tokenRequests: () =>
      server.requests.filter((r) => r.path === "/api/auth/sso/oauth2/token"),
    apiRequests: () =>
      server.requests.filter((r) => r.path !== "/api/auth/sso/oauth2/token"),
  };

  function respond(status, body, headers = {}) {
    const text = typeof body === "string" ? body : JSON.stringify(body ?? "");
    const h = { "content-type": "application/json", ...headers };
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name) => h[name.toLowerCase()] ?? null },
      text: async () => text,
      json: async () => JSON.parse(text),
    };
  }

  function defaultTokenHandler(form) {
    if (form.grant_type === "refresh_token") {
      if (!refreshTokens.has(form.refresh_token)) {
        return { status: 400, body: { error: "invalid_grant" } };
      }
      const { token } = server.issueAccessToken();
      return {
        status: 200,
        body: {
          access_token: token,
          refresh_token: form.refresh_token,
          token_type: "Bearer",
        },
      };
    }
    return { status: 400, body: { error: "unsupported_grant_type" } };
  }

  server.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const headers = init.headers || {};
    const auth = headers.Authorization || headers.authorization || "";
    const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    const req = {
      method: init.method || "GET",
      path: url.pathname,
      url: String(input),
      bearer,
      body: init.body,
      at: clock.now,
    };
    server.requests.push(req);
    await Promise.resolve();

    if (url.pathname === "/api/auth/sso/oauth2/token") {
      const form = Object.fromEntries(new URLSearchParams(init.body || ""));
      req.form = form;
      if (server.holdTokenResponses) {
        await new Promise((resolve) => server.held.push(resolve));
      }
      const r = (server.tokenHandler || defaultTokenHandler)(form, req);
      return respond(r.status, r.body);
    }

    if (url.pathname === "/api/health") return respond(200, { status: "UP" });

    if (server.apiHandler) {
      const r = server.apiHandler(req);
      if (r) return respond(r.status, r.body);
    }
    if (!bearer || !server.isAccessTokenValid(bearer)) {
      return respond(401, {
        status: 401,
        error: "Unauthorized",
        message: "An error occurred during authentication. Please login again.",
        path: url.pathname,
      });
    }
    return respond(200, defaultApiBody(url.pathname));
  };

  return server;
}

function defaultApiBody(pathname) {
  if (pathname === "/api/banner") return {};
  if (pathname.startsWith("/api/v1/approvals")) return [];
  if (pathname.startsWith("/api/access")) return [];
  return {};
}

// ── Fake WebExtension API ──

function createExtensionApi(build, clock, initialStorage) {
  const listeners = new Map(); // "runtime.onMessage" -> [fn]
  const local = structuredClone(initialStorage);
  const notifications = [];
  const cookies = [];
  const alarms = new Map();

  const event = (name) => ({
    addListener: (fn) => {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(fn);
    },
    removeListener: (fn) => {
      const list = listeners.get(name) || [];
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    },
    hasListener: (fn) => (listeners.get(name) || []).includes(fn),
  });

  const pick = (keys) => {
    if (keys == null) return structuredClone(local);
    const names =
      typeof keys === "string"
        ? [keys]
        : Array.isArray(keys)
          ? keys
          : Object.keys(keys);
    const out = {};
    for (const k of names) {
      if (k in local) out[k] = structuredClone(local[k]);
      else if (keys && typeof keys === "object" && !Array.isArray(keys)) {
        out[k] = keys[k];
      }
    }
    return out;
  };

  const storageArea = (backing) => ({
    get: async (keys) => (backing === local ? pick(keys) : {}),
    set: async (items) => {
      Object.assign(backing, structuredClone(items));
    },
    remove: async (keys) => {
      for (const k of [].concat(keys)) delete backing[k];
    },
    clear: async () => {
      for (const k of Object.keys(backing)) delete backing[k];
    },
  });

  const explicit = {
    storage: {
      local: storageArea(local),
      session: storageArea({}),
      onChanged: event("storage.onChanged"),
    },
    runtime: {
      id: "test-extension",
      getManifest: () =>
        JSON.parse(
          fs.readFileSync(path.join(ROOT, build, "manifest.json"), "utf8"),
        ),
      getURL: (p) => `ext://test/${p}`,
      sendMessage: async () => undefined,
      getContexts: async () => [],
      lastError: undefined,
    },
    identity: {
      getRedirectURL: () => "https://test.extensions.example/",
    },
    notifications: {
      create: (id, options) => {
        notifications.push({ id, ...options });
        return Promise.resolve(id);
      },
      clear: async () => true,
    },
    cookies: {
      set: async (details) => {
        const p = details.path || "/";
        const i = cookies.findIndex(
          (c) => c.url === details.url && c.name === details.name && c.path === p,
        );
        const cookie = { ...details, path: p, storeId: "default" };
        if (i >= 0) cookies[i] = cookie;
        else cookies.push(cookie);
        return cookie;
      },
      getAll: async ({ url, name }) =>
        cookies.filter(
          (c) =>
            (!name || c.name === name) &&
            (!url || new URL(url).host === new URL(c.url).host),
        ),
      remove: async ({ url, name }) => {
        // Like the real API, remove the cookie whose path best matches url.
        const urlPath = new URL(url).pathname;
        const matches = cookies
          .map((c, i) => ({ c, i }))
          .filter(
            ({ c }) =>
              c.name === name &&
              new URL(c.url).host === new URL(url).host &&
              urlPath.startsWith(c.path),
          )
          .sort((a, b) => b.c.path.length - a.c.path.length);
        if (matches.length) cookies.splice(matches[0].i, 1);
        return matches.length ? { url, name } : null;
      },
    },
    alarms: {
      create: (name, info = {}) => {
        const when =
          info.when ?? clock.now + (info.delayInMinutes || 0) * 60 * 1000;
        alarms.set(name, { name, scheduledTime: when, ...info });
      },
      clear: async (name) => alarms.delete(name),
      clearAll: async () => alarms.clear(),
      get: async (name) => alarms.get(name),
      getAll: async () => [...alarms.values()],
    },
    tabs: {
      query: async () => [],
      create: async (props) => ({ id: 1, ...props }),
      update: async () => ({}),
      remove: async () => undefined,
      get: async () => ({}),
    },
    windows: { getAll: async () => [] },
  };

  // Anything not mocked explicitly: `on*` properties are events, everything
  // else is a callable namespace whose calls resolve to undefined.
  function namespace(prefix, base = {}) {
    return new Proxy(base, {
      get(target, prop) {
        if (typeof prop === "symbol") return target[prop];
        if (prop in target) {
          const v = target[prop];
          return v && typeof v === "object" && !Array.isArray(v)
            ? namespace(prefix ? `${prefix}.${prop}` : prop, v)
            : v;
        }
        if (prop === "then") return undefined;
        const name = prefix ? `${prefix}.${prop}` : prop;
        if (/^on[A-Z]/.test(prop)) {
          target[prop] = event(name);
          return target[prop];
        }
        const fn = () => Promise.resolve(undefined);
        target[prop] = new Proxy(fn, {
          get: (_, p) => (p === "then" ? undefined : namespace(`${name}.${p}`)[p]),
        });
        return target[prop];
      },
    });
  }

  return {
    api: namespace("", explicit),
    listeners,
    local,
    notifications,
    cookies,
    alarms,
  };
}

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances = [];
  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    FakeWebSocket.instances.push(this);
  }
  send() {}
  close() {
    this.readyState = FakeWebSocket.CLOSED;
  }
}

// ── Loader ──

/**
 * @param {"firefox"|"chrome"} build
 * @param {object} [opts]
 * @param {object} [opts.storage] initial browser.storage.local contents
 * @param {(server, clock) => object} [opts.storageFromServer] build initial
 *   storage using tokens issued by the fake server (e.g. a logged-in session)
 */
export async function loadBackground(build, opts = {}) {
  const clock = createClock(Date.UTC(2026, 9, 1, 21, 0, 0));
  const server = createServer(clock);
  const initialStorage = opts.storageFromServer
    ? opts.storageFromServer(server, clock)
    : opts.storage || {};
  const ext = createExtensionApi(build, clock, initialStorage);

  const RealDate = Date;
  class FakeDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(clock.now);
      else super(...args);
    }
    static now() {
      return clock.now;
    }
  }

  const errors = [];
  const quiet = {
    log() {},
    info() {},
    debug() {},
    warn() {},
    error: (...args) => errors.push(args),
  };

  const sandbox = {
    console: quiet,
    fetch: server.fetch,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
    Date: FakeDate,
    WebSocket: FakeWebSocket,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    AbortSignal,
    AbortController,
    crypto: globalThis.crypto,
    atob,
    btoa,
    structuredClone,
    queueMicrotask,
    navigator: { userAgent: "node-test" },
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox[build === "firefox" ? "browser" : "chrome"] = ext.api;

  const file = path.join(ROOT, build, "background.js");
  const source = fs.readFileSync(file, "utf8");
  vm.createContext(sandbox);
  // __eval runs inside the script's top-level scope, so tests can reach
  // let/const/class bindings (e.g. britiveAPI) that aren't on globalThis.
  vm.runInContext(`${source}\n;globalThis.__eval = (expr) => eval(expr);`, sandbox, {
    filename: file,
  });
  await flush();

  const env = {
    build,
    clock,
    server,
    ext,
    errors,
    get: (expr) => sandbox.__eval(expr),
    get api() {
      return sandbox.__eval("britiveAPI");
    },
    get settings() {
      return ext.local.britiveSettings;
    },
    // Deliver a runtime message the way the popup does.
    async sendMessage(message, sender = { id: "test-extension" }) {
      const fns = ext.listeners.get("runtime.onMessage") || [];
      for (const fn of fns) {
        let sent;
        const replied = new Promise((resolve) => {
          sent = resolve;
        });
        const ret = fn(message, sender, sent);
        if (ret === true) return await replied;
        if (ret && typeof ret.then === "function") {
          const value = await ret;
          if (value !== undefined) return value;
        }
      }
      return undefined;
    },
    // Fire a chrome.alarms alarm by name.
    async fireAlarm(name) {
      const alarm = ext.alarms.get(name) || { name, scheduledTime: clock.now };
      ext.alarms.delete(name);
      for (const fn of ext.listeners.get("alarms.onAlarm") || []) {
        await fn(alarm);
      }
      await flush();
    },
    // Fire every alarm whose wall-clock time has passed. Alarms are wall-clock
    // based, so the browser fires overdue ones on wake.
    async fireDueAlarms() {
      const due = [...ext.alarms.values()]
        .filter((a) => a.scheduledTime <= clock.now)
        .sort((a, b) => a.scheduledTime - b.scheduledTime);
      for (const a of due) await env.fireAlarm(a.name);
    },
    // Advance awake time: timers and alarms fire as they come due. Steps in
    // small chunks so alarms interleave with timers at roughly the right time.
    async advance(ms) {
      const step = 15 * 1000;
      let remaining = ms;
      do {
        const chunk = Math.min(step, remaining);
        await clock.advance(chunk);
        await env.fireDueAlarms();
        remaining -= chunk;
      } while (remaining > 0);
    },
    // Put the machine to sleep for ms, then wake it.
    async sleep(ms) {
      await clock.sleep(ms);
      await env.fireDueAlarms();
    },
  };
  return env;
}

// Storage for a session that logged in at `clock.now` with a fresh token pair.
export function loggedInSession({ loggedInMinutesAgo = 10 } = {}) {
  return (server, clock) => {
    const { token, exp } = server.issueAccessToken();
    return {
      britiveSettings: {
        tenant: TENANT,
        bearerToken: token,
        refreshToken: server.issueRefreshToken(),
        expirationTime: exp,
        authenticated: true,
        authGeneration: "gen-1",
        // Outside the post-login refresh cooldown unless the test says otherwise.
        lastInteractiveLoginAt: clock.now - loggedInMinutesAgo * 60 * 1000,
        loginTimestamp: clock.now - loggedInMinutesAgo * 60 * 1000,
      },
      extensionSettings: { bannerCheck: true },
    };
  };
}
