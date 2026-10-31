import React from "react";
import ReactDOM from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import AccountApp from "./AccountApp";
import AppUpdateNotice from "./components/AppUpdateNotice";
import { announceAppUpdate, appUpdater, checkRegisteredUpdate } from "./lib/appUpdate";
import "./styles.css";
import "./auth.css";
import "./admin.css";
import "./sms.css";
import "./update.css";

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  let requested = false;
  let activated = false;
  let applySignal: AbortSignal | undefined;
  let previousController = navigator.serviceWorker.controller;
  function activatedUpdate() {
    if (activated) return;
    activated = true;
    // Late activation after a failed attempt must preserve any new form input.
    if (requested && !applySignal?.aborted) window.location.reload();
    else announceAppUpdate();
  }
  // Workbox can label a second rapid update as external; native controller
  // changes still identify its activation. The first install is not an update.
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    const controller = navigator.serviceWorker.controller;
    if (previousController && controller && previousController !== controller) activatedUpdate();
    previousController = controller;
  });
  const updateWorker = registerSW({
    immediate: true,
    onNeedRefresh: announceAppUpdate,
    onNeedReload: activatedUpdate,
  });
  appUpdater.configure({ check: async () => {
    if (activated) return true;
    const registration = await navigator.serviceWorker.getRegistration(import.meta.env.BASE_URL);
    if (!registration) throw new Error("Update service is not ready");
    return checkRegisteredUpdate(registration);
  }, apply: async signal => {
    requested = true;
    applySignal = signal;
    if (activated) { window.location.reload(); return; }
    try { await updateWorker(); }
    catch (error) { requested = false; throw error; }
  } });
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AccountApp />
    <AppUpdateNotice />
  </React.StrictMode>,
);
