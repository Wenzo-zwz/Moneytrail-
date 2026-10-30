import { importBackup, type AppData, type StorageWriteResult } from "./storage";
import { isValidLocalDateTime } from "./ledger";
import type { MerchantRuleIntent } from "./merchantClassification";
import { latestMerchantRuleIntents, matchingMerchantRuleIntents, readMerchantRuleIntents } from "./merchantRuleIntents";

export type AccountCache = {
  version: 1;
  ownerId: string;
  data: AppData;
  baseRevision: number;
  dirty: boolean;
  lastSyncedAt: string | null;
  pendingMerchantRules?: MerchantRuleIntent[];
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_CACHE_LENGTH = 20 * 1024 * 1024;

function owner(userId: string): string {
  if (!UUID.test(userId)) throw new Error("账号身份无效，请重新登录。");
  return userId.toLowerCase();
}

function projectOrigin(projectUrl: string): string {
  const url = new URL(projectUrl);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("账号服务地址不正确。");
  return url.origin;
}

export function cacheKey(projectUrl: string, userId: string): string {
  return `moneytrail:cloud:v1:${encodeURIComponent(projectOrigin(projectUrl))}:${owner(userId)}`;
}

function storage(): Storage {
  const value = globalThis.localStorage;
  if (!value) throw new Error("浏览器未提供本地存储。");
  return value;
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:[0-5]\d(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return false;
  return isValidLocalDateTime(value.slice(0, 16)) && Number.isFinite(Date.parse(value));
}

function validateCache(value: unknown, userId: string): AccountCache {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("缓存格式无效。");
  const item = value as Record<string, unknown>;
  const expectedOwner = owner(userId);
  if (item.version !== 1 || typeof item.ownerId !== "string" || owner(item.ownerId) !== expectedOwner) throw new Error("缓存不属于当前账号。");
  if (!Number.isSafeInteger(item.baseRevision) || (item.baseRevision as number) < 0 || typeof item.dirty !== "boolean" || !(item.lastSyncedAt === null || isTimestamp(item.lastSyncedAt))) throw new Error("缓存的同步状态无效。");
  const data = importBackup(JSON.stringify(item.data));
  const pending = latestMerchantRuleIntents(matchingMerchantRuleIntents(data, readMerchantRuleIntents(item.pendingMerchantRules)));
  if (pending.length && !item.dirty) throw new Error("商户记忆尚未提交，缓存状态无效。");
  return { version: 1, ownerId: expectedOwner, data, baseRevision: item.baseRevision as number, dirty: item.dirty, lastSyncedAt: item.lastSyncedAt as string | null,
    ...(pending.length ? { pendingMerchantRules: pending } : {}) };
}

function parseCache(raw: string, userId: string): AccountCache {
  if (raw.length > MAX_CACHE_LENGTH) throw new Error("缓存超过本机存储上限。");
  return validateCache(JSON.parse(raw), userId);
}

export function loadAccountCache(projectUrl: string, userId: string): { cache: AccountCache | null; error?: string } {
  try {
    const raw = storage().getItem(cacheKey(projectUrl, userId));
    if (raw === null) return { cache: null };
    try { return { cache: parseCache(raw, userId) }; }
    catch { return { cache: null, error: "当前账号的本机缓存无法安全读取，原始内容已保留。请先导出，再恢复云端账目。" }; }
  } catch { return { cache: null, error: "无法读取当前账号的本机缓存，请检查浏览器存储权限。" }; }
}

export function readAccountCacheRaw(projectUrl: string, userId: string): string | null {
  return storage().getItem(cacheKey(projectUrl, userId));
}

function conflict(): StorageWriteResult {
  return { ok: false, conflict: true, error: "另一页面已更新当前账号的本机账目，本次修改未保存，请核对后重试。" };
}

function failure(error: unknown): StorageWriteResult {
  if (error instanceof DOMException && error.name === "QuotaExceededError") return { ok: false, error: "本机存储空间不足，本次修改未保存。请先导出备份。" };
  return { ok: false, error: "未能保存当前账号的本机账目，请检查存储权限并保留备份。" };
}

function serializeCache(cache: AccountCache, userId: string): string {
  const raw = JSON.stringify(validateCache(cache, userId));
  if (raw.length > MAX_CACHE_LENGTH) throw new Error("缓存超过本机存储上限。");
  return raw;
}

/** A normal write never overwrites malformed data or another tab's newer raw snapshot. */
export function saveAccountCache(projectUrl: string, userId: string, cache: AccountCache, expectedRaw?: string | null): StorageWriteResult {
  try {
    const raw = serializeCache(cache, userId);
    const key = cacheKey(projectUrl, userId);
    const local = storage();
    const current = local.getItem(key);
    if (expectedRaw !== undefined && current !== expectedRaw) return conflict();
    if (current !== null) {
      try { parseCache(current, userId); }
      catch { return { ok: false, error: "当前账号缓存无法读取，已阻止覆盖。请先导出原始内容，再选择恢复。" }; }
    }
    local.setItem(key, raw);
    return { ok: true };
  } catch (error) { return failure(error); }
}

/** Explicit recovery only: one replacement write preserves the old raw if writing fails. */
export function replaceAccountCache(projectUrl: string, userId: string, cache: AccountCache, expectedRaw: string | null): StorageWriteResult {
  try {
    const raw = serializeCache(cache, userId);
    const key = cacheKey(projectUrl, userId);
    const local = storage();
    if (local.getItem(key) !== expectedRaw) return conflict();
    local.setItem(key, raw);
    return { ok: true };
  } catch (error) { return failure(error); }
}

export function clearAccountCache(projectUrl: string, userId: string, expectedRaw?: string | null): StorageWriteResult {
  try {
    const key = cacheKey(projectUrl, userId);
    const local = storage();
    if (expectedRaw !== undefined && local.getItem(key) !== expectedRaw) return conflict();
    local.removeItem(key);
    return { ok: true };
  } catch { return { ok: false, error: "未能移除当前账号的本机缓存，请检查存储权限。" }; }
}
