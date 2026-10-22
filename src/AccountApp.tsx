import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { ArrowDownToLine, Cloud, LogOut, RefreshCw, ShieldCheck, UserRound, X } from "lucide-react";
import App from "./App";
import AuthForm from "./components/AuthForm";
import { getCloudClient, getCloudConfigError, readCloudConfig } from "./lib/cloudClient";
import { createCloudStore, type CloudStore, type CloudStoreState } from "./lib/cloudStore";
import { planLegacyMigration } from "./lib/accountMigration";
import { clearAccountCache } from "./lib/accountCache";
import { clearStoredData, exportBackup, loadData, readStoredRaw } from "./lib/storage";

function download(text: string, filename: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = filename;
  document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function hasLegacyBook() {
  try { return readStoredRaw() !== null; } catch { return false; }
}

const phaseNames: Record<CloudStoreState["phase"], string> = {
  loading: "正在读取", saved: "已同步", pending: "待同步", offline: "离线", syncing: "同步中", conflict: "需要核对", error: "同步未完成",
};

function SyncBadge({ state }: { state: CloudStoreState }) {
  return <span className={`sync-state ${state.phase}`} role="status">{phaseNames[state.phase]}</span>;
}

export default function AccountApp() {
  const [client] = useState(getCloudClient);
  const configuration = readCloudConfig(import.meta.env);
  if (!client || !configuration) return <LocalApplication />;
  return <AccountSession client={client} projectUrl={configuration.url} />;
}

function LocalApplication() {
  const dialog = useRef<HTMLDialogElement>(null);
  return <>
    <App accountControls={<button className="button secondary small" onClick={() => dialog.current?.showModal()}><UserRound size={16} />账户服务</button>} />
    <dialog className="account-dialog" ref={dialog} aria-labelledby="configuration-title">
      <div className="account-dialog-header"><h2 id="configuration-title">独立账户尚未接通</h2><button className="icon-button" aria-label="关闭" onClick={() => dialog.current?.close()}><X size={18} /></button></div>
      <div className="account-dialog-body"><p>{getCloudConfigError()}</p><p>当前仍是本机账本，账目不会上传。接入账号服务后，你可以登录自己的账户，并确认是否迁移已有账目。</p><p>换设备前，请在设置中导出完整备份。</p></div>
    </dialog>
  </>;
}

function AccountSession({ client, projectUrl }: { client: SupabaseClient; projectUrl: string }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [recovery, setRecovery] = useState(false);
  useEffect(() => {
    let active = true; let events = 0;
    // Keep this callback synchronous: calling another auth method here can deadlock the SDK.
    const { data: { subscription } } = client.auth.onAuthStateChange((event, next) => {
      if (!active) return;
      events += 1;
      setSession(next); setLoading(false); setError("");
      if (event === "PASSWORD_RECOVERY") setRecovery(true);
      if (!next) setRecovery(false);
    });
    const expectedEvents = events;
    void client.auth.getSession().then(({ data, error: authError }) => {
      if (!active || events !== expectedEvents) return;
      if (authError) setError("无法读取登录状态，请重新连接账号服务。");
      setSession(authError ? null : data.session); setLoading(false);
    }).catch(() => {
      if (active && events === expectedEvents) { setError("暂时无法连接账号服务，请检查网络后重试。"); setLoading(false); }
    });
    return () => { active = false; subscription.unsubscribe(); };
  }, [client]);
  if (loading) return <main className="account-loading"><RefreshCw className="auth-spinning" /><h1>正在打开你的账本</h1><p>正在确认当前登录账户。</p></main>;
  if (error) return <main className="account-empty"><ShieldCheck /><h1>暂时无法读取账号</h1><p role="alert">{error}</p><button className="button secondary" onClick={() => location.reload()}>重新连接</button></main>;
  if (recovery) return <AuthForm key="recovery" client={client} initialMode="recovery" onRecoveryComplete={() => setRecovery(false)} />;
  if (!session) return <AuthForm key="login" client={client} legacyPresent={hasLegacyBook()} />;
  return <CloudConnection key={session.user.id} client={client} projectUrl={projectUrl} session={session} />;
}

function CloudConnection({ client, projectUrl, session }: { client: SupabaseClient; projectUrl: string; session: Session }) {
  const [store, setStore] = useState<CloudStore | null>(null);
  useEffect(() => {
    // Each effect owns its store, including React StrictMode's setup/cleanup replay.
    const next = createCloudStore({ client, userId: session.user.id, projectUrl });
    setStore(next); next.start();
    return () => next.dispose();
  }, [client, projectUrl, session.user.id]);
  if (!store) return <main className="account-loading"><RefreshCw className="auth-spinning" /><p>正在准备账户账本。</p></main>;
  return <CloudLedger key={session.user.id} client={client} projectUrl={projectUrl} session={session} store={store} />;
}

function CloudLedger({ client, projectUrl, session, store }: { client: SupabaseClient; projectUrl: string; session: Session; store: CloudStore }) {
  const state = useSyncExternalStore(store.subscribeState, store.getState);
  const dialog = useRef<HTMLDialogElement>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [legacy, setLegacy] = useState(() => ({ present: hasLegacyBook(), ...loadData() }));
  const [legacyBackup, setLegacyBackup] = useState<string | null>(null);
  const [migrated, setMigrated] = useState(false);
  const [bookEpoch, setBookEpoch] = useState(0);
  const accountName = session.user.email || "当前账户";

  function backupAccount() {
    try {
      const raw = state.recoveryError ? store.readStoredRaw() : exportBackup(store.loadData().data);
      if (raw === null) throw new Error("当前没有可导出的本机副本。");
      download(raw, `moneytrail-${state.recoveryError ? "raw-cache" : "account-backup"}-${new Date().toISOString().slice(0, 10)}.json`);
      return true;
    } catch { setNotice("备份未能导出，请检查浏览器存储和下载权限。"); return false; }
  }

  async function resolve(choice: "cloud" | "local") {
    if (busy) return;
    if ((state.dirty || state.recoveryError) && !backupAccount()) return;
    const prompt = choice === "cloud"
      ? "采用云端版本将替换此设备的账本。尚未同步的本机内容请保留在刚下载的备份中。确定继续吗？"
      : `将本机完整账本提交至 ${accountName}，替换当前云端账本，并同步到其他设备。确定保留本机版本吗？`;
    if (!window.confirm(prompt)) return;
    setBusy(true); setNotice("");
    try { await store.resolveConflict(choice); }
    finally { setBusy(false); }
  }

  function backupLegacy() {
    try {
      const raw = readStoredRaw();
      if (raw === null) throw new Error();
      download(raw, "moneytrail-legacy-device-backup.json"); setLegacyBackup(raw);
      setNotice("旧本机账本备份已下载，请妥善保存后再迁移。");
    } catch { setNotice("旧本机账本备份未能导出。原数据没有修改。"); }
  }

  function migrateLegacy() {
    if (busy || !state.ready || state.recoveryError || state.phase === "conflict") return;
    try {
      const raw = readStoredRaw();
      if (!legacyBackup || raw !== legacyBackup) throw new Error("请先下载当前旧本机账本的备份，再确认迁移。");
      const old = loadData();
      if (old.error) throw new Error(old.error);
      const current = store.loadData();
      if (current.error) throw new Error(current.error);
      const plan = planLegacyMigration(old.data, current.data);
      if (!window.confirm(`将旧本机账本合并到 ${accountName}：新增 ${plan.added} 笔，跳过 ${plan.duplicates} 笔相同记录${plan.renamed ? `，为 ${plan.renamed} 笔编号冲突记录生成独立编号` : ""}。确认后这些账目会同步至该账户。现有账目和旧本机副本会保留，确定继续吗？`)) return;
      if (readStoredRaw() !== raw) throw new Error("另一页面更新了旧账本，请重新备份后迁移。");
      const result = store.saveData(plan.data, current.data);
      if (!result.ok) throw new Error(result.error);
      setMigrated(true); setBookEpoch((value) => value + 1); setNotice("账目已合并到当前账户的本机副本，请等待“已同步”，再在另一设备确认。旧本机副本仍然保留。");
    } catch (error) { setNotice(error instanceof Error ? error.message : "迁移未完成，原数据已保留。"); }
  }

  function removeLegacy() {
    try {
      if (!migrated || state.phase !== "saved" || !legacyBackup || readStoredRaw() !== legacyBackup) throw new Error("请先完成迁移与云端同步，并保留当前旧账本的备份。");
      const old = loadData(); const current = store.loadData();
      if (old.error || current.error || planLegacyMigration(old.data, current.data).added) throw new Error("旧账本与账户内容还未完全对应，请重新核对，原副本已保留。");
      if (!window.confirm("请确认另一设备已能读到迁移的账目，并已保留 JSON 备份。现在移除此浏览器的旧本机账本副本吗？")) return;
      if (readStoredRaw() !== legacyBackup) throw new Error("旧账本已改变，请重新核对。");
      const result = clearStoredData(); if (!result.ok) throw new Error(result.error);
      setLegacy({ present: false, ...loadData() }); setNotice("旧本机副本已移除，账户账本与下载的备份保留。");
    } catch (error) { setNotice(error instanceof Error ? error.message : "旧副本未能移除。"); }
  }

  async function signOut() {
    if (busy) return;
    const current = store.getState();
    if (current.dirty && !window.confirm("尚有账目未同步。建议先取消退出并导出账户备份。仍要退出吗？继续将移除此账户的本机副本，未同步修改将丢失。")) return;
    setBusy(true); setNotice("");
    const result = store.clearCache();
    if (!result.ok) { setNotice(result.error ?? "本机账户副本未能移除，请检查存储权限后重试退出。"); setBusy(false); return; }
    setLeaving(true);
    try {
      const { error } = await client.auth.signOut({ scope: "local" });
      if (error) throw error;
      // Purge once more after auth has ended, including a tab opened during logout.
      clearAccountCache(projectUrl, session.user.id);
    } catch { setNotice("本机账本副本已移除，但退出登录未完成。请检查网络后重试。"); setBusy(false); }
  }

  const controls = <button className="button secondary small account-control" onClick={() => dialog.current?.showModal()} aria-label="我的账户"><UserRound size={16} /><span>我的账户</span><SyncBadge state={state} /></button>;
  const panel = <section className="setting-card account-panel"><div className="setting-heading"><Cloud size={23} /><h2>账户与云端同步</h2></div><p className="account-email">{accountName}</p><SyncBadge state={state} /><p>{state.message}</p><button className="button secondary" onClick={() => dialog.current?.showModal()}>管理账户与同步</button></section>;
  return <>
    {leaving ? <main className="account-empty"><LogOut /><h1>正在退出账户</h1><p role="status">{notice || "正在移除本机账户副本并结束登录。"}</p>{!busy && <button className="button secondary" onClick={() => void signOut()}>重试退出</button>}</main> : state.ready || state.recoveryError ? <App key={bookEpoch} store={store} cloudMode accountControls={controls} accountPanel={panel} /> : <main className="account-loading"><RefreshCw className={state.phase === "syncing" ? "auth-spinning" : ""} /><h1>正在读取你的账户账本</h1><p>{state.message}</p><p>首次读取需要联网。连接失败时不会创建空账本覆盖已有记录。</p><div className="account-actions"><button className="button secondary" disabled={state.phase === "syncing"} onClick={() => { void store.retry(); }}>重新连接</button><button className="button ghost" onClick={() => location.reload()}>重新打开应用</button>{controls}</div></main>}
    {!leaving && <dialog className="account-dialog" ref={dialog} aria-labelledby="account-dialog-title">
      <div className="account-dialog-header"><h2 id="account-dialog-title">我的账户</h2><button className="icon-button" aria-label="关闭账户窗口" onClick={() => dialog.current?.close()}><X size={18} /></button></div>
      <div className="account-dialog-body">
        <p className="account-email">{accountName}</p><SyncBadge state={state} /><p>{state.message}</p>
        {state.lastSyncedAt && <p>最近确认同步：{new Date(state.lastSyncedAt).toLocaleString("zh-CN")}</p>}
        <div className="account-actions"><button className="button secondary" disabled={busy || state.phase === "syncing" || state.phase === "conflict"} onClick={() => void store.retry()}><RefreshCw size={16} />立即同步</button><button className="button secondary" disabled={!state.ready && !state.recoveryError} onClick={backupAccount}><ArrowDownToLine size={16} />导出账户备份</button></div>
        {(state.phase === "conflict" || state.recoveryError) && <section className="conflict-box" aria-labelledby="sync-conflict-title"><h3 id="sync-conflict-title">{state.recoveryError ? "本机副本需要恢复" : "两个设备的账目需要核对"}</h3><p>先保留本机备份，再选择完整账本版本。采用云端会替换此设备内容；保留本机会替换云端及其他设备内容。</p><div className="account-actions"><button className="button secondary" disabled={busy} onClick={() => void resolve("cloud")}>采用云端版本</button>{!state.recoveryError && <button className="button secondary" disabled={busy} onClick={() => void resolve("local")}>保留本机版本</button>}</div></section>}
        {legacy.present && <section className="migration-card"><h3>迁移原来的本机账本</h3>{legacy.error ? <p>旧本机账本暂时无法读取。原始数据保留，请下载备份后核对。</p> : <p>此浏览器保留着 {legacy.data.transactions.length} 笔旧记录。它们尚未因登录而自动上传。目标账户：{accountName}。</p>}<p>先下载完整备份，再确认合并。已有账户账目会保留；相近交易请自行核对。</p><div className="account-actions"><button className="button secondary" onClick={backupLegacy}>备份旧本机账本</button><button className="button primary" disabled={busy || !legacyBackup || Boolean(legacy.error) || !state.ready || Boolean(state.recoveryError) || state.phase === "conflict" || migrated} onClick={migrateLegacy}>{migrated ? "已合并，原副本保留" : "确认迁移至此账户"}</button>{migrated && <button className="button ghost" disabled={state.phase !== "saved" || busy} onClick={removeLegacy}>移除旧本机副本</button>}</div></section>}
        {notice && <p role="status" className="auth-feedback">{notice}</p>}
        <hr className="account-divider" /><p>账目按账户保存到云端；此设备的离线副本和导出备份仍是明文。共用设备使用后请退出。</p>
        <button className="button secondary" disabled={busy} onClick={() => void signOut()}><LogOut size={16} />退出登录并清除本机副本</button>
      </div>
    </dialog>}
  </>;
}
