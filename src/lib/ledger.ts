export const CATEGORIES = [
  "本地生活",
  "购物",
  "交通",
  "居住",
  "医疗",
  "学习",
  "其他",
  "待分类",
] as const;

export type TransactionKind = "expense" | "refund" | "transfer" | "income";
export type Source = "manual" | "sms" | "wechat" | "alipay" | "csv";
export const PLATFORMS = ["美团", "京东", "淘宝", "天猫", "拼多多", "滴滴"] as const;
export type Platform = typeof PLATFORMS[number];
export interface SmsEvidence {
  text: string;
  receivedAt?: string;
  classificationReason?: string;
  ruleVersion?: string;
}

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
  subcategory?: string;
  platform?: Platform;
  smsEvidence?: SmsEvidence;
}

export type DraftTransaction = Omit<Transaction, "id">;

const MAX_AMOUNT_CENTS = 1_000_000_000_000;
const KINDS: readonly string[] = ["expense", "refund", "transfer", "income"];
const SOURCES: readonly string[] = ["manual", "sms", "wechat", "alipay", "csv"];

/** Deterministic legacy conversion: retain any already-known purpose detail. */
export function normalizeTransactionCategory<T extends { category: string; subcategory?: string }>(transaction: T): T {
  if (transaction.category !== "餐饮" && transaction.category !== "娱乐") return { ...transaction };
  return { ...transaction, category: "本地生活", subcategory: transaction.subcategory ?? (transaction.category === "餐饮" ? "餐饮" : "休闲娱乐") };
}

export function copyTransaction(transaction: Transaction): Transaction {
  const copy: Transaction = {
    id: transaction.id, kind: transaction.kind, amountCents: transaction.amountCents,
    date: transaction.date, merchant: transaction.merchant, category: transaction.category,
    source: transaction.source, note: transaction.note,
  };
  if (transaction.sourceRef !== undefined) copy.sourceRef = transaction.sourceRef;
  if (transaction.linkedTransactionId !== undefined) copy.linkedTransactionId = transaction.linkedTransactionId;
  if (transaction.subcategory !== undefined) copy.subcategory = transaction.subcategory;
  if (transaction.platform !== undefined) copy.platform = transaction.platform;
  if (transaction.smsEvidence !== undefined) {
    const evidence = transaction.smsEvidence;
    copy.smsEvidence = { text: evidence.text,
      ...(evidence.receivedAt !== undefined ? { receivedAt: evidence.receivedAt } : {}),
      ...(evidence.classificationReason !== undefined ? { classificationReason: evidence.classificationReason } : {}),
      ...(evidence.ruleVersion !== undefined ? { ruleVersion: evidence.ruleVersion } : {}),
    };
  }
  return normalizeTransactionCategory(copy);
}

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

export function validateSmsEvidence(value: unknown): value is SmsEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return Object.keys(item).every(key => ["text", "receivedAt", "classificationReason", "ruleVersion"].includes(key))
    && nonemptyString(item.text, 3000)
    && (item.receivedAt === undefined || (typeof item.receivedAt === "string"
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:[0-5]\d(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(item.receivedAt)
      && isValidLocalDateTime(item.receivedAt.slice(0, 16)) && Number.isFinite(Date.parse(item.receivedAt))))
    && (item.classificationReason === undefined || (typeof item.classificationReason === "string" && item.classificationReason.length <= 200))
    && (item.ruleVersion === undefined || (typeof item.ruleVersion === "string" && item.ruleVersion.length <= 64));
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
    [...CATEGORIES, "餐饮", "娱乐"].includes(item.category) &&
    typeof item.source === "string" &&
    SOURCES.includes(item.source) &&
    typeof item.note === "string" &&
    item.note.length <= 2000 &&
    (item.sourceRef === undefined || nonemptyString(item.sourceRef, 200)) &&
    (item.linkedTransactionId === undefined ||
      nonemptyString(item.linkedTransactionId, 128)) &&
    (item.subcategory === undefined || nonemptyString(item.subcategory, 40)) &&
    (item.platform === undefined || (PLATFORMS as readonly unknown[]).includes(item.platform)) &&
    (item.smsEvidence === undefined || validateSmsEvidence(item.smsEvidence))
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
  categories: { category: string; amountCents: number; subcategories: { subcategory: string; amountCents: number }[] }[];
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
  const details = new Map<string, Map<string, number>>();
  for (const raw of transactions) {
    const item = normalizeTransactionCategory(raw);
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
    const subcategory = item.subcategory ?? "未细分";
    const categoryDetails = details.get(item.category) ?? new Map<string, number>();
    categoryDetails.set(subcategory, (categoryDetails.get(subcategory) ?? 0) + (item.kind === "expense" ? item.amountCents : -item.amountCents));
    details.set(item.category, categoryDetails);
  }
  summary.netCents = summary.expenseCents - summary.refundCents;
  summary.budgetRemainingCents = budgetCents - summary.netCents;
  summary.categories = [...categories.entries()]
    .map(([category, amountCents]) => ({ category, amountCents, subcategories: [...details.get(category)!.entries()].map(([subcategory, amountCents]) => ({ subcategory, amountCents })).filter(item => item.amountCents !== 0).sort((a, b) => b.amountCents - a.amountCents) }))
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
