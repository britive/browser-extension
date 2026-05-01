// Container picker - runs in the intercepted tab

const CONTAINER_COLORS = [
  { name: "blue", code: "#37adff" },
  { name: "turquoise", code: "#00c79a" },
  { name: "green", code: "#51cd00" },
  { name: "yellow", code: "#ffcb00" },
  { name: "orange", code: "#ff9f00" },
  { name: "red", code: "#ff613d" },
  { name: "pink", code: "#ff4bda" },
  { name: "purple", code: "#af51f5" },
];

function clearElement(el) {
  if (el) el.replaceChildren();
}

function setStateMessage(container, className, message) {
  if (!container) return;
  clearElement(container);
  const div = document.createElement("div");
  div.className = className;
  div.textContent = message;
  container.appendChild(div);
}

function buildMissingExtensionNotice(text) {
  const wrapper = document.createElement("div");
  wrapper.className = "missing-ext";

  const p = document.createElement("p");
  p.textContent = text;
  wrapper.appendChild(p);

  const link = document.createElement("a");
  link.href =
    "https://addons.mozilla.org/en-US/firefox/addon/multi-account-containers/";
  link.target = "_blank";
  link.textContent = "Install Multi-Account Containers";
  wrapper.appendChild(link);

  return wrapper;
}

(async () => {
  // Ensure the picker is running as a top-level extension page, not embedded by a web page
  if (
    window.location.protocol !== "moz-extension:" ||
    window.top !== window.self
  ) {
    document.body.textContent = "";
    return;
  }

  // Load banner
  const { britiveBanner } = await browser.storage.local.get("britiveBanner");
  const bannerEl = document.getElementById("banner");
  if (britiveBanner && britiveBanner.message) {
    bannerEl.textContent = britiveBanner.message;
    const allowedTypes = ["INFO", "WARNING", "CAUTION"];
    const safeType = allowedTypes.includes(britiveBanner.messageType)
      ? britiveBanner.messageType
      : "INFO";
    bannerEl.className = "banner " + safeType;
  }

  const requestId = new URLSearchParams(window.location.search).get(
    "requestId",
  );
  const storage = await browser.storage.local.get([
    "pendingContainerRequests",
    "britiveSettings",
  ]);
  const pendingRequests = storage.pendingContainerRequests || {};
  const pendingRequest = requestId ? pendingRequests[requestId] : null;
  const url = pendingRequest?.url;
  const listDiv = document.getElementById("container-list");
  const cancelBtn = document.getElementById("cancel");

  if (cancelBtn) {
    cancelBtn.addEventListener("click", async () => {
      if (requestId && pendingRequests[requestId]) {
        delete pendingRequests[requestId];
        await browser.storage.local.set({
          pendingContainerRequests: pendingRequests,
        });
      }

      const currentTab = await browser.tabs.getCurrent();
      if (currentTab && currentTab.id) {
        await browser.tabs.remove(currentTab.id).catch(() => {});
        return;
      }
      window.close();
    });
  }

  const isAuthenticated = Boolean(
    storage.britiveSettings?.authenticated &&
    storage.britiveSettings?.bearerToken &&
    storage.britiveSettings?.tenant,
  );

  if (!isAuthenticated) {
    if (requestId && pendingRequests[requestId]) {
      delete pendingRequests[requestId];
      await browser.storage.local.set({
        pendingContainerRequests: pendingRequests,
      });
    }
    setStateMessage(
      listDiv,
      "loading",
      "Not authenticated. Please log in to Britive.",
    );
    return;
  }

  if (!requestId || !url) {
    setStateMessage(listDiv, "loading", "No pending URL found.");
    return;
  }

  // Show destination
  try {
    const dest = new URL(url);
    document.getElementById("destination").textContent =
      dest.hostname + dest.pathname;
  } catch (e) {
    document.getElementById("destination").textContent = url.slice(0, 80);
  }

  // Check if contextualIdentities API is available
  if (typeof browser.contextualIdentities === "undefined") {
    clearElement(listDiv);
    listDiv.appendChild(
      buildMissingExtensionNotice(
        "Container support requires the contextualIdentities API. Install Firefox Multi-Account Containers to enable it.",
      ),
    );
    return;
  }

  // Load and render containers
  try {
    await renderContainers(url, listDiv);
  } catch (error) {
    // contextualIdentities.query can throw if the feature is disabled
    clearElement(listDiv);
    listDiv.appendChild(
      buildMissingExtensionNotice(
        "Container tabs are not enabled. Install Firefox Multi-Account Containers or enable container tabs in Firefox settings.",
      ),
    );
    return;
  }
})();

async function renderContainers(url, listDiv) {
  const containers = await browser.contextualIdentities.query({});

  clearElement(listDiv);

  // Render existing containers
  containers.forEach((c) => {
    const item = document.createElement("div");
    item.className = "container-item";

    const icon = document.createElement("div");
    icon.className = "container-icon";
    icon.style.backgroundColor = c.colorCode;

    const name = document.createElement("div");
    name.className = "container-name";
    name.textContent = c.name;

    item.appendChild(icon);
    item.appendChild(name);

    item.addEventListener("click", async () => {
      await browser.runtime.sendMessage({
        action: "openInContainer",
        url,
        requestId: new URLSearchParams(window.location.search).get("requestId"),
        containerId: c.cookieStoreId,
      });
    });

    listDiv.appendChild(item);
  });

  // "New container" row
  const newRow = document.createElement("div");
  newRow.className = "new-container";

  const newIcon = document.createElement("div");
  newIcon.className = "new-container-icon";
  newIcon.textContent = "+";

  const newLabel = document.createElement("div");
  newLabel.className = "new-container-label";
  newLabel.textContent = "New container...";

  newRow.appendChild(newIcon);
  newRow.appendChild(newLabel);
  listDiv.appendChild(newRow);

  // Create form (hidden by default)
  const form = document.createElement("div");
  form.className = "create-form";
  form.id = "create-form";

  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.placeholder = "Container name";
  nameInput.id = "new-container-name";

  const colorRow = document.createElement("div");
  colorRow.className = "color-options";

  let selectedColor = CONTAINER_COLORS[0].name;

  CONTAINER_COLORS.forEach((c, i) => {
    const swatch = document.createElement("div");
    swatch.className = "color-option" + (i === 0 ? " selected" : "");
    swatch.style.backgroundColor = c.code;
    swatch.dataset.color = c.name;
    swatch.addEventListener("click", () => {
      colorRow
        .querySelectorAll(".color-option")
        .forEach((s) => s.classList.remove("selected"));
      swatch.classList.add("selected");
      selectedColor = c.name;
    });
    colorRow.appendChild(swatch);
  });

  const createBtn = document.createElement("button");
  createBtn.className = "create-btn";
  createBtn.textContent = "Create & Open";

  form.appendChild(nameInput);
  form.appendChild(colorRow);
  form.appendChild(createBtn);
  listDiv.appendChild(form);

  // Toggle form on click
  newRow.addEventListener("click", () => {
    form.classList.toggle("visible");
    if (form.classList.contains("visible")) {
      nameInput.focus();
    }
  });

  // Create container and open URL in it
  createBtn.addEventListener("click", async () => {
    const name = nameInput.value.trim();
    if (!name) {
      nameInput.focus();
      return;
    }

    createBtn.disabled = true;
    createBtn.textContent = "Creating...";

    try {
      const container = await browser.contextualIdentities.create({
        name,
        color: selectedColor,
        icon: "circle",
      });

      await browser.runtime.sendMessage({
        action: "openInContainer",
        url,
        requestId: new URLSearchParams(window.location.search).get("requestId"),
        containerId: container.cookieStoreId,
      });
    } catch (error) {
      createBtn.disabled = false;
      createBtn.textContent = "Create & Open";
    }
  });

  // Allow Enter key to submit
  nameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") createBtn.click();
  });
}
