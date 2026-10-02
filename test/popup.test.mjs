// Popup UI: login, My Access (render, checkout flows, search), My Approvals,
// My Secrets, and logout. The background is faked per test via handlers.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { BUILDS } from "./harness.mjs";
import { loadPage } from "./dom.mjs";

const accessItem = (papId, environmentId, app, profile, env, extra = {}) => ({
  papId,
  environmentId,
  application: { appName: app, applicationType: "AWS" },
  profile: { papName: profile },
  environment: { environmentName: env },
  myAccessDetails: [{ accessType: "CONSOLE", status: "available" }],
  ...extra,
});

const ACCESS = [
  accessItem("pap-admin", "env-prod", "AWS Prod", "Admin", "prod-123"),
  accessItem("pap-admin", "env-stage", "AWS Prod", "Admin", "stage-456"),
  accessItem("pap-ro", "env-prod", "AWS Prod", "ReadOnly", "prod-123"),
  accessItem("pap-gcp", "env-gcp", "GCP", "Viewer", "my-project"),
  // CLI-only access is not shown in the popup.
  {
    ...accessItem("pap-cli", "env-cli", "AWS CLI", "Programmatic", "cli"),
    myAccessDetails: [{ accessType: "PROGRAMMATIC", status: "available" }],
  },
];

// A fake background with enough behavior for the popup's flows.
function fakeBackground(overrides = {}) {
  const state = { checkedOut: [], access: structuredClone(ACCESS) };
  const handlers = {
    checkAuthenticationStatus: () => ({ authenticated: true }),
    getUserProfile: () => ({
      profile: { userId: "u1", name: "Ada Lovelace", email: "ada@acme.test" },
    }),
    getAccess: () => ({ access: { items: state.access } }),
    getCheckedOutProfiles: () => ({ checkedOut: state.checkedOut }),
    getCheckoutExpirations: () => ({ expirations: {} }),
    getProfileSettings: () => ({ settings: {} }),
    checkoutAccess: (m) => {
      state.checkedOut.push({
        papId: m.papId,
        environmentId: m.environmentId,
        transactionId: "tx-1",
        accessType: "CONSOLE",
        status: "checkedOut",
      });
      return { success: true, data: {} };
    },
    getAccessUrl: () => ({ url: "https://signin.aws.amazon.com/federation?x=1" }),
    checkinAccess: () => ({ success: true }),
    searchAccess: () => ({ items: [] }),
    getCachedApprovals: () => ({ approvals: null }),
    getApprovals: () => ({ approvals: [] }),
    approveRequest: () => ({ success: true }),
    rejectRequest: () => ({ success: true }),
    getSecrets: () => ({ secrets: [] }),
    getSecretTemplates: () => ({ allTypes: [] }),
    getPasswordManagerCandidates: () => ({ candidates: [] }),
    drainNotificationQueue: () => ({ notifications: [] }),
    startOAuthLogin: () => ({ success: true }),
    logout: () => ({ success: true }),
    ...overrides,
  };
  return { state, handlers };
}

async function openPopup(build, { loggedIn = true, storage = {}, overrides } = {}) {
  const bg = fakeBackground(overrides);
  const page = await loadPage(build, {
    html: "popup/popup.html",
    scripts: ["popup/popup.js"],
    url: "ext://test/popup/popup.html",
    storage: {
      britiveSettings: { tenant: "acme", authenticated: loggedIn },
      ...storage,
    },
    handlers: bg.handlers,
  });
  await page.settle(100);
  return Object.assign(page, { bg });
}

const isHidden = (el) => el.classList.contains("hidden");
const envRow = (page, papId, envId) =>
  page.$(`.access-env-row[data-pap-id="${papId}"][data-environment-id="${envId}"]`);
const visibleRows = (page) =>
  page.$$(".access-env-row").filter((r) => {
    for (let el = r; el; el = el.parentElement) if (el.style?.display === "none") return false;
    return true;
  });

for (const build of BUILDS) {
  describe(`${build}: popup login`, () => {
    test("shows the login form, pre-filled with the last tenant", async () => {
      const page = await openPopup(build, { loggedIn: false });
      assert.equal(isHidden(page.$("#auth-view")), false);
      assert.equal(isHidden(page.$("#main-view")), true);
      assert.equal(page.$("#tenant").value, "acme");
      assert.deepEqual(page.sentActions(), [], "no API calls while logged out");
    });

    test("logs in with a normalized tenant and loads My Access", async () => {
      const page = await openPopup(build, { loggedIn: false });
      page.$("#tenant").value = "  ACME  ";
      page.$("#auth-form").dispatchEvent(
        new page.window.Event("submit", { bubbles: true, cancelable: true }),
      );
      await page.settle();
      assert.deepEqual(page.lastSent("startOAuthLogin"), {
        action: "startOAuthLogin",
        tenant: "acme",
      });
      assert.equal(page.$("#auth-success").textContent, "Authenticated!");

      await page.settle(1000);
      assert.equal(isHidden(page.$("#main-view")), false);
      assert.ok(page.lastSent("getAccess"));
      assert.ok(page.$$(".access-env-row").length > 0);
    });

    for (const tenant of ["", "evil.com/", "acme corp"]) {
      test(`refuses tenant ${JSON.stringify(tenant)}`, async () => {
        const page = await openPopup(build, { loggedIn: false });
        page.$("#tenant").value = tenant;
        page.$("#auth-form").dispatchEvent(
          new page.window.Event("submit", { bubbles: true, cancelable: true }),
        );
        await page.settle();
        assert.equal(page.lastSent("startOAuthLogin"), undefined);
        assert.equal(isHidden(page.$("#auth-error")), false);
      });
    }

    test("shows the error and re-enables the form when login fails", async () => {
      const page = await openPopup(build, {
        loggedIn: false,
        overrides: { startOAuthLogin: () => ({ success: false, error: "Tenant not found" }) },
      });
      page.$("#auth-form").dispatchEvent(
        new page.window.Event("submit", { bubbles: true, cancelable: true }),
      );
      await page.settle();
      assert.equal(page.$("#auth-error").textContent, "Tenant not found");
      const submit = page.$('#auth-form button[type="submit"]');
      assert.equal(submit.disabled, false);
      assert.equal(submit.textContent, "Log In");
    });

    test("shows a login already in progress", async () => {
      const page = await openPopup(build, {
        loggedIn: false,
        storage: {
          britiveAuth: { loginInProgress: true, startTime: Date.now(), tenant: "acme" },
        },
      });
      assert.equal(isHidden(page.$("#auth-pending")), false);
      assert.equal(page.$('#auth-form button[type="submit"]').disabled, true);
    });
  });

  describe(`${build}: popup My Access`, () => {
    test("groups console access by app and profile, skipping CLI-only access", async () => {
      const page = await openPopup(build);
      const tree = page.$$(".access-group").map((g) => [
        g.querySelector(".access-group-title").textContent,
        [...g.querySelectorAll(".access-profile-section")].map((s) => [
          s.querySelector(".access-profile-name").textContent,
          [...s.querySelectorAll(".access-env-name")].map((e) => e.textContent),
        ]),
      ]);
      assert.deepEqual(tree, [
        [
          "AWS Prod",
          [
            ["Admin", ["prod-123", "stage-456"]],
            ["ReadOnly", ["prod-123"]],
          ],
        ],
        ["GCP", [["Viewer", ["my-project"]]]],
      ]);
    });

    test("renders names from the API as text, not HTML", async () => {
      const page = await openPopup(build, {
        overrides: {
          getAccess: () => ({
            access: {
              items: [
                accessItem("p", "e", '<img src=x onerror="window.pwned=1">', "<b>p</b>", "<i>e</i>"),
              ],
            },
          }),
        },
      });
      const list = page.$("#access-list");
      assert.equal(list.querySelector("img[src='x'], b, i"), null);
      assert.match(list.textContent, /<img src=x/);
      assert.equal(page.window.pwned, undefined);
    });

    test("marks checked-out profiles", async () => {
      const page = await openPopup(build, {
        overrides: {
          getCheckedOutProfiles: () => ({
            checkedOut: [
              {
                papId: "pap-ro",
                environmentId: "env-prod",
                transactionId: "tx-9",
                accessType: "CONSOLE",
              },
            ],
          }),
        },
      });
      const toggle = (p, e) => envRow(page, p, e).querySelector(".access-toggle");
      assert.ok(toggle("pap-ro", "env-prod").classList.contains("on"));
      assert.ok(toggle("pap-admin", "env-prod").classList.contains("off"));
    });

    test("checks out directly when no extra input is required, then opens the console", async () => {
      const page = await openPopup(build);
      await page.click(envRow(page, "pap-admin", "env-prod").querySelector(".access-toggle"));
      await page.settle(2000);

      assert.deepEqual(page.lastSent("checkoutAccess"), {
        action: "checkoutAccess",
        papId: "pap-admin",
        environmentId: "env-prod",
      });
      assert.deepEqual(page.lastSent("getAccessUrl"), {
        action: "getAccessUrl",
        transactionId: "tx-1",
      });
      assert.deepEqual(page.tabsCreated, [
        { url: "https://signin.aws.amazon.com/federation?x=1" },
      ]);
      const toggle = envRow(page, "pap-admin", "env-prod").querySelector(".access-toggle");
      assert.ok(toggle.classList.contains("on"));
    });

    test("never opens a non-http console URL", async () => {
      const page = await openPopup(build, {
        overrides: { getAccessUrl: () => ({ url: "javascript:alert(1)" }) },
      });
      await page.click(envRow(page, "pap-admin", "env-prod").querySelector(".access-toggle"));
      await page.settle(2000);
      assert.ok(page.lastSent("getAccessUrl"));
      assert.deepEqual(page.tabsCreated, []);
    });

    test("asks for a justification when the profile requires one", async () => {
      const page = await openPopup(build, {
        overrides: {
          getProfileSettings: () => ({
            settings: { justificationSetting: { isJustificationRequiredAtCheckout: true } },
          }),
        },
      });
      await page.click(envRow(page, "pap-admin", "env-prod").querySelector(".access-toggle"));
      assert.equal(isHidden(page.$("#checkout-modal")), false);
      assert.equal(isHidden(page.$("#checkout-field-justification")), false);
      assert.equal(isHidden(page.$("#checkout-field-otp")), true);

      await page.click("#checkout-modal-submit");
      assert.equal(page.$("#checkout-modal-error").textContent, "Justification is required.");
      assert.equal(page.lastSent("checkoutAccess"), undefined);

      page.$("#checkout-justification").value = "x".repeat(256);
      await page.click("#checkout-modal-submit");
      assert.match(page.$("#checkout-modal-error").textContent, /cannot exceed 255/);

      page.$("#checkout-justification").value = "  INC-42 hotfix  ";
      await page.click("#checkout-modal-submit");
      await page.settle(2000);
      assert.deepEqual(page.lastSent("checkoutAccess"), {
        action: "checkoutAccess",
        papId: "pap-admin",
        environmentId: "env-prod",
        justification: "INC-42 hotfix",
      });
    });

    test("prompts for an OTP when the checkout needs step-up auth", async () => {
      let calls = 0;
      const page = await openPopup(build);
      const checkout = page.bg.handlers.checkoutAccess;
      page.handlers.checkoutAccess = (m) =>
        ++calls === 1 ? { error: "PE-0028", stepUpRequired: true } : checkout(m);

      await page.click(envRow(page, "pap-admin", "env-prod").querySelector(".access-toggle"));
      assert.equal(isHidden(page.$("#checkout-modal")), false);
      assert.equal(isHidden(page.$("#checkout-field-otp")), false);

      await page.click("#checkout-modal-submit");
      assert.equal(page.$("#checkout-modal-error").textContent, "One-time passcode is required.");

      page.$("#checkout-otp").value = "123456";
      await page.click("#checkout-modal-submit");
      await page.settle(2000);
      assert.deepEqual(page.lastSent("checkoutAccess"), {
        action: "checkoutAccess",
        papId: "pap-admin",
        environmentId: "env-prod",
        otp: "123456",
      });
    });

    test("shows the error and re-enables the toggle when checkout fails", async () => {
      const page = await openPopup(build, {
        overrides: { checkoutAccess: () => ({ error: "Profile is disabled" }) },
      });
      const row = envRow(page, "pap-admin", "env-prod");
      await page.click(row.querySelector(".access-toggle"));
      await page.settle();
      assert.match(page.$("#toast-container").textContent, /Profile is disabled/);
      assert.equal(row.querySelector(".access-toggle").disabled, false);
      assert.deepEqual(page.tabsCreated, []);
    });

    test("checking in sends the transaction id", async () => {
      const page = await openPopup(build, {
        overrides: {
          getCheckedOutProfiles: () => ({
            checkedOut: [
              { papId: "pap-ro", environmentId: "env-prod", transactionId: "tx-9", accessType: "CONSOLE" },
            ],
          }),
        },
      });
      await page.click(envRow(page, "pap-ro", "env-prod").querySelector(".access-toggle"));
      await page.settle(2000);
      assert.deepEqual(page.lastSent("checkinAccess"), {
        action: "checkinAccess",
        transactionId: "tx-9",
      });
    });

    test("search filters rows locally and queries the server after 3 characters", async () => {
      const page = await openPopup(build);
      await page.type("#search-access", "stage");
      assert.deepEqual(
        visibleRows(page).map((r) => r.querySelector(".access-env-name").textContent),
        ["stage-456"],
      );
      assert.equal(page.lastSent("searchAccess"), undefined, "debounced");
      await page.settle(300);
      assert.deepEqual(page.lastSent("searchAccess"), {
        action: "searchAccess",
        searchText: "stage",
      });

      await page.type("#search-access", "");
      assert.equal(visibleRows(page).length, 4);
    });
  });

  describe(`${build}: popup My Approvals`, () => {
    const approval = (extra = {}) => ({
      requestId: "req-1",
      trackingId: "BRV-1001",
      userId: "grace@acme.test",
      resourceName: "AWS Prod / Admin",
      justification: "Deploy hotfix",
      createdAt: new Date().toISOString(),
      context: { tenantUrl: "https://acme.britive-app.com" },
      ...extra,
    });

    async function openApprovals(build, list) {
      const page = await openPopup(build, {
        overrides: { getApprovals: () => ({ approvals: list }) },
      });
      await page.click('.tab[data-tab="approvals"]');
      await page.settle(100);
      return page;
    }

    test("lists pending requests with requester and justification", async () => {
      const page = await openApprovals(build, [approval()]);
      const item = page.$(".approval-item");
      assert.equal(item.dataset.id, "req-1");
      assert.match(item.textContent, /grace@acme\.test/);
      assert.match(item.textContent, /AWS Prod \/ Admin/);
      assert.match(item.textContent, /Deploy hotfix/);
    });

    test("approving takes two clicks and sends the comment", async () => {
      const page = await openApprovals(build, [approval()]);
      const item = page.$(".approval-item");
      await page.click(item.querySelector(".btn-approve"));
      assert.equal(page.lastSent("approveRequest"), undefined, "first click opens the comment");
      assert.ok(item.querySelector(".approval-comment").classList.contains("visible"));

      item.querySelector(".approval-comment").value = "  looks good ";
      await page.click(item.querySelector(".btn-approve"));
      assert.deepEqual(page.lastSent("approveRequest"), {
        action: "approveRequest",
        requestId: "req-1",
        comments: "looks good",
      });
    });

    test("rejecting sends rejectRequest", async () => {
      const page = await openApprovals(build, [approval()]);
      const item = page.$(".approval-item");
      await page.click(item.querySelector(".btn-reject"));
      await page.click(item.querySelector(".btn-reject"));
      assert.deepEqual(page.lastSent("rejectRequest"), {
        action: "rejectRequest",
        requestId: "req-1",
        comments: "",
      });
    });

    test("links the tracking id only to the configured tenant", async () => {
      const page = await openApprovals(build, [
        approval(),
        approval({
          requestId: "req-2",
          trackingId: "BRV-2",
          context: { tenantUrl: "https://acme.britive-app.com.evil.test" },
        }),
        approval({
          requestId: "req-3",
          trackingId: "BRV-3",
          context: { tenantUrl: "http://acme.britive-app.com" },
        }),
      ]);
      const link = (id) => page.$(`.approval-item[data-id="${id}"] a.approval-link`);
      assert.ok(link("req-1"));
      assert.equal(link("req-2"), null);
      assert.equal(link("req-3"), null);

      await page.click(link("req-1"));
      assert.deepEqual(page.tabsCreated, [
        { url: "https://acme.britive-app.com/my-approvals/view/req-1" },
      ]);
    });
  });

  describe(`${build}: popup My Secrets`, () => {
    test("shows only the selected secret types, as text", async () => {
      const page = await openPopup(build, {
        overrides: {
          getSecrets: () => ({
            secrets: [
              { name: "GitHub", path: "/pm/github", secretType: "Password Manager" },
              { name: "<b>Wiki</b>", path: "/web/wiki", secretType: "GenericWebApp" },
              { name: "Deploy key", path: "/ssh/deploy", secretType: "SSH Key" },
            ],
          }),
        },
      });
      await page.click('.tab[data-tab="secrets"]');
      await page.settle(100);
      const names = page.$$("#secrets-list .secret-name").map((n) => n.textContent);
      assert.deepEqual(names, ["GitHub", "<b>Wiki</b>"]);
      assert.equal(page.$("#secrets-list b"), null);
    });
  });

  describe(`${build}: popup session`, () => {
    test("logout from the sidebar clears the UI and returns to the login form", async () => {
      const page = await openPopup(build);
      assert.ok(page.$$(".access-env-row").length > 0);
      await page.click("#open-sidebar");
      await page.settle(100);
      await page.click("#sb-logout");
      await page.settle(500);

      assert.ok(page.lastSent("logout"));
      assert.equal(isHidden(page.$("#auth-view")), false);
      assert.equal(isHidden(page.$("#main-view")), true);
      assert.equal(page.$$(".access-env-row").length, 0);
    });

    test("hides tabs that are turned off in settings", async () => {
      const page = await openPopup(build, {
        storage: { extensionSettings: { tabSecrets: false } },
      });
      assert.equal(isHidden(page.$('.tab[data-tab="secrets"]')), true);
      assert.equal(isHidden(page.$('.tab[data-tab="access"]')), false);
      assert.equal(page.lastSent("getSecrets"), undefined);
    });

    test("shows the tenant banner from the background", async () => {
      const page = await openPopup(build, {
        storage: {
          britiveBanner: { message: "<b>Maintenance</b> tonight", messageType: "WARNING" },
        },
      });
      const banner = page.$("#banner");
      assert.equal(isHidden(banner), false);
      assert.match(banner.textContent, /<b>Maintenance<\/b> tonight/);
      assert.equal(banner.querySelector("b"), null);
    });

    test("shows the extension version", async () => {
      const page = await openPopup(build);
      const { version } = page.window[build === "firefox" ? "browser" : "chrome"].runtime.getManifest();
      assert.equal(page.$("#footer-version").textContent, `v${version}`);
    });
  });
}
