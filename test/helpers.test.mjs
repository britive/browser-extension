// Pure helpers: tenant handling, OAuth client id, autofill matching, and
// checkout expiration parsing. Every test runs against both builds.

import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { BUILDS, loadBackground } from "./harness.mjs";

const MIN = 60 * 1000;

for (const build of BUILDS) {
  describe(`${build}: helpers`, () => {
    let env;
    let fn;
    before(async () => {
      env = await loadBackground(build);
      fn = (name) => env.get(name);
    });

    describe("tenant", () => {
      test("accepts tenant names with subdomains and hyphens", () => {
        const isValidTenant = fn("isValidTenant");
        for (const t of ["acme", "acme.corp", "team1.dev.aws", "my-co"]) {
          assert.equal(isValidTenant(t), true, t);
        }
      });

      test("rejects names that could redirect requests off britive-app.com", () => {
        const isValidTenant = fn("isValidTenant");
        for (const t of [
          "",
          "Acme",
          "evil.com/",
          "evil.com#",
          "a@evil.com",
          "-acme",
          "acme-",
          "acme.",
          "ac me",
          null,
          undefined,
          42,
        ]) {
          assert.equal(isValidTenant(t), false, String(t));
        }
        assert.throws(() => fn("getTenantBaseUrl")("evil.com/"), /Invalid tenant/);
      });

      test("builds the tenant base URL", () => {
        assert.equal(
          fn("getTenantBaseUrl")("acme.corp"),
          "https://acme.corp.britive-app.com",
        );
      });
    });

    describe("computeClientId", () => {
      test("is sha256 of browser-extension-<first tenant label>", async () => {
        const expected = createHash("sha256")
          .update("browser-extension-acme")
          .digest("hex");
        assert.equal(await fn("computeClientId")("acme.corp"), expected);
        assert.equal(await fn("computeClientId")("acme"), expected);
      });
    });

    describe("getPasswordManagerMatch", () => {
      const cases = [
        ["https://github.com/login", "https://github.com", "exact"],
        ["https://www.github.com/login", "github.com", "exact"],
        ["https://GitHub.com/", "https://github.com/", "exact"],
        ["https://gist.github.com/", "github.com", "domain"],
        ["https://a.b.github.com/", "https://github.com", "domain"],
        ["https://github.com/", "gist.github.com", null],
        // Suffix match must be on a label boundary.
        ["https://evilgithub.com/", "github.com", null],
        ["https://github.com.evil.io/", "github.com", null],
        ["https://github.com/", "", null],
        ["", "github.com", null],
        ["not a url", "github.com", null],
      ];
      for (const [active, secret, expected] of cases) {
        test(`${JSON.stringify(active)} vs ${JSON.stringify(secret)} -> ${expected}`, () => {
          assert.equal(fn("getPasswordManagerMatch")(active, secret), expected);
        });
      }
    });

    describe("extractCheckedOutExpiration", () => {
      test("reads ISO strings, epoch seconds, and epoch milliseconds", () => {
        const extract = fn("extractCheckedOutExpiration");
        const future = env.clock.now + 30 * MIN;
        const iso = new Date(future).toISOString();
        assert.equal(extract({ expiration: iso }), future);
        assert.equal(extract({ expiresAt: future }), future);
        assert.equal(
          extract({ expirationTime: Math.floor(future / 1000) }),
          Math.floor(future / 1000) * 1000,
        );
      });

      test("ignores expirations in the past", () => {
        const extract = fn("extractCheckedOutExpiration");
        const past = new Date(env.clock.now - MIN).toISOString();
        assert.equal(extract({ expiration: past }), null);
        assert.equal(extract({}), null);
        assert.equal(extract(null), null);
      });

      test("falls back to any expiry-like field name", () => {
        const extract = fn("extractCheckedOutExpiration");
        const future = env.clock.now + 10 * MIN;
        assert.equal(extract({ accessExpiresOn: future }), future);
        assert.equal(extract({ profileValidUntil: future }), future);
        assert.equal(extract({ somethingElse: future }), null);
      });
    });
  });
}
