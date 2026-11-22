import { useState, type FormEvent, type KeyboardEvent } from "react";
import { EXPENSE_CATEGORIES } from "../lib/expenseCategories";
import { formatMoney } from "../lib/ledger";
import { MIN_TREND_MONTH, type SpendingSlice, type ReviewTrendRange, type TrendPoint } from "../lib/reviewSpending";
import "../review-charts.css";

const COLORS = ["#e1a773", "#a9a0d7", "#80c0b5", "#e696a2", "#d8bf72", "#8bb6df", "#b7c687", "#dba1c3", "#c6a293", "#92b0a5", "#8e8a96"];
const ALL_COLOR = "#e8b789";
const TURN = Math.PI * 2;
const CENTER = 120;
const OUTER = 98;
const INNER = 67;
const COMPACT_AMOUNT = new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 });
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

function categoryColor(category: string | null) {
  return COLORS[EXPENSE_CATEGORIES.findIndex(item => item === category)] ?? ALL_COLOR;
}

function monthLabel(month: string) {
  return `${month.slice(0, 4)} 年 ${Number(month.slice(5))} 月`;
}

function percentLabel(amount: number, total: number) {
  const percent = (amount / total) * 100;
  return percent > 0 && percent < 0.1 ? "不足 0.1%" : `${Number(percent.toFixed(1))}%`;
}

function graphKey(event: KeyboardEvent<SVGGElement>, select: () => void) {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    select();
  }
}

function radialPoint(radius: number, angle: number) {
  return `${CENTER + Math.cos(angle) * radius} ${CENTER + Math.sin(angle) * radius}`;
}

function ringSlice(start: number, end: number) {
  const outerStart = radialPoint(OUTER, start);
  const innerStart = radialPoint(INNER, start);
  if (end - start >= TURN - 1e-12) {
    const outerMiddle = radialPoint(OUTER, start + Math.PI);
    const innerMiddle = radialPoint(INNER, start + Math.PI);
    return `M ${outerStart} A ${OUTER} ${OUTER} 0 0 1 ${outerMiddle} A ${OUTER} ${OUTER} 0 0 1 ${outerStart}
      L ${innerStart} A ${INNER} ${INNER} 0 0 0 ${innerMiddle} A ${INNER} ${INNER} 0 0 0 ${innerStart} Z`;
  }
  const large = end - start > Math.PI ? 1 : 0;
  return `M ${outerStart} A ${OUTER} ${OUTER} 0 ${large} 1 ${radialPoint(OUTER, end)}
    L ${radialPoint(INNER, end)} A ${INNER} ${INNER} 0 ${large} 0 ${innerStart} Z`;
}

export function SpendingDonut({ slices, selectedCategory, onSelect, refundCents }: {
  slices: readonly SpendingSlice[];
  selectedCategory: string | null;
  onSelect: (category: string | null) => void;
  refundCents: number;
}) {
  const total = slices.reduce((sum, slice) => sum + slice.amountCents, 0);
  const selected = slices.find(slice => slice.category === selectedCategory);
  const selectedAmount = selected?.amountCents ?? 0;
  function toggle(category: string) {
    onSelect(selectedCategory === category ? null : category);
  }
  let angle = -Math.PI / 2;

  return <section className="review-chart review-donut" aria-label="支出构成">
    <h2 className="panel-title">支出构成</h2>
    <p className="panel-subtitle">按消费原额计算占比{refundCents > 0 && ` · 退款 ${formatMoney(refundCents)}`}</p>
    {total > 0 ? <>
      <div className="review-donut-ring">
        <svg viewBox="0 0 240 240" role="group" aria-label="分类支出环形图">
          {slices.map(({ category, amountCents }) => {
            const start = angle;
            angle += TURN * amountCents / total;
            const centerAngle = (start + angle) / 2;
            const pressed = category === selectedCategory;
            const position = pressed ? `translate(${Math.cos(centerAngle) * 8}px, ${Math.sin(centerAngle) * 8}px)` : "translate(0px, 0px)";
            return <g
              key={category}
              className="review-donut-wedge"
              data-category={category}
              aria-pressed={pressed}
              role="button"
              tabIndex={0}
              aria-label={`${category} ${formatMoney(amountCents)}`}
              onClick={() => toggle(category)}
              onKeyDown={event => graphKey(event, () => toggle(category))}
              style={{ transform: position }}
            >
              <path d={ringSlice(start, angle)} fill={categoryColor(category)} fillRule="evenodd" />
            </g>;
          })}
        </svg>
        <div className="review-donut-center" aria-live="polite">
          <span>{selectedCategory ?? "本月支出"}</span>
          <strong>{formatMoney(selectedCategory === null ? total : selectedAmount)}</strong>
          {selectedCategory !== null && <small>{percentLabel(selectedAmount, total)}</small>}
        </div>
      </div>
      <ul className="review-donut-legend">
        {slices.map(({ category, amountCents }) => (
          <li key={category}>
            <button type="button" aria-label={`查看${category}`} aria-pressed={category === selectedCategory} onClick={() => toggle(category)}>
              <span className="review-legend-dot" style={{ backgroundColor: categoryColor(category) }} />
              <span className="review-legend-name">{category}</span>
              <span>{formatMoney(amountCents)}</span>
              <small>{percentLabel(amountCents, total)}</small>
            </button>
          </li>
        ))}
      </ul>
    </> : <p className="review-chart-empty">本月暂无支出</p>}
  </section>;
}

type TrendProps = {
  points: readonly TrendPoint[];
  range: ReviewTrendRange;
  maxMonth: string;
  selectedCategory: string | null;
  categoryOptions: readonly string[];
  onSelectCategory: (category: string | null) => void;
  onRangeChange: (range: ReviewTrendRange) => void;
  onOpenMonth?: (month: string) => void;
  throughDate?: string;
};

function TrendFilters({ range, maxMonth, selectedCategory, categoryOptions, onSelectCategory, onRangeChange }: Omit<TrendProps, "points" | "onOpenMonth" | "throughDate">) {
  const [draft, setDraft] = useState(range);
  const [error, setError] = useState("");
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const months = [draft.startMonth, draft.endMonth];
    if (months.some(month => !MONTH_PATTERN.test(month) || month < MIN_TREND_MONTH || month > maxMonth)) {
      setError("请选择有效的起始月份和结束月份。");
      return;
    }
    if (draft.startMonth > draft.endMonth) {
      setError("起始月份应早于或等于结束月份。");
      return;
    }
    setError("");
    onRangeChange(draft);
  }
  return <>
    <label className="review-trend-category">
      趋势分类
      <select aria-label="趋势分类" value={selectedCategory ?? ""} onChange={event => onSelectCategory(event.target.value || null)}>
        <option value="">全部</option>
        {categoryOptions.map(category => <option key={category} value={category}>{category}</option>)}
      </select>
    </label>
    <form className="review-trend-dates" onSubmit={submit} noValidate>
      <label>起始月份<input type="month" min={MIN_TREND_MONTH} max={maxMonth} value={draft.startMonth} onChange={event => { setDraft({ ...draft, startMonth: event.target.value }); setError(""); }} required /></label>
      <label>结束月份<input type="month" min={MIN_TREND_MONTH} max={maxMonth} value={draft.endMonth} onChange={event => { setDraft({ ...draft, endMonth: event.target.value }); setError(""); }} required /></label>
      <button type="submit" className="button secondary small">应用区间</button>
      {error && <p role="alert" className="review-trend-error">{error}</p>}
    </form>
  </>;
}

export function SpendingTrend({ points, range, maxMonth, selectedCategory, categoryOptions, onSelectCategory, onRangeChange, onOpenMonth, throughDate }: TrendProps) {
  const [pickedMonth, setPickedMonth] = useState("");
  const known = points.flatMap(point => point.amountCents === null ? [] : [{ ...point, amountCents: point.amountCents }]);
  const selected = known.find(point => point.month === pickedMonth);
  const lastPoint = known[known.length - 1];
  const readout = selected ?? lastPoint;
  const color = categoryColor(selectedCategory);
  const minCents = Math.min(0, ...known.map(point => point.amountCents));
  const maxCents = Math.max(0, ...known.map(point => point.amountCents));
  const xStart = 52;
  const plotWidth = 316;
  const segments = Math.max(1, points.length - 1);
  const x = (index: number) => xStart + plotWidth * (points.length === 1 ? 0.5 : index / segments);
  const y = (cents: number) => maxCents === minCents ? 80 : 140 - 120 * (cents - minCents) / (maxCents - minCents);
  const dollarTicks = [0, ...[minCents, maxCents].filter(cents => Math.abs(y(cents) - y(0)) >= 24)];
  const tickCount = Math.min(points.length, 6);
  const ticks = Array.from({ length: tickCount }, (_, index) => Math.round(index * segments / Math.max(1, tickCount - 1)));
  const acrossYears = range.startMonth.slice(0, 4) !== range.endMonth.slice(0, 4);
  const hitWidth = Math.min(44, plotWidth / segments);

  return <section className="review-chart review-trend" aria-label="支出趋势">
    <h2 className="panel-title">支出趋势</h2>
    <p className="panel-subtitle">按月净支出（元）</p>
    <TrendFilters
      key={`${range.startMonth} ${range.endMonth}`}
      range={range}
      maxMonth={maxMonth}
      selectedCategory={selectedCategory}
      categoryOptions={categoryOptions}
      onSelectCategory={onSelectCategory}
      onRangeChange={onRangeChange}
    />
    {readout ? <>
      <svg className="review-trend-plot" viewBox="0 0 400 171" role="group" aria-label="按月净支出趋势图">
        {dollarTicks.map(cents => <g key={cents} aria-hidden="true">
          <line x1={xStart - 4} y1={y(cents)} x2={xStart + plotWidth + 4} y2={y(cents)} className={cents === 0 ? "review-trend-zero" : "review-trend-guide"} />
          <text x={xStart - 7} y={y(cents)} textAnchor="end" dominantBaseline="central">{COMPACT_AMOUNT.format(cents / 100)}</text>
        </g>)}
        {points.slice(1).map((point, index) => {
          const before = points[index];
          return before.amountCents === null || point.amountCents === null ? null : <line
            key={point.month}
            className={point.isPartial ? "review-trend-edge review-trend-edge-partial" : "review-trend-edge"}
            data-from={before.month} data-to={point.month}
            x1={x(index)} y1={y(before.amountCents)} x2={x(index + 1)} y2={y(point.amountCents)}
            stroke={color}
            aria-hidden="true"
          />;
        })}
        {ticks.map(index => <text key={points[index].month} x={x(index)} y={163} textAnchor="middle" aria-hidden="true">
          {acrossYears ? `${points[index].month.slice(2, 4)}/${Number(points[index].month.slice(5))}` : `${Number(points[index].month.slice(5))} 月`}
        </text>)}
        {points.map(({ month, amountCents, isPartial }, index) => {
          if (amountCents === null) return null;
          const pressed = month === selected?.month;
          return <g
            key={month} className="review-trend-point" data-month={month} data-amount-cents={amountCents}
            role="button" tabIndex={points.length > 12 ? -1 : 0} aria-pressed={pressed}
            aria-label={`${monthLabel(month)} ${formatMoney(amountCents)}`}
            onClick={() => setPickedMonth(month)}
            onKeyDown={event => graphKey(event, () => setPickedMonth(month))}
          >
            <rect x={x(index) - hitWidth / 2} y={6} width={hitWidth} height={149} fill="transparent" />
            <circle cx={x(index)} cy={y(amountCents)} r={pressed ? 5.5 : 4} fill={isPartial ? "var(--review-chart-surface)" : color} stroke={color} />
          </g>;
        })}
      </svg>
      {points.length > 12 && <label className="review-trend-category">
        查看月份
        <select aria-label="查看月份" value={selected?.month ?? ""} onChange={event => setPickedMonth(event.target.value)}>
          <option value="">选择月份</option>
          {known.map(point => <option key={point.month} value={point.month}>{monthLabel(point.month)}</option>)}
        </select>
      </label>}
      <div className="review-trend-readout">
        <div aria-live="polite">
          <span>{monthLabel(readout.month)}{readout.isPartial && (throughDate?.startsWith(readout.month) ? ` · 截至 ${Number(throughDate.slice(8, 10))} 日` : " · 本月未完")}</span>
          <strong>{formatMoney(readout.amountCents)}</strong>
        </div>
        {selected && onOpenMonth && <button type="button" className="button ghost small" onClick={() => onOpenMonth(selected.month)}>查看该月复盘</button>}
      </div>
    </> : <p className="review-chart-empty">所选区间暂无账目</p>}
  </section>;
}
