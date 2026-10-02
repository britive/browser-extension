// Loads an extension page or content script into jsdom with a fake extension
// API. The page talks to a fake background: each runtime.sendMessage({action})
// is answered by `handlers[action]`, and every message is recorded.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { createClock, flush } from "./harness.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export { flush };

function readBuildFile(build, file) {
  return fs.readFileSync(path.join(ROOT, build, file), "utf8");
}

function cssEscape(value) {
  return String(value).replace(/[^a-zA-Z0-9_ -￿-]/g, (c) => `\\${c}`);
}

// jsdom has no layout engine. Treat an element as laid out (100x24 at the
// origin) unless it, or an ancestor, is hidden or display:none.
function installLayout(window) {
  const { HTMLElement, Element } = window;
  Element.prototype.getBoundingClientRect = function () {
    for (let el = this; el; el = el.parentElement) {
      if (el.hidden) return zeroRect();
      if (window.getComputedStyle(el).display === "none") return zeroRect();
    }
    return { x: 0, y: 0, top: 0, left: 0, right: 100, bottom: 24, width: 100, height: 24 };
  };
  Object.defineProperty(HTMLElement.prototype, "innerText", {
    configurable: true,
    get() {
      return this.textContent;
    },
    set(value) {
      this.textContent = value;
    },
  });
  HTMLElement.prototype.scrollIntoView = function () {};
  window.CSS = { escape: cssEscape, supports: () => false };
  window.matchMedia = (query) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  });
}

function zeroRect() {
  return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
}

function createPageApi(build, { storage, handlers, sent, clock }) {
  const listeners = new Map();
  const event = (name) => ({
    addListener: (fn) => {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(fn);
    },
    removeListener: () => {},
    hasListener: () => false,
  });

  const local = storage;
  const pick = (keys) => {
    if (keys == null) return structuredClone(local);
    const names =
      typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
    const out = {};
    for (const k of names) if (k in local) out[k] = structuredClone(local[k]);
    return out;
  };

  const tabsCreated = [];
  const explicit = {
    storage: {
      local: {
        get: async (keys) => pick(keys),
        set: async (items) => {
          Object.assign(local, structuredClone(items));
        },
        remove: async (keys) => {
          for (const k of [].concat(keys)) delete local[k];
        },
      },
      session: { get: async () => ({}), set: async () => {}, remove: async () => {} },
      onChanged: event("storage.onChanged"),
    },
    runtime: {
      id: "test-extension",
      getManifest: () => JSON.parse(readBuildFile(build, "manifest.json")),
      getURL: (p) => `ext://test/${p}`,
      sendMessage: async (message) => {
        // Messages are serialized in transit, which drops undefined fields.
        const wire = JSON.parse(JSON.stringify(message ?? null));
        sent.push(wire);
        const handler = handlers[wire?.action];
        await Promise.resolve();
        return handler ? handler(structuredClone(wire)) : undefined;
      },
      openOptionsPage: async () => {},
      onMessage: event("runtime.onMessage"),
    },
    tabs: {
      create: async (props) => {
        tabsCreated.push(structuredClone(props));
        return { id: tabsCreated.length, ...props };
      },
      query: async () => [],
      getCurrent: async () => ({ id: 7 }),
      remove: async () => {},
    },
    permissions: {
      request: async () => true,
      contains: async () => true,
    },
  };

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
        if (/^on[A-Z]/.test(prop)) return (target[prop] = event(name));
        const fn = () => Promise.resolve(undefined);
        return (target[prop] = new Proxy(fn, {
          get: (_, p) => (p === "then" ? undefined : namespace(`${name}.${p}`)[p]),
        }));
      },
    });
  }

  return { api: namespace("", explicit), listeners, tabsCreated, raw: explicit };
}

/**
 * @param {"firefox"|"chrome"} build
 * @param {object} opts
 * @param {string} [opts.html]     page HTML, relative to the build dir
 * @param {string} [opts.body]     HTML for a web page (content-script tests)
 * @param {string[]} opts.scripts  scripts to run, relative to the build dir
 * @param {string} [opts.url]
 * @param {object} [opts.storage]  extension storage.local contents
 * @param {object} [opts.handlers] fake background: action -> (msg) => response
 * @param {(api, window) => void} [opts.setup] customize the API before scripts run
 */
export async function loadPage(build, opts) {
  const html = opts.html
    ? readBuildFile(build, opts.html).replace(/<script\b[^>]*><\/script>/g, "")
    : `<!doctype html><html><head></head><body>${opts.body || ""}</body></html>`;
  const dom = new JSDOM(html, {
    url: opts.url || "https://example.com/",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const { window } = dom;
  installLayout(window);

  const clock = createClock(Date.now());
  window.setTimeout = clock.setTimeout;
  window.clearTimeout = clock.clearTimeout;
  window.setInterval = clock.setInterval;
  window.clearInterval = clock.clearInterval;

  const sent = [];
  const handlers = { ...(opts.handlers || {}) };
  const storage = structuredClone(opts.storage || {});
  const ext = createPageApi(build, { storage, handlers, sent, clock });
  window[build === "firefox" ? "browser" : "chrome"] = ext.api;
  const clipboard = [];
  Object.defineProperty(window.navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (text) => clipboard.push(text) },
  });
  if (opts.setup) opts.setup(ext.raw, window);

  const errors = [];
  window.addEventListener("error", (e) => errors.push(e.error || e.message));
  window.console.error = (...args) => errors.push(args);

  for (const script of opts.scripts) {
    window.eval(`${readBuildFile(build, script)}\n//# sourceURL=${build}/${script}`);
  }
  // Lets tests reach top-level let/const bindings, like the background harness.
  window.eval("window.__eval = (expr) => eval(expr);");
  // jsdom fires DOMContentLoaded and load asynchronously after construction,
  // so scripts evaluated above see a "loading" document, as in a browser.
  if (window.document.readyState !== "complete") {
    await new Promise((resolve) => window.addEventListener("load", resolve, { once: true }));
  }
  await flush();

  const page = {
    build,
    window,
    document: window.document,
    clock,
    storage,
    handlers,
    sent,
    clipboard,
    errors,
    tabsCreated: ext.tabsCreated,
    $: (sel) => window.document.querySelector(sel),
    $$: (sel) => [...window.document.querySelectorAll(sel)],
    get: (expr) => window.__eval(expr),
    sentActions: () => sent.map((m) => m.action),
    lastSent: (action) => sent.filter((m) => m.action === action).at(-1),
    async settle(ms = 0) {
      await clock.advance(ms);
      await flush();
    },
    async click(target) {
      const el = typeof target === "string" ? page.$(target) : target;
      if (!el) throw new Error(`click: no element for ${target}`);
      el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
      await flush();
    },
    async type(target, value) {
      const el = typeof target === "string" ? page.$(target) : target;
      el.value = value;
      el.dispatchEvent(new window.Event("input", { bubbles: true }));
      await flush();
    },
    // Deliver a runtime message to the page (e.g. from the background).
    async receiveMessage(message) {
      const results = [];
      for (const fn of ext.listeners.get("runtime.onMessage") || []) {
        let replied;
        const reply = new Promise((resolve) => (replied = resolve));
        const ret = fn(message, { id: "test-extension" }, replied);
        if (ret === true) results.push(await reply);
        else if (ret && typeof ret.then === "function") results.push(await ret);
      }
      await flush();
      // Copy out of the jsdom realm so deepStrictEqual compares plain objects.
      const found = results.find((r) => r !== undefined);
      return found === undefined ? undefined : structuredClone(found);
    },
  };
  return page;
}
