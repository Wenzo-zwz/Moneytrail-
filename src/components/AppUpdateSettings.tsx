import { useSyncExternalStore } from "react";
import { RefreshCw } from "lucide-react";
import { appUpdater, requestAppUpdate } from "../lib/appUpdate";

export default function AppUpdateSettings() {
  const state = useSyncExternalStore(appUpdater.subscribe, appUpdater.getState);
  const busy = state.phase === "checking" || state.phase === "installing";
  return <section className="setting-card" aria-labelledby="app-update-settings-title">
    <div className="setting-heading"><RefreshCw size={23} /><h2 id="app-update-settings-title">应用更新</h2></div>
    <p>在这里检查并更新网页版本，已保存的账目会保留。</p>
    <p role={state.phase === "error" ? "alert" : "status"}>{state.message}</p>
    <div className="app-update-actions">
      <button className="button secondary" disabled={busy || state.phase === "unavailable"} onClick={() => void appUpdater.check()}>{state.phase === "checking" ? "正在检查…" : "检查更新"}</button>
      {state.available && <button className="button primary" disabled={busy} onClick={() => void requestAppUpdate()}>{state.phase === "installing" ? "正在更新…" : "更新并重新打开"}</button>}
    </div>
    <p className="help-text">更新前请保存正在填写的内容；未同步的账目请先导出备份。</p>
  </section>;
}
