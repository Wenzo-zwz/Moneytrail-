import { useState, useSyncExternalStore } from "react";
import { RefreshCw } from "lucide-react";

let updateVersion = 0;
const listeners = new Set<() => void>();

/** Called by the one production registration, including updates activated in another tab. */
export function announceAppUpdate(): void {
  updateVersion += 1;
  listeners.forEach(listener => listener());
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
const snapshot = () => updateVersion;

export default function AppUpdateNotice({ onUpdate }: { onUpdate: () => Promise<void> }) {
  const version = useSyncExternalStore(subscribe, snapshot, () => 0);
  const [dismissed, setDismissed] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (version <= dismissed) return null;

  async function update() {
    if (busy || !window.confirm("更新会重新打开当前页面。请先保存正在填写的记录，确认尚未同步的修改已妥善保留。现在更新吗？")) return;
    setBusy(true); setError("");
    try { await onUpdate(); }
    catch { setBusy(false); setError("更新未完成，请稍后重试。"); }
  }

  return <aside className="app-update-notice" aria-labelledby="app-update-title">
    <div className="app-update-heading"><RefreshCw size={19} aria-hidden="true" /><h2 id="app-update-title">发现新版本</h2></div>
    <p>先保存正在填写的记录，并确认账目同步状态，再更新应用。</p>
    {error && <p role="alert">{error}</p>}
    <div className="app-update-actions"><button className="button primary small" disabled={busy} onClick={() => void update()}>{busy ? "正在更新…" : "更新并重新打开"}</button><button className="button ghost small" disabled={busy} onClick={() => setDismissed(version)}>本次稍后</button></div>
  </aside>;
}
