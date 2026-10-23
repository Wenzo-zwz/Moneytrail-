import type { SupabaseClient } from "@supabase/supabase-js";
import { captureAccountBearer } from "./cloudClient";
import { CATEGORIES, isValidLocalDateTime, type TransactionKind } from "./ledger";

export type SmsMode = "review" | "auto";
export type SmsConfig = {
  enabled: boolean;
  mode: SmsMode;
  created_at: string | null;
  last_received_at: string | null;
  pending_count: number;
};
export type SmsDraft = {
  kind: TransactionKind;
  amountCents: number;
  date: string;
  merchant: string;
  category: string;
  source: "sms";
  note: string;
};
export type SmsInboxItem = {
  id: string;
  received_at: string;
  status: "pending" | "recorded" | "dismissed";
  raw_text: string | null;
  draft: SmsDraft | null;
  warnings: string[];
  reason: string | null;
  transaction_id: string | null;
};
export type SmsInbox = { items: SmsInboxItem[]; total: number; page: number; page_size: number };
export type SmsInboxOptions = { page: number; pageSize: number };
export type SmsReprocessResult = { recorded_count: number; pending_count: number };

export class SmsUpgradeError extends Error {
  constructor() {
    super("自动入账规则尚未升级，请在 Supabase 执行本次规则更新 SQL。现有短信接收功能仍可使用。");
    this.name = "SmsUpgradeError";
  }
}

export class SmsSetupError extends Error {
  constructor() {
    super("短信自动化尚未开通，请先在 Supabase 执行短信数据库脚本。已有账本仍可正常使用。");
    this.name = "SmsSetupError";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CAPABILITY = /^mt_sms_[0-9a-f]{64}$/;
const KINDS = ["expense", "refund", "transfer", "income"];
const DRAFT_KEYS = ["kind", "amountCents", "date", "merchant", "category", "source", "note"];
const CONFIG_KEYS = ["enabled", "mode", "created_at", "last_received_at", "pending_count"];
const ITEM_KEYS = ["id", "received_at", "status", "raw_text", "draft", "warnings", "reason", "transaction_id"];

function failFormat(): never {
  throw new Error("短信服务返回的内容格式不正确，请刷新后重试。");
}

function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return failFormat();
  const data = value as Record<string, unknown>;
  if (Object.keys(data).length !== keys.length || keys.some(key => !Object.hasOwn(data, key))) return failFormat();
  return data;
}

function count(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max) return failFormat();
  return value as number;
}

function timestamp(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:[0-5]\d(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    || !isValidLocalDateTime(value.slice(0, 16)) || !Number.isFinite(Date.parse(value))) return failFormat();
  return value;
}

function nullableTimestamp(value: unknown): string | null {
  return value === null ? null : timestamp(value);
}

function text(value: unknown, max: number, nonempty = false): string {
  if (typeof value !== "string" || value.length > max || value.includes("\u0000") || (nonempty && !value.trim())) return failFormat();
  return value;
}

function readDraft(value: unknown): SmsDraft {
  const draft = record(value, DRAFT_KEYS);
  if (typeof draft.kind !== "string" || !KINDS.includes(draft.kind)
    || !Number.isSafeInteger(draft.amountCents) || (draft.amountCents as number) <= 0 || (draft.amountCents as number) > 1_000_000_000_000
    || !isValidLocalDateTime(draft.date) || !CATEGORIES.includes(draft.category as typeof CATEGORIES[number]) || draft.source !== "sms") return failFormat();
  return {
    kind: draft.kind as TransactionKind, amountCents: draft.amountCents as number, date: draft.date,
    merchant: text(draft.merchant, 200, true), category: draft.category as string, source: "sms", note: text(draft.note, 2000),
  };
}

function readConfig(value: unknown): SmsConfig {
  const config = record(value, CONFIG_KEYS);
  if (typeof config.enabled !== "boolean" || !["review", "auto"].includes(config.mode as string)) return failFormat();
  const result = {
    enabled: config.enabled, mode: config.mode as SmsMode,
    created_at: nullableTimestamp(config.created_at), last_received_at: nullableTimestamp(config.last_received_at),
    pending_count: count(config.pending_count, 200),
  };
  if (result.enabled && result.created_at === null) return failFormat();
  return result;
}

function readInbox(value: unknown, options: SmsInboxOptions): SmsInbox {
  const data = record(value, ["items", "total", "page", "page_size"]);
  const total = count(data.total), page = count(data.page), pageSize = count(data.page_size);
  if (page !== options.page || pageSize !== options.pageSize || !Array.isArray(data.items)
    || data.items.length > pageSize || data.items.length > total || ((page - 1) * pageSize >= total && data.items.length !== 0)) return failFormat();
  const ids = new Set<string>();
  const items = data.items.map((entry): SmsInboxItem => {
    const item = record(entry, ITEM_KEYS);
    if (typeof item.id !== "string" || !UUID.test(item.id) || ids.has(item.id.toLowerCase())
      || !["pending", "recorded", "dismissed"].includes(item.status as string)
      || !Array.isArray(item.warnings) || item.warnings.length > 20) return failFormat();
    ids.add(item.id.toLowerCase());
    const transactionId = item.transaction_id === null ? null : text(item.transaction_id, 128, true);
    if (transactionId !== null && transactionId !== `sms-${item.id.toLowerCase()}`) return failFormat();
    if ((item.status === "recorded") !== (transactionId !== null) || (item.status !== "pending" && item.raw_text !== null)) return failFormat();
    return {
      id: item.id, received_at: timestamp(item.received_at), status: item.status as SmsInboxItem["status"],
      raw_text: item.raw_text === null ? null : text(item.raw_text, 2000),
      draft: item.draft === null ? null : readDraft(item.draft),
      warnings: item.warnings.map(warning => text(warning, 500, true)),
      reason: item.reason === null ? null : text(item.reason, 1000), transaction_id: transactionId,
    };
  });
  return { items, total, page, page_size: pageSize };
}

function checkMode(mode: SmsMode): void {
  if (mode !== "review" && mode !== "auto") throw new Error("请选择有效的短信记账方式。");
}

function checkId(id: string): void {
  if (typeof id !== "string" || !UUID.test(id)) throw new Error("短信记录编号无效，请刷新列表。");
}

function checkAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException("请求已取消。", "AbortError");
}

function throwSmsError(error: unknown, status?: number): never {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  if (["42883", "42P01", "PGRST202", "PGRST205"].includes(code)) throw new SmsSetupError();
  if (status === 401 || ["PGRST301", "PGRST302", "28000"].includes(code)) throw new Error("登录状态已过期，请重新登录后配置短信自动化。");
  if (status === 403 || code === "42501") throw new Error("当前账户无法操作此短信记录，请确认邮箱已验证并重新登录。");
  if (["22023", "23514", "22P02", "22001"].includes(code)) throw new Error("短信记录或设置无效，请核对金额、日期和其他内容后重试。");
  if (code === "P0002") throw new Error("这条短信记录已不存在，请刷新列表。");
  if (code === "40001" || code === "23505") throw new Error("短信记录已发生变化，请刷新列表后再操作。");
  throw new Error("暂时无法连接短信服务，请检查网络后重试。");
}

async function rpc(client: SupabaseClient, userId: string, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  const token = await captureAccountBearer(client, userId, signal);
  checkAborted(signal);
  let result;
  try {
    const query = client.rpc(name, args).setHeader("Authorization", `Bearer ${token}`);
    if (signal) query.abortSignal(signal);
    result = await query;
  } catch (error) { checkAborted(signal); return throwSmsError(error); }
  checkAborted(signal);
  if (result.error) return throwSmsError(result.error, result.status);
  return result.data;
}

export async function fetchSmsConfig(client: SupabaseClient, userId: string, signal?: AbortSignal): Promise<SmsConfig> {
  return readConfig(await rpc(client, userId, "moneytrail_sms_config", {}, signal));
}

/** A new capability is returned exactly once; callers keep it in component memory only. */
export async function rotateSmsToken(client: SupabaseClient, userId: string, mode: SmsMode, signal?: AbortSignal): Promise<{ token: string; config: SmsConfig }> {
  checkMode(mode);
  const data = record(await rpc(client, userId, "moneytrail_sms_rotate", { p_mode: mode }, signal), ["token", "config"]);
  if (typeof data.token !== "string" || !CAPABILITY.test(data.token)) return failFormat();
  const config = readConfig(data.config);
  if (!config.enabled || config.mode !== mode) return failFormat();
  return { token: data.token, config };
}

export async function setSmsMode(client: SupabaseClient, userId: string, mode: SmsMode, signal?: AbortSignal): Promise<SmsConfig> {
  checkMode(mode);
  const config = readConfig(await rpc(client, userId, "moneytrail_sms_set_mode", { p_mode: mode }, signal));
  if (config.mode !== mode) return failFormat();
  return config;
}

export async function revokeSmsToken(client: SupabaseClient, userId: string, signal?: AbortSignal): Promise<SmsConfig> {
  const config = readConfig(await rpc(client, userId, "moneytrail_sms_revoke", {}, signal));
  if (config.enabled) return failFormat();
  return config;
}

export async function fetchSmsInbox(client: SupabaseClient, userId: string, options: SmsInboxOptions, signal?: AbortSignal): Promise<SmsInbox> {
  if (!options || !Number.isSafeInteger(options.page) || options.page < 1 || options.page > 1_000_000
    || !Number.isSafeInteger(options.pageSize) || options.pageSize < 1 || options.pageSize > 50) throw new Error("短信列表页码无效，请重新选择。");
  const safe = { page: options.page, pageSize: options.pageSize };
  return readInbox(await rpc(client, userId, "moneytrail_sms_inbox", { p_page: safe.page, p_page_size: safe.pageSize }, signal), safe);
}

export async function confirmSms(client: SupabaseClient, userId: string, id: string, draft: SmsDraft, signal?: AbortSignal): Promise<{ status: "recorded"; transaction_id: string }> {
  checkId(id);
  let clean: SmsDraft;
  try { clean = readDraft(draft); }
  catch { throw new Error("请填写有效的短信金额、日期、交易对象和分类。"); }
  const data = record(await rpc(client, userId, "moneytrail_sms_confirm", { p_id: id, p_draft: clean }, signal), ["status", "transaction_id"]);
  if (data.status !== "recorded" || data.transaction_id !== `sms-${id.toLowerCase()}`) return failFormat();
  return { status: "recorded", transaction_id: data.transaction_id as string };
}

export async function dismissSms(client: SupabaseClient, userId: string, id: string, signal?: AbortSignal): Promise<{ status: "dismissed" }> {
  checkId(id);
  const data = record(await rpc(client, userId, "moneytrail_sms_dismiss", { p_id: id }, signal), ["status"]);
  if (data.status !== "dismissed") return failFormat();
  return { status: "dismissed" };
}

export async function reprocessPendingSms(client: SupabaseClient, userId: string, signal?: AbortSignal): Promise<SmsReprocessResult> {
  let response: unknown;
  try { response = await rpc(client, userId, "moneytrail_sms_reprocess_pending", {}, signal); }
  catch (error) { if (error instanceof SmsSetupError) throw new SmsUpgradeError(); throw error; }
  const data = record(response, ["recorded_count", "pending_count"]);
  return { recorded_count: count(data.recorded_count, 200), pending_count: count(data.pending_count, 200) };
}
