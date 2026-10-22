import { useEffect, useRef, useState, type FormEvent } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ArrowLeft, ArrowUpRight, BookOpen, Check, ChevronLeft, ChevronRight, Clock3, Cloud, KeyRound, LogOut, RefreshCw, Search, ShieldCheck, UserRound, UserRoundCheck, UsersRound } from "lucide-react";
import { AdminAccessError, AdminSetupError, fetchAdminOverview, type AdminOverview, type AdminUser } from "../lib/adminClient";

export interface AdminPanelProps {
  client: SupabaseClient;
  user: { id: string; email?: string };
  onBack: () => void;
  onSignOut: () => void;
}

type Result = {
  ownerId: string;
  requestKey: string;
  phase: "loading" | "ready" | "error" | "denied" | "unavailable";
  data: AdminOverview | null;
  updatedAt: string | null;
  message: string;
};

const PAGE_SIZE = 20;
const dateTime = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
const number = new Intl.NumberFormat("zh-CN");

function formatDate(value: string | null) {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? dateTime.format(parsed) : "—";
}

function Verification({ confirmed }: { confirmed: boolean }) {
  return <span className={`admin-verification ${confirmed ? "confirmed" : "pending"}`}>
    {confirmed ? <Check size={12} aria-hidden="true" /> : <Clock3 size={12} aria-hidden="true" />}
    {confirmed ? "已验证" : "待验证"}
  </span>;
}

function UserRow({ user }: { user: AdminUser }) {
  return <tr className="admin-user-row">
    <td className="admin-user-identity">
      <span className="admin-user-avatar" aria-hidden="true"><UserRound size={18} /></span>
      <span className="admin-user-address">{user.email || "未提供邮箱"}</span>
      <span className="admin-mobile-verification"><Verification confirmed={Boolean(user.email_confirmed_at)} /></span>
    </td>
    <td className="admin-user-verification"><Verification confirmed={Boolean(user.email_confirmed_at)} /></td>
    <td data-label="注册时间"><time dateTime={user.created_at ?? undefined}>{formatDate(user.created_at)}</time></td>
    <td data-label="最近登录"><time dateTime={user.last_sign_in_at ?? undefined}>{formatDate(user.last_sign_in_at)}</time></td>
    <td data-label="账本同步">
      {user.ledger_updated_at ? <time dateTime={user.ledger_updated_at}>{formatDate(user.ledger_updated_at)}</time> : <span className="admin-no-ledger">尚未建立账本</span>}
    </td>
    <td className="admin-record-count" data-label="记录数"><span>{number.format(user.transaction_count)}</span><span className="admin-mobile-count-unit"> 笔</span></td>
  </tr>;
}

export default function AdminPanel({ client, user, onBack, onSignOut }: AdminPanelProps) {
  const [draftQuery, setDraftQuery] = useState("");
  const [selection, setSelection] = useState({ query: "", page: 1 });
  const [refreshNumber, setRefreshNumber] = useState(0);
  const requestKey = JSON.stringify([selection.query, selection.page, refreshNumber]);
  const [result, setResult] = useState<Result | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    let timedOut = false;
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      timedOut = true; controller.abort();
      if (active) setResult({ ownerId: user.id, requestKey, phase: "error", data: null, updatedAt: null, message: "读取超时，请检查网络后重试。" });
    }, 20_000);
    setResult({ ownerId: user.id, requestKey, phase: "loading", data: null, updatedAt: null, message: "" });
    void fetchAdminOverview(client, user.id, { query: selection.query, page: selection.page, pageSize: PAGE_SIZE }, controller.signal).then((data) => {
      if (!active || controller.signal.aborted) return;
      setResult({ ownerId: user.id, requestKey, phase: "ready", data, updatedAt: new Date().toISOString(), message: "" });
    }).catch((error: unknown) => {
      if (!active || (controller.signal.aborted && !timedOut)) return;
      const phase = error instanceof AdminAccessError ? "denied" : error instanceof AdminSetupError ? "unavailable" : "error";
      const message = phase === "denied"
        ? "当前账户未获得管理权限，或登录状态已经失效。"
        : phase === "unavailable"
          ? "管理服务尚未准备好，请完成管理员配置后重试。"
          : timedOut ? "读取超时，请检查网络后重试。" : "暂时无法读取管理信息，请检查网络后重试。";
      setResult({ ownerId: user.id, requestKey, phase, data: null, updatedAt: null, message });
    }).finally(() => clearTimeout(timeout));
    return () => { active = false; clearTimeout(timeout); controller.abort(); };
  }, [client, user.id, requestKey, selection.query, selection.page]);

  // Identity or filter changes hide the previous response before the effect runs.
  const current = result?.ownerId === user.id && result.requestKey === requestKey ? result : null;
  const loading = !current || current.phase === "loading";
  const overview = current?.phase === "ready" ? current.data : null;
  const pageCount = overview ? Math.max(1, Math.ceil(overview.total / overview.page_size)) : 1;
  const totals = overview?.totals;
  const stats = [
    { label: "总用户", count: totals?.users, hint: "全部注册账户", Icon: UsersRound },
    { label: "已验证", count: totals?.confirmed_users, hint: "已完成邮箱确认", Icon: UserRoundCheck },
    { label: "近 7 天新增", count: totals?.new_users_7d, hint: "最近加入的账户", Icon: ArrowUpRight },
    { label: "已有账本", count: totals?.ledgers, hint: "已建立云端账本", Icon: BookOpen },
    { label: "24 小时内同步", count: totals?.synced_24h, hint: "最近一天更新的账本", Icon: Cloud },
  ];

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSelection({ query: draftQuery.trim(), page: 1 });
    setRefreshNumber((value) => value + 1);
  }

  function clearSearch() {
    setDraftQuery(""); setSelection({ query: "", page: 1 });
    setRefreshNumber((value) => value + 1); searchInput.current?.focus();
  }

  function refresh() {
    setSelection((value) => ({ ...value, page: 1 }));
    setRefreshNumber((value) => value + 1);
  }

  return <main className="admin-shell">
    <div className="admin-content">
      <header className="admin-topbar">
        <div className="admin-brand">
          <span className="brand-mark" aria-hidden="true"><svg viewBox="120 140 272 240" fill="none"><path d="M150 334V178l106 114 106-114v156" stroke="currentColor" strokeWidth="27" strokeLinejoin="round" strokeLinecap="round" /></svg></span>
          <span><strong>Moneytrail</strong><small>PRIVATE MANAGEMENT</small></span>
        </div>
        <div className="admin-topbar-actions">
          <button className="button ghost" onClick={onBack}><ArrowLeft size={16} />返回账本</button>
          <button className="button secondary" onClick={onSignOut}><LogOut size={16} />退出登录</button>
        </div>
      </header>

      <section className="admin-intro" aria-labelledby="admin-title">
        <div><p className="admin-eyebrow">MONEYTRAIL / PRIVATE CONSOLE</p><h1 id="admin-title">管理后台</h1><p className="admin-subtitle">用户与同步状态，一目了然。</p></div>
        <div className="admin-owner"><span><ShieldCheck size={16} />仅当前管理员可访问</span><strong>{user.email || "当前管理员"}</strong></div>
      </section>

      {loading || overview ? <>
        <section className="admin-overview" aria-label="平台概览" aria-busy={loading}>
          {stats.map(({ label, count, hint, Icon }, index) => <article className={`admin-stat ${index === 0 ? "featured" : ""}`} key={label}>
            <div className="admin-stat-heading"><h2>{label}</h2><Icon size={17} aria-hidden="true" /></div>
            <p className={`admin-stat-value ${loading ? "loading" : ""}`} aria-label={loading ? `${label}正在读取` : undefined}>{count === undefined ? "—" : number.format(count)}</p>
            <p className="admin-stat-hint">{hint}</p>
          </article>)}
        </section>

        <section className="admin-directory" aria-labelledby="admin-directory-title" aria-busy={loading}>
          <div className="admin-directory-heading">
            <div><p className="admin-section-kicker">ACCOUNT DIRECTORY</p><h2 id="admin-directory-title">用户目录</h2><p>注册、验证与账本同步状态。</p></div>
            <div className="admin-refresh"><span>{current?.updatedAt ? `更新于 ${formatDate(current.updatedAt)}` : "等待读取最新状态"}</span><button className="button secondary" disabled={loading} onClick={refresh} aria-label="刷新管理数据"><RefreshCw size={16} className={loading ? "auth-spinning" : undefined} />刷新</button></div>
          </div>
          <form className="admin-search" onSubmit={search} role="search" aria-label="搜索注册用户">
            <label className="sr-only" htmlFor="admin-user-search">搜索用户邮箱</label>
            <div className="admin-search-input"><Search size={17} aria-hidden="true" /><input ref={searchInput} id="admin-user-search" name="query" type="search" placeholder="搜索用户邮箱" autoComplete="off" spellCheck={false} autoCapitalize="none" maxLength={200} value={draftQuery} onChange={(event) => setDraftQuery(event.target.value)} /></div>
            <button className="button primary" type="submit" disabled={loading}>搜索</button>
            {selection.query && <button className="button ghost" type="button" onClick={clearSearch} disabled={loading}>清除搜索</button>}
          </form>
          {selection.query && <p className="admin-search-summary">正在查看“<span>{selection.query}</span>”的搜索结果</p>}

          {loading ? <div className="admin-list-loading" role="status"><RefreshCw size={20} className="auth-spinning" aria-hidden="true" /><p>正在读取管理概览…</p><span>仅显示当前管理员有权访问的信息。</span></div>
            : overview && overview.users.length ? <>
              <div className="admin-table-wrap"><table className="admin-users-table"><caption className="sr-only">注册用户及邮箱验证、最近登录和账本同步状态</caption><thead><tr><th scope="col">用户邮箱</th><th scope="col">邮箱状态</th><th scope="col">注册时间</th><th scope="col">最近登录</th><th scope="col">账本同步</th><th scope="col">记录数</th></tr></thead><tbody>{overview.users.map((entry) => <UserRow key={entry.id} user={entry} />)}</tbody></table></div>
              <div className="admin-pagination"><p>共 <strong>{number.format(overview.total)}</strong> 个{selection.query ? "匹配" : "注册"}账户</p><div><button className="button secondary" disabled={overview.page <= 1} onClick={() => setSelection((value) => ({ ...value, page: Math.max(1, value.page - 1) }))}><ChevronLeft size={16} />上一页</button><span className="admin-page-number">第 {overview.page} / {pageCount} 页</span><button className="button secondary" disabled={overview.page >= pageCount} onClick={() => setSelection((value) => ({ ...value, page: value.page + 1 }))}>下一页<ChevronRight size={16} /></button></div></div>
            </> : <div className="admin-list-empty"><UsersRound size={28} aria-hidden="true" /><h3>{selection.query ? "没有找到匹配的用户" : "用户目录还是空的"}</h3><p>{selection.query ? "试试完整邮箱或其他关键词。" : "新账户注册后，会在这里显示。"}</p>{selection.query && <button className="button secondary" onClick={clearSearch}>查看全部用户</button>}</div>}
        </section>
      </> : <section className={`admin-access-state ${current?.phase ?? "error"}`} aria-labelledby="admin-state-title">
        <span className="admin-state-icon" aria-hidden="true">{current?.phase === "denied" ? <KeyRound size={29} /> : <ShieldCheck size={29} />}</span>
        <p className="admin-section-kicker">PRIVATE ACCESS</p><h2 id="admin-state-title">{current?.phase === "denied" ? "当前账户无法进入管理后台" : current?.phase === "unavailable" ? "管理后台尚未开通" : "管理信息暂时无法读取"}</h2><p role="alert">{current?.message || "请稍后重试。"}</p>
        <div className="admin-state-actions"><button className="button secondary" onClick={onBack}><ArrowLeft size={16} />返回我的账本</button><button className="button primary" onClick={refresh}><RefreshCw size={16} />重新检查</button></div>
      </section>}

      <footer className="admin-footer"><span><ShieldCheck size={14} />独立身份 · 专属管理</span><p>管理概览展示账户与同步状态，消费明细保留在各自的账本中。</p></footer>
    </div>
  </main>;
}
