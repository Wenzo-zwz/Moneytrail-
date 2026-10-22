export const CATEGORIES = [
  "餐饮",
  "购物",
  "交通",
  "居住",
  "娱乐",
  "医疗",
  "学习",
  "其他",
  "待分类",
] as const;

export type TransactionKind = "expense" | "refund" | "transfer" | "income";
export type Source = "manual" | "sms" | "wechat" | "alipay" | "csv";

export interface Transaction {
  id: string;
  kind: TransactionKind;
  amountCents: number;
  /** Local wall-clock time. Never interpret a bill's date in a different timezone. */
  date: string;
  merchant: string;
  category: string;
  source: Source;
  note: string;
  sourceRef?: string;
  linkedTransactionId?: string;
}

export type DraftTransaction = Omit<Transaction, "id">;

const MAX_AMOUNT_CENTS = 1_000_000_000_000;
const KINDS: readonly string[] = ["expense", "refund", "transfer", "income"];
const SOURCES: readonly string[] = ["manual", "sms", "wechat", "alipay", "csv"];

/** Parse decimal yuan without floating-point multiplication or rounding. */
export function parseAmount(value: string): number | null {
  if (typeof value !== "string" || value.length > 100) return null;
  let amount = value.trim();
  // Restrict accepted currency markers to yuan. In particular, $ is not RMB.
  amount = amount
    .replace(/^(?:人民币|CNY|RMB)\s*/i, "")
    .replace(/^[¥￥]\s*/, "");
  amount = amount.replace(/\s*(?:元|CNY|RMB)$/i, "").trim();
  if (!/^(?:\d+|[1-9]\d{0,2}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(amount))
    return null;
  const [whole, fraction = ""] = amount.replaceAll(",", "").split(".");
  // Bound before conversion so arbitrarily long strings never lose precision.
  if (whole.length > 11) return null;
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(cents) && cents > 0 && cents <= MAX_AMOUNT_CENTS
    ? cents
    : null;
}

export function formatMoney(cents: number): string {
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: "CNY",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

export function currentMonth(date: Date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

/** Validate the written calendar date rather than Date's overflow normalization. */
export function isValidLocalDateTime(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText] = match;
  const year = Number(yearText),
    month = Number(monthText),
    day = Number(dayText);
  const hour = Number(hourText),
    minute = Number(minuteText);
  if (year < 1 || month < 1 || month > 12 || hour > 23 || minute > 59)
    return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= days[month - 1];
}

function nonemptyString(value: unknown, max: number): value is string {
  return (
    typeof value === "string" && value.trim().length > 0 && value.length <= max
  );
}

export function validateTransaction(value: unknown): value is Transaction {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    nonemptyString(item.id, 128) &&
    typeof item.kind === "string" &&
    KINDS.includes(item.kind) &&
    typeof item.amountCents === "number" &&
    Number.isSafeInteger(item.amountCents) &&
    item.amountCents > 0 &&
    item.amountCents <= MAX_AMOUNT_CENTS &&
    isValidLocalDateTime(item.date) &&
    nonemptyString(item.merchant, 200) &&
    typeof item.category === "string" &&
    (CATEGORIES as readonly string[]).includes(item.category) &&
    typeof item.source === "string" &&
    SOURCES.includes(item.source) &&
    typeof item.note === "string" &&
    item.note.length <= 2000 &&
    (item.sourceRef === undefined || nonemptyString(item.sourceRef, 200)) &&
    (item.linkedTransactionId === undefined ||
      nonemptyString(item.linkedTransactionId, 128))
  );
}

export interface MonthSummary {
  expenseCents: number;
  refundCents: number;
  netCents: number;
  incomeCents: number;
  budgetRemainingCents: number;
  count: number;
  uncategorizedCount: number;
  categories: { category: string; amountCents: number }[];
}

/** Refunds reduce spending in the month received. Transfers are never spending. */
export function summarize(
  transactions: Transaction[],
  month: string,
  budgetCents: number,
): MonthSummary {
  const summary: MonthSummary = {
    expenseCents: 0,
    refundCents: 0,
    netCents: 0,
    incomeCents: 0,
    budgetRemainingCents: budgetCents,
    count: 0,
    uncategorizedCount: 0,
    categories: [],
  };
  const categories = new Map<string, number>();
  for (const item of transactions) {
    if (!item.date.startsWith(`${month}-`)) continue;
    if (item.kind === "income") summary.incomeCents += item.amountCents;
    if (item.kind !== "expense" && item.kind !== "refund") continue;
    summary.count += 1;
    if (item.category === "待分类") summary.uncategorizedCount += 1;
    if (item.kind === "expense") summary.expenseCents += item.amountCents;
    else summary.refundCents += item.amountCents;
    categories.set(
      item.category,
      (categories.get(item.category) ?? 0) +
        (item.kind === "expense" ? item.amountCents : -item.amountCents),
    );
  }
  summary.netCents = summary.expenseCents - summary.refundCents;
  summary.budgetRemainingCents = budgetCents - summary.netCents;
  summary.categories = [...categories.entries()]
    .map(([category, amountCents]) => ({ category, amountCents }))
    .filter((item) => item.amountCents !== 0)
    .sort((a, b) => b.amountCents - a.amountCents);
  return summary;
}

function wallClockMinutes(value: string): number {
  // UTC here encodes a local calendar for comparison; it does not shift the date.
  const [date, time] = value.split("T");
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const result = new Date(0);
  result.setUTCFullYear(year, month - 1, day);
  result.setUTCHours(hour, minute, 0, 0);
  return result.getTime() / 60_000;
}

/** Suggestions only: equal amounts and nearby times do not prove a duplicate. */
export function findDuplicates(
  candidate: DraftTransaction,
  existing: Transaction[],
): Transaction[] {
  return existing.filter((item) => {
    if (item.kind !== candidate.kind) return false;
    if (
      candidate.sourceRef &&
      item.source === candidate.source &&
      item.sourceRef === candidate.sourceRef
    )
      return true;
    return (
      item.amountCents === candidate.amountCents &&
      isValidLocalDateTime(item.date) &&
      isValidLocalDateTime(candidate.date) &&
      Math.abs(
        wallClockMinutes(item.date) - wallClockMinutes(candidate.date),
      ) <= 10
    );
  });
}
