// Options page: auth controls, loading and saving settings, reset dialog.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { BUILDS } from "./harness.mjs";
import { loadPage } from "./dom.mjs";

const DEFAULT_TYPES = ["GenericWebApp", "Password Manager", "WebApp With OTP"];

function loadOptions(build, { authenticated = false, storage, handlers } = {}) {
  return loadPage(build, {
    html: "options/options.html",
    scripts: ["options/options.js"],
    url: "ext://test/options/options.html",
    storage: storage ?? {
      britiveSettings: { tenant: "acme", authenticated },
    },
    handlers: {
      checkAuthenticationStatus: () => ({ authenticated }),
      getSecretTemplates: () => ({
        allTypes: [{ secretType: "SSH Key" }, { secretType: "Password Manager" }],
      }),
      startOAuthLogin: () => ({ success: true }),
      logout: () => ({ success: true }),
      ...handlers,
    },
  });
}

const checkedTypes = (page) =>
  page
    .$$('#visible-secret-types input[type="checkbox"]')
    .filter((i) => i.checked)
    .map((i) => i.value);

for (const build of BUILDS) {
  describe(`${build}: options page`, () => {
    test("shows the logged-in state and locks the tenant field", async () => {
      const page = await loadOptions(build, { authenticated: true });
      assert.equal(page.$("#auth-status").textContent, "Authenticated");
      assert.equal(page.$("#auth-action").textContent, "Logout");
      assert.equal(page.$("#tenant").value, "acme");
      assert.equal(page.$("#tenant").disabled, true);
    });

    test("shows the logged-out state", async () => {
      const page = await loadOptions(build);
      assert.equal(page.$("#auth-status").textContent, "Not authenticated");
      assert.equal(page.$("#auth-action").textContent, "Login");
      assert.equal(page.$("#tenant").disabled, false);
    });

    test("login normalizes the tenant name before starting OAuth", async () => {
      const page = await loadOptions(build);
      page.$("#tenant").value = "  ACME.Dev  ";
      await page.click("#auth-action");
      assert.deepEqual(page.lastSent("startOAuthLogin"), {
        action: "startOAuthLogin",
        tenant: "acme.dev",
      });
      assert.equal(page.$("#connection-status").textContent, "Authenticated successfully.");
    });

    for (const tenant of ["", "evil.com/", "a b", "-acme"]) {
      test(`login refuses tenant ${JSON.stringify(tenant)}`, async () => {
        const page = await loadOptions(build);
        page.$("#tenant").value = tenant;
        await page.click("#auth-action");
        assert.equal(page.lastSent("startOAuthLogin"), undefined);
        assert.match(page.$("#connection-status").className, /error/);
      });
    }

    test("shows the error when login fails", async () => {
      const page = await loadOptions(build, {
        handlers: { startOAuthLogin: () => ({ success: false, error: "User cancelled" }) },
      });
      await page.click("#auth-action");
      assert.equal(page.$("#connection-status").textContent, "User cancelled");
      assert.equal(page.$("#auth-action").disabled, false);
    });

    test("logout asks the background to clear the session", async () => {
      const page = await loadOptions(build, { authenticated: true });
      await page.click("#auth-action");
      assert.ok(page.lastSent("logout"));
      assert.equal(page.$("#auth-action").textContent, "Login");
      assert.equal(page.$("#tenant").disabled, false);
    });

    test("reacts to authenticationComplete from the background", async () => {
      const page = await loadOptions(build);
      await page.receiveMessage({ action: "authenticationComplete", success: true });
      assert.equal(page.$("#auth-status").textContent, "Authenticated");
      await page.receiveMessage({
        action: "authenticationComplete",
        success: false,
        error: "Denied",
      });
      assert.equal(page.$("#auth-status").textContent, "Not authenticated");
      assert.equal(page.$("#connection-status").textContent, "Denied");
    });

    test("loads stored settings into the form", async () => {
      const page = await loadOptions(build, {
        storage: {
          britiveSettings: { tenant: "acme" },
          extensionSettings: {
            theme: "light",
            zoomLevel: 125,
            bannerCheck: false,
            bannerPollInterval: 300,
            passwordManagerAutofill: false,
            textButtons: true,
            visibleSecretTypes: ["SSH Key"],
          },
        },
      });
      assert.equal(page.$("#theme").value, "light");
      assert.equal(page.$("#zoom-level").value, "125");
      assert.equal(page.$("#banner-check").checked, false);
      assert.equal(page.$("#banner-poll-interval").value, "300");
      assert.equal(page.$("#password-manager-autofill").checked, false);
      assert.equal(page.$("#text-buttons").checked, true);
      assert.ok(page.document.documentElement.classList.contains("light"));
      assert.deepEqual(checkedTypes(page), ["SSH Key"]);
    });

    test("lists default and tenant secret types, defaults checked", async () => {
      const page = await loadOptions(build);
      const all = page.$$('#visible-secret-types input[type="checkbox"]').map((i) => i.value);
      assert.deepEqual(all, [...DEFAULT_TYPES, "SSH Key"].sort((a, b) => a.localeCompare(b)));
      assert.deepEqual(checkedTypes(page), DEFAULT_TYPES);
    });

    test("saving clamps zoom and banner interval to their limits", async () => {
      const page = await loadOptions(build);
      for (const [zoom, interval, wantZoom, wantInterval] of [
        ["300", "5", 200, 60],
        ["10", "99999", 50, 600],
        ["abc", "", 100, 60],
      ]) {
        page.$("#zoom-level").value = zoom;
        page.$("#banner-poll-interval").value = interval;
        await page.click("#save-settings");
        const saved = page.storage.extensionSettings;
        assert.equal(saved.zoomLevel, wantZoom, `zoom ${zoom}`);
        assert.equal(saved.bannerPollInterval, wantInterval, `interval ${interval}`);
      }
      assert.equal(page.$("#save-status").textContent, "Settings saved.");
    });

    test("saving with no secret types checked keeps the defaults", async () => {
      const page = await loadOptions(build);
      for (const input of page.$$('#visible-secret-types input[type="checkbox"]')) {
        input.checked = false;
      }
      await page.click("#save-settings");
      assert.deepEqual(
        [...page.storage.extensionSettings.visibleSecretTypes].sort(),
        DEFAULT_TYPES,
      );
    });

    test("saving stores a new tenant but rejects an invalid one", async () => {
      const page = await loadOptions(build, {
        storage: { britiveSettings: { tenant: "acme", refreshToken: "keep" } },
      });
      page.$("#tenant").value = "Other-Co";
      await page.click("#save-settings");
      assert.deepEqual(page.storage.britiveSettings, {
        tenant: "other-co",
        refreshToken: "keep",
      });

      page.$("#tenant").value = "evil.com/";
      await page.click("#save-settings");
      assert.equal(page.storage.britiveSettings.tenant, "other-co");
      assert.match(page.$("#save-status").className, /error/);
    });

    test("saving the theme updates the page and the toolbar icon", async () => {
      const page = await loadOptions(build);
      page.$("#theme").value = "light";
      await page.click("#save-settings");
      assert.equal(page.storage.extensionSettings.theme, "light");
      assert.ok(page.document.documentElement.classList.contains("light"));
      assert.deepEqual(page.lastSent("setExtensionIcon"), {
        action: "setExtensionIcon",
        crt: false,
      });
    });

    test("status messages disappear after three seconds", async () => {
      const page = await loadOptions(build);
      await page.click("#save-settings");
      assert.equal(page.$("#save-status").style.display, "block");
      await page.settle(3000);
      assert.equal(page.$("#save-status").style.display, "none");
    });

    describe("reset", () => {
      const customized = {
        britiveSettings: { tenant: "acme" },
        extensionSettings: { theme: "light", zoomLevel: 150 },
      };

      test("asks for confirmation and keeps settings on cancel", async () => {
        const page = await loadOptions(build, { storage: structuredClone(customized) });
        await page.click("#reset-settings");
        assert.equal(page.$("#reset-confirm-dialog").hidden, false);
        await page.click("#reset-confirm-cancel");
        assert.equal(page.$("#reset-confirm-dialog").hidden, true);
        assert.equal(page.storage.extensionSettings.zoomLevel, 150);
      });

      test("Escape cancels the dialog", async () => {
        const page = await loadOptions(build, { storage: structuredClone(customized) });
        await page.click("#reset-settings");
        page.document.dispatchEvent(
          new page.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        );
        await page.settle();
        assert.equal(page.$("#reset-confirm-dialog").hidden, true);
        assert.equal(page.storage.extensionSettings.zoomLevel, 150);
      });

      test("restores defaults on confirm", async () => {
        const page = await loadOptions(build, { storage: structuredClone(customized) });
        await page.click("#reset-settings");
        await page.click("#reset-confirm-confirm");
        await page.settle();
        assert.equal(page.storage.extensionSettings.zoomLevel, 100);
        assert.equal(page.storage.extensionSettings.theme, "dark");
        assert.equal(page.$("#zoom-level").value, "100");
        assert.equal(page.$("#save-status").textContent, "Settings reset to defaults.");
      });
    });

    if (build === "firefox") {
      test("custom intercept patterns are saved one per line and request host access", async () => {
        let requested = null;
        const page = await loadPage(build, {
          html: "options/options.html",
          scripts: ["options/options.js"],
          url: "ext://test/options/options.html",
          storage: { britiveSettings: { tenant: "acme" } },
          handlers: { checkAuthenticationStatus: () => ({ authenticated: false }) },
          setup: (api) => {
            api.permissions.request = async (p) => {
              requested = structuredClone(p);
              return true;
            };
          },
        });
        page.$("#custom-patterns").value = " console.example.com \n\n*.corp.example.org\n";
        await page.click("#save-settings");
        assert.deepEqual(page.storage.extensionSettings.customPatterns, [
          "console.example.com",
          "*.corp.example.org",
        ]);
        assert.deepEqual(requested, { origins: ["<all_urls>"] });
      });

      test("no host access is requested without custom patterns", async () => {
        let requested = false;
        const page = await loadPage(build, {
          html: "options/options.html",
          scripts: ["options/options.js"],
          url: "ext://test/options/options.html",
          storage: {},
          handlers: { checkAuthenticationStatus: () => ({ authenticated: false }) },
          setup: (api) => {
            api.permissions.request = async () => {
              requested = true;
              return true;
            };
          },
        });
        await page.click("#save-settings");
        assert.equal(requested, false);
      });
    }
  });
}
