// Smaller extension scripts: the Firefox container picker, the Firefox CLI
// auth content script, and Chrome's offscreen WebSocket client.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { loadPage } from "./dom.mjs";

const MIN = 60 * 1000;

describe("firefox: container picker", () => {
  const authed = { authenticated: true, bearerToken: "t", tenant: "acme" };
  const pending = {
    r1: { url: "https://console.aws.amazon.com/ec2/home?region=us-west-2" },
  };
  const containers = [
    { name: "Work", colorCode: "#37adff", cookieStoreId: "firefox-container-1" },
    { name: "<b>Personal</b>", colorCode: "#ff613d", cookieStoreId: "firefox-container-2" },
  ];

  async function openPicker({ url, storage, setup } = {}) {
    const calls = { created: [], removedTabs: [] };
    const page = await loadPage("firefox", {
      html: "picker/picker.html",
      scripts: ["picker/picker.js"],
      url: url || "moz-extension://test/picker/picker.html?requestId=r1",
      storage: storage ?? { britiveSettings: authed, pendingContainerRequests: structuredClone(pending) },
      handlers: { openInContainer: () => ({ success: true }) },
      setup: (api, window) => {
        api.contextualIdentities = {
          query: async () => structuredClone(containers),
          create: async (details) => {
            calls.created.push(structuredClone(details));
            return { cookieStoreId: "firefox-container-new", ...details };
          },
        };
        api.tabs.remove = async (id) => calls.removedTabs.push(id);
        if (setup) setup(api, window);
      },
    });
    await page.settle();
    return Object.assign(page, { calls });
  }

  test("refuses to run outside a moz-extension page", async () => {
    const page = await openPicker({ url: "https://evil.test/picker.html?requestId=r1" });
    assert.equal(page.document.body.textContent, "");
    assert.deepEqual(page.sentActions(), []);
  });

  test("shows the destination and lists containers as text", async () => {
    const page = await openPicker();
    assert.equal(page.$("#destination").textContent, "console.aws.amazon.com/ec2/home");
    assert.deepEqual(
      page.$$(".container-name").map((n) => n.textContent),
      ["Work", "<b>Personal</b>"],
    );
    assert.equal(page.$("#container-list b"), null);
  });

  test("opening in a container sends the pending URL and request id", async () => {
    const page = await openPicker();
    await page.click(page.$$(".container-item")[0]);
    assert.deepEqual(page.lastSent("openInContainer"), {
      action: "openInContainer",
      url: pending.r1.url,
      requestId: "r1",
      containerId: "firefox-container-1",
    });
  });

  test("creates a container with the chosen color, then opens in it", async () => {
    const page = await openPicker();
    await page.click(".new-container");
    assert.ok(page.$("#create-form").classList.contains("visible"));

    await page.click(".create-btn");
    assert.deepEqual(page.calls.created, [], "name is required");

    page.$("#new-container-name").value = "  Prod  ";
    await page.click('.color-option[data-color="red"]');
    await page.click(".create-btn");
    assert.deepEqual(page.calls.created, [{ name: "Prod", color: "red", icon: "circle" }]);
    assert.equal(page.lastSent("openInContainer").containerId, "firefox-container-new");
  });

  test("cancel drops the pending request and closes the tab", async () => {
    const page = await openPicker();
    await page.click("#cancel");
    assert.deepEqual(page.storage.pendingContainerRequests, {});
    assert.deepEqual(page.calls.removedTabs, [7]);
  });

  test("when logged out, drops the pending request instead of opening it", async () => {
    const page = await openPicker({
      storage: { britiveSettings: { tenant: "acme" }, pendingContainerRequests: structuredClone(pending) },
    });
    assert.match(page.$("#container-list").textContent, /Not authenticated/);
    assert.deepEqual(page.storage.pendingContainerRequests, {});
    assert.equal(page.$$(".container-item").length, 0);
  });

  test("handles an unknown request id", async () => {
    const page = await openPicker({ url: "moz-extension://test/picker/picker.html?requestId=nope" });
    assert.match(page.$("#container-list").textContent, /No pending URL found/);
  });

  test("explains how to enable containers when the API is missing", async () => {
    const page = await openPicker({
      setup: (api) => {
        api.contextualIdentities = undefined;
      },
    });
    assert.match(page.$("#container-list").textContent, /Multi-Account Containers/);
  });

  test("only applies known banner types as CSS classes", async () => {
    const page = await openPicker({
      storage: {
        britiveSettings: authed,
        pendingContainerRequests: structuredClone(pending),
        britiveBanner: { message: "Heads up", messageType: "x onclick" },
      },
    });
    assert.equal(page.$("#banner").textContent, "Heads up");
    assert.equal(page.$("#banner").className, "banner INFO");
  });
});

describe("firefox: CLI auth page script", () => {
  const load = (url, body) =>
    loadPage("firefox", { url, body, scripts: ["cli-ready.js"] });
  const cliReadyCount = (page) => page.sentActions().filter((a) => a === "cliReady").length;

  test("tells the background when the CLI login page reports success", async () => {
    const page = await load("https://acme.britive-app.com/cli?token=x", "<h1>CLI is ready</h1>");
    assert.equal(cliReadyCount(page), 1);
  });

  test("waits for the success text to appear, and reports it once", async () => {
    const page = await load("https://acme.britive-app.com/cli", "<div id=s>Authenticating...</div>");
    assert.equal(cliReadyCount(page), 0);
    page.$("#s").textContent = "CLI is ready. You can close this tab.";
    await page.settle();
    page.document.body.append("CLI is ready");
    await page.settle();
    assert.equal(cliReadyCount(page), 1);
  });

  for (const url of ["https://acme.britive-app.com/admin", "http://acme.britive-app.com/cli"]) {
    test(`ignores ${url}`, async () => {
      const page = await load(url, "CLI is ready");
      assert.equal(cliReadyCount(page), 0);
    });
  }
});

describe("chrome: offscreen WebSocket client", () => {
  async function openOffscreen() {
    const sockets = [];
    const page = await loadPage("chrome", {
      html: "offscreen.html",
      scripts: ["offscreen.js"],
      url: "chrome-extension://test/offscreen.html",
      setup: (_api, window) => {
        window.WebSocket = class FakeSocket {
          static OPEN = 1;
          constructor(url) {
            this.url = url;
            this.readyState = 0;
            this.sent = [];
            sockets.push(this);
          }
          send(data) {
            this.sent.push(data);
          }
          close() {
            this.readyState = 3;
            this.onclose?.({ code: 1000 });
          }
          open() {
            this.readyState = 1;
            this.onopen?.();
          }
          message(data) {
            this.onmessage?.({ data });
          }
        };
      },
    });
    return Object.assign(page, { sockets });
  }
  const connect = (page) =>
    page.receiveMessage({ action: "connectWs", tenant: "acme.britive-app.com" });

  test("connects to the tenant's v2 endpoint and reports when connected", async () => {
    const page = await openOffscreen();
    await connect(page);
    assert.equal(page.sockets.length, 1);
    assert.equal(page.sockets[0].url, "wss://acme.britive-app.com/api/websocket/v2");

    page.sockets[0].open();
    await page.settle();
    assert.ok(page.lastSent("wsConnected"));
    assert.deepEqual(page.sockets[0].sent, ['["ping"]']);
  });

  test("keeps the connection alive with a ping every five minutes", async () => {
    const page = await openOffscreen();
    await connect(page);
    page.sockets[0].open();
    await page.settle(15 * MIN);
    assert.equal(page.sockets[0].sent.length, 4);
  });

  test("does not open a second socket while connecting or connected", async () => {
    const page = await openOffscreen();
    await connect(page);
    await connect(page);
    page.sockets[0].open();
    await connect(page);
    assert.equal(page.sockets.length, 1);
  });

  test("relays events in both server message formats and ignores junk", async () => {
    const page = await openOffscreen();
    await connect(page);
    page.sockets[0].open();
    page.sockets[0].message(JSON.stringify(["approvalRequested", { requestId: "r1" }]));
    page.sockets[0].message(JSON.stringify({ type: "checkoutExpired", data: { id: 2 } }));
    page.sockets[0].message("not json");
    page.sockets[0].message(JSON.stringify({ nothing: true }));
    await page.settle();
    assert.deepEqual(
      page.sent.filter((m) => m.action === "wsEventFromOffscreen"),
      [
        { action: "wsEventFromOffscreen", eventName: "approvalRequested", payload: { requestId: "r1" } },
        { action: "wsEventFromOffscreen", eventName: "checkoutExpired", payload: { id: 2 } },
      ],
    );
  });

  test("reports an unexpected close so the service worker can reconnect", async () => {
    const page = await openOffscreen();
    await connect(page);
    page.sockets[0].open();
    page.sockets[0].onclose({ code: 1006 });
    await page.settle();
    assert.ok(page.lastSent("wsDisconnected"));
    // Reconnecting is allowed after a close.
    await connect(page);
    assert.equal(page.sockets.length, 2);
  });

  test("disconnectWs closes the socket and stops pinging", async () => {
    const page = await openOffscreen();
    await connect(page);
    page.sockets[0].open();
    await page.receiveMessage({ action: "disconnectWs" });
    assert.equal(page.sockets[0].readyState, 3);
    assert.equal(page.sentActions().filter((a) => a === "wsDisconnected").length, 1);
    await page.settle(10 * MIN);
    assert.equal(page.sockets[0].sent.length, 1);
  });
});
