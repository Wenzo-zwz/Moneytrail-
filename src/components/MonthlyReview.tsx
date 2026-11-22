import { useId, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { EXPENSE_CATEGORIES, EXPENSE_DETAILS } from "../lib/expenseCategories";
import { formatMoney, normalizeTransactionCategory, parseAmount, summarize, type MonthSummary, type Transaction } from "../lib/ledger";
import {
  buildBudgetReview,
  getAnnualCap,
  setAnnualBudget,
  setMonthlyOverride,
  type AnnualBudget,
  type BudgetScope,
} from "../lib/reviewBudget";
import "../review.css";

type ReviewData = {
  month: string;
  today: string;
  transactions: Transaction[];
  budgets: AnnualBudget[];
};

type EditorProps = ReviewData & {
  onSave: (budgets: AnnualBudget[]) => boolean;
  onClose: () => void;
};

type ReviewMode = "equal" | "full";
const NO_CHECKED_MONTHS: readonly string[] = [];
const budgetCategories = EXPENSE_CATEGORIES.filter(category => category !== "待分类");

function monthName(month: string) {
  return `${month.slice(0, 4)} 年 ${Number(month.slice(5, 7))} 月`;
}

function periodLabel(month: string, through: string) {
  return `${monthName(month)} 1–${Number(through.slice(8, 10))} 日`;
}

function scopeKey({ category, subcategory }: BudgetScope) {
  return JSON.stringify([category, subcategory]);
}

function scopeLabel({ category, subcategory }: BudgetScope) {
  return subcategory ? `${category} · ${subcategory}` : category;
}

function signedMoney(cents: number) {
  return `${cents > 0 ? "+" : ""}${formatMoney(cents)}`;
}

function amountInput(cents: number | null) {
  return cents === null ? "" : (cents / 100).toFixed(2);
}

function parseBudgetAmount(value: string) {
  return /^0+(?:\.0{1,2})?$/.test(value.trim()) ? 0 : parseAmount(value);
}

function reviewTotal(transactions: Transaction[], month: string, through: string) {
  return summarize(transactions.filter(transaction => transaction.date.slice(0, 10) <= through), month, 0);
}

export function MonthlyReviewSummary({ month, today, stats, onOpen }: {
  month: string;
  today: string;
  stats: MonthSummary;
  onOpen: () => void;
}) {
  const largest = stats.categories.find(item => item.category !== "待分类" && item.amountCents > 0);
  const unclassifiedCents = stats.categories.find(item => item.category === "待分类")?.amountCents ?? 0;
  const share = stats.netCents > 0 && unclassifiedCents >= 0 && unclassifiedCents <= stats.netCents
    ? (unclassifiedCents / stats.netCents) * 100
    : null;
  const shareText = share === null ? "" : share === 0 ? "0%" : share < 1 ? "不足 1%" : `约 ${Math.round(share)}%`;

  return <button className="panel full-width review-summary" type="button" onClick={onOpen}>
    <span>
      <strong className="panel-title">月度复盘</strong>
      <span className="panel-subtitle">{monthName(month)}{month === today.slice(0, 7) ? " · 进行中" : ""}</span>
      <span className="review-summary-metric">{largest ? `已分类支出最多：${largest.category} ${formatMoney(largest.amountCents)}` : "本月暂无已分类支出"}</span>
      <span className="review-summary-metric">待分类：{formatMoney(unclassifiedCents)}{shareText && `（占本月净支出${shareText}）`}</span>
    </span>
    <ChevronRight size={20} aria-hidden="true" />
  </button>;
}

export function MonthlyReview({ month, today, transactions, budgets, checkedMonths = NO_CHECKED_MONTHS, onEditAnnualBudget, onEditNextMonth, onReviewMonth, renderTransaction }: ReviewData & {
  checkedMonths?: readonly string[];
  onEditAnnualBudget: (year: number) => void;
  onEditNextMonth: (baseMonth: string) => void;
  onReviewMonth?: (month: string) => void;
  renderTransaction?: (transaction: Transaction) => ReactNode;
}) {
  const [period, setPeriod] = useState<{ month: string; mode: ReviewMode }>();
  const [detail, setDetail] = useState<{ month: string; key: string }>();
  const detailsId = useId();
  const currentMonth = today.slice(0, 7);
  const isFuture = month > currentMonth;
  const mode = period?.month === month ? period.mode : month === currentMonth ? "equal" : "full";
  const report = useMemo(() => buildBudgetReview(transactions, budgets, month, today, mode), [transactions, budgets, month, today, mode]);
  const actual = useMemo(() => reviewTotal(transactions, month, report.currentThrough), [transactions, month, report.currentThrough]);
  const prior = useMemo(() => reviewTotal(transactions, report.priorMonth, report.priorThrough), [transactions, report.priorMonth, report.priorThrough]);
  const hasPrior = checkedMonths.includes(report.priorMonth) || transactions.some(transaction =>
    transaction.date.startsWith(report.priorMonth) && transaction.date.slice(0, 10) <= report.priorThrough);
  const rows = report.rows.filter(row => row.currentCount || row.priorCount || row.annualCapCents !== null);
  const ordered = EXPENSE_CATEGORIES.flatMap(category => rows.filter(row => row.category === category));
  const selected = detail?.month === month ? rows.find(row => scopeKey(row) === detail.key) : undefined;
  const periods = selected ? [
    { month, through: report.currentThrough },
    { month: report.priorMonth, through: report.priorThrough },
  ].map(period => ({
    ...period,
    items: transactions.filter(transaction => {
      if (!transaction.date.startsWith(period.month) || transaction.date.slice(0, 10) > period.through) return false;
      if (transaction.kind !== "expense" && transaction.kind !== "refund") return false;
      const item = normalizeTransactionCategory(transaction);
      return item.category === selected.category && (!selected.subcategory || item.subcategory === selected.subcategory);
    }).sort((a, b) => b.date.localeCompare(a.date)),
  })) : [];
  const totals = [
    { label: "已记录收入", actual: actual.incomeCents, prior: prior.incomeCents },
    { label: "净支出", actual: actual.netCents, prior: prior.netCents },
    { label: "收支差额", actual: actual.incomeCents - actual.netCents, prior: prior.incomeCents - prior.netCents },
  ];
  const currentYear = Number(currentMonth.slice(0, 4));
  const annualYear = Math.min(Math.max(currentYear, Number(month.slice(0, 4))), currentYear + 1);
  const canAdjustNext = !isFuture && report.nextMonth >= currentMonth;

  return <section className="panel review-card" aria-label="月度复盘">
    {isFuture ? <p className="help-text">本月尚未开始。</p> : <>
    <div className="review-period">
      <div className="review-mode-switch" role="group" aria-label="对比区间">
        <button className="button secondary small" type="button" aria-pressed={mode === "equal"} onClick={() => setPeriod({ month, mode: "equal" })}>同期</button>
        <button className="button secondary small" type="button" aria-pressed={mode === "full"} onClick={() => setPeriod({ month, mode: "full" })}>整月</button>
      </div>
      <p className="panel-subtitle">{periodLabel(month, report.currentThrough)} 对比 {periodLabel(report.priorMonth, report.priorThrough)}</p>
      {month === currentMonth && onReviewMonth && <button className="button ghost small" type="button" onClick={() => onReviewMonth(report.priorMonth)}>回看上月</button>}
    </div>
    {!hasPrior && <p className="help-text">{mode === "equal" ? "上月同期暂无记录" : "上月暂无记录"}，暂不显示月间变化。</p>}
    <dl className="review-totals">
      {totals.map(total => <div key={total.label}><dt>{total.label}</dt><dd>{formatMoney(total.actual)}{hasPrior && <small>较上月 {signedMoney(total.actual - total.prior)}</small>}</dd></div>)}
    </dl>
    {ordered.length ? <div className="review-spend-list">
      {ordered.map(row => {
        const key = scopeKey(row);
        const expanded = selected === row;
        const difference = row.currentNetCents - row.priorNetCents;
        const monthlyRemaining = row.monthlyReferenceCents === null ? null : row.monthlyReferenceCents - row.currentNetCents;
        return <div key={key} className={`review-spend-entry${row.subcategory ? " review-detail" : ""}`}>
          <div className="review-spend-heading">
            <button className="button ghost small" type="button" aria-expanded={expanded} aria-controls={expanded ? detailsId : undefined} onClick={() => setDetail(expanded ? undefined : { month, key })}>
              <ChevronRight size={15} aria-hidden="true" />{row.subcategory || row.category}
            </button>
            <dl className="review-row-values">
              <div><dt>净支出</dt><dd>{formatMoney(row.currentNetCents)}</dd></div>
              <div><dt>较上月</dt><dd className={hasPrior && difference > 0 ? "text-danger" : undefined}>{hasPrior ? signedMoney(difference) : "—"}</dd></div>
              <div><dt>月参考</dt><dd>{row.monthlyReferenceCents === null ? "未设置" : formatMoney(row.monthlyReferenceCents)}</dd></div>
              <div><dt>{monthlyRemaining !== null && monthlyRemaining < 0 ? "超出" : "月剩余"}</dt><dd className={monthlyRemaining !== null && monthlyRemaining < 0 ? "text-danger" : undefined}>{monthlyRemaining === null ? "—" : formatMoney(Math.abs(monthlyRemaining))}</dd></div>
            </dl>
          </div>
          {expanded && <div className="transaction-list" id={detailsId}>
            {row.annualCapCents !== null && <p className="help-text">年度预算 {formatMoney(row.annualCapCents)} · 年度净支出 {formatMoney(row.yearNetCents)} · 年度剩余 {formatMoney(row.annualRemainingCents ?? 0)}</p>}
            {periods.map(({ month: period, through, items }, index) => {
              const refunds = items.filter(item => item.kind === "refund");
              return <section key={period} className="review-detail-period">
                <p className="help-text"><strong>{periodLabel(period, through)}</strong>
                  {" · "}{items.length - refunds.length} 笔支出 · {refunds.length} 笔退款 {formatMoney(refunds.reduce((sum, refund) => sum + refund.amountCents, 0))}
                </p>
                {index === 0 && (items.length ? items.map(item => renderTransaction ? <div key={item.id}>{renderTransaction(item)}</div> : <div className="review-transaction-line" key={item.id}>
                  <span>{item.date.slice(5, 10)} · {item.merchant}</span><span>{item.kind === "refund" ? "+" : "−"}{formatMoney(item.amountCents)}</span>
                </div>) : <p className="help-text">此分类在所选期间没有账目。</p>)}
              </section>;
            })}
          </div>}
        </div>;
      })}
    </div> : <p className="help-text">所选两段期间暂无支出或退款，分类预算可随时设置。</p>}
    </>}
    <div className="review-actions">
      <button className="button ghost small" type="button" onClick={() => onEditAnnualBudget(annualYear)}>年度分类预算</button>
      {canAdjustNext && <button className="button secondary small" type="button" onClick={() => onEditNextMonth(month)}>调整 {Number(report.nextMonth.slice(5, 7))} 月预算</button>}
    </div>
  </section>;
}

export function AnnualBudgetEditor({ month, today, transactions, budgets, onSave, onClose }: EditorProps) {
  const id = useId();
  const currentYear = Number(today.slice(0, 4));
  const [year, setYear] = useState(() => Math.min(Math.max(Number(month.slice(0, 4)), currentYear), currentYear + 1));
  const [scope, setScope] = useState<BudgetScope>({ category: budgetCategories[0] });
  const [draft, setDraft] = useState<string>();
  const [error, setError] = useState("");
  const effectiveMonth = year === currentYear ? today.slice(0, 7) : `${year}-01`;
  const configured = budgets.filter(budget => budget.year === year);
  const overview = useMemo(() => buildBudgetReview(transactions, budgets, effectiveMonth, today), [transactions, budgets, effectiveMonth, today]);
  const saved = configured.find(budget => scopeKey(budget) === scopeKey(scope));
  const currentCap = getAnnualCap(saved, effectiveMonth);
  const details = new Set<string>(EXPENSE_DETAILS[scope.category as keyof typeof EXPENSE_DETAILS] ?? []);
  for (const transaction of transactions) {
    const item = normalizeTransactionCategory(transaction);
    if (item.category === scope.category && item.subcategory && item.subcategory !== "未细分" && (item.kind === "expense" || item.kind === "refund")) details.add(item.subcategory);
  }
  for (const budget of configured) {
    if (budget.category === scope.category && budget.subcategory) details.add(budget.subcategory);
  }
  function selectScope(next: BudgetScope) { setScope(next); setDraft(undefined); setError(""); }
  function save(amount: number | null) {
    try {
      if (onSave(setAnnualBudget(budgets, scope, effectiveMonth, amount))) onClose();
      else setError("预算暂未保存，请检查账本状态后重试。");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "暂时无法保存此预算。");
    }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    const amount = parseBudgetAmount(draft ?? amountInput(currentCap));
    if (amount === null) { setError("请输入非负金额，最多两位小数。"); return; }
    save(amount);
  }

  return <form className="review-budget-editor" onSubmit={submit}>
    <div className="modal-body">
      <p className="help-text">当月默认参考为全年额度 ÷ 12。整类预算包含其细类支出，两种额度各自比较。</p>
      <div className="form-grid">
        <div className="form-field"><label htmlFor={`${id}-year`}>预算年度</label><select id={`${id}-year`} value={year} onChange={event => { setYear(Number(event.target.value)); selectScope({ category: scope.category }); }}>
          <option value={currentYear}>{currentYear} 年</option><option value={currentYear + 1}>{currentYear + 1} 年</option>
        </select></div>
        <div className="form-field"><label htmlFor={`${id}-category`}>大类</label><select id={`${id}-category`} value={scope.category} onChange={event => selectScope({ category: event.target.value })}>
          {budgetCategories.map(category => <option key={category}>{category}</option>)}
        </select></div>
        <div className="form-field"><label htmlFor={`${id}-subcategory`}>细类</label><select id={`${id}-subcategory`} value={scope.subcategory ?? ""} onChange={event => selectScope({ category: scope.category, subcategory: event.target.value || undefined })}>
          <option value="">整类</option>{[...details].map(detail => <option key={detail}>{detail}</option>)}
        </select></div>
        <div className="form-field"><label htmlFor={`${id}-amount`}>全年额度（元）</label><input id={`${id}-amount`} inputMode="decimal" value={draft ?? amountInput(currentCap)} onChange={event => setDraft(event.target.value)} placeholder="未设置" maxLength={16} /></div>
      </div>
      <p className="help-text">本次设置从 {monthName(effectiveMonth)}生效。之前的月预算供复盘时查看。</p>
      {configured.some(budget => getAnnualCap(budget, effectiveMonth) !== null) && <div className="review-budget-scope-list" aria-label="已设置的年度预算">
        {configured.map(budget => {
          const row = overview.rows.find(item => scopeKey(item) === scopeKey(budget));
          const cap = row?.annualCapCents;
          const remaining = row?.annualRemainingCents;
          return !row || cap == null || remaining == null ? null : <button type="button" className="button secondary small" key={scopeKey(budget)} onClick={() => selectScope({ category: budget.category, subcategory: budget.subcategory })}>
            <span>{scopeLabel(budget)}</span><span>{formatMoney(cap)} · 已用 {formatMoney(row.yearNetCents)} · {remaining < 0 ? "超出" : "剩余"} {formatMoney(Math.abs(remaining))}</span>
          </button>;
        })}
      </div>}
      {error && <p className="notice error" role="alert">{error}</p>}
    </div>
    <div className="modal-footer">
      {currentCap !== null && <button className="button ghost" type="button" onClick={() => save(null)}>移除年度额度</button>}
      <button className="button secondary" type="button" onClick={onClose}>取消</button>
      <button className="button primary" type="submit">保存年度预算</button>
    </div>
  </form>;
}

export function NextMonthBudgetEditor({ month, today, transactions, budgets, onSave, onClose, onEditAnnualBudget }: EditorProps & {
  onEditAnnualBudget?: (year: number) => void;
}) {
  const id = useId();
  const report = useMemo(() => buildBudgetReview(transactions, budgets, month, today), [transactions, budgets, month, today]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const rows = report.rows.filter(row => row.next.annualCapCents !== null);
  function submit(event: FormEvent) {
    event.preventDefault();
    let updated = budgets;
    for (const row of rows) {
      const raw = drafts[scopeKey(row)]?.trim();
      if (raw === undefined) continue;
      const amount = raw ? parseBudgetAmount(raw) : null;
      if (raw && amount === null) { setError(`${scopeLabel(row)}请输入非负金额，最多两位小数。`); return; }
      try {
        updated = setMonthlyOverride(updated, row, report.nextMonth, amount);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "暂时无法保存此预算。");
        return;
      }
    }
    if (onSave(updated)) onClose();
    else setError("预算暂未保存，请检查账本状态后重试。");
  }

  return <form className="review-budget-editor" onSubmit={submit}>
    <div className="modal-body">
      <p className="panel-title">{monthName(report.nextMonth)}</p>
      {rows.length > 0 ? <>
        <p className="help-text">参考建议按已记录的年度支出和剩余月数计算。留空使用默认月参考，填 0 表示这个月额度为零。</p>
        <div className="review-next-budget-list">{rows.map((row, index) => {
          const key = scopeKey(row);
          const inputId = `${id}-monthly-${index}`;
          return <div className="review-next-budget-row" key={key}>
            <p className="help-text">默认月参考 {formatMoney(Math.round((row.next.annualCapCents ?? 0) / 12))} · 年度剩余 {formatMoney(row.next.annualRemainingCents ?? 0)} · 剩余 {row.next.monthsRemaining} 个月</p>
            <div className="form-field">
              <label htmlFor={inputId}>{scopeLabel(row)}（元）</label>
              <input id={inputId} inputMode="decimal" maxLength={16} placeholder="使用默认月参考" value={drafts[key] ?? amountInput(row.next.overrideCents)} onChange={event => setDrafts({ ...drafts, [key]: event.target.value })} />
              {row.next.suggestedCents !== null && <button className="button secondary small" type="button" onClick={() => setDrafts({ ...drafts, [key]: amountInput(row.next.suggestedCents) })}>采用建议 {formatMoney(row.next.suggestedCents)}</button>}
            </div>
          </div>;
        })}</div>
      </> : <p className="help-text">请先设置年度预算，再调整这个月的参考额度。</p>}
      {error && <p className="notice error" role="alert">{error}</p>}
    </div>
    <div className="modal-footer">
      <button className="button secondary" type="button" onClick={onClose}>{rows.length ? "取消" : "关闭"}</button>
      {rows.length > 0 ? <button className="button primary" type="submit" disabled={Object.keys(drafts).length === 0}>保存月度调整</button> : onEditAnnualBudget && <button className="button primary" type="button" onClick={() => onEditAnnualBudget(Number(report.nextMonth.slice(0, 4)))}>设置年度预算</button>}
    </div>
  </form>;
}
