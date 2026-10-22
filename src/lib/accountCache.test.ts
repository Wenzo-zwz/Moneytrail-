import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cacheKey, clearAccountCache, loadAccountCache, readAccountCacheRaw,
  replaceAccountCache, saveAccountCache, type AccountCache,
} from "./accountCache";
import { emptyData, STORAGE_KEY } from "./storage";

const project = "https://one.supabase.co";
const userA = "11111111-1111-4111-8111-111111111111";
const userB = "22222222-2222-4222-8222-222222222222";
let values: Map<string, string>;
let local: Storage;

function cache(ownerId = userA, budgetCents = 12345): AccountCache {
  return { version: 1, ownerId, data: { ...emptyData(), budgetCents }, baseRevision: 3,
    dirty: true, lastSyncedAt: "2026-10-22T10:00:00.123456+00:00" };
}

beforeEach(() => {
  values = new Map();
  local = {
    get length() { return values.size; },
    key: vi.fn((index: number) => [...values.keys()][index] ?? null),
    clear: vi.fn(() => values.clear()),
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { values.set(key, value); }),
    removeItem: vi.fn((key: string) => { values.delete(key); }),
  };
  vi.stubGlobal("localStorage", local);
});
afterEach(() => vi.unstubAllGlobals());

describe("account cache isolation", () => {
  it("never substitutes another account, project, or the legacy local ledger", () => {
    values.set(STORAGE_KEY, JSON.stringify({ ...emptyData(), budgetCents: 99999 }));
    expect(saveAccountCache(project, userA, cache(), null)).toEqual({ ok: true });
    expect(loadAccountCache(project, userA)).toEqual({ cache: cache() });
    expect(loadAccountCache(project, userB)).toEqual({ cache: null });
    expect(loadAccountCache("https://two.supabase.co", userA)).toEqual({ cache: null });
    expect(local.setItem).toHaveBeenCalledTimes(1);
    expect(cacheKey(`${project}/`, userA.toUpperCase())).toBe(cacheKey(project, userA));
  });

  it("rejects a copied cache whose internal owner differs from its key", () => {
    const raw = JSON.stringify(cache(userB));
    values.set(cacheKey(project, userA), raw);
    expect(loadAccountCache(project, userA)).toMatchObject({ cache: null, error: expect.any(String) });
    expect(saveAccountCache(project, userA, cache(), raw).ok).toBe(false);
    expect(readAccountCacheRaw(project, userA)).toBe(raw);
    expect(local.setItem).not.toHaveBeenCalled();
  });

  it.each([
    ["invalid user", project, "someone"],
    ["insecure URL", "http://one.supabase.co", userA],
    ["embedded credentials", "https://person:password@one.supabase.co", userA],
    ["path", `${project}/rest/v1`, userA],
    ["query", `${project}/?key=x`, userA],
  ])("refuses %s as a storage namespace", (_label, url, id) => {
    expect(() => cacheKey(url, id)).toThrow();
    expect(saveAccountCache(url, id, cache()).ok).toBe(false);
    expect(local.setItem).not.toHaveBeenCalled();
  });
});

describe("cache preservation and recovery", () => {
  it.each([
    "{broken", JSON.stringify({ ...cache(), baseRevision: -1 }),
    JSON.stringify({ ...cache(), lastSyncedAt: "2026-02-30T10:00:00Z" }),
    JSON.stringify({ ...cache(), data: { ...emptyData(), budgetCents: 1.5 } }),
  ])("preserves malformed cache until explicit recovery", (raw) => {
    values.set(cacheKey(project, userA), raw);
    expect(loadAccountCache(project, userA).error).toContain("已保留");
    expect(saveAccountCache(project, userA, cache(), raw)).toMatchObject({ ok: false });
    expect(readAccountCacheRaw(project, userA)).toBe(raw);
    expect(replaceAccountCache(project, userA, cache(), raw)).toEqual({ ok: true });
    expect(loadAccountCache(project, userA)).toEqual({ cache: cache() });
    expect(local.removeItem).not.toHaveBeenCalled();
    expect(local.setItem).toHaveBeenCalledTimes(1);
  });

  it("stops stale saves, recovery, and cache removal without touching newer data", () => {
    expect(saveAccountCache(project, userA, cache(), null).ok).toBe(true);
    const old = readAccountCacheRaw(project, userA);
    expect(saveAccountCache(project, userA, cache(userA, 777), old).ok).toBe(true);
    const latest = readAccountCacheRaw(project, userA);
    expect(saveAccountCache(project, userA, cache(), old)).toMatchObject({ ok: false, conflict: true });
    expect(replaceAccountCache(project, userA, cache(), old)).toMatchObject({ ok: false, conflict: true });
    expect(clearAccountCache(project, userA, old)).toMatchObject({ ok: false, conflict: true });
    expect(readAccountCacheRaw(project, userA)).toBe(latest);
    expect(local.removeItem).not.toHaveBeenCalled();
  });

  it("preserves both valid and corrupt snapshots when replacement runs out of quota", () => {
    const raw = "corrupt-but-valuable";
    values.set(cacheKey(project, userA), raw);
    vi.mocked(local.setItem).mockImplementation(() => { throw new DOMException("full", "QuotaExceededError"); });
    expect(replaceAccountCache(project, userA, cache(), raw)).toMatchObject({ ok: false, error: expect.stringContaining("空间不足") });
    expect(readAccountCacheRaw(project, userA)).toBe(raw);
    values.set(cacheKey(project, userA), JSON.stringify(cache()));
    const before = readAccountCacheRaw(project, userA);
    expect(saveAccountCache(project, userA, cache(userA, 777), before).ok).toBe(false);
    expect(readAccountCacheRaw(project, userA)).toBe(before);
    expect(local.removeItem).not.toHaveBeenCalled();
  });

  it("removes only the signed out user's current project cache", () => {
    saveAccountCache(project, userA, cache());
    saveAccountCache(project, userB, cache(userB));
    saveAccountCache("https://two.supabase.co", userA, cache());
    values.set(STORAGE_KEY, "old-local");
    expect(clearAccountCache(project, userA, readAccountCacheRaw(project, userA))).toEqual({ ok: true });
    expect(loadAccountCache(project, userA)).toEqual({ cache: null });
    expect(loadAccountCache(project, userB).cache).toEqual(cache(userB));
    expect(loadAccountCache("https://two.supabase.co", userA).cache).toEqual(cache());
    expect(values.get(STORAGE_KEY)).toBe("old-local");
  });

  it("reports blocked browser storage rather than inventing an empty persisted cache", () => {
    vi.mocked(local.getItem).mockImplementation(() => { throw new DOMException("blocked", "SecurityError"); });
    expect(loadAccountCache(project, userA)).toMatchObject({ cache: null, error: expect.any(String) });
    expect(saveAccountCache(project, userA, cache()).ok).toBe(false);
    expect(clearAccountCache(project, userA).ok).toBe(true);
    expect(local.setItem).not.toHaveBeenCalled();
  });
});
