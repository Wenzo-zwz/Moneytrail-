import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ArrowLeft, Check, ChevronDown, ChevronLeft, ChevronRight, Copy, Eye, EyeOff, KeyRound, LockKeyhole, MessageSquare, RefreshCw, ShieldCheck, Smartphone, X } from "lucide-react";
import { CATEGORIES, formatMoney, isValidLocalDateTime, parseAmount } from "../lib/ledger";
import { readCloudConfig } from "../lib/cloudConfig";
import type { CloudStore } from "../lib/cloudStore";
import { SmsSetupError, confirmSms, dismissSms, fetchSmsConfig, fetchSmsInbox, reprocessPendingSms, revokeSmsToken, rotateSmsToken, setSmsMode, type SmsConfig, type SmsDraft, type SmsInbox, type SmsInboxItem, type SmsMode } from "../lib/smsClient";

interface SmsAutomationPanelProps {
  client: SupabaseClient;
  userId: string;
  projectUrl: string;
  onBack: () => void;
  store: CloudStore;
}
type Result = { owner: string; key: string; config: SmsConfig; inbox: SmsInbox };
type Failure = { owner: string; key: string; setup: boolean; message: string };
const PAGE_SIZE = 10;
const dateTime = new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Shanghai" });
const kinds = [{ value: "expense", label: "消费支出" }, { value: "transfer", label: "转账，不计消费" }, { value: "refund", label: "退款" }, { value: "income", label: "收入" }] as const;

function receivedTime(value: string | null) {
  if (!value) return "尚未收到短信";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? `${dateTime.format(date)}（北京时间）` : "—";
}

function receiptDate(value: string) {
  const parts = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "Asia/Shanghai" }).formatToParts(new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`;
}

function InboxCard({ item, busy, canConfirm, onConfirm, onDismiss }: { item: SmsInboxItem; busy: boolean; canConfirm: boolean; onConfirm: (id: string, draft: SmsDraft) => Promise<void>; onDismiss: (id: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [kind, setKind] = useState<SmsDraft["kind"]>(item.draft?.kind ?? "expense");
  const [amount, setAmount] = useState(item.draft ? (item.draft.amountCents / 100).toFixed(2) : "");
  const [date, setDate] = useState(item.draft?.date ?? receiptDate(item.received_at));
  const [merchant, setMerchant] = useState(item.draft?.merchant ?? "");
  const [category, setCategory] = useState(item.draft?.category ?? "待分类");
  const [note, setNote] = useState(item.draft?.note ?? "");
  const [error, setError] = useState("");
  const pending = item.status === "pending";
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !canConfirm) return;
    const cents = parseAmount(amount);
    if (!cents || !isValidLocalDateTime(date) || !merchant.trim() || merchant.length > 200) { setError("请填写有效的金额、时间和商户。"); return; }
    setError("");
    await onConfirm(item.id, { kind, amountCents: cents, date, merchant: merchant.trim(), category, source: "sms", note });
  }
  return <article className={`sms-message ${item.status}`}>
    <div className="sms-message-heading"><span className={`sms-status ${item.status}`}>{pending ? "待确认" : item.status === "recorded" ? "已入账" : "已忽略"}</span><time dateTime={item.received_at}>{receivedTime(item.received_at)}</time></div>
    <div className="sms-message-summary"><div><h3>{item.draft?.merchant || "需要手动核对的银行短信"}</h3><p>{item.draft?.date.replace("T", " ") || "尚未识别消费时间"}</p></div><strong>{item.draft ? formatMoney(item.draft.amountCents) : "待核对"}</strong></div>
    {pending ? <>
      {item.reason && <p className="sms-review-reason">{item.reason}</p>}
      {item.warnings.length > 0 && <ul className="sms-warnings">{item.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
      {item.raw_text && <details className="sms-original"><summary>查看短信原文<ChevronDown size={14} /></summary><p>{item.raw_text}</p></details>}
      <button className="sms-edit-toggle" type="button" aria-expanded={editing} aria-controls={`sms-form-${item.id}`} onClick={() => setEditing(value => !value)}>{editing ? "收起核对" : "核对并记录"}<ChevronDown size={16} className={editing ? "expanded" : undefined} /></button>
      {editing && <form className="sms-review-form" id={`sms-form-${item.id}`} onSubmit={submit}>
        <label>交易类型<select value={kind} onChange={event => setKind(event.target.value as SmsDraft["kind"])} disabled={busy}>{kinds.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
        <label>金额（元）<input type="text" inputMode="decimal" required autoComplete="off" maxLength={20} value={amount} onChange={event => setAmount(event.target.value)} disabled={busy} /></label>
        <label>交易时间<input type="datetime-local" required value={date} onChange={event => setDate(event.target.value)} disabled={busy} /></label>
        <label>商户或用途<input type="text" required autoComplete="off" maxLength={200} value={merchant} onChange={event => setMerchant(event.target.value)} disabled={busy} /></label>
        <label>分类<select value={category} onChange={event => setCategory(event.target.value)} disabled={busy}>{CATEGORIES.map(value => <option key={value} value={value}>{value}</option>)}</select></label>
        <label>备注<input type="text" autoComplete="off" maxLength={2000} value={note} onChange={event => setNote(event.target.value)} disabled={busy} /></label>
        {kind === "transfer" && <p className="sms-form-hint">转账会保留记录，不计入消费支出。</p>}
        {!item.draft && <p className="sms-form-hint">未能自动识别这条短信，请对照原文逐项填写后再确认。</p>}
        {error && <p className="sms-form-error" role="alert">{error}</p>}
        <div className="sms-review-actions"><button className="button primary" type="submit" disabled={busy || !canConfirm}><Check size={16} />确认并记入账本</button><button className="button ghost" type="button" disabled={busy} onClick={() => void onDismiss(item.id)}>忽略此条</button></div>
      </form>}
    </> : <p className="sms-processed-note">{item.status === "recorded" ? "已处理；短信原文已移除。若之后修改或删除账目，此处仍保留处理记录。" : "已移除短信原文，不计入账本。"}</p>}
  </article>;
}

export default function SmsAutomationPanel({ client, userId, projectUrl, onBack, store }: SmsAutomationPanelProps) {
  const syncState = useSyncExternalStore(store.subscribeState, store.getState);
  const [page, setPage] = useState(1);
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<Result | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [mode, setMode] = useState<SmsMode>("auto");
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
  const loading = !current && !currentFailure;
  const token = secret?.owner === userId ? secret.value : "";
  const canConfirm = syncState.ready && !syncState.dirty && syncState.phase === "saved" && !syncState.recoveryError;
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
    void Promise.all([fetchSmsConfig(client, userId, controller.signal), fetchSmsInbox(client, userId, { page, pageSize: PAGE_SIZE }, controller.signal)]).then(([nextConfig, nextInbox]) => {
      if (!active || controller.signal.aborted) return;
      setResult({ owner: userId, key, config: nextConfig, inbox: nextInbox }); setMode(nextConfig.mode);
    }).catch((error: unknown) => {
      if (!active || controller.signal.aborted) return;
      setFailure({ owner: userId, key, setup: error instanceof SmsSetupError, message: error instanceof Error ? error.message : "暂时无法读取短信接入状态。" });
    }).finally(() => clearTimeout(timeout));
    return () => { active = false; clearTimeout(timeout); controller.abort(); };
  }, [client, userId, key, page]);
  useEffect(() => {
    return () => { actionController.current?.abort(); actionController.current = null; };
  }, [userId]);
  useEffect(() => {
    if (token) tokenDialog.current?.showModal();
    else tokenDialog.current?.close();
  }, [token]);

  function refresh() { setRevision(value => value + 1); }
  async function refreshInbox() {
    await run(async () => {
      const state = store.getState();
      if (state.ready && !state.dirty && state.phase === "saved" && !state.recoveryError) await store.refresh();
    });
  }
  function clearSecret() { setSecret(null); setRevealed(false); tokenDialog.current?.close(); }
  async function run(action: (signal: AbortSignal) => Promise<string | void>) {
    if (actionController.current) return;
    const owner = userId;
    const controller = new AbortController();
    actionController.current = controller; setBusy(true); setNotice("");
    const timeout = setTimeout(() => { controller.abort(); if (ownerRef.current === owner) setNotice("操作超时，请刷新状态后再重试；不要连续重复提交。"); }, 20_000);
    try {
      const message = await action(controller.signal);
      if (controller.signal.aborted || ownerRef.current !== owner) return;
      if (message) setNotice(message);
      refresh();
    } catch (error) {
      if (!controller.signal.aborted && ownerRef.current === owner) setNotice(error instanceof Error ? error.message : "操作未完成，请检查网络后重试。");
    } finally {
      clearTimeout(timeout);
      if (actionController.current === controller) { actionController.current = null; if (ownerRef.current === owner) setBusy(false); }
    }
  }
  async function createToken() {
    if (config?.enabled && !window.confirm("更换令牌后，原有 iPhone 自动化会停止接收，需更新手机里的令牌。确定更换吗？")) return;
    await run(async signal => {
      const response = await rotateSmsToken(client, userId, mode, signal);
      if (!signal.aborted && ownerRef.current === userId) { setSecret({ owner: userId, value: response.token }); setRevealed(false); }
      return "接入已启用。请保存令牌，并完成手机上的自动化配置。";
    });
  }
  async function copy(value: string, message: string) {
    const owner = userId;
    try { await navigator.clipboard.writeText(value); if (ownerRef.current === owner) setNotice(message); }
    catch { if (ownerRef.current === owner) setNotice("复制未完成，请长按内容手动复制。" ); }
  }
  async function confirm(id: string, draft: SmsDraft) {
    const state = store.getState();
    if (!state.ready || state.dirty || state.phase !== "saved" || state.recoveryError) { setNotice("请先返回账本完成同步或处理冲突，再确认这条短信。" ); return; }
    await run(async signal => {
      await confirmSms(client, userId, id, draft, signal);
      if (signal.aborted) return;
      await store.refresh();
      return "已确认并记入云端账本。";
    });
  }
  async function dismiss(id: string) { await run(async signal => { await dismissSms(client, userId, id, signal); return "已忽略这条短信，原文已移除。"; }); }

  async function reprocess() {
    if (!config || mode !== config.mode) { setNotice("请先保存记录方式，再重新识别短信。"); return; }
    const state = store.getState();
    if (!state.ready || state.dirty || state.phase !== "saved" || state.recoveryError) { setNotice("请先返回账本完成同步或处理冲突，再重新识别短信。"); return; }
    if (!window.confirm("按当前规则重新识别待确认短信：普通支出会直接入账，群收款、转账和疑似重复记录仍待确认。仅使用短信原文，尚未提交的核对修改不会带入。确定继续吗？")) return;
    await run(async signal => {
      const result = await reprocessPendingSms(client, userId, signal);
      if (signal.aborted) return;
      await store.refresh();
      return `已自动入账 ${result.recorded_count} 笔，仍有 ${result.pending_count} 笔待确认。`;
    });
  }

  return <main className="sms-shell">
    <div className="sms-content">
      <header className="sms-topbar"><span className="sms-brand"><span className="brand-mark" aria-hidden="true"><MessageSquare size={21} /></span><span><strong>Moneytrail</strong><small>PRIVATE CAPTURE</small></span></span><button className="button ghost" onClick={() => { clearSecret(); onBack(); }}><ArrowLeft size={16} />返回账本</button></header>
      <section className="sms-intro"><div><p className="sms-eyebrow">MONEYTRAIL / SMS AUTOMATION</p><h1>短信自动记账</h1><p>让银行短信，成为账本的起点。</p></div><span className="sms-privacy-tag"><LockKeyhole size={15} />仅进入当前账户</span></section>

      <div className="sms-notice" role="status" aria-live="polite">{notice}</div>
      {loading ? <section className="sms-state" role="status"><RefreshCw className="auth-spinning" size={24} /><h2>正在读取接入状态</h2><p>正在连接当前账户的短信收件箱。</p></section> : currentFailure ? <section className="sms-state"><ShieldCheck size={28} /><h2>{currentFailure.setup ? "短信接入尚未开通" : "暂时无法读取短信接入"}</h2><p role="alert">{currentFailure.message}</p>{currentFailure.setup && <p>请在 Supabase SQL Editor 运行短信自动化初始化 SQL 后，重新检查。</p>}<button className="button secondary" onClick={refresh}><RefreshCw size={16} />重新检查</button></section> : config && inbox && <>
        <section className="sms-overview" aria-label="短信接入概览"><article><span>接入状态</span><strong className={config.enabled ? "sms-enabled" : undefined}>{config.enabled ? "已启用" : "未启用"}</strong><small>{config.enabled ? "等待手机自动化发送短信" : "启用后，仍需配置一次 iPhone"}</small></article><article><span>最近接收</span><strong className="sms-receipt-time">{receivedTime(config.last_received_at)}</strong><small>收到新短信后，可在此核对接入是否成功</small></article><article><span>待确认</span><strong>{config.pending_count}<em>笔</em></strong><small>确认前，不计入月度消费</small></article></section>
        <div className={`sms-main-grid${config.enabled && config.pending_count > 0 ? " has-pending" : ""}`}>
          <section className="sms-setup-card" aria-labelledby="sms-setup-title"><div className="sms-section-heading"><div><p className="sms-eyebrow">CAPTURE SETTINGS</p><h2 id="sms-setup-title">接收与记录</h2></div><Smartphone size={23} /></div><p className="sms-section-description">当前支持工行“支出(用途)金额元”格式。无法明确判断的内容会保留给你核对。</p>
            <fieldset className="sms-mode-options" disabled={busy}><legend>收到短信后</legend><label className={mode === "auto" ? "selected" : undefined}><input type="radio" name="sms-mode" value="auto" checked={mode === "auto"} onChange={() => setMode("auto")} /><span><strong>自动记录明确消费</strong><small>普通扣款直接入账；商户或分类可稍后补充</small></span></label><label className={mode === "review" ? "selected" : undefined}><input type="radio" name="sms-mode" value="review" checked={mode === "review"} onChange={() => setMode("review")} /><span><strong>全部先待确认</strong><small>每条短信都由你核对后再入账</small></span></label></fieldset>
            <p className="sms-group-rule"><ShieldCheck size={15} />“财付通-群收款”始终待确认，由你判断是消费还是转账。</p>
            <p className="sms-forward-consent">启用表示你同意：由自己配置的 iPhone 自动化，将筛选后的银行消费短信转发至当前账户的 Supabase。请勿转发验证码或其他私人短信。</p>
            <div className="sms-setup-actions">{config.enabled ? <><button className="button primary" disabled={busy || mode === config.mode} onClick={() => void run(async signal => { await setSmsMode(client, userId, mode, signal); return "记录方式已更新，仅对之后收到的短信生效。"; })}>保存记录方式</button><button className="button secondary" disabled={busy} onClick={() => void createToken()}><KeyRound size={15} />更换接入令牌</button><button className="button ghost" disabled={busy} onClick={() => void run(async signal => { await revokeSmsToken(client, userId, signal); clearSecret(); return "已停用接入，手机里的旧令牌立即失效。已有待确认短信仍可处理。"; })}>停用接入</button></> : <button className="button primary" disabled={busy} onClick={() => void createToken()}><KeyRound size={16} />同意转发并启用</button>}</div>
            <details className="sms-guide"><summary><span><Smartphone size={17} />iPhone 配置步骤</span><ChevronDown size={16} /></summary><div>
              <p className="sms-guide-intro">适用于 iOS 18。创建一次个人自动化后，新短信才能触发；网站无法直接读取 iPhone 的短信历史。</p>
              <ol><li>打开 iPhone「快捷指令」→「自动化」→「＋」→「信息」。发件人选择银行短信的真实号码（工行通常为 95588，请以实际短信为准），内容包含填「支出」，选择「立即运行」。</li><li>添加「从输入中获取文本」，输入选择「快捷指令输入／信息正文」。发送前增加「如果」筛选：包含「工商银行」和「支出」，且不包含「验证码」「动态口令」「一次性密码」。</li><li>添加「获取 URL 内容」，填入下方接收地址，方法选 <strong>POST</strong>，请求体选 <strong>JSON</strong>。添加两个文本字段：<code>p_token</code> 填刚保存的接入令牌；<code>p_message</code> 选择上一步的短信文本变量。</li><li>在请求头添加 <code>apikey</code>，值填下方公开密钥；添加 <code>Content-Type</code>，值为 <code>application/json</code>。保存自动化。</li><li>下一笔真实消费短信到达后，打开这里点击「刷新收件箱」，核对最近接收时间和交易。也可先在快捷指令中用已脱敏的样例文本试运行，测试交易请自行忽略。</li></ol>
              <div className="sms-copy-field"><span>接收地址</span><code>{endpoint}</code><button className="button secondary small" onClick={() => void copy(endpoint, "接收地址已复制。")}><Copy size={14} />复制接收地址</button></div>
              <div className="sms-copy-field"><span>公开密钥（apikey）</span>{publicConfig?.url === projectUrl.replace(/\/$/, "") ? <><code>{publicConfig.publishableKey}</code><button className="button secondary small" onClick={() => void copy(publicConfig.publishableKey, "公开密钥已复制。")}><Copy size={14} />复制公开密钥</button></> : <p>请使用此 Supabase 项目的 Publishable key。不要填写 Secret key。</p>}</div>
              <p className="sms-guide-footnote">接入令牌仅允许提交短信，不能读取账本。请保存在自己的快捷指令中，不要分享。离线发送失败不会自动补传，已有短信也不会自动导入；漏记时仍可粘贴短信补录。</p>
            </div></details>
          </section>

          <section className="sms-inbox" aria-labelledby="sms-inbox-title"><div className="sms-section-heading"><div><p className="sms-eyebrow">YOUR MESSAGE INBOX</p><h2 id="sms-inbox-title">短信收件箱</h2><p>{inbox.total} 条接收记录</p></div><button className="button secondary small" disabled={busy} onClick={() => void refreshInbox()} aria-label="刷新收件箱"><RefreshCw size={15} />刷新</button></div>
            {config.mode === "auto" && config.pending_count > 0 && <div className="sms-reprocess"><p>已有记录也可按当前规则重新识别。普通支出直接入账，分类可稍后整理。{mode !== config.mode && "请先保存记录方式。"}</p><button className="button secondary small" disabled={busy || !canConfirm || mode !== config.mode} onClick={() => void reprocess()}><RefreshCw size={15} />重新识别待确认</button></div>}
            {config.pending_count > 0 && !canConfirm && <p className="sms-sync-hint" role="status">当前账本尚未完成同步。请先返回账本同步或处理冲突，再确认短信，避免覆盖本机修改。</p>}
            {inbox.items.length ? <div className="sms-messages">{inbox.items.map(item => <InboxCard key={`${userId}:${item.id}:${item.status}`} item={item} busy={busy} canConfirm={canConfirm} onConfirm={confirm} onDismiss={dismiss} />)}</div> : <div className="sms-inbox-empty"><MessageSquare size={30} /><h3>等待第一条消费短信</h3><p>完成 iPhone 自动化后，新收到的银行消费短信会出现在这里。</p><span>群收款待确认 · 相同短信 24 小时内去重</span></div>}
            {inbox.total > PAGE_SIZE && <div className="sms-pagination"><button className="button ghost small" disabled={busy || page <= 1} onClick={() => setPage(value => Math.max(1, value - 1))}><ChevronLeft size={15} />上一页</button><span>{inbox.page} / {Math.max(1, Math.ceil(inbox.total / inbox.page_size))}</span><button className="button ghost small" disabled={busy || inbox.page * inbox.page_size >= inbox.total} onClick={() => setPage(value => value + 1)}>下一页<ChevronRight size={15} /></button></div>}
          </section>
        </div>
      </>}
      <footer className="sms-footer"><ShieldCheck size={14} /><p>账本与收件箱按账户隔离。短信确认或忽略后会移除原文。</p></footer>
    </div>
    <dialog className="sms-token-dialog" ref={tokenDialog} onCancel={clearSecret} onClose={clearSecret} aria-labelledby="sms-token-title"><div className="sms-token-heading"><KeyRound size={25} /><button className="icon-button" aria-label="关闭令牌窗口" onClick={clearSecret}><X size={18} /></button></div><p className="sms-eyebrow">YOUR PRIVATE INGESTION KEY</p><h2 id="sms-token-title">接入令牌，仅显示这一次</h2><p>请将它粘贴到自己 iPhone 的快捷指令中。关闭后无法再次查看，可通过更换令牌重新生成。</p><div className="sms-token-value"><code>{revealed ? token : "mt_sms_••••••••••••••••••••••••"}</code></div><div className="sms-token-tools"><button className="button secondary" onClick={() => void copy(token, "接入令牌已复制，请粘贴到自己的快捷指令中。")}><Copy size={16} />复制令牌</button><button className="button ghost" onClick={() => setRevealed(value => !value)}>{revealed ? <EyeOff size={16} /> : <Eye size={16} />}{revealed ? "隐藏令牌" : "显示令牌"}</button></div><p className="sms-token-warning">令牌持有者可向你的收件箱提交短信。请勿发到聊天、公开仓库或分享链接中。</p><button className="button primary sms-token-done" onClick={clearSecret}><Check size={16} />我已保存</button></dialog>
  </main>;
}
