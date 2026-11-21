import { EXPENSE_CATEGORIES, normalizeExpenseCategory } from "./expenseCategories";
import { isValidLocalDateTime, type Transaction } from "./ledger";

const MONTH = /^(?!0000)\d{4}-(0[1-9]|1[0-2])$/;
const MAX_AMOUNT_CENTS = 1_000_000_000_000;
const MAX_MONTHLY_ENTRIES = 12_000;

export type BudgetScope = { category: string; subcategory?: string };

export type AnnualBudget = BudgetScope & {
  year: number;
  capChanges: { month: string; amountCents: number | null }[];
  monthlyOverrides: { month: string; amountCents: number }[];
};

type Spending = {
  currentNetCents: number;
  currentCount: number;
  priorNetCents: number;
  priorCount: number;
  yearNetCents: number;
};

export type BudgetReviewRow = BudgetScope & Spending & {
  annualCapCents: number | null;
  monthlyReferenceCents: number | null;
  annualRemainingCents: number | null;
  next: {
    monthsRemaining: number;
    annualCapCents: number | null;
    annualRemainingCents: number | null;
    suggestedCents: number | null;
    overrideCents: number | null;
  };
};

export type BudgetReview = {
  selectedMonth: string;
  currentThrough: string;
  priorMonth: string;
  priorThrough: string;
  isMonthToDate: boolean;
  nextMonth: string;
  rows: BudgetReviewRow[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBudgetAmount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_AMOUNT_CENTS;
}

function isCapAmount(value: unknown): value is number | null {
  return value === null || isBudgetAmount(value);
}

function isBudgetableScope<T extends Record<string, unknown> | BudgetScope>(value: T): value is T & BudgetScope {
  const { category, subcategory } = value;
  return typeof category === "string" && category !== "待分类" && (EXPENSE_CATEGORIES as readonly string[]).includes(category)
    && (subcategory === undefined || (typeof subcategory === "string" && subcategory.length > 0 && subcategory.length <= 40
      && subcategory === subcategory.trim() && subcategory !== "未细分"));
}

function scopeKey({ category, subcategory }: BudgetScope): string {
  return JSON.stringify([category, subcategory]);
}

function parseMonthlyEntries<T extends number | null>(
  value: unknown, year: number, isAmount: (amount: unknown) => amount is T,
): { month: string; amountCents: T }[] {
  if (!Array.isArray(value) || value.length > 12) throw new Error("预算月份列表无效。");
  let previousMonth = "";
  return value.map(entry => {
    if (!isRecord(entry)) throw new Error("预算月份或金额无效。");
    const { month, amountCents } = entry;
    if (typeof month !== "string" || !MONTH.test(month) || Number(month.slice(0, 4)) !== year
      || month <= previousMonth || !isAmount(amountCents)) throw new Error("预算月份或金额无效。");
    previousMonth = month;
    return { month, amountCents };
  });
}

export function parseAnnualBudgets(value: unknown): AnnualBudget[] {
  if (!Array.isArray(value) || value.length > MAX_MONTHLY_ENTRIES) throw new Error("年度预算列表无效。");
  const seen = new Set<string>();
  let monthlyEntries = 0;
  return value.map(entry => {
    if (!isRecord(entry) || !isBudgetableScope(entry)) throw new Error("年度预算分类无效。");
    const { year, category, subcategory } = entry;
    if (typeof year !== "number" || !Number.isInteger(year) || year < 1 || year > 9999) throw new Error("预算年份无效。");
    const key = `${year}:${scopeKey(entry)}`;
    if (seen.has(key)) throw new Error("同一分类和年份的年度预算重复。");
    seen.add(key);
    const capChanges = parseMonthlyEntries(entry.capChanges, year, isCapAmount);
    const monthlyOverrides = parseMonthlyEntries(entry.monthlyOverrides, year, isBudgetAmount);
    monthlyEntries += capChanges.length + monthlyOverrides.length;
    if (!capChanges.length || monthlyEntries > MAX_MONTHLY_ENTRIES) throw new Error("预算月份记录无效或过多。");
    return { year, category, ...(subcategory !== undefined ? { subcategory } : {}), capChanges, monthlyOverrides };
  });
}

export function getAnnualCap(budget: AnnualBudget | undefined, month: string): number | null {
  if (!budget || Number(month.slice(0, 4)) !== budget.year) return null;
  for (let index = budget.capChanges.length - 1; index >= 0; index--) {
    const change = budget.capChanges[index];
    if (change.month <= month) return change.amountCents;
  }
  return null;
}

function monthlyOverride(budget: AnnualBudget | undefined, month: string): number | null {
  return budget?.monthlyOverrides.find(entry => entry.month === month)?.amountCents ?? null;
}

function findBudgetIndex(budgets: readonly AnnualBudget[], scope: BudgetScope, month: string, amountCents: number | null): number {
  if (!MONTH.test(month) || !isBudgetableScope(scope) || !isCapAmount(amountCents)) throw new Error("预算分类、月份或金额无效。");
  const year = Number(month.slice(0, 4));
  return budgets.findIndex(item => item.year === year && item.category === scope.category && item.subcategory === scope.subcategory);
}

function replaceMonthlyEntry<T extends { month: string }>(entries: T[], month: string, replacement?: T): T[] {
  const next = entries.filter(entry => entry.month !== month);
  if (replacement) next.push(replacement);
  return next.sort((a, b) => a.month.localeCompare(b.month));
}

export function setAnnualBudget(budgets: readonly AnnualBudget[], scope: BudgetScope, month: string, amountCents: number | null): AnnualBudget[] {
  const index = findBudgetIndex(budgets, scope, month, amountCents);
  const previous = budgets[index];
  if (getAnnualCap(previous, month) === amountCents) return [...budgets];
  const capChanges = replaceMonthlyEntry(previous?.capChanges ?? [], month, { month, amountCents });
  if (!previous) return [...budgets, { ...scope, year: Number(month.slice(0, 4)), capChanges, monthlyOverrides: [] }];
  return budgets.map((budget, itemIndex) => itemIndex === index ? { ...budget, capChanges } : budget);
}

export function setMonthlyOverride(budgets: readonly AnnualBudget[], scope: BudgetScope, month: string, amountCents: number | null): AnnualBudget[] {
  const index = findBudgetIndex(budgets, scope, month, amountCents);
  const previous = budgets[index];
  if (amountCents !== null && getAnnualCap(previous, month) === null) throw new Error("请先设置该月适用的年度预算。");
  if (monthlyOverride(previous, month) === amountCents) return [...budgets];
  const replacement = amountCents === null ? undefined : { month, amountCents };
  return budgets.map((budget, itemIndex) => itemIndex === index
    ? { ...budget, monthlyOverrides: replaceMonthlyEntry(budget.monthlyOverrides, month, replacement) }
    : budget);
}

function monthBoundary(month: string, monthOffset: number, day: number): Date {
  const [year, monthNumber] = month.split("-").map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, monthNumber - 1 + monthOffset, day);
  return date;
}

function formatMonth(date: Date): string {
  return `${String(date.getUTCFullYear()).padStart(4, "0")}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function lastDay(month: string): number {
  return monthBoundary(month, 1, 0).getUTCDate();
}

function formatDay(month: string, day: number): string {
  return `${month}-${String(day).padStart(2, "0")}`;
}

export function buildBudgetReview(
  transactions: readonly Transaction[], budgets: readonly AnnualBudget[], selectedMonth: string, today: string, mode?: "equal" | "full",
): BudgetReview {
  if (!MONTH.test(selectedMonth) || !isValidLocalDateTime(`${today}T00:00`)) throw new Error("复盘日期无效。");
  const year = Number(selectedMonth.slice(0, 4));
  const priorMonth = formatMonth(monthBoundary(selectedMonth, -1, 1));
  const nextDate = monthBoundary(selectedMonth, 1, 1);
  const nextMonth = formatMonth(nextDate);
  const nextYear = nextDate.getUTCFullYear();
  const monthsRemaining = 12 - nextDate.getUTCMonth();
  const isMonthToDate = today.startsWith(`${selectedMonth}-`);
  const currentEnd = formatDay(selectedMonth, lastDay(selectedMonth));
  const currentThrough = today < currentEnd ? today : currentEnd;
  const priorDay = (mode ?? (isMonthToDate ? "equal" : "full")) === "equal"
    ? Math.min(lastDay(priorMonth), Number(currentThrough.slice(-2))) : lastDay(priorMonth);
  const priorEnd = formatDay(priorMonth, priorDay);
  const priorThrough = today < priorEnd ? today : priorEnd;

  const totals = new Map<string, BudgetScope & Spending>();
  const forScope = (scope: BudgetScope) => {
    const key = scopeKey(scope);
    let total = totals.get(key);
    if (!total) {
      const { category, subcategory } = scope;
      total = { category, ...(subcategory !== undefined ? { subcategory } : {}), currentNetCents: 0, currentCount: 0, priorNetCents: 0, priorCount: 0, yearNetCents: 0 };
      totals.set(key, total);
    }
    return total;
  };
  for (const category of EXPENSE_CATEGORIES) forScope({ category });

  const currentBudgets = new Map<string, AnnualBudget>();
  const nextBudgets = year === nextYear ? currentBudgets : new Map<string, AnnualBudget>();
  for (const budget of budgets) {
    if (budget.year === year) currentBudgets.set(scopeKey(budget), budget);
    else if (budget.year === nextYear) nextBudgets.set(scopeKey(budget), budget);
    else continue;
    forScope(budget);
  }

  const yearPrefix = selectedMonth.slice(0, 5);
  for (const raw of transactions) {
    if (raw.kind !== "expense" && raw.kind !== "refund") continue;
    const date = raw.date.slice(0, 10);
    const inYear = date.startsWith(yearPrefix) && date <= currentThrough;
    const inCurrent = inYear && date.startsWith(`${selectedMonth}-`);
    const inPrior = date.startsWith(`${priorMonth}-`) && date <= priorThrough;
    if (!inYear && !inPrior) continue;
    const { category, subcategory } = normalizeExpenseCategory(raw);
    const amount = raw.kind === "expense" ? raw.amountCents : -raw.amountCents;
    const scopes = [forScope({ category })];
    const detail = subcategory?.trim();
    if (detail && detail !== "未细分") scopes.push(forScope({ category, subcategory: detail }));
    for (const total of scopes) {
      if (inCurrent) { total.currentNetCents += amount; total.currentCount += 1; }
      if (inPrior) { total.priorNetCents += amount; total.priorCount += 1; }
      if (inYear) total.yearNetCents += amount;
    }
  }

  const rows = [...totals].map(([key, total]): BudgetReviewRow => {
    const budget = currentBudgets.get(key);
    const nextBudget = nextBudgets.get(key);
    const annualCapCents = getAnnualCap(budget, selectedMonth);
    const nextCap = getAnnualCap(nextBudget, nextMonth);
    const nextRemaining = nextCap === null ? null : nextCap - (year === nextYear ? total.yearNetCents : 0);
    return {
      ...total,
      annualCapCents,
      monthlyReferenceCents: annualCapCents === null ? null : (monthlyOverride(budget, selectedMonth) ?? Math.round(annualCapCents / 12)),
      annualRemainingCents: annualCapCents === null ? null : annualCapCents - total.yearNetCents,
      next: {
        monthsRemaining,
        annualCapCents: nextCap,
        annualRemainingCents: nextRemaining,
        suggestedCents: nextRemaining === null ? null : Math.round(Math.max(0, nextRemaining) / monthsRemaining),
        overrideCents: monthlyOverride(nextBudget, nextMonth),
      },
    };
  });
  return { selectedMonth, currentThrough, priorMonth, priorThrough, isMonthToDate, nextMonth, rows };
}
