export const APP_RESUMED = "bot-panel-resumed";

// Rebuild WebKit's suspended paint layers without clearing React state or login.
export function installBrowserResumeRecovery(root: HTMLElement, recover: () => void) {
  let hidden = document.visibilityState === "hidden";
  let lastResumeAt = 0;
  let lastRecoveryAt = 0;
  let checkTimer: ReturnType<typeof setTimeout> | undefined;
  let paintTimer: ReturnType<typeof setTimeout> | undefined;

  const checkScreen = () => {
    if (document.visibilityState === "hidden") return;
    if (root.childElementCount && root.textContent?.trim()) return;
    if (Date.now() - lastRecoveryAt < 30_000) return;
    lastRecoveryAt = Date.now();
    recover();
  };

  const resume = () => {
    if (document.visibilityState === "hidden") return;
    hidden = false;
    if (Date.now() - lastResumeAt < 500) return;
    lastResumeAt = Date.now();
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;
    const display = root.style.getPropertyValue("display");
    const priority = root.style.getPropertyPriority("display");
    document.documentElement.classList.add("app-resuming");
    root.style.setProperty("display", "none", "important");
    root.getBoundingClientRect();
    if (display) root.style.setProperty("display", display, priority);
    else root.style.removeProperty("display");
    root.getBoundingClientRect();
    window.scrollTo({ left: scrollX, top: scrollY, behavior: "instant" });
    window.dispatchEvent(new Event(APP_RESUMED));
    if (paintTimer) clearTimeout(paintTimer);
    paintTimer = setTimeout(() => document.documentElement.classList.remove("app-resuming"), 250);
    if (checkTimer) clearTimeout(checkTimer);
    checkTimer = setTimeout(checkScreen, 1000);
  };
  const visibilityChanged = () => {
    if (document.visibilityState === "hidden") hidden = true;
    else if (hidden) resume();
  };
  const pageHidden = () => { hidden = true; };
  const pageShown = (event: PageTransitionEvent) => { if (hidden || event.persisted) resume(); };
  const focused = () => { if (hidden) resume(); };

  document.addEventListener("visibilitychange", visibilityChanged);
  window.addEventListener("pagehide", pageHidden);
  window.addEventListener("pageshow", pageShown);
  window.addEventListener("focus", focused);
  window.addEventListener("online", checkScreen);
  return () => {
    if (checkTimer) clearTimeout(checkTimer);
    if (paintTimer) clearTimeout(paintTimer);
    document.documentElement.classList.remove("app-resuming");
    document.removeEventListener("visibilitychange", visibilityChanged);
    window.removeEventListener("pagehide", pageHidden);
    window.removeEventListener("pageshow", pageShown);
    window.removeEventListener("focus", focused);
    window.removeEventListener("online", checkScreen);
  };
}
