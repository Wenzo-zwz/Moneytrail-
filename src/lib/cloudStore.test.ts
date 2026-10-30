import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cacheKey, loadAccountCache, saveAccountCache, type AccountCache } from "./accountCache";
import { CloudConflictError, type CloudSnapshot } from "./cloudClient";
import { createCloudStore, type CloudStore, type CloudTransport } from "./cloudStore";
import { emptyData, type AppData } from "./storage";

const projectUrl = "https://test-project.supabase.co";
const userId = "11111111-1111-4111-8111-111111111111";
const client = {} as SupabaseClient;
const at = "2026-10-22T12:00:00.000Z";
const data = (budgetCents = 10000): AppData => ({ ...emptyData(), budgetCents });
const remembered = { id: "remembered", kind: "expense" as const, amountCents: 2000, date: "2026-10-31T12:00", merchant: "消费抖音支付-星辰小馆", category: "本地生活", subcategory: "堂食", source: "manual" as const, note: "" };
const intent = { transactionId: remembered.id, merchant: remembered.merchant, category: remembered.category, subcategory: remembered.subcategory };
const snapshot = (budget = 10000, revision = 1): CloudSnapshot => ({ data: data(budget), revision, updatedAt: at });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (value: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
let values: Map<string, string>;
let local: Storage;
let stores: CloudStore[];
function seed(budget = 10000, revision = 1, dirty = false) {
  const cache: AccountCache = { version: 1, ownerId: userId, data: data(budget), baseRevision: revision, dirty, lastSyncedAt: at };
  expect(saveAccountCache(projectUrl, userId, cache)).toEqual({ ok: true });
  return cache;
}
function create(transport: CloudTransport, isOnline: () => boolean = () => true) {
  const store = createCloudStore({ client, userId, projectUrl, transport, isOnline });
  stores.push(store); return store;
}

beforeEach(() => {
  values = new Map(); stores = [];
  local = {
    get length() { return values.size; },
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { values.set(key, value); }),
    removeItem: vi.fn((key: string) => { values.delete(key); }),
    clear: vi.fn(() => values.clear()),
    key: vi.fn((index: number) => [...values.keys()][index] ?? null),
  };
  vi.stubGlobal("localStorage", local);
});
afterEach(() => { for (const store of stores) store.dispose(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("account cloud store", () => {
  it("durably queues explicit merchant learning with offline transactions and sends it after restart", async () => {
    seed(); const push = vi.fn(async (next: AppData, revision: number) => ({ data: next, revision: revision + 1, updatedAt: at }));
    const offline = create({ load: vi.fn(), push }, () => false);
    const next = { ...data(), transactions: [remembered] };
    expect(offline.saveData(next, data(), { merchantRules: [intent] }).ok).toBe(true);
    await settle();
    expect(loadAccountCache(projectUrl, userId).cache?.pendingMerchantRules).toEqual([intent]);
    const shown = offline.getPendingMerchantRules();
    expect(shown).toEqual([intent]); shown[0].category = "购物";
    expect(offline.getPendingMerchantRules()).toEqual([intent]);
    expect(push).not.toHaveBeenCalled(); offline.dispose();
    const restarted = create({ load: vi.fn(), push });
    await restarted.refresh();
    expect(push).toHaveBeenCalledWith(next, 1, expect.any(AbortSignal), [intent]);
    expect(loadAccountCache(projectUrl, userId).cache?.pendingMerchantRules).toBeUndefined();
    expect(restarted.getState()).toMatchObject({ dirty: false, phase: "saved" });
  });

  it("drops stale or explicitly cancelled pending learning without changing transaction edits", async () => {
    seed(); const push = vi.fn(); const store = create({ load: vi.fn(), push }, () => false);
    const first = { ...data(), transactions: [remembered] };
    expect(store.saveData(first, data(), { merchantRules: [intent] }).ok).toBe(true);
    const second = { ...first, transactions: [{ ...remembered, subcategory: "外卖" }] };
    expect(store.saveData(second, first).ok).toBe(true);
    expect(loadAccountCache(projectUrl, userId).cache?.pendingMerchantRules).toBeUndefined();
    const replacement = { ...intent, subcategory: "外卖" };
    expect(store.saveData(second, second, { merchantRules: [replacement] }).ok).toBe(true);
    expect(store.saveData(second, second, { forgetMerchantRulesFor: [remembered.id] }).ok).toBe(true);
    expect(loadAccountCache(projectUrl, userId).cache?.pendingMerchantRules).toBeUndefined();
    expect(store.loadData().data).toEqual(second);
    await settle(); expect(push).not.toHaveBeenCalled();
  });

  it("uses the latest explicit choice across channel aliases without blocking unrelated ledger saves", async () => {
    seed(); const store = create({ load: vi.fn(), push: vi.fn() }, () => false);
    const first = { ...data(), transactions: [remembered] };
    store.saveData(first, data(), { merchantRules: [intent] });
    const newer = { ...remembered, id: "newer", merchant: "财付通-星辰小馆", subcategory: "外卖" };
    const latest = { ...intent, transactionId: newer.id, merchant: newer.merchant, subcategory: newer.subcategory };
    const second = { ...first, transactions: [remembered, newer] };
    expect(store.saveData(second, first, { merchantRules: [latest] }).ok).toBe(true);
    expect(loadAccountCache(projectUrl, userId).cache?.pendingMerchantRules).toEqual([latest]);
    expect(store.loadData().data.transactions).toEqual([remembered, newer]);
  });

  it("keeps a newer merchant learning choice when an older push is acknowledged", async () => {
    seed(); const flight = deferred<CloudSnapshot>(); const followup = deferred<CloudSnapshot>();
    const push = vi.fn().mockReturnValueOnce(flight.promise).mockReturnValueOnce(followup.promise);
    const store = create({ load: vi.fn(), push });
    const first = { ...data(), transactions: [remembered] };
    store.saveData(first, data(), { merchantRules: [intent] }); await settle();
    const newer = { ...first, transactions: [{ ...remembered, subcategory: "外卖" }] };
    const latestIntent = { ...intent, subcategory: "外卖" };
    store.saveData(newer, first, { merchantRules: [latestIntent] });
    flight.resolve({ data: first, revision: 2, updatedAt: at }); await settle();
    expect(push).toHaveBeenNthCalledWith(2, newer, 2, expect.any(AbortSignal), [latestIntent]);
    expect(loadAccountCache(projectUrl, userId).cache?.pendingMerchantRules).toEqual([latestIntent]);
    followup.resolve({ data: newer, revision: 3, updatedAt: at }); await settle();
    expect(loadAccountCache(projectUrl, userId).cache?.pendingMerchantRules).toBeUndefined();
  });

  it("does not queue learning after failed storage and never publishes mismatched intents", async () => {
    seed(); const store = create({ load: vi.fn(), push: vi.fn() }, () => false);
    const next = { ...data(), transactions: [remembered] };
    expect(store.saveData(next, data(), { merchantRules: [{ ...intent, category: "购物" }] }).ok).toBe(false);
    expect(store.loadData().data).toEqual(data());
    vi.mocked(local.setItem).mockImplementation(() => { throw new DOMException("full", "QuotaExceededError"); });
    expect(store.saveData(next, data(), { merchantRules: [intent] }).ok).toBe(false);
    expect(loadAccountCache(projectUrl, userId).cache?.pendingMerchantRules).toBeUndefined();
  });

  it("retains learning on CAS conflict and discards it when explicitly adopting cloud data", async () => {
    seed(); const push = vi.fn().mockRejectedValue(new CloudConflictError());
    const store = create({ load: vi.fn().mockResolvedValue(snapshot(30000, 2)), push }, () => false);
    store.saveData({ ...data(), transactions: [remembered] }, data(), { merchantRules: [intent] });
    // Reopen online so the dirty cache is submitted with its original CAS revision.
    store.dispose(); const restarted = create({ load: vi.fn().mockResolvedValue(snapshot(30000, 2)), push });
    await restarted.refresh();
    expect(loadAccountCache(projectUrl, userId).cache?.pendingMerchantRules).toEqual([intent]);
    await restarted.resolveConflict("cloud");
    expect(loadAccountCache(projectUrl, userId).cache?.pendingMerchantRules).toBeUndefined();
    expect(restarted.loadData().data).toEqual(data(30000));
  });
  it("requires a first cloud read before accepting edits and only reads this account's cache", async () => {
    const load = deferred<CloudSnapshot>();
    const push = vi.fn();
    const store = create({ load: () => load.promise, push });
    expect(store.getState().ready).toBe(false);
    expect(store.saveData(data()).ok).toBe(false);
    const refresh = store.refresh();
    expect(store.getState().phase).toBe("syncing");
    load.resolve(snapshot()); await refresh;
    expect(store.loadData().data).toEqual(data());
    expect(store.getState()).toMatchObject({ ready: true, dirty: false, phase: "saved" });
    expect(loadAccountCache(projectUrl, userId).cache?.baseRevision).toBe(1);
    expect(push).not.toHaveBeenCalled();
  });

  it("saves offline edits durably, then syncs using their original cloud revision", async () => {
    seed(); let online = false;
    const load = vi.fn(); const push = vi.fn(async (next: AppData, revision: number) => ({ data: next, revision: revision + 1, updatedAt: at }));
    const store = create({ load, push }, () => online);
    const before = store.loadData().data;
    expect(store.saveData(data(25000), before)).toEqual({ ok: true });
    await settle();
    expect(store.getState()).toMatchObject({ phase: "offline", dirty: true });
    expect(loadAccountCache(projectUrl, userId).cache).toMatchObject({ data: data(25000), dirty: true, baseRevision: 1 });
    expect(push).not.toHaveBeenCalled();
    online = true; await store.refresh();
    expect(push).toHaveBeenCalledWith(data(25000), 1, expect.any(AbortSignal));
    expect(store.getState()).toMatchObject({ phase: "saved", dirty: false });
    expect(loadAccountCache(projectUrl, userId).cache?.baseRevision).toBe(2);
  });

  it("never claims a failed local write succeeded or uploads the unsaved edit", async () => {
    seed(); const oldRaw = values.get(cacheKey(projectUrl, userId));
    const push = vi.fn(); const store = create({ load: vi.fn(), push });
    vi.mocked(local.setItem).mockImplementation(() => { throw new DOMException("full", "QuotaExceededError"); });
    expect(store.saveData(data(90000), data())).toMatchObject({ ok: false });
    await settle();
    expect(store.loadData().data).toEqual(data());
    expect(values.get(cacheKey(projectUrl, userId))).toBe(oldRaw);
    expect(push).not.toHaveBeenCalled();
  });

  it("keeps the current edit when a push acknowledgement arrives for an older edit", async () => {
    seed(); const first = deferred<CloudSnapshot>(); const second = deferred<CloudSnapshot>();
    const push = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const store = create({ load: vi.fn(), push });
    expect(store.saveData(data(20000), data()).ok).toBe(true); await settle();
    expect(push).toHaveBeenCalledTimes(1);
    expect(store.saveData(data(30000), data(20000)).ok).toBe(true);
    first.resolve(snapshot(20000, 2)); await settle();
    expect(store.loadData().data).toEqual(data(30000));
    expect(loadAccountCache(projectUrl, userId).cache).toMatchObject({ data: data(30000), dirty: true, baseRevision: 2 });
    expect(push).toHaveBeenNthCalledWith(2, data(30000), 2, expect.any(AbortSignal));
    second.resolve(snapshot(30000, 3)); await settle();
    expect(store.getState()).toMatchObject({ dirty: false, phase: "saved" });
    expect(store.loadData().data).toEqual(data(30000));
  });

  it("preserves pending local data when another device wins the cloud CAS", async () => {
    seed(20000, 1, true);
    const push = vi.fn().mockRejectedValue(new CloudConflictError());
    const load = vi.fn().mockResolvedValue(snapshot(40000, 2));
    const store = create({ load, push });
    await store.refresh();
    expect(store.getState()).toMatchObject({ phase: "conflict", dirty: true });
    expect(store.loadData().data).toEqual(data(20000));
    await store.refresh(); await store.retry();
    expect(push).toHaveBeenCalledTimes(1);
    expect(load).not.toHaveBeenCalled();
  });

  it("can explicitly adopt the cloud version after a conflict", async () => {
    seed(20000, 1, true);
    const push = vi.fn().mockRejectedValue(new CloudConflictError());
    const load = vi.fn().mockResolvedValue(snapshot(40000, 2));
    const store = create({ load, push }); const changed = vi.fn(); store.subscribe(changed);
    await store.refresh(); await store.resolveConflict("cloud");
    expect(store.loadData().data).toEqual(data(40000));
    expect(store.getState()).toMatchObject({ phase: "saved", dirty: false });
    expect(loadAccountCache(projectUrl, userId).cache?.baseRevision).toBe(2);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledTimes(1);
  });

  it("retains the original CAS baseline after further edits to a conflicted pull, including after reload", async () => {
    seed();
    const pull = deferred<CloudSnapshot>();
    const store = create({ load: () => pull.promise, push: vi.fn() });
    const pending = store.refresh();
    expect(store.saveData(data(20000), data()).ok).toBe(true);
    pull.resolve(snapshot(40000, 2)); await pending;
    expect(store.getState().phase).toBe("conflict");
    expect(store.saveData(data(25000), data(20000)).ok).toBe(true);
    expect(loadAccountCache(projectUrl, userId).cache?.baseRevision).toBe(1);
    store.dispose();
    const push = vi.fn().mockRejectedValue(new CloudConflictError());
    const reloaded = create({ load: vi.fn(), push }); await reloaded.refresh();
    expect(push).toHaveBeenCalledWith(data(25000), 1, expect.any(AbortSignal));
    expect(reloaded.getState().phase).toBe("conflict");
  });

  it("can explicitly submit the retained local version with the latest cloud CAS", async () => {
    seed(20000, 1, true);
    const push = vi.fn().mockRejectedValueOnce(new CloudConflictError()).mockResolvedValueOnce(snapshot(20000, 3));
    const load = vi.fn().mockResolvedValue(snapshot(40000, 2));
    const store = create({ load, push });
    await store.refresh(); await store.resolveConflict("local"); await settle();
    expect(push).toHaveBeenNthCalledWith(2, data(20000), 2, expect.any(AbortSignal));
    expect(store.getState()).toMatchObject({ phase: "saved", dirty: false });
    expect(store.loadData().data).toEqual(data(20000));
  });

  it("does not discard an edit made while the confirmed cloud replacement is being fetched", async () => {
    seed(20000, 1, true);
    const request = deferred<CloudSnapshot>();
    const push = vi.fn().mockRejectedValue(new CloudConflictError());
    const load = vi.fn().mockReturnValue(request.promise);
    const store = create({ load, push });
    await store.refresh(); const resolving = store.resolveConflict("cloud"); await settle();
    expect(store.saveData(data(35000), data(20000)).ok).toBe(true);
    const concurrent = store.refresh();
    request.resolve(snapshot(40000, 2)); await resolving; await concurrent;
    expect(load).toHaveBeenCalledTimes(1);
    expect(store.loadData().data).toEqual(data(35000));
    expect(store.getState()).toMatchObject({ phase: "conflict", dirty: true });
    expect(push).toHaveBeenCalledTimes(1);
  });

  it("serializes competing conflict resolution choices", async () => {
    seed(20000, 1, true);
    const request = deferred<CloudSnapshot>();
    const load = vi.fn().mockReturnValue(request.promise);
    const push = vi.fn().mockRejectedValue(new CloudConflictError());
    const store = create({ load, push }); await store.refresh();
    const a = store.resolveConflict("cloud"); const b = store.resolveConflict("local");
    request.resolve(snapshot(40000, 2)); await a; await b;
    expect(load).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledTimes(1);
    expect(store.loadData().data).toEqual(data(40000));
  });

  it("ignores an account's late response after disposal and aborts its request", async () => {
    const request = deferred<CloudSnapshot>();
    let signal!: AbortSignal;
    const store = create({ load: (arg) => { signal = arg; return request.promise; }, push: vi.fn() });
    const change = vi.fn(); store.subscribe(change);
    const pending = store.refresh(); store.dispose();
    expect(signal.aborted).toBe(true);
    request.resolve(snapshot(90000)); await pending;
    expect(values.has(cacheKey(projectUrl, userId))).toBe(false);
    expect(change).not.toHaveBeenCalled();
    expect(store.saveData(data()).ok).toBe(false);
  });

  it("does not repopulate an explicitly cleared account cache from an outstanding request", async () => {
    seed(); const request = deferred<CloudSnapshot>();
    const store = create({ load: () => request.promise, push: vi.fn() });
    const pending = store.refresh();
    expect(store.clearCache()).toEqual({ ok: true });
    request.resolve(snapshot(90000, 2)); await pending;
    expect(values.has(cacheKey(projectUrl, userId))).toBe(false);
    expect(store.saveData(data()).ok).toBe(false);
  });

  it("invalidates another tab immediately when logout removes the shared account cache", async () => {
    seed();
    const target = new EventTarget(); vi.stubGlobal("window", target);
    const request = deferred<CloudSnapshot>();
    let signal!: AbortSignal;
    const load = vi.fn((next: AbortSignal) => { signal = next; return request.promise; });
    const store = create({ load, push: vi.fn() }); store.start();
    const key = cacheKey(projectUrl, userId); values.delete(key);
    target.dispatchEvent(Object.assign(new Event("storage"), { key, newValue: null }));
    expect(store.getState()).toMatchObject({ ready: false, dirty: false, phase: "error" });
    expect(signal.aborted).toBe(true);
    request.resolve(snapshot(90000, 2)); await settle(); await store.refresh();
    expect(load).toHaveBeenCalledTimes(1);
    expect(values.has(key)).toBe(false);
    expect(store.loadData().data).toEqual(emptyData());
  });

  it("adopts a newer tab's pending edits before a repeated explicit logout attempt", () => {
    seed(); const store = create({ load: vi.fn(), push: vi.fn() }, () => false);
    seed(70000, 2, true);
    expect(store.clearCache()).toMatchObject({ ok: false, conflict: true });
    expect(store.getState().dirty).toBe(true);
    expect(store.loadData().data.budgetCents).toBe(70000);
    expect(store.clearCache()).toEqual({ ok: true });
    expect(values.has(cacheKey(projectUrl, userId))).toBe(false);
  });

  it("does not overwrite a newer clean cache from another page with an older pull response", async () => {
    seed(); const request = deferred<CloudSnapshot>();
    const store = create({ load: () => request.promise, push: vi.fn() });
    const refresh = store.refresh();
    seed(70000, 3, false);
    request.resolve(snapshot(20000, 2)); await refresh;
    expect(store.loadData().data).toEqual(data(70000));
    expect(loadAccountCache(projectUrl, userId).cache?.baseRevision).toBe(3);
    expect(store.getState()).toMatchObject({ phase: "saved", dirty: false });
  });

  it("rejects a stale page edit after another page has changed this account's cache", () => {
    seed(); const store = create({ load: vi.fn(), push: vi.fn() }, () => false);
    seed(70000, 2, true);
    expect(store.saveData(data(20000), data())).toMatchObject({ ok: false, conflict: true });
    expect(store.loadData().data).toEqual(data(70000));
    expect(loadAccountCache(projectUrl, userId).cache?.data).toEqual(data(70000));
  });

  it("does not overwrite corruption on a normal load, but permits explicit cloud recovery", async () => {
    const key = cacheKey(projectUrl, userId); values.set(key, "broken but retained");
    const load = vi.fn().mockResolvedValue(snapshot(80000, 4));
    const store = create({ load, push: vi.fn() });
    expect(store.loadData().error).toContain("原始内容已保留");
    await store.refresh();
    expect(values.get(key)).toBe("broken but retained");
    expect(store.saveData(data()).ok).toBe(false);
    await store.resolveConflict("cloud");
    expect(store.loadData()).toEqual({ data: data(80000), error: undefined });
    expect(store.getState()).toMatchObject({ phase: "saved", ready: true, dirty: false });
  });

  it("requires a known cloud revision for explicit backup recovery and retains corrupt bytes on failed recovery", async () => {
    const key = cacheKey(projectUrl, userId); values.set(key, "preserve me");
    const store = create({ load: vi.fn().mockResolvedValue(snapshot(80000, 4)), push: vi.fn() }, () => false);
    expect(store.restoreData(data(30000), "preserve me").ok).toBe(false);
    expect(values.get(key)).toBe("preserve me");
    // A second store learns the revision through a safe read, without replacing corruption.
    const onlineStore = create({ load: vi.fn().mockResolvedValue(snapshot(80000, 4)), push: vi.fn() });
    await onlineStore.refresh();
    vi.mocked(local.setItem).mockImplementation(() => { throw new DOMException("full", "QuotaExceededError"); });
    expect(onlineStore.restoreData(data(30000), "preserve me").ok).toBe(false);
    expect(values.get(key)).toBe("preserve me");
  });

  it("keeps local edits intact after a temporary network error and retries on demand", async () => {
    seed(20000, 1, true);
    const push = vi.fn().mockRejectedValueOnce(new Error("network unavailable")).mockResolvedValueOnce(snapshot(20000, 2));
    const store = create({ load: vi.fn(), push });
    await store.refresh();
    expect(store.getState()).toMatchObject({ phase: "error", dirty: true });
    expect(store.loadData().data).toEqual(data(20000));
    await store.retry();
    expect(store.getState()).toMatchObject({ phase: "saved", dirty: false });
  });

  it("returns ledger snapshots that cannot mutate the store without a save", () => {
    seed(); const store = create({ load: vi.fn(), push: vi.fn() });
    store.loadData().data.budgetCents = 99999;
    expect(store.loadData().data.budgetCents).toBe(10000);
    expect(loadAccountCache(projectUrl, userId).cache?.data.budgetCents).toBe(10000);
  });
});
