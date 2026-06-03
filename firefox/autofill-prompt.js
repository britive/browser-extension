(() => {
  if (window.__britiveAutofillPromptInstalled) return;
  window.__britiveAutofillPromptInstalled = true;

  const runtime =
    typeof browser !== "undefined" ? browser.runtime : chrome.runtime;
  let candidates = [];
  let activeField = null;
  let hostUrl = location.href;
  const iconUrl = runtime.getURL("icons/britive-icon-48.png");
  let menu = null;
  let button = null;
  let candidateLoad = null;

  function isLoginField(el) {
    if (!el || el.disabled || el.readOnly) return false;
    if (!el.matches || !el.matches("input, textarea")) return false;
    const type = (el.type || "").toLowerCase();
    if (
      [
        "button",
        "checkbox",
        "color",
        "file",
        "hidden",
        "image",
        "radio",
        "range",
        "reset",
        "submit",
      ].includes(type)
    )
      return false;
    const text = [
      el.name,
      el.id,
      el.autocomplete,
      el.placeholder,
      el.getAttribute("aria-label"),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return (
      type === "password" ||
      /(user|email|login|account|identifier|password)/i.test(text)
    );
  }

  function ensureCandidates() {
    if (candidateLoad) return candidateLoad;
    candidateLoad = runtime
      .sendMessage({
        action: "getPasswordManagerCandidatesForUrl",
        url: hostUrl,
      })
      .then((response) => {
        candidates = response?.candidates || [];
        return candidates;
      })
      .catch(() => {
        candidates = [];
        return candidates;
      });
    return candidateLoad;
  }

  function removeUi() {
    if (menu) menu.remove();
    if (button) button.remove();
    menu = null;
    button = null;
  }

  function positionNearField(el, node, alignRight) {
    const rect = el.getBoundingClientRect();
    const top = rect.top + window.scrollY;
    const left = rect.left + window.scrollX;
    node.style.position = "absolute";
    node.style.zIndex = "2147483647";
    if (alignRight) {
      node.style.top = `${top + Math.max(6, rect.height / 2 - 17)}px`;
      node.style.left = `${left + rect.width - 42}px`;
    } else {
      node.style.top = `${top + rect.height + 4}px`;
      node.style.left = `${left}px`;
      node.style.width = `${Math.min(Math.max(220, rect.width), 360)}px`;
    }
  }

  function showButton(el) {
    if (!candidates.length) return;
    if (!button) {
      button = document.createElement("button");
      button.type = "button";
      button.title = "Britive autofill";
      button.style.cssText =
        "width:30px;height:30px;border:0;background:transparent;box-shadow:none;cursor:pointer;display:grid;place-items:center;padding:3px;";
      const img = document.createElement("img");
      img.src = iconUrl;
      img.alt = "Britive";
      img.style.cssText =
        "width:24px;height:24px;display:block;filter:drop-shadow(0 2px 5px rgba(62,93,224,.35));";
      button.appendChild(img);
      button.addEventListener("mousedown", (event) => event.preventDefault());
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        showMenu(activeField || el);
      });
      document.documentElement.appendChild(button);
    }
    positionNearField(el, button, true);
  }

  function showMenu(el) {
    if (!el || !candidates.length) return;
    if (menu) menu.remove();
    menu = document.createElement("div");
    menu.id = "britive-inline-autofill-menu";
    menu.style.cssText =
      "background:#12122a;color:#edf6fb;border:1px solid rgba(255,255,255,.1);border-radius:10px;box-shadow:0 10px 28px rgba(0,0,0,.32),0 0 0 1px rgba(202,30,204,.06);overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:4px;";
    candidates.slice(0, 6).forEach((candidate) => {
      const item = document.createElement("button");
      item.type = "button";
      item.style.cssText =
        "display:flex;gap:10px;align-items:center;width:100%;border:1px solid transparent;background:#1a1a35;color:inherit;text-align:left;padding:8px 10px;margin:3px 0;border-radius:8px;cursor:pointer;transition:background .12s ease,border-color .12s ease;";
      const textWrap = document.createElement("span");
      textWrap.style.cssText = "min-width:0;flex:1;";
      const name = document.createElement("span");
      name.style.cssText =
        "display:block;font-weight:800;font-size:13px;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
      name.textContent = candidate.name || location.hostname;
      const username = document.createElement("span");
      username.style.cssText =
        "display:block;color:rgba(237,246,251,.62);font-size:11px;line-height:1.2;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
      username.textContent = candidate.username || "username from secret";
      const arrow = document.createElement("span");
      arrow.style.cssText =
        "color:rgba(237,246,251,.38);font-size:14px;line-height:1;";
      arrow.textContent = "›";
      textWrap.appendChild(name);
      textWrap.appendChild(username);
      item.appendChild(textWrap);
      item.appendChild(arrow);
      item.addEventListener("mouseenter", () => {
        item.style.background = "#222248";
        item.style.borderColor = "rgba(62,93,224,.35)";
      });
      item.addEventListener("mouseleave", () => {
        item.style.background = "#1a1a35";
        item.style.borderColor = "transparent";
      });
      item.addEventListener("mousedown", (event) => event.preventDefault());
      item.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        item.disabled = true;
        await runtime.sendMessage({
          action: "autofillSecret",
          path: candidate.path,
          username: candidate.username || "",
        });
        removeUi();
      });
      menu.appendChild(item);
    });
    document.documentElement.appendChild(menu);
    positionNearField(el, menu, false);
  }

  async function handleFocus(event) {
    const el = event.target;
    if (!isLoginField(el)) return;
    activeField = el;
    await ensureCandidates();
    showButton(el);
    if (candidates.length) showMenu(el);
  }

  document.addEventListener("focusin", handleFocus, true);
  document.addEventListener(
    "click",
    (event) => {
      if (event.target === button || menu?.contains(event.target)) return;
      if (!isLoginField(event.target)) removeUi();
    },
    true,
  );
  window.addEventListener(
    "scroll",
    () => activeField && button && showButton(activeField),
    true,
  );
  window.addEventListener(
    "resize",
    () => activeField && button && showButton(activeField),
  );

  setTimeout(async () => {
    const first = Array.from(document.querySelectorAll("input, textarea")).find(
      isLoginField,
    );
    if (!first) return;
    activeField = first;
    await ensureCandidates();
    if (document.activeElement === first) showButton(first);
  }, 500);
})();
