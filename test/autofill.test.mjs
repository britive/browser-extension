// Content scripts injected into web pages: autofill.js fills credentials sent
// by the background; autofill-prompt.js offers matching secrets inline.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { BUILDS } from "./harness.mjs";
import { loadPage } from "./dom.mjs";

const LOGIN_FORM = `
  <form>
    <label for="user">Email address</label>
    <input id="user" name="email" type="text">
    <input id="pass" name="password" type="password">
    <button type="submit">Sign in</button>
  </form>`;

function fill(page, credential) {
  return page.receiveMessage({ action: "britiveAutofill", credential });
}

function recordEvents(el) {
  const events = [];
  for (const type of ["input", "change", "keyup"]) {
    el.addEventListener(type, () => events.push(type));
  }
  return events;
}

for (const build of BUILDS) {
  describe(`${build}: autofill.js`, () => {
    const load = (body) => loadPage(build, { body, scripts: ["autofill.js"] });

    test("fills username and password on a standard login form", async () => {
      const page = await load(LOGIN_FORM);
      const userEvents = recordEvents(page.$("#user"));

      const response = await fill(page, { username: "ada", password: "s3cret" });

      assert.deepEqual(response, {
        success: true,
        result: { username: true, password: true, otp: false },
      });
      assert.equal(page.$("#user").value, "ada");
      assert.equal(page.$("#pass").value, "s3cret");
      // Frameworks like React only see values set with input/change events.
      assert.deepEqual(userEvents, ["input", "change", "keyup"]);
    });

    test("skips hidden, disabled, and read-only decoy fields", async () => {
      const page = await load(`
        <input id="trap1" name="email" style="display:none">
        <input id="trap2" name="username" disabled>
        <input id="trap3" name="login" readonly>
        <div hidden><input id="trap4" name="password" type="password"></div>
        ${LOGIN_FORM}`);

      await fill(page, { username: "ada", password: "s3cret" });

      for (const id of ["trap1", "trap2", "trap3", "trap4"]) {
        assert.equal(page.$(`#${id}`).value, "", id);
      }
      assert.equal(page.$("#user").value, "ada");
      assert.equal(page.$("#pass").value, "s3cret");
    });

    test("fills the focused field as the username", async () => {
      const page = await load(`
        <input id="search" name="q" type="text">
        <input id="acct" type="text">
        <input id="pass" type="password">`);
      page.$("#acct").focus();

      await fill(page, { username: "ada", password: "pw" });

      assert.equal(page.$("#acct").value, "ada");
      assert.equal(page.$("#search").value, "");
    });

    test("without name hints, picks the text field just before the password", async () => {
      const page = await load(`
        <input id="a" type="text">
        <input id="b" type="text">
        <input id="pass" type="password">
        <input id="c" type="text">`);

      await fill(page, { username: "ada", password: "pw" });

      assert.equal(page.$("#b").value, "ada");
      assert.equal(page.$("#a").value, "");
      assert.equal(page.$("#c").value, "");
    });

    test("fills an OTP field only when the secret has an OTP", async () => {
      const html = `<input id="otp" name="otp" autocomplete="one-time-code">`;
      let page = await load(html);
      let response = await fill(page, { otp: "123456" });
      assert.equal(page.$("#otp").value, "123456");
      assert.equal(response.result.otp, true);

      page = await load(html);
      response = await fill(page, { username: "ada" });
      assert.equal(page.$("#otp").value, "");
      assert.equal(response.result.otp, false);
    });

    test("never fills buttons, checkboxes, or hidden inputs", async () => {
      const page = await load(`
        <input id="h" type="hidden" name="username">
        <input id="cb" type="checkbox" name="remember-user">
        <input id="s" type="submit" value="Login">`);

      const response = await fill(page, { username: "ada", password: "pw" });

      assert.deepEqual(response.result, { username: false, password: false, otp: false });
      assert.equal(page.$("#h").value, "");
      assert.equal(page.$("#s").value, "Login");
    });

    test("ignores unrelated messages", async () => {
      const page = await load(LOGIN_FORM);
      const response = await page.receiveMessage({ action: "somethingElse" });
      assert.equal(response, undefined);
      assert.equal(page.$("#user").value, "");
    });

    test("installs its listener only once when injected twice", async () => {
      const page = await load(LOGIN_FORM);
      const { readFileSync } = await import("node:fs");
      const src = readFileSync(new URL(`../${build}/autofill.js`, import.meta.url), "utf8");
      page.window.eval(src);
      const userEvents = recordEvents(page.$("#user"));

      await fill(page, { username: "ada" });

      assert.equal(userEvents.filter((e) => e === "input").length, 1);
    });
  });

  describe(`${build}: autofill-prompt.js`, () => {
    const candidates = [
      { name: "GitHub (work)", username: "ada@work", path: "/pm/github-work" },
      { name: "GitHub (personal)", username: "", path: "/pm/github-home" },
    ];

    async function load(body, response = { candidates }) {
      return loadPage(build, {
        body,
        url: "https://github.com/login",
        scripts: ["autofill-prompt.js"],
        handlers: {
          getPasswordManagerCandidatesForUrl: () => structuredClone(response),
          autofillSecret: () => ({ success: true }),
        },
      });
    }

    const focus = async (page, sel) => {
      page.$(sel).focus();
      await page.settle();
    };
    const menu = (page) => page.$("#britive-inline-autofill-menu");
    const menuItems = (page) => [...(menu(page)?.querySelectorAll("button") || [])];

    test("offers matching secrets when a login field is focused", async () => {
      const page = await load(LOGIN_FORM);
      await focus(page, "#user");

      assert.deepEqual(page.lastSent("getPasswordManagerCandidatesForUrl"), {
        action: "getPasswordManagerCandidatesForUrl",
        url: "https://github.com/login",
      });
      assert.deepEqual(
        menuItems(page).map((b) => b.textContent),
        ["GitHub (work)ada@work›", "GitHub (personal)username from secret›"],
      );
      assert.ok(page.$('button[title="Britive autofill"]'), "inline button shown");
    });

    test("clicking a secret asks the background to autofill it and closes the menu", async () => {
      const page = await load(LOGIN_FORM);
      await focus(page, "#user");

      await page.click(menuItems(page)[0]);

      assert.deepEqual(page.lastSent("autofillSecret"), {
        action: "autofillSecret",
        path: "/pm/github-work",
        username: "ada@work",
      });
      assert.equal(menu(page), null);
      assert.equal(page.$('button[title="Britive autofill"]'), null);
    });

    test("renders secret names as text, not HTML", async () => {
      const page = await load(LOGIN_FORM, {
        candidates: [
          {
            name: '<img src=x onerror="window.pwned=1">',
            username: "<b>bold</b>",
            path: "/pm/x",
          },
        ],
      });
      await focus(page, "#user");

      assert.equal(menu(page).querySelector("img, b"), null);
      assert.match(menuItems(page)[0].textContent, /<img src=x/);
      assert.equal(page.window.pwned, undefined);
    });

    test("shows nothing when no secrets match the site", async () => {
      const page = await load(LOGIN_FORM, { candidates: [] });
      await focus(page, "#user");
      assert.equal(menu(page), null);
      assert.equal(page.$('button[title="Britive autofill"]'), null);
    });

    test("does not query for non-login fields", async () => {
      const page = await load(`<input id="q" name="q" type="search" placeholder="Search">`);
      await focus(page, "#q");
      await page.settle(1000);
      assert.equal(page.sentActions().length, 0);
    });

    test("asks the background for candidates only once per page", async () => {
      const page = await load(LOGIN_FORM);
      await focus(page, "#user");
      await focus(page, "#pass");
      await page.settle(1000);
      assert.equal(
        page.sentActions().filter((a) => a === "getPasswordManagerCandidatesForUrl").length,
        1,
      );
    });

    test("caps the menu at six secrets", async () => {
      const many = Array.from({ length: 9 }, (_, i) => ({ name: `s${i}`, path: `/p/${i}` }));
      const page = await load(LOGIN_FORM, { candidates: many });
      await focus(page, "#user");
      assert.equal(menuItems(page).length, 6);
    });

    test("clicking elsewhere on the page closes the menu", async () => {
      const page = await load(`${LOGIN_FORM}<p id="elsewhere">text</p>`);
      await focus(page, "#user");
      assert.ok(menu(page));
      await page.click("#elsewhere");
      assert.equal(menu(page), null);
    });

    test("survives the background being unavailable", async () => {
      const page = await load(LOGIN_FORM);
      page.handlers.getPasswordManagerCandidatesForUrl = () => {
        throw new Error("Could not establish connection");
      };
      await focus(page, "#user");
      assert.equal(menu(page), null);
      assert.deepEqual(page.errors, []);
    });
  });
}
