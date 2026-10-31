import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { emptyData, importBackup, type AppData } from "./storage";
import { isValidLocalDateTime } from "./ledger";
import type { MerchantRuleIntent } from "./merchantClassification";
import { matchingMerchantRuleIntents, readMerchantRuleIntents } from "./merchantRuleIntents";
import { readCloudConfig, getCloudConfigError as configError, type CloudConfig } from "./cloudConfig";

export type AccountIdentity = { id: string; email?: string };
export type CloudSnapshot = {
  data: AppData;
  revision: number;
  updatedAt: string | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export { readCloudConfig } from "./cloudConfig";
export type { CloudConfig } from "./cloudConfig";
export function getCloudConfigError(env: Record<string, unknown> = import.meta.env): string | null {
  return configError(env);
}

export function createCloudClient(config: CloudConfig): SupabaseClient {
  const safe = readCloudConfig({ VITE_SUPABASE_URL: config.url, VITE_SUPABASE_PUBLISHABLE_KEY: config.publishableKey });
  if (!safe) throw new Error("账号服务配置不正确。");
  return createClient(safe.url, safe.publishableKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      flowType: "pkce",
      detectSessionInUrl: true,
      storageKey: `moneytrail:auth:v1:${encodeURIComponent(new URL(safe.url).host)}`,
    },
  });
}

let sharedClient: SupabaseClient | null | undefined;
export function getCloudClient(): SupabaseClient | null {
  if (sharedClient !== undefined) return sharedClient;
  const config = readCloudConfig(import.meta.env);
  sharedClient = config ? createCloudClient(config) : null;
  return sharedClient;
}

export class CloudConflictError extends Error {
  constructor() {
    super("云端已有更新，本机修改已保留。请核对两个版本后再选择同步方式。");
    this.name = "CloudConflictError";
  }
}

function throwCloudError(error: unknown, status?: number): never {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  if (code === "PT409" || code === "40001" || code === "23505") throw new CloudConflictError();
  if (["PGRST301", "PGRST302"].includes(code) || status === 401) throw new Error("登录状态已过期，请重新登录后同步。");
  if (code === "42501" || status === 403) throw new Error("没有当前账本的访问权限，请重新登录。");
  if (code === "54000") throw new Error("商户规则已达上限（200 条）。请在个人商户规则的待同步记忆列表中取消这次学习，让账目先同步，再删除不再使用的规则；本机账目与记忆选择已保留。");
  if (["42P01", "42883", "PGRST202", "PGRST205"].includes(code)) throw new Error("账号账本尚未开通，请联系应用维护者。");
  if (["23514", "22023", "22P02", "22001"].includes(code)) throw new Error("云端拒绝了无效或过大的账目，请导出备份并检查数据。");
  throw new Error("暂时无法连接云端，请检查网络后重试。");
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:[0-5]\d(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return false;
  return isValidLocalDateTime(value.slice(0, 16)) && Number.isFinite(Date.parse(value));
}

function readSnapshot(row: unknown): CloudSnapshot {
  if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("云端账目格式不正确，已停止同步以保护本机数据。");
  const record = row as Record<string, unknown>;
  if (!Number.isSafeInteger(record.revision) || (record.revision as number) < 1 || !validTimestamp(record.updated_at)) throw new Error("云端账目版本不正确，已停止同步以保护本机数据。");
  let data: AppData;
  try { data = importBackup(JSON.stringify(record.data)); }
  catch { throw new Error("云端账目内容无法安全读取，本机数据已保留。"); }
  return { data, revision: record.revision as number, updatedAt: record.updated_at };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("请求已取消。", "AbortError");
}

/** The bearer is captured before creating the query, so a later account switch cannot retarget a write. */
async function capturedBearer(client: SupabaseClient, userId: string, signal?: AbortSignal): Promise<string> {
  if (!UUID.test(userId)) throw new Error("账号身份无效，请重新登录。");
  throwIfAborted(signal);
  const { data, error } = await client.auth.getSession();
  throwIfAborted(signal);
  const session = data.session;
  if (error || !session || session.user.id.toLowerCase() !== userId.toLowerCase() || !session.access_token || /\s/.test(session.access_token)) throw new Error("登录账号已发生变化，本次同步已停止，请重新打开当前账号账本。");
  return session.access_token;
}

export { capturedBearer as captureAccountBearer };

export async function fetchCloudLedger(client: SupabaseClient, userId: string, signal?: AbortSignal): Promise<CloudSnapshot> {
  const token = await capturedBearer(client, userId, signal);
  let result;
  try {
    const query = client.from("moneytrail_ledgers").select("data,revision,updated_at").eq("user_id", userId).setHeader("Authorization", `Bearer ${token}`);
    if (signal) query.abortSignal(signal);
    result = await query.maybeSingle();
  } catch (error) { throwIfAborted(signal); return throwCloudError(error); }
  throwIfAborted(signal);
  if (result.error) return throwCloudError(result.error, result.status);
  if (result.data === null) return { data: emptyData(), revision: 0, updatedAt: null };
  return readSnapshot(result.data);
}

export async function pushCloudLedger(client: SupabaseClient, data: AppData, expectedRevision: number, userId: string, signal?: AbortSignal, merchantRules: MerchantRuleIntent[] = []): Promise<CloudSnapshot> {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error("本机同步版本无效，请先核对云端账目。");
  // Sanitize the payload through the same strict format used by backups; never send auth/cache state.
  const clean = importBackup(JSON.stringify(data));
  const rules = readMerchantRuleIntents(merchantRules);
  if (matchingMerchantRuleIntents(clean, rules).length !== rules.length) throw new Error("商户分类已改变，请重新确认后同步。");
  const token = await capturedBearer(client, userId, signal);
  let result;
  try {
    const query = client.rpc(rules.length ? "save_moneytrail_ledger_with_rules" : "save_moneytrail_ledger", {
      p_data: clean, p_expected_revision: expectedRevision, ...(rules.length ? { p_rules: rules } : {}),
    }).setHeader("Authorization", `Bearer ${token}`);
    if (signal) query.abortSignal(signal);
    result = await query;
  } catch (error) { throwIfAborted(signal); return throwCloudError(error); }
  throwIfAborted(signal);
  if (result.error) return throwCloudError(result.error, result.status);
  if (!Array.isArray(result.data) || result.data.length !== 1) throw new Error("云端没有确认保存结果，本机修改已保留，请重新检查同步状态。");
  const snapshot = readSnapshot(result.data[0]);
  if (snapshot.revision !== expectedRevision + 1) throw new Error("云端返回了意外的账目版本，本机修改已保留。");
  return snapshot;
}
