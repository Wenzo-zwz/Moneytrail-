import SmsClassificationTools from "./SmsClassificationTools";
import SmsShortcutSetup from "./SmsShortcutSetup";
import SmsActivitySummary from "./SmsActivitySummary";
import { getCompatibleBankActivityTemplate, getCompatibleSmsShortcutTemplate } from "../lib/bankOnboarding";
import { getReleasedBankSmsV4 } from "../lib/bankRulesV4";
import { categoryText, DetailField } from "./TransactionMetadata";
import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ArrowLeft, Check, ChevronDown, ChevronLeft, ChevronRight, Copy, Eye, EyeOff, KeyRound, LockKeyhole, MessageSquare, RefreshCw, ShieldCheck, Smartphone, X } from "lucide-react";
import { CATEGORIES, formatMoney, isValidLocalDateTime, parseAmount } from "../lib/ledger";
import { readCloudConfig } from "../lib/cloudConfig";
import type { CloudStore } from "../lib/cloudStore";
import { SmsSetupError, confirmSms, dismissSms, fetchSmsConfig, fetchSmsInbox, fetchSmsPreferences, revokeSmsToken, rotateSmsToken, setSmsMode, setSmsPreferences, type SmsConfig, type SmsDraft, type SmsInbox, type SmsInboxItem, type SmsPreferences } from "../lib/smsClient";
import type { MerchantRule } from "../lib/merchantClassification";
import type { SmsBankCode } from "../lib/smsBanks";
import { canOfferMerchantMemory } from "./merchantMemory";
import { refreshSmsLedger } from "../lib/smsLedgerSync";
import { isShortcutTemplateCompatible } from "../lib/shortcutTemplate";

interface SmsAutomationPanelProps {
  client: SupabaseClient;
  userId: string;
  projectUrl: string;
  onBack: () => void;
  store: CloudStore;
  onRulesChanged?: () => void;
}
type Result = { owner: string; key: string; config: SmsConfig; inbox: SmsInbox; preferences: SmsPreferences | null; preferencesError: string | null };
type Failure = { owner: string; key: string; setup: boolean; message: string };
const PAGE_SIZE = 10;
const dateTime = new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Shanghai" });
const kinds = [{ value: "expense", label: "消费支出" }, { value: "transfer", label: "转账，不计消费" }, { value: "refund", label: "退款" }, { value: "income", label: "收入" }] as const;
const defaultPreferences: SmsPreferences = { mode: "auto", category_depth: "primary" };
const categoryShortcutFile = "moneytrail-bank-sms-category-beta.unsigned.plist";
const categoryShortcutDownload = `${import.meta.env.BASE_URL}shortcuts/${categoryShortcutFile}`;
const signedShortcutFile = "MoneyTrail-SMS-Category-Beta.shortcut";
const signCategoryShortcut = `cd ~/Downloads && shortcuts sign --mode anyone --input ${categoryShortcutFile} --output ${signedShortcutFile}`;

function receivedTime(value: string | null) {
  if (!value) return "尚未收到短信";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? `${dateTime.format(date)}（北京时间）` : "—";
}

function InboxCard({ item, busy, canConfirm, onConfirm, onDismiss }: { item: SmsInboxItem; busy: boolean; canConfirm: boolean; onConfirm: (id: string, draft: SmsDraft, remember: boolean) => Promise<void>; onDismiss: (id: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [kind, setKind] = useState<SmsDraft["kind"] | "">(item.draft?.kind ?? "");
  const [amount, setAmount] = useState(item.draft ? (item.draft.amountCents / 100).toFixed(2) : "");
  const [date, setDate] = useState(item.draft?.date ?? "");
  const [merchant, setMerchant] = useState(item.draft?.merchant ?? "");
  const [category, setCategory] = useState(item.draft?.category ?? "待分类");
  const [subcategory, setSubcategory] = useState(item.draft?.subcategory);
  const [note, setNote] = useState(item.draft?.note ?? "");
  const [error, setError] = useState("");
  const [explicitChoice, setExplicitChoice] = useState(false);
  const [remember, setRemember] = useState(true);
  const canRemember = Boolean(item.draft && kind !== "" && item.warnings.length === 0 && canOfferMerchantMemory(item.draft, { ...item.draft, kind, merchant, category, subcategory }, explicitChoice));
  const pending = item.status === "pending";
  const kindLabel = kinds.find(option => option.value === item.draft?.kind)?.label ?? "交易类型待核对";
  const amountPrefix = item.draft?.kind === "expense" ? "−" : item.draft?.kind === "income" || item.draft?.kind === "refund" ? "+" : "";
  const amountClass = item.draft?.kind === "income" || item.draft?.kind === "refund" ? "text-success" : item.draft?.kind === "transfer" ? "text-muted" : undefined;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !canConfirm) return;
    if (!kind) { setError("请选择交易类型。"); return; }
    const cents = parseAmount(amount);
    if (!cents || !isValidLocalDateTime(date) || !merchant.trim() || merchant.length > 200) { setError("请填写有效的金额、时间和商户。"); return; }
    setError("");
    await onConfirm(item.id, { ...item.draft, kind, amountCents: cents, date, merchant: merchant.trim(), category, ...(subcategory ? { subcategory: subcategory.trim() || "未细分" } : {}), source: "sms", note }, canRemember && remember);
  }
  return <article className={`sms-message ${item.status}`}>
    <div className="sms-message-heading"><span className={`sms-status ${item.status}`}>{pending ? "待确认" : item.status === "recorded" ? "已入账" : "已忽略"}</span><time dateTime={item.received_at}>{receivedTime(item.received_at)}</time></div>
    <div className="sms-message-summary"><div><h3>{item.draft?.merchant || "需要手动核对的银行短信"}</h3><p>{item.draft?.date.replace("T", " ") || "尚未识别交易时间"}</p><p className="sms-message-kind">{kindLabel}</p></div><strong className={amountClass}>{item.draft ? `${amountPrefix}${formatMoney(item.draft.amountCents)}` : "待核对"}</strong></div>
    {item.draft && <p className="sms-form-hint">{categoryText(item.draft)}</p>}
    {pending ? <>
      {item.reason && <p className="sms-review-reason">{item.reason}</p>}
      {item.warnings.length > 0 && <ul className="sms-warnings">{item.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
      {item.raw_text && <details className="sms-original"><summary>查看短信原文<ChevronDown size={14} /></summary><p>{item.raw_text}</p></details>}
      <button className="sms-edit-toggle" type="button" aria-expanded={editing} aria-controls={`sms-form-${item.id}`} onClick={() => setEditing(value => !value)}>{editing ? "收起核对" : "核对并记录"}<ChevronDown size={16} className={editing ? "expanded" : undefined} /></button>
      {editing && <form className="sms-review-form" id={`sms-form-${item.id}`} onSubmit={submit}>
        <label>交易类型<select required value={kind} onChange={event => setKind(event.target.value as SmsDraft["kind"] | "")} disabled={busy}>{!item.draft && <option value="" disabled>请选择交易类型</option>}{kinds.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
        <label>金额（元）<input type="text" inputMode="decimal" required autoComplete="off" maxLength={20} value={amount} onChange={event => setAmount(event.target.value)} disabled={busy} /></label>
        <label>交易时间<input type="datetime-local" required value={date} onChange={event => setDate(event.target.value)} disabled={busy} /></label>
        <label>商户或用途<input type="text" required autoComplete="off" maxLength={200} value={merchant} onChange={event => setMerchant(event.target.value)} disabled={busy} /></label>
        <label>分类<select value={category} onChange={event => { setExplicitChoice(true); setCategory(event.target.value); setSubcategory("未细分"); }} disabled={busy}>{CATEGORIES.map(value => <option key={value} value={value}>{value}</option>)}</select></label>
        <DetailField category={category} value={subcategory} onChange={value => { setExplicitChoice(true); setSubcategory(value); }} disabled={busy} />
        {canRemember && <label className="sms-remember"><input type="checkbox" checked={remember} onChange={event => setRemember(event.target.checked)} disabled={busy} />以后这家都这样分类</label>}
        <label>备注<input type="text" autoComplete="off" maxLength={2000} value={note} onChange={event => setNote(event.target.value)} disabled={busy} /></label>
        {kind === "transfer" && <p className="sms-form-hint">转账会保留记录，不计入消费支出。</p>}
        {!item.draft && <p className="sms-form-hint">未能自动识别这条短信，请对照原文选择交易类型、逐项填写后再确认。支出付款详情也可用截图记账补录；先核对已有记录，避免重复。</p>}
        {error && <p className="sms-form-error" role="alert">{error}</p>}
        <div className="sms-review-actions"><button className="button primary" type="submit" disabled={busy || !canConfirm}><Check size={16} />确认并记入账本</button><button className="button ghost" type="button" disabled={busy} onClick={() => void onDismiss(item.id)}>忽略此条</button></div>
      </form>}
    </> : <p className="sms-processed-note">{item.status === "recorded" ? "已入账，短信原文已移除。新记录的脱敏凭据长期保留在账本中，可在编辑账目时查看；历史记录可能没有凭据。" : "已移除短信原文，不计入账本，也不新增凭据。"}</p>}
  </article>;
}

function SmsRecordingOptions({ preferences, iphoneAvailable, disabled, onChange }: {
  preferences: SmsPreferences;
  iphoneAvailable: boolean;
  disabled: boolean;
  onChange: (preferences: SmsPreferences) => void;
}) {
  const { mode, category_depth } = preferences;
  function changeMode(nextMode: SmsPreferences["mode"]) { onChange({ ...preferences, mode: nextMode }); }
  function changeDepth(depth: SmsPreferences["category_depth"]) { onChange({ ...preferences, category_depth: depth }); }
  return <>
    <fieldset className="sms-mode-options" disabled={disabled}>
      <legend>收到短信后</legend>
      <label className={mode === "auto" ? "selected" : undefined}>
        <input type="radio" name="sms-mode" value="auto" checked={mode === "auto"} onChange={() => changeMode("auto")} />
        <span><strong>自动记录明确消费</strong><small>明确消费和已识别的本人资金周转可入账；不明用途继续核对</small></span>
      </label>
      {iphoneAvailable && <label className={mode === "iphone" ? "selected" : undefined}>
        <input type="radio" name="sms-mode" value="iphone" checked={mode === "iphone"} onChange={() => changeMode("iphone")} />
        <span><strong>在 iPhone 确认</strong><small>用支持分类确认的快捷指令，在 iPhone 上为符合条件的工行支出选分类</small></span>
      </label>}
      <label className={mode === "review" ? "selected" : undefined}>
        <input type="radio" name="sms-mode" value="review" checked={mode === "review"} onChange={() => changeMode("review")} />
        <span><strong>到收件箱确认</strong><small>每条短信都由你核对后再入账</small></span>
      </label>
    </fieldset>
    {iphoneAvailable && mode === "iphone" && <fieldset className="sms-mode-options sms-depth-options" disabled={disabled}>
      <legend>在 iPhone 上确认的分类</legend>
      <label className={category_depth === "primary" ? "selected" : undefined}>
        <input type="radio" name="sms-category-depth" value="primary" checked={category_depth === "primary"} onChange={() => changeDepth("primary")} />
        <strong>只确认一级</strong>
      </label>
      <label className={category_depth === "secondary" ? "selected" : undefined}>
        <input type="radio" name="sms-category-depth" value="secondary" checked={category_depth === "secondary"} onChange={() => changeDepth("secondary")} />
        <strong>也确认二级</strong>
      </label>
    </fieldset>}
  </>;
}

export default function SmsAutomationPanel({ client, userId, projectUrl, onBack, store, onRulesChanged }: SmsAutomationPanelProps) {
  const syncState = useSyncExternalStore(store.subscribeState, store.getState);
  const [page, setPage] = useState(1);
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<Result | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [preferences, setPreferences] = useState(defaultPreferences);
  const [setupBank, setSetupBank] = useState<{ owner: string; code: SmsBankCode }>({ owner: userId, code: "icbc" });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [secret, setSecret] = useState<{ owner: string; value: string } | null>(null);
  const [revealed, setRevealed] = useState(false);
  const tokenDialog = useRef<HTMLDialogElement>(null);
  const actionController = useRef<AbortController | null>(null);
  const ownerRef = useRef(userId);
  ownerRef.current = userId;
  const key = `${page}|${revision}`;
  const current = result?.owner === userId && result.key === key ? result : null;
  const currentFailure = failure?.owner === userId && failure.key === key ? failure : null;
  const config = current?.config;
  const inbox = current?.inbox;
  const storedPreferences = current?.preferences;
  const settingsUnavailable = Boolean(current?.preferencesError);
  const iphoneMode = preferences.mode === "iphone";
  const categoryShortcutCompatible = isShortcutTemplateCompatible(projectUrl);
  const selectedPreferences: SmsPreferences = {
    ...preferences,
    category_depth: preferences.mode === "iphone" ? preferences.category_depth : storedPreferences?.category_depth ?? "primary",
  };
  const preferencesChanged = selectedPreferences.mode !== (storedPreferences?.mode ?? config?.mode)
    || selectedPreferences.category_depth !== (storedPreferences?.category_depth ?? "primary");
  const loading = !current && !currentFailure;
  const token = secret?.owner === userId ? secret.value : "";
  const selectedSetupBank = setupBank.owner === userId ? setupBank.code : "icbc";
  const simpleTemplate = getReleasedBankSmsV4(projectUrl);
  const selectedActivityTemplate = simpleTemplate ?? getCompatibleBankActivityTemplate(projectUrl, selectedSetupBank);
  const selectedTemplate = selectedActivityTemplate ?? getCompatibleSmsShortcutTemplate(projectUrl, selectedSetupBank);
  const canConfirm = syncState.ready && !syncState.dirty && syncState.phase === "saved" && !syncState.recoveryError;
  const canRefreshLedger = syncState.ready && !syncState.dirty && syncState.phase !== "conflict" && !syncState.recoveryError;
  const publicConfig = readCloudConfig(import.meta.env);
  const endpoint = `${projectUrl.replace(/\/$/, "")}/rest/v1/rpc/moneytrail_receive_sms`;

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
      if (active) setFailure({ owner: userId, key, setup: false, message: "读取超时，请检查网络后重试。" });
    }, 20_000);
    setFailure(null);
    const preferencesRequest = fetchSmsPreferences(client, userId, controller.signal).then(
      preferences => ({ preferences, preferencesError: null }),
      () => ({ preferences: null, preferencesError: "暂时无法读取记录方式。请刷新收件箱后重试。" }),
    );
    void Promise.all([
      fetchSmsConfig(client, userId, controller.signal),
      fetchSmsInbox(client, userId, { page, pageSize: PAGE_SIZE }, controller.signal),
      preferencesRequest,
    ]).then(([nextConfig, nextInbox, preferenceResult]) => {
      if (!active || controller.signal.aborted) return;
      setResult({ owner: userId, key, config: nextConfig, inbox: nextInbox, ...preferenceResult });
      setPreferences(preferenceResult.preferences ?? { ...defaultPreferences, mode: nextConfig.mode });
    }).catch((error: unknown) => {
      if (!active || controller.signal.aborted) return;
      setFailure({ owner: userId, key, setup: error instanceof SmsSetupError, message: error instanceof Error ? error.message : "暂时无法读取短信接入状态。" });
    }).finally(() => clearTimeout(timeout));
    return () => { active = false; clearTimeout(timeout); controller.abort(); };
  }, [client, userId, key, page]);
  useEffect(() => {
    return () => { actionController.current?.abort(); actionController.current = null; setBusy(false); };
  }, [userId]);
  useEffect(() => {
    if (token) tokenDialog.current?.showModal();
    else tokenDialog.current?.close();
  }, [token]);

  function refresh() { setRevision(value => value + 1); }
  async function refreshInbox() {
    await run(async () => {
      const state = store.getState();
      if (state.ready && !state.dirty && state.phase !== "conflict" && !state.recoveryError) return refreshSmsLedger(store);
    });
  }
  function clearSecret() { setSecret(null); setRevealed(false); tokenDialog.current?.close(); }
  async function run(action: (signal: AbortSignal) => Promise<string | void>, refreshAfter = true) {
    if (actionController.current) return;
    const owner = userId;
    const controller = new AbortController();
    actionController.current = controller; setBusy(true); setNotice("");
    const timeout = setTimeout(() => { controller.abort(); if (ownerRef.current === owner) setNotice("操作超时，请刷新状态后再重试；不要连续重复提交。"); }, 20_000);
    try {
      const message = await action(controller.signal);
      if (controller.signal.aborted || ownerRef.current !== owner) return;
      if (message) setNotice(message);
      if (refreshAfter) refresh();
    } catch (error) {
      if (!controller.signal.aborted && ownerRef.current === owner) setNotice(error instanceof Error ? error.message : "操作未完成，请检查网络后重试。");
    } finally {
      clearTimeout(timeout);
      if (actionController.current === controller) { actionController.current = null; if (ownerRef.current === owner) setBusy(false); }
    }
  }
  async function createToken() {
    if (!config || settingsUnavailable) return;
    if (config.enabled && !window.confirm("更换令牌后，原有 iPhone 自动化会停止接收，需更新手机里的令牌。确定更换吗？")) return;
    await run(async signal => {
      // The legacy endpoint keeps handling its existing senders while iPhone confirmation uses the new shortcut.
      const legacyMode = selectedPreferences.mode === "iphone" ? (config.enabled ? config.mode : "review") : selectedPreferences.mode;
      const response = await rotateSmsToken(client, userId, legacyMode, signal);
      if (!signal.aborted && ownerRef.current === userId) { setSecret({ owner: userId, value: response.token }); setRevealed(false); }
      if (storedPreferences && preferencesChanged && !signal.aborted) {
        try { await setSmsPreferences(client, userId, selectedPreferences, signal); }
        catch { return "接入令牌已生成。记录方式未确认，请保存令牌后重新核对记录方式。"; }
      }
      return "接入已启用。请保存令牌，并完成手机上的自动化配置。";
    });
  }
  async function saveRecordingMode() {
    if (settingsUnavailable || !preferencesChanged) return;
    await run(async signal => {
      if (storedPreferences) await setSmsPreferences(client, userId, selectedPreferences, signal);
      else if (selectedPreferences.mode !== "iphone") await setSmsMode(client, userId, selectedPreferences.mode, signal);
      return "记录方式已更新，仅对之后收到的短信生效。";
    });
  }
  async function copy(value: string, message: string) {
    const owner = userId;
    try { await navigator.clipboard.writeText(value); if (ownerRef.current === owner) setNotice(message); }
    catch { if (ownerRef.current === owner) setNotice("复制未完成，请长按内容手动复制。" ); }
  }
  async function confirm(id: string, draft: SmsDraft, remember: boolean) {
    const state = store.getState();
    if (!state.ready || state.dirty || state.phase !== "saved" || state.recoveryError) { setNotice("请先返回账本完成同步或处理冲突，再确认这条短信。" ); return; }
    await run(async signal => {
      await confirmSms(client, userId, id, draft, signal, remember);
      if (signal.aborted) return;
      if (remember) onRulesChanged?.();
      const refreshNotice = await refreshSmsLedger(store);
      return `已确认并记入云端账本。${refreshNotice}`;
    });
  }
  async function dismiss(id: string) { await run(async signal => { await dismissSms(client, userId, id, signal); return "已忽略这条短信，原文已移除。"; }); }


  return <main className="sms-shell">
    <div className="sms-content">
      <header className="sms-topbar"><span className="sms-brand"><span className="brand-mark" aria-hidden="true"><MessageSquare size={21} /></span><span><strong>Moneytrail</strong><small>PRIVATE CAPTURE</small></span></span><button className="button ghost" onClick={() => { clearSecret(); onBack(); }}><ArrowLeft size={16} />返回账本</button></header>
      <section className="sms-intro"><div><p className="sms-eyebrow">MONEYTRAIL / SMS AUTOMATION</p><h1>短信自动记账</h1><p>让银行短信，成为账本的起点。</p></div><span className="sms-privacy-tag"><LockKeyhole size={15} />仅进入当前账户</span></section>

      <div className="sms-notice" role="status" aria-live="polite">{notice}</div>
      {canRefreshLedger && syncState.phase !== "saved" && syncState.phase !== "syncing" && <div className="sms-sync-hint" role="status"><p>首页账目尚未刷新。{syncState.message}</p><button className="button secondary small" disabled={busy} onClick={() => void refreshInbox()}><RefreshCw size={15} />重试账本同步</button></div>}
      {loading ? <section className="sms-state" role="status"><RefreshCw className="auth-spinning" size={24} /><h2>正在读取接入状态</h2><p>正在连接当前账户的短信收件箱。</p></section> : currentFailure ? <section className="sms-state"><ShieldCheck size={28} /><h2>{currentFailure.setup ? "短信接入尚未开通" : "暂时无法读取短信接入"}</h2><p role="alert">{currentFailure.message}</p>{currentFailure.setup && <p>请联系应用维护者完成短信接入配置，已有账本仍可使用。</p>}<button className="button secondary" onClick={refresh}><RefreshCw size={16} />重新检查</button></section> : config && inbox && <>
        <section className="sms-overview" aria-label="短信接入概览"><article><span>接入状态</span><strong className={config.enabled ? "sms-enabled" : undefined}>{config.enabled ? "已启用" : "未启用"}</strong><small>{config.enabled ? "等待手机自动化发送短信" : "启用后，仍需配置一次 iPhone"}</small></article><article><span>最近接收</span><strong className="sms-receipt-time">{receivedTime(config.last_received_at)}</strong><small>收到新短信后，可在此核对接入是否成功</small></article><article><span>待确认</span><strong>{config.pending_count}<em>笔</em></strong><small>确认前，不计入账本</small></article></section>
        <SmsActivitySummary client={client} userId={userId} refreshKey={revision} />
        <details className="sms-guide"><summary>未收到或未识别时，怎么核对与补录？</summary><div>
          <p>先确认银行已开通动账短信、实际发件人、自动化输入和运行权限。iOS 更新后需用新短信核对锁屏运行；“接入已启用”不能证明手机已触发。</p>
          <p>服务端只能显示已接收记录。网络失败没有自动补传；恢复网络后先核对收件箱和账本，再决定补录。</p>
          <p>返回账本 → 录入 → 粘贴银行短信，或在付款详情使用“截图记账”。截图入口当前用于支出；收入、退款和转账需手动核对。补录前对照金额、时间和已有记录，避免重复。</p>
          <button type="button" className="button secondary small" onClick={onBack}>返回账本补录</button>
        </div></details>
        <SmsClassificationTools key={userId} client={client} userId={userId} store={store} busy={busy} canWrite={canConfirm} iphoneAvailable={Boolean(storedPreferences)} run={action => run(action, false)} onServerWrite={refresh} onRulesChanged={onRulesChanged} />
        <div className={`sms-main-grid${config.enabled && config.pending_count > 0 ? " has-pending" : ""}`}>
          <section className="sms-setup-card" aria-labelledby="sms-setup-title"><div className="sms-section-heading"><div><p className="sms-eyebrow">CAPTURE SETTINGS</p><h2 id="sms-setup-title">接收与记录</h2></div><Smartphone size={23} /></div><p className="sms-section-description">工行明确消费按下方方式处理。五家银行的收入候选、农中建招支出均先待确认。</p>
            <SmsRecordingOptions preferences={preferences} iphoneAvailable={Boolean(storedPreferences)} disabled={busy || settingsUnavailable} onChange={setPreferences} />
            {current?.preferencesError && <p className="sms-group-rule" role="alert">{current.preferencesError}</p>}
            <p className="sms-group-rule"><ShieldCheck size={15} />“财付通-群收款”始终待确认，由你判断是消费还是转账。</p>
            <p className="sms-forward-consent">启用表示你同意：由自己配置的 iPhone 自动化，将筛选后的银行收支短信转发至当前慢慢记账账户。请勿转发验证码或其他私人短信。</p>
            <div className="sms-setup-actions">{config.enabled ? <>
              <button className="button primary" disabled={busy || settingsUnavailable || !preferencesChanged} onClick={() => void saveRecordingMode()}>保存记录方式</button>
              <button className="button secondary" disabled={busy || settingsUnavailable} onClick={() => void createToken()}><KeyRound size={15} />更换接入令牌</button>
              <button className="button ghost" disabled={busy} onClick={() => void run(async signal => { await revokeSmsToken(client, userId, signal); clearSecret(); return "已停用接入，手机里的旧令牌立即失效。已有待确认短信仍可处理。"; })}>停用接入</button>
            </> : <button className="button primary" disabled={busy || settingsUnavailable} onClick={() => void createToken()}><KeyRound size={16} />同意转发并启用</button>}</div>
            {iphoneMode ? <section className="sms-shortcut-setup" aria-labelledby="sms-category-shortcut-title">
              <h3 id="sms-category-shortcut-title">在 iPhone 上接入</h3>
              {categoryShortcutCompatible ? <>
                <p className="sms-shortcut-intro">将分类确认快捷指令的源文件保存到 Mac 的「下载」，在终端签名。</p>
                <a className="button secondary sms-shortcut-install" href={categoryShortcutDownload} download={categoryShortcutFile}>下载未签名快捷指令</a>
                <div className="sms-copy-field"><code>{signCategoryShortcut}</code><button className="button secondary small" onClick={() => void copy(signCategoryShortcut, "签名命令已复制。")}><Copy size={14} />复制签名命令</button></div>
                <p className="sms-shortcut-boundary">把 <code>{signedShortcutFile}</code> 传到 iPhone，从「文件」打开并添加，填入已有接入令牌。将「信息」自动化设为「立即运行」，传入收到的信息正文。同一发件人只绑定一条记账自动化，首次运行时在解锁状态下允许联网。</p>
              </> : <p className="sms-shortcut-intro">请使用为当前部署配置的分类确认快捷指令，并绑定「信息」自动化。</p>}
            </section> : <SmsShortcutSetup projectUrl={projectUrl} config={config} busy={busy} bankCode={selectedSetupBank} onBankChange={code => setSetupBank({ owner: userId, code })} onRefresh={() => void refreshInbox()} />}
            {!iphoneMode && !simpleTemplate && <details className="sms-guide"><summary><span><Smartphone size={17} />iPhone 配置步骤</span><ChevronDown size={16} /></summary><div>
              <p className="sms-guide-intro">以下为高级手动配置。收入接入使用上方收支新版；旧工行和农中建安装链接仅用于支出。其他部署需按当前项目地址和公开密钥制作配套指令，以下网络字段共用。</p>
              <p className="sms-guide-intro">新收支自动化使用实际发件人、完整短信输入和本地收支筛选。创建个人自动化后，新短信才能触发；网站无法直接读取短信历史。</p>
              <ol><li>打开 iPhone「快捷指令」→「自动化」→「＋」→「信息」。发件人选择银行短信的实际号码，“信息包含”留空，选择「立即运行」。</li><li>添加「从输入中获取文本」，输入选择「快捷指令输入／信息正文」。使用配套收支模板的「匹配文本」规则核对唯一银行来源与交易动作，排除验证码；仅在匹配有值时继续网络请求。</li><li>添加「获取 URL 内容」，填入下方接收地址，方法选 <strong>POST</strong>，请求体选 <strong>JSON</strong>。添加两个文本字段：<code>p_token</code> 填刚保存的接入令牌；<code>p_message</code> 选择上一步的短信文本变量。</li><li>在请求头添加 <code>apikey</code>，值填下方公开密钥；添加 <code>Content-Type</code>，值为 <code>application/json</code>。保存自动化。</li><li>下一条真实银行交易短信到达后，打开这里点击「刷新收件箱」，核对最近接收时间、金额与状态。请勿为了测试通知而提交虚构交易。</li></ol>
              <div className="sms-copy-field"><span>接收地址</span><code>{endpoint}</code><button className="button secondary small" onClick={() => void copy(endpoint, "接收地址已复制。")}><Copy size={14} />复制接收地址</button></div>
              <div className="sms-copy-field"><span>公开密钥（apikey）</span>{publicConfig?.url === projectUrl.replace(/\/$/, "") ? <><code>{publicConfig.publishableKey}</code><button className="button secondary small" onClick={() => void copy(publicConfig.publishableKey, "公开密钥已复制。")}><Copy size={14} />复制公开密钥</button></> : <p>请使用此 Supabase 项目的 Publishable key。不要填写 Secret key。</p>}</div>
              <p className="sms-guide-footnote">接入令牌仅允许提交短信，不能读取账本。请保存在自己的快捷指令中，不要分享。离线发送失败不会自动补传，已有短信也不会自动导入；漏记时仍可粘贴短信补录。</p>
            </div></details>}
          </section>

          <section className="sms-inbox" aria-labelledby="sms-inbox-title"><div className="sms-section-heading"><div><p className="sms-eyebrow">YOUR MESSAGE INBOX</p><h2 id="sms-inbox-title">短信收件箱</h2><p>{inbox.total} 条接收记录</p></div><button className="button secondary small" disabled={busy} onClick={() => void refreshInbox()} aria-label="刷新收件箱"><RefreshCw size={15} />刷新</button></div>

            {config.pending_count > 0 && !canConfirm && <p className="sms-sync-hint" role="status">当前账本尚未完成同步。请先返回账本同步或处理冲突，再确认短信，避免覆盖本机修改。</p>}
            {inbox.items.length ? <div className="sms-messages">{inbox.items.map(item => <InboxCard key={`${userId}:${item.id}:${item.status}`} item={item} busy={busy} canConfirm={canConfirm} onConfirm={confirm} onDismiss={dismiss} />)}</div> : <div className="sms-inbox-empty"><MessageSquare size={30} /><h3>等待第一条银行交易短信</h3><p>完成 iPhone 自动化后，新收到的符合条件的银行收支短信会出现在这里。</p><span>收入与群收款先待确认 · 相同短信 24 小时内去重</span></div>}
            {inbox.total > PAGE_SIZE && <div className="sms-pagination"><button className="button ghost small" disabled={busy || page <= 1} onClick={() => setPage(value => Math.max(1, value - 1))}><ChevronLeft size={15} />上一页</button><span>{inbox.page} / {Math.max(1, Math.ceil(inbox.total / inbox.page_size))}</span><button className="button ghost small" disabled={busy || inbox.page * inbox.page_size >= inbox.total} onClick={() => setPage(value => value + 1)}>下一页<ChevronRight size={15} /></button></div>}
          </section>
        </div>
      </>}
      <footer className="sms-footer"><ShieldCheck size={14} /><p>账本与收件箱按账户隔离。入账后移除原文，脱敏凭据长期保留在账本中；历史记录可能没有凭据。忽略不会新增账目或凭据。</p></footer>
    </div>
    <dialog className="sms-token-dialog" ref={tokenDialog} onCancel={clearSecret} onClose={clearSecret} aria-labelledby="sms-token-title">
      <div className="sms-token-heading"><KeyRound size={25} /><button className="icon-button" aria-label="关闭令牌窗口" onClick={clearSecret}><X size={18} /></button></div>
      <p className="sms-eyebrow">YOUR PRIVATE INGESTION KEY</p>
      <h2 id="sms-token-title">接入令牌，仅显示这一次</h2>
      <p>请先复制并保存令牌，再填写到手机快捷指令中。关闭后无法再次查看，可通过更换令牌重新生成。</p>
      <div className="sms-token-value"><code>{revealed ? token : "mt_sms_••••••••••••••••••••••••"}</code></div>
      <div className="sms-token-tools">
        <button className="button secondary" onClick={() => void copy(token, "接入令牌已复制，请粘贴到自己的快捷指令中。")}><Copy size={16} />复制令牌</button>
        <button className="button ghost" onClick={() => setRevealed(value => !value)}>{revealed ? <EyeOff size={16} /> : <Eye size={16} />}{revealed ? "隐藏令牌" : "显示令牌"}</button>
      </div>
      {iphoneMode ? <p>保存后按「在 iPhone 上接入」的步骤签名并安装分类确认快捷指令。{categoryShortcutCompatible && <> <a className="button secondary small" href={categoryShortcutDownload} download={categoryShortcutFile}>下载未签名快捷指令</a></>}</p> : <>
        {selectedTemplate && <p>复制后，<a className="button secondary small" href={selectedTemplate.url} target="_blank" rel="noopener noreferrer">{selectedActivityTemplate ? "打开收支模板安装页" : "打开支出模板安装页"}</a>，安装「{selectedTemplate.name}」并在导入问题中粘贴自己的令牌。{selectedActivityTemplate ? "此模板支持五家银行收支，收入先待确认。" : "此旧版仅接收支出，收入请使用下方的收入与支出快捷指令。"}</p>}
        {!selectedActivityTemplate && <p>收支新版的匹配规则和制作步骤在下方接入指引中；已有有效令牌可直接沿用。</p>}
      </>}
      <p className="sms-token-warning">令牌持有者可向你的收件箱提交短信。请勿发到聊天、公开仓库或分享链接中。</p>
      <button className="button primary sms-token-done" onClick={clearSecret}><Check size={16} />我已保存</button>
    </dialog>
  </main>;
}
