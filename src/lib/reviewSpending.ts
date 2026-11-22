import { EXPENSE_CATEGORIES, normalizeExpenseCategory } from "./expenseCategories";
import { isValidLocalDateTime, type Transaction } from "./ledger";
import type { BudgetReviewRow } from "./reviewBudget";

export type SpendingSlice = { category: string; amountCents: number };
export type ReviewTrendRange = { startMonth: string; endMonth: string };
export type TrendPoint = { month: string; amountCents: number | null; isPartial: boolean };

type ReviewChange = {
  category: string;
  deltaCents: number;
  detail?: { subcategory: string; deltaCents: number };
};

export const MIN_TREND_MONTH = "2000-01";
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

function isTrendMonth(month: string): boolean {
  return MONTH.test(month) && month >= MIN_TREND_MONTH;
}

function monthIndex(month: string): number {
  const [year, number] = month.split("-").map(Number);
  return year * 12 + number - 1;
}

function formatMonth(index: number): string {
  const year = Math.floor(index / 12);
  const number = String(index % 12 + 1).padStart(2, "0");
  return year + "-" + number;
}

export function defaultTrendRange(selectedMonth: string, today: string): ReviewTrendRange {
  const currentMonth = today.slice(0, 7);
  const latestMonth = isTrendMonth(currentMonth) ? currentMonth : MIN_TREND_MONTH;
  const endMonth = isTrendMonth(selectedMonth) && selectedMonth < latestMonth ? selectedMonth : latestMonth;
  const startIndex = Math.max(monthIndex(MIN_TREND_MONTH), monthIndex(endMonth) - 5);
  return { startMonth: formatMonth(startIndex), endMonth };
}

export function buildSpendingMix(
  transactions: readonly Transaction[], month: string, through: string,
): SpendingSlice[] {
  const amounts = new Map<string, number>();
  const monthPrefix = month + "-";
  for (const transaction of transactions) {
    if (transaction.kind !== "expense" || transaction.amountCents <= 0
      || !transaction.date.startsWith(monthPrefix) || transaction.date.slice(0, 10) > through) continue;
    const { category } = normalizeExpenseCategory(transaction);
    amounts.set(category, (amounts.get(category) ?? 0) + transaction.amountCents);
  }

  return EXPENSE_CATEGORIES
    .filter(category => amounts.has(category))
    .map(category => ({ category, amountCents: amounts.get(category)! }))
    .sort((left, right) => right.amountCents - left.amountCents);
}

export function buildSpendingTrend(
  transactions: readonly Transaction[],
  { startMonth, endMonth }: ReviewTrendRange,
  today: string,
  category: string | null,
  checkedMonths: readonly string[] = [],
): TrendPoint[] {
  if (!isTrendMonth(startMonth) || !isTrendMonth(endMonth) || !isValidLocalDateTime(today + "T00:00")) return [];
  const currentMonth = today.slice(0, 7);
  const lastMonth = endMonth < currentMonth ? endMonth : currentMonth;
  if (startMonth > lastMonth) return [];

  const totals = new Map<string, number>();
  for (const transaction of transactions) {
    const month = transaction.date.slice(0, 7);
    if (month < startMonth || month > lastMonth || transaction.date.slice(0, 10) > today) continue;
    let sum = totals.get(month) ?? 0;
    if ((transaction.kind === "expense" || transaction.kind === "refund")
      && (category === null || normalizeExpenseCategory(transaction).category === category)) {
      sum += transaction.kind === "expense" ? transaction.amountCents : -transaction.amountCents;
    }
    // A recorded month may have zero spending, including for a selected category.
    totals.set(month, sum);
  }

  const checked = new Set(checkedMonths);
  const points: TrendPoint[] = [];
  const endIndex = monthIndex(lastMonth);
  for (let index = monthIndex(startMonth); index <= endIndex; index++) {
    const month = formatMonth(index);
    points.push({
      month,
      amountCents: totals.get(month) ?? (checked.has(month) ? 0 : null),
      isPartial: month === currentMonth,
    });
  }
  return points;
}

function largestMovement(rows: readonly BudgetReviewRow[], direction: number) {
  let largest: { row: BudgetReviewRow; deltaCents: number } | undefined;
  for (const row of rows) {
    const deltaCents = row.currentNetCents - row.priorNetCents;
    if (!deltaCents || (direction !== 0 && Math.sign(deltaCents) !== direction)) continue;
    if (!largest || Math.abs(deltaCents) > Math.abs(largest.deltaCents)) largest = { row, deltaCents };
  }
  return largest;
}

export function findLargestReviewChange(rows: readonly BudgetReviewRow[], netDeltaCents: number): ReviewChange | undefined {
  const categories: readonly string[] = EXPENSE_CATEGORIES;
  const classified = rows.filter(row => !row.subcategory && row.category !== "待分类" && categories.includes(row.category));
  const largest = largestMovement(classified, Math.sign(netDeltaCents));
  if (!largest) return undefined;
  const { category } = largest.row;
  const detail = largestMovement(
    rows.filter(row => row.category === category && row.subcategory),
    Math.sign(largest.deltaCents),
  );
  return {
    category, deltaCents: largest.deltaCents,
    ...(detail?.row.subcategory ? { detail: { subcategory: detail.row.subcategory, deltaCents: detail.deltaCents } } : {}),
  };
}
