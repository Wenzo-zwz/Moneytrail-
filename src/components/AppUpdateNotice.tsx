import { useState, useSyncExternalStore } from "react";
import { RefreshCw } from "lucide-react";
import { appUpdater, requestAppUpdate } from "../lib/appUpdate";

export default function AppUpdateNotice() {
  const state = useSyncExternalStore(appUpdater.subscribe, appUpdater.getState);
  const [dismissed, setDismissed] = useState(0);
  const busy = state.phase === "checking" || state.phase === "installing";
  if (!state.available || state.version <= dismissed) return null;

  return <aside className="app-update-notice" aria-labelledby="app-update-title">
    <div className="app-update-heading"><RefreshCw size={19} aria-hidden="true" /><h2 id="app-update-title">发现新版本</h2></div>
    <p>先保存正在填写的记录，并确认账目同步状态，再更新应用。</p>
    {state.phase === "error" && <p role="alert">{state.message}</p>}
    <div className="app-update-actions"><button className="button primary small" disabled={busy} onClick={() => void requestAppUpdate()}>{state.phase === "installing" ? "正在更新…" : "更新并重新打开"}</button><button className="button ghost small" disabled={busy} onClick={() => setDismissed(state.version)}>本次稍后</button></div>
  </aside>;
}
