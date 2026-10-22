import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { AppRecoveryBoundary } from "./AppRecoveryBoundary";
import { installBrowserResumeRecovery } from "./browserResume";

function lockApplicationZoom() {
  const preventWheelZoom = (event: WheelEvent) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
  };
  const preventKeyboardZoom = (event: KeyboardEvent) => {
    if ((!event.ctrlKey && !event.metaKey) || !["+", "=", "-", "0"].includes(event.key)) return;
    event.preventDefault();
  };
  const preventGestureZoom = (event: Event) => event.preventDefault();

  window.addEventListener("wheel", preventWheelZoom, { passive: false, capture: true });
  window.addEventListener("keydown", preventKeyboardZoom, { capture: true });
  document.addEventListener("gesturestart", preventGestureZoom, { passive: false });
  document.addEventListener("gesturechange", preventGestureZoom, { passive: false });
}

lockApplicationZoom();

const container = document.getElementById("root") as HTMLElement;
const root = createRoot(container);
let screenGeneration = 0;
function renderPanel() {
  root.render(
    <React.StrictMode>
      <AppRecoveryBoundary key={screenGeneration++}>
        <App />
      </AppRecoveryBoundary>
    </React.StrictMode>
  );
}
installBrowserResumeRecovery(container, renderPanel);
renderPanel();

if ("serviceWorker" in navigator && (window.location.protocol === "https:" || ["localhost", "127.0.0.1"].includes(window.location.hostname))) {
  window.addEventListener("load", () => {
    let refreshing = false;
    let hadController = Boolean(navigator.serviceWorker.controller);
    let pendingUpdate = false;
    const refreshUpdatedShell = () => {
      if (!pendingUpdate || refreshing || document.visibilityState === "hidden") return;
      refreshing = true;
      window.location.reload();
    };
    document.addEventListener("visibilitychange", refreshUpdatedShell);
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (!hadController) { hadController = true; return; }
      pendingUpdate = true;
      refreshUpdatedShell();
    });

    navigator.serviceWorker
      .register("/sw.js")
      .then((registration) => registration.update().catch(() => undefined))
      .catch(() => undefined);
  });
}
