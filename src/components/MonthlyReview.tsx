import { useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
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
import { buildSpendingMix, buildSpendingTrend, defaultTrendRange, findLargestReviewChange, type ReviewTrendRange } from "../lib/reviewSpending";
import { SpendingDonut, SpendingTrend } from "./ReviewCharts";
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

export function MonthlyReview({ month, today, transactions, budgets, checkedMonths = NO_CHECKED_MONTHS, onEditAnnualBudget, onEditNextMonth, onReviewMonth, onReviewUnclassified, renderTransaction }: ReviewData & {
  checkedMonths?: readonly string[];
  onEditAnnualBudget: (year: number) => void;
  onEditNextMonth: (baseMonth: string) => void;
  onReviewMonth?: (month: string) => void;
  onReviewUnclassified?: () => void;
  renderTransaction?: (transaction: Transaction) => ReactNode;
}) {
  const [detail, setDetail] = useState<{ month: string; key: string | null }>();
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [trendRange, setTrendRange] = useState<ReviewTrendRange>();
  const detailRegion = useRef<HTMLElement>(null);
  const detailsId = useId();
  const currentMonth = today.slice(0, 7);
  const isFuture = month > currentMonth;
  const report = useMemo(() => buildBudgetReview(transactions, budgets, month, today, "full"), [transactions, budgets, month, today]);
  const actual = useMemo(() => reviewTotal(transactions, month, report.currentThrough), [transactions, month, report.currentThrough]);
  const prior = useMemo(() => reviewTotal(transactions, report.priorMonth, report.priorThrough), [transactions, report.priorMonth, report.priorThrough]);
  function hasRecordedPeriod(periodMonth: string, through: string) {
    return checkedMonths.includes(periodMonth) || transactions.some(transaction =>
      transaction.date.startsWith(`${periodMonth}-`) && transaction.date.slice(0, 10) <= through);
  }
  const ongoing = report.isMonthToDate;
  const hasPrior = !ongoing && hasRecordedPeriod(report.priorMonth, report.priorThrough);
  const canCompare = hasPrior && hasRecordedPeriod(month, report.currentThrough);
  const netChange = actual.netCents - prior.netCents;
  const priorLabel = month.slice(0, 4) === report.priorMonth.slice(0, 4)
    ? `${Number(report.priorMonth.slice(5, 7))} 月`
    : monthName(report.priorMonth);
  const currentLabel = ongoing
    ? `本月截至 ${Number(month.slice(5, 7))} 月 ${Number(report.currentThrough.slice(8, 10))} 日`
    : `${monthName(month)}全月`;
  const recordedText = `本月已记净支出 ${formatMoney(actual.netCents)}`;
  const direction = netChange > 0 ? "多花" : "少花";
  const headline = !canCompare ? recordedText : netChange === 0
    ? "与上月持平"
    : `比上月${direction} ${formatMoney(Math.abs(netChange))}`;
  const driver = canCompare ? findLargestReviewChange(report.rows, netChange) : undefined;
  const largestExpense = actual.categories.find(category => category.category !== "待分类" && category.amountCents > 0);
  const leadCategory = driver?.category ?? (!canCompare ? largestExpense?.category : undefined);
  const driverText = driver
    ? `已分类中${netChange === 0 ? "变化最大" : driver.deltaCents > 0 ? "增加最多" : "减少最多"}：${driver.category} ${signedMoney(driver.deltaCents)}`
    : !canCompare && largestExpense
      ? `已分类支出最多：${largestExpense.category} ${formatMoney(largestExpense.amountCents)}`
      : "";
  const unclassified = actual.categories.find(category => category.category === "待分类")?.amountCents ?? 0;
  const priorUnclassified = prior.categories.find(category => category.category === "待分类")?.amountCents ?? 0;
  const unclassifiedChange = canCompare ? unclassified - priorUnclassified : 0;
  const largestOverrun = report.rows.reduce<{ label: string; amount: number } | null>((largest, row) => {
    if (row.monthlyReferenceCents === null) return largest;
    const amount = row.currentNetCents - row.monthlyReferenceCents;
    return amount > (largest?.amount ?? 0) ? { label: row.subcategory ?? row.category, amount } : largest;
  }, null);
  const range = trendRange ?? defaultTrendRange(month, today);
  const slices = useMemo(() => buildSpendingMix(transactions, month, report.currentThrough), [transactions, month, report.currentThrough]);
  const trendPoints = useMemo(
    () => buildSpendingTrend(transactions, range, today, selectedCategory, checkedMonths),
    [transactions, range.startMonth, range.endMonth, today, selectedCategory, checkedMonths],
  );
  const rows = report.rows.filter(row => row.currentCount || (hasPrior && row.priorCount) || row.annualCapCents !== null);
  const shownCategories = selectedCategory === null ? EXPENSE_CATEGORIES : [selectedCategory];
  const ordered = shownCategories.flatMap(category => rows.filter(row => row.category === category));
  const selectedKey = detail?.month === month ? detail.key : selectedCategory === null ? null : scopeKey({ category: selectedCategory });
  const selected = rows.find(row => scopeKey(row) === selectedKey);
  function focusCategory(category: string | null) {
    setSelectedCategory(category);
    setDetail({ month, key: category === null ? null : scopeKey({ category }) });
  }
  const periods = selected ? [
    { month, through: report.currentThrough },
    ...(hasPrior ? [{ month: report.priorMonth, through: report.priorThrough }] : []),
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

  return <section className="review-card" aria-label="月度复盘">
    {isFuture ? <div className="panel"><p className="help-text">本月尚未开始。</p></div> : <>
    <section className="panel review-headline" aria-label="月度复盘结论">
      <h2 className="review-headline-title">{headline}</h2>
      {canCompare && <p className="review-headline-total">{recordedText}</p>}
      <div className="review-headline-period">
        <p className="panel-subtitle">
          {currentLabel}{canCompare && `，和 ${priorLabel}全月对比`}
          {!ongoing && !canCompare && (hasPrior ? " · 本月暂无记录" : " · 上月暂无记录")}
        </p>
        {ongoing && onReviewMonth && <button className="button ghost small" type="button" onClick={() => onReviewMonth(report.priorMonth)}>回看上月</button>}
      </div>
      {leadCategory && <div className="review-key-insight">
        <p>{driverText}</p>
        <button className="button ghost small" type="button" onClick={() => {
          focusCategory(leadCategory);
          detailRegion.current?.scrollIntoView({ block: "start" });
        }}>查看这类明细 <ChevronRight size={15} aria-hidden="true" /></button>
      </div>}
      {!canCompare && !leadCategory && <p className="review-headline-total">本月暂无已分类支出</p>}
    </section>
      <SpendingDonut
        slices={slices}
        selectedCategory={selectedCategory}
        onSelect={focusCategory}
        refundCents={actual.refundCents}
      />
      <SpendingTrend
        points={trendPoints}
        range={range}
        maxMonth={currentMonth}
        selectedCategory={selectedCategory}
        categoryOptions={EXPENSE_CATEGORIES}
        onSelectCategory={focusCategory}
        onRangeChange={setTrendRange}
        onOpenMonth={onReviewMonth}
        throughDate={today}
      />
    <section className="panel review-details" aria-label="分类明细" ref={detailRegion}>
      <div className="review-details-heading">
        <h2 className="panel-title">{selectedCategory === null ? "分类明细" : `${selectedCategory} · 分类明细`}</h2>
        {selectedCategory !== null && <button className="button ghost small" type="button" onClick={() => focusCategory(null)}>查看全部分类</button>}
      </div>
    {selectedCategory === null && <dl className="review-totals">
      {totals.map(total => <div key={total.label}><dt>{total.label}</dt><dd>{formatMoney(total.actual)}{canCompare && <small>较上月 {signedMoney(total.actual - total.prior)}</small>}</dd></div>)}
    </dl>}
    {largestOverrun && <div className="review-key-insight">
      <p>{largestOverrun.label}超出月计划 {formatMoney(largestOverrun.amount)}</p>
      {canAdjustNext && <button className="button ghost small" type="button" onClick={() => onEditNextMonth(month)}>调整下月计划</button>}
    </div>}
    {(actual.uncategorizedCount > 0 || unclassifiedChange !== 0) && <div className="review-key-insight">
      <p>待分类净支出 {formatMoney(unclassified)}{unclassifiedChange !== 0 && ` · 较上月 ${signedMoney(unclassifiedChange)}`}</p>
      {actual.uncategorizedCount > 0 && onReviewUnclassified && <button className="button ghost small" type="button" onClick={onReviewUnclassified}>去整理</button>}
    </div>}
    {ordered.length ? <div className="review-spend-list">
      {ordered.map(row => {
        const key = scopeKey(row);
        const expanded = selected === row;
        const difference = row.currentNetCents - row.priorNetCents;
        const monthlyRemaining = row.monthlyReferenceCents === null ? null : row.monthlyReferenceCents - row.currentNetCents;
        return <div key={key} className={`review-spend-entry${row.subcategory ? " review-detail" : ""}`}>
          <div className="review-spend-heading">
            <button className="button ghost small" type="button" aria-expanded={expanded} aria-controls={expanded ? detailsId : undefined} onClick={() => setDetail({ month, key: expanded ? null : key })}>
              <ChevronRight size={15} aria-hidden="true" />{row.subcategory || row.category}
            </button>
            <dl className="review-row-values">
              <div><dt>净支出</dt><dd>{formatMoney(row.currentNetCents)}</dd></div>
              {canCompare && <div><dt>较上月</dt><dd className={difference > 0 ? "text-danger" : undefined}>{signedMoney(difference)}</dd></div>}
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
    </div> : <p className="help-text">{selectedCategory ? "所选分类在这段期间没有支出或退款。" : "暂无支出或退款，分类预算可随时设置。"}</p>}
    </section>
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
