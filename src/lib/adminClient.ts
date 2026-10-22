import type { SupabaseClient } from "@supabase/supabase-js";
import { captureAccountBearer } from "./cloudClient";
import { isValidLocalDateTime } from "./ledger";

export type AdminUser = {
  id: string;
  email: string | null;
  created_at: string | null;
  email_confirmed_at: string | null;
  last_sign_in_at: string | null;
  ledger_updated_at: string | null;
  transaction_count: number;
};

export type AdminOverview = {
  totals: {
    users: number;
    confirmed_users: number;
    new_users_7d: number;
    ledgers: number;
    synced_24h: number;
  };
  users: AdminUser[];
  total: number;
  page: number;
  page_size: number;
};

export type AdminOverviewOptions = { query: string; page: number; pageSize: number };

export class AdminAccessError extends Error {
  constructor(message = "当前账户没有管理员权限。") {
    super(message);
    this.name = "AdminAccessError";
  }
}

export class AdminSetupError extends Error {
  constructor() {
    super("管理后台尚未完成配置，请先执行管理员数据库脚本并绑定账户。");
    this.name = "AdminSetupError";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const overviewKeys = ["totals", "users", "total", "page", "page_size"];
const totalKeys = ["users", "confirmed_users", "new_users_7d", "ledgers", "synced_24h"];
const userKeys = ["id", "email", "created_at", "email_confirmed_at", "last_sign_in_at", "ledger_updated_at", "transaction_count"];

function failFormat(): never {
  throw new Error("管理数据格式不正确，已停止显示，请刷新后重试。");
}

function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return failFormat();
  const data = value as Record<string, unknown>;
  if (Object.keys(data).length !== keys.length || keys.some(key => !Object.hasOwn(data, key))) return failFormat();
  return data;
}

function count(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) return failFormat();
  return value as number;
}

function timestamp(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:[0-5]\d(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    || !isValidLocalDateTime(value.slice(0, 16)) || !Number.isFinite(Date.parse(value))) return failFormat();
  return value;
}

function readOverview(value: unknown, expected: AdminOverviewOptions): AdminOverview {
  const data = record(value, overviewKeys);
  const summary = record(data.totals, totalKeys);
  const totals: AdminOverview["totals"] = {
    users: count(summary.users),
    confirmed_users: count(summary.confirmed_users),
    new_users_7d: count(summary.new_users_7d),
    ledgers: count(summary.ledgers),
    synced_24h: count(summary.synced_24h),
  };
  if (totals.confirmed_users > totals.users || totals.new_users_7d > totals.users
    || totals.ledgers > totals.users || totals.synced_24h > totals.ledgers) return failFormat();
  const total = count(data.total); const page = count(data.page); const pageSize = count(data.page_size);
  if (total > totals.users || page !== expected.page || pageSize !== expected.pageSize || !Array.isArray(data.users)
    || data.users.length > pageSize || data.users.length > total
    || ((page - 1) * pageSize >= total && data.users.length !== 0)) return failFormat();
  const ids = new Set<string>();
  const users = data.users.map((value): AdminUser => {
    const item = record(value, userKeys);
    if (typeof item.id !== "string" || !UUID.test(item.id) || ids.has(item.id.toLowerCase())) return failFormat();
    if (item.email !== null && (typeof item.email !== "string" || item.email.length > 320 || /[\u0000-\u001f\u007f]/.test(item.email))) return failFormat();
    ids.add(item.id.toLowerCase());
    return {
      id: item.id,
      email: item.email as string | null,
      created_at: timestamp(item.created_at),
      email_confirmed_at: timestamp(item.email_confirmed_at),
      last_sign_in_at: timestamp(item.last_sign_in_at),
      ledger_updated_at: timestamp(item.ledger_updated_at),
      transaction_count: count(item.transaction_count),
    };
  });
  return { totals, users, total, page, page_size: pageSize };
}

function checkOptions(options: AdminOverviewOptions): AdminOverviewOptions {
  if (!options || typeof options.query !== "string" || options.query.trim().length > 200
    || !Number.isSafeInteger(options.page) || options.page < 1 || options.page > 1_000_000
    || !Number.isSafeInteger(options.pageSize) || options.pageSize < 1 || options.pageSize > 50) {
    throw new Error("查询条件无效，请缩短搜索内容或重新选择页码。");
  }
  return { query: options.query.trim(), page: options.page, pageSize: options.pageSize };
}

function checkAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException("请求已取消。", "AbortError");
}

function throwAdminError(error: unknown, status?: number): never {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  if (status === 401 || ["PGRST301", "PGRST302", "28000"].includes(code)) throw new AdminAccessError("登录状态已过期，请重新登录后进入管理后台。");
  if (status === 403 || code === "42501") throw new AdminAccessError();
  if (["42883", "42P01", "PGRST202", "PGRST205"].includes(code)) throw new AdminSetupError();
  throw new Error("暂时无法读取管理数据，请检查网络后重试。");
}

async function rpc(client: SupabaseClient, userId: string, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  const token = await captureAccountBearer(client, userId, signal);
  checkAborted(signal);
  let result;
  try {
    const query = client.rpc(name, args).setHeader("Authorization", `Bearer ${token}`);
    if (signal) query.abortSignal(signal);
    result = await query;
  } catch (error) { checkAborted(signal); return throwAdminError(error); }
  checkAborted(signal);
  if (result.error) return throwAdminError(result.error, result.status);
  return result.data;
}

/** The database makes this decision; email strings, JWT metadata and browser flags do not grant access. */
export async function fetchAdminAccess(client: SupabaseClient, userId: string, signal?: AbortSignal): Promise<boolean> {
  const result = await rpc(client, userId, "moneytrail_is_admin", {}, signal);
  if (typeof result !== "boolean") return failFormat();
  return result;
}

/** Every overview request is authorized again by its server function, even after a successful access check. */
export async function fetchAdminOverview(client: SupabaseClient, userId: string, options: AdminOverviewOptions, signal?: AbortSignal): Promise<AdminOverview> {
  const safe = checkOptions(options);
  const data = await rpc(client, userId, "moneytrail_admin_overview", { p_query: safe.query, p_page: safe.page, p_page_size: safe.pageSize }, signal);
  return readOverview(data, safe);
}
