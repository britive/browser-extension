const cliReadyApi = typeof browser !== "undefined" ? browser : chrome;

(function monitorCliReadyPage() {
  if (window.top !== window.self) return;
  if (
    window.location.protocol !== "https:" ||
    !window.location.pathname.startsWith("/cli")
  ) {
    return;
  }

  let notified = false;
  let observer = null;

  const notifyIfReady = () => {
    if (
      notified ||
      !document.body ||
      !document.body.innerText.includes("CLI is ready")
    ) {
      return;
    }

    notified = true;
    if (observer) observer.disconnect();
    try {
      const result = cliReadyApi.runtime.sendMessage({ action: "cliReady" });
      if (result && typeof result.catch === "function") result.catch(() => {});
    } catch (_) {}
  };

  const startObserver = () => {
    notifyIfReady();
    if (notified || !document.body) return;

    observer = new MutationObserver(() => {
      notifyIfReady();
    });
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startObserver, {
      once: true,
    });
  } else {
    startObserver();
  }
})();
