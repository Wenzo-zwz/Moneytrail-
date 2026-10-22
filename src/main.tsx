import React from "react";
import ReactDOM from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import AccountApp from "./AccountApp";
import AppUpdateNotice, { announceAppUpdate } from "./components/AppUpdateNotice";
import "./styles.css";
import "./auth.css";
import "./admin.css";
import "./sms.css";
import "./update.css";

let applyUpdate: () => Promise<void> = async () => {};
if (import.meta.env.PROD) {
  let requested = false;
  let activated = false;
  const updateWorker = registerSW({
    immediate: true,
    onNeedRefresh: announceAppUpdate,
    onNeedReload: () => {
      activated = true;
      // Another tab can activate a worker. Preserve this tab's in-memory form
      // until its own user explicitly accepts reopening it.
      if (requested) window.location.reload();
      else announceAppUpdate();
    },
  });
  applyUpdate = async () => {
    requested = true;
    if (activated) { window.location.reload(); return; }
    try { await updateWorker(); }
    catch (error) { requested = false; throw error; }
  };
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AccountApp />
    <AppUpdateNotice onUpdate={applyUpdate} />
  </React.StrictMode>,
);
