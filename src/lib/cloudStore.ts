import type { SupabaseClient } from "@supabase/supabase-js";
import { emptyData, importBackup, type AppData, type StorageWriteResult } from "./storage";
import { cacheKey, clearAccountCache, loadAccountCache, readAccountCacheRaw, replaceAccountCache, saveAccountCache, type AccountCache } from "./accountCache";
import { CloudConflictError, fetchCloudLedger, pushCloudLedger, type CloudSnapshot } from "./cloudClient";
import type { MerchantRuleIntent } from "./merchantClassification";
import { latestMerchantRuleIntents, matchingMerchantRuleIntents, readMerchantRuleIntents, sameMerchantRuleIntent } from "./merchantRuleIntents";

export type LedgerSaveOptions = { merchantRules?: MerchantRuleIntent[]; forgetMerchantRulesFor?: string[] };

export interface LedgerStore {
  loadData(): { data: AppData; error?: string };
  saveData(data: AppData, expected?: AppData, options?: LedgerSaveOptions): StorageWriteResult;
  restoreData(data: AppData, expectedRaw: string | null): StorageWriteResult;
  readStoredRaw(): string | null;
  subscribe(listener: () => void): () => void;
}
export type SyncPhase = "loading" | "saved" | "pending" | "offline" | "syncing" | "conflict" | "error";
export interface CloudStoreState {
  phase: SyncPhase;
  ready: boolean;
  dirty: boolean;
  message: string;
  lastSyncedAt: string | null;
  recoveryError?: string;
}
export interface CloudTransport {
  load(signal: AbortSignal): Promise<CloudSnapshot>;
  push(data: AppData, revision: number, signal: AbortSignal, merchantRules?: MerchantRuleIntent[]): Promise<CloudSnapshot>;
}
export interface CloudStore extends LedgerStore {
  getState(): CloudStoreState;
  getPendingMerchantRules(): MerchantRuleIntent[];
  subscribeState(listener: () => void): () => void;
  start(): void;
  refresh(): Promise<void>;
  retry(): Promise<void>;
  resolveConflict(choice: "cloud" | "local"): Promise<void>;
  clearCache(): StorageWriteResult;
  dispose(): void;
}

const clean = (data: AppData) => importBackup(JSON.stringify(data));
const same = (a: AppData, b: AppData) => JSON.stringify(clean(a)) === JSON.stringify(clean(b));
const failure = (message: string): StorageWriteResult => ({ ok: false, error: message });

export function createCloudStore({ client, userId, projectUrl, isOnline = () => typeof navigator === "undefined" || navigator.onLine, transport }: {
  client: SupabaseClient;
  userId: string;
  projectUrl: string;
  isOnline?: () => boolean;
  transport?: CloudTransport;
}): CloudStore {
  const io = transport ?? {
    load: (signal: AbortSignal) => fetchCloudLedger(client, userId, signal),
    push: (data: AppData, revision: number, signal: AbortSignal, merchantRules?: MerchantRuleIntent[]) => pushCloudLedger(client, data, revision, userId, signal, merchantRules),
  };
  const loaded = loadAccountCache(projectUrl, userId);
  let cache: AccountCache | null = loaded.cache;
  let raw: string | null = null;
  try { raw = readAccountCacheRaw(projectUrl, userId); } catch { /* loadAccountCache reports access errors. */ }
  let knownRevision: number | null = cache?.baseRevision ?? null;
  let state: CloudStoreState = {
    phase: loaded.error ? "error" : cache ? (cache.dirty ? "pending" : "saved") : "loading",
    ready: Boolean(cache), dirty: cache?.dirty ?? false,
    message: loaded.error ?? (cache?.dirty ? "本机修改等待同步" : cache ? "已读取本机账户副本" : "正在读取当前账户账本"),
    lastSyncedAt: cache?.lastSyncedAt ?? null,
    recoveryError: loaded.error,
  };
  const dataListeners = new Set<() => void>();
  const stateListeners = new Set<() => void>();
  let disposed = false; let started = false; let flight: Promise<void> | null = null;
  let resolution: Promise<void> | null = null;
  let controller: AbortController | null = null; let poll: ReturnType<typeof setInterval> | undefined;
  const emitData = () => { if (!disposed) for (const listener of dataListeners) listener(); };
  function setState(patch: Partial<CloudStoreState>) {
    if (disposed) return;
    state = { ...state, ...patch, dirty: cache?.dirty ?? false, lastSyncedAt: cache?.lastSyncedAt ?? state.lastSyncedAt };
    for (const listener of stateListeners) listener();
  }
  function adoptExternal(): boolean {
    let actual: string | null;
    try { actual = readAccountCacheRaw(projectUrl, userId); } catch { setState({ phase: "error", message: "无法读取本机账户副本，请检查存储权限。" }); return false; }
    if (actual === raw) return false;
    if (actual === null) { invalidateCache(); return true; }
    const conflictedRevision = state.phase === "conflict" ? cache?.baseRevision : undefined;
    raw = actual; const latest = loadAccountCache(projectUrl, userId);
    cache = latest.cache; knownRevision = cache?.baseRevision ?? null;
    // A new local edit cannot resolve a conflict against the same cloud baseline.
    const conflict = conflictedRevision !== undefined && cache?.dirty && cache.baseRevision <= conflictedRevision;
    setState({ ready: Boolean(cache), recoveryError: latest.error, phase: latest.error ? "error" : conflict ? "conflict" : cache?.dirty ? "pending" : "loading", message: latest.error ?? (conflict ? "本机修改已保留，请先核对同步冲突" : "另一页面已更新当前账本") });
    emitData(); return true;
  }
  function invalidateCache() {
    cache = null; raw = null; knownRevision = null;
    setState({ ready: false, recoveryError: undefined, phase: "error", message: "另一页面已移除此账户的本机副本。请重新登录或重新打开应用。" });
    emitData(); dispose();
  }
  function write(next: AccountCache, recovery = false): StorageWriteResult {
    if (disposed) return failure("账户已关闭，本次修改未保存。");
    // Keep the exact canonical bytes we wrote. A second storage read can fail after
    // a successful write, or observe another tab's edit and incorrectly adopt it
    // as the expected bytes for this tab's older in-memory ledger.
    const pending = latestMerchantRuleIntents(matchingMerchantRuleIntents(next.data, readMerchantRuleIntents(next.pendingMerchantRules)));
    const canonical: AccountCache = { version: 1, ownerId: userId.toLowerCase(), data: clean(next.data), baseRevision: next.baseRevision, dirty: next.dirty, lastSyncedAt: next.lastSyncedAt,
      ...(pending.length ? { pendingMerchantRules: pending } : {}) };
    const result = recovery ? replaceAccountCache(projectUrl, userId, canonical, raw) : saveAccountCache(projectUrl, userId, canonical, raw);
    if (!result.ok) { if (result.conflict) adoptExternal(); setState({ phase: "error", message: result.error ?? "本机副本未能保存" }); return result; }
    cache = canonical; raw = JSON.stringify(canonical); knownRevision = canonical.baseRevision;
    setState({ ready: true, recoveryError: undefined }); return result;
  }
  function localWrite(data: AppData, expected?: AppData, recoveryRaw?: string | null, options?: LedgerSaveOptions): StorageWriteResult {
    if (disposed) return failure("账户已关闭，请重新登录。");
    if (recoveryRaw !== undefined) {
      let actual: string | null; try { actual = readAccountCacheRaw(projectUrl, userId); } catch { return failure("无法读取本机账户副本。"); }
      if (actual !== recoveryRaw) { adoptExternal(); return { ok: false, conflict: true, error: "另一页面已更新账本，请重新核对后恢复。" }; }
      if (knownRevision === null) return failure("首次恢复需要联网读取当前账户的云端版本，请先重试连接。");
      raw = actual;
    } else {
      if (adoptExternal()) return { ok: false, conflict: true, error: "另一页面已更新账本，本次修改未保存。" };
      if (!state.ready || state.recoveryError || !cache) return failure("账本尚未安全加载，请先恢复或重试连接。");
    }
    try {
      const nextData = clean(data);
      if (expected && cache && !same(expected, cache.data)) return { ok: false, conflict: true, error: "账本已经更新，本次修改未保存。" };
      const incomingRules = readMerchantRuleIntents(options?.merchantRules);
      if (matchingMerchantRuleIntents(nextData, incomingRules).length !== incomingRules.length) return failure("商户分类已改变，请重新确认后保存。");
      const forget = options?.forgetMerchantRulesFor ?? [];
      if (!Array.isArray(forget) || forget.length > 200 || forget.some(id => typeof id !== "string" || !id || id.length > 200)) return failure("商户记忆选择无效，请重新打开账目。");
      const replaced = new Set([...forget, ...incomingRules.map(rule => rule.transactionId)]);
      const pending = readMerchantRuleIntents(latestMerchantRuleIntents([
        ...(recoveryRaw === undefined ? matchingMerchantRuleIntents(nextData, cache?.pendingMerchantRules ?? []).filter(rule => !replaced.has(rule.transactionId)) : []),
        ...incomingRules,
      ]));
      // An observed remote revision is not an accepted merge baseline. In a
      // conflict, ordinary edits must retain the old CAS revision, including
      // across reloads, until the user explicitly resolves the conflict.
      const result = write({ version: 1, ownerId: userId.toLowerCase(), data: nextData, baseRevision: cache?.baseRevision ?? knownRevision ?? 0, dirty: true, lastSyncedAt: cache?.lastSyncedAt ?? null,
        ...(pending.length ? { pendingMerchantRules: pending } : {}) }, recoveryRaw !== undefined);
      if (!result.ok) return result;
      const conflict = state.phase === "conflict";
      setState({ phase: conflict ? "conflict" : isOnline() ? "pending" : "offline", message: conflict ? "本机修改已保留，请先核对同步冲突" : pending.length ? "账目与商户记忆已保存在本机，联网同步后生效" : isOnline() ? "本机已保存，等待云端确认" : "本机已保存，联网后同步" });
      if (!conflict) queueMicrotask(() => void refresh());
      return { ok: true };
    } catch { return failure("账目格式无效，本次修改未保存。"); }
  }
  async function cycle() {
    if (disposed || state.phase === "conflict") return;
    if (!isOnline()) { setState({ phase: "offline", message: cache ? "当前离线，本机修改将在联网后同步" : "首次读取账户账本需要联网" }); return; }
    adoptExternal(); if (disposed) return;
    controller = new AbortController(); const signal = controller.signal;
    setState({ phase: "syncing", message: "正在核对云端账目" });
    try {
      if (cache?.dirty && !state.recoveryError) {
        const sent = clean(cache.data); const revision = cache.baseRevision;
        const sentRules = matchingMerchantRuleIntents(sent, cache.pendingMerchantRules ?? []);
        const snapshot = await (sentRules.length ? io.push(sent, revision, signal, sentRules) : io.push(sent, revision, signal));
        if (disposed || signal.aborted) return;
        adoptExternal(); if (!cache || state.recoveryError) return;
        // A newer write in this tab or another tab survives an older request's response.
        if (cache.baseRevision > snapshot.revision) return;
        const remaining = matchingMerchantRuleIntents(cache.data, cache.pendingMerchantRules ?? []).filter(rule => !sentRules.some(sentRule => sameMerchantRuleIntent(rule, sentRule)));
        const stillDirty = !same(cache.data, sent) || remaining.length > 0;
        const { pendingMerchantRules: _pending, ...rest } = cache;
        const result = write({ ...rest, data: cache.data, baseRevision: snapshot.revision, dirty: stillDirty, lastSyncedAt: snapshot.updatedAt ?? new Date().toISOString(),
          ...(remaining.length ? { pendingMerchantRules: remaining } : {}) });
        if (result.ok) setState({ phase: stillDirty ? "pending" : "saved", message: stillDirty ? "新修改等待下一次同步" : sentRules.length ? "账目与商户记忆已同步至云端" : "已同步至云端" });
      } else {
        const snapshot = await io.load(signal);
        if (disposed || signal.aborted) return;
        adoptExternal(); knownRevision = snapshot.revision;
        if (state.recoveryError) { setState({ phase: "error", message: "云端版本已读取，请导出原始缓存后选择恢复。" }); return; }
        if (cache && snapshot.revision < cache.baseRevision) {
          knownRevision = cache.baseRevision;
          setState({ phase: cache.dirty ? "pending" : "saved", message: "已保留另一页面较新的账本版本" }); return;
        }
        if (cache?.dirty) {
          if (snapshot.revision !== cache.baseRevision) setState({ phase: "conflict", message: "另一设备也修改了账本，本机内容已保留，请选择要保留的版本。" });
          else setState({ phase: "pending", message: "本机新修改等待同步" });
          return;
        }
        const changed = !cache || !same(cache.data, snapshot.data);
        const result = write({ version: 1, ownerId: userId.toLowerCase(), data: snapshot.data, baseRevision: snapshot.revision, dirty: false, lastSyncedAt: snapshot.updatedAt ?? new Date().toISOString() });
        if (result.ok) { setState({ phase: "saved", message: "已同步至云端" }); if (changed) emitData(); }
      }
    } catch (error) {
      if (disposed || signal.aborted) return;
      setState({ phase: error instanceof CloudConflictError ? "conflict" : isOnline() ? "error" : "offline", message: error instanceof Error ? error.message : "同步未完成，本机修改已保留。" });
    }
  }
  async function refresh(): Promise<void> {
    if (disposed) return;
    if (resolution) return resolution;
    if (flight) return flight;
    flight = cycle().finally(() => {
      flight = null; controller = null;
      if (!disposed && !resolution && cache?.dirty && state.phase === "pending" && isOnline()) queueMicrotask(() => void refresh());
    });
    return flight;
  }
  const onWake = () => void refresh();
  const onVisibilityChange = () => { if (document.visibilityState === "visible") void refresh(); };
  const onStorage = (event: StorageEvent) => {
    if (event.key === cacheKey(projectUrl, userId) || event.key === null) {
      try {
        if (readAccountCacheRaw(projectUrl, userId) === null) { invalidateCache(); return; }
      } catch { /* adoptExternal reports a storage access failure. */ }
      adoptExternal(); void refresh();
    }
  };
  function dispose() {
    disposed = true; controller?.abort(); clearInterval(poll);
    if (typeof window !== "undefined") { window.removeEventListener("online", onWake); window.removeEventListener("focus", onWake); window.removeEventListener("storage", onStorage); }
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibilityChange);
    dataListeners.clear(); stateListeners.clear();
  }
  return {
    loadData: () => ({ data: cache ? clean(cache.data) : emptyData(), error: state.recoveryError }),
    saveData: (data, expected, options) => localWrite(data, expected, undefined, options),
    restoreData: (data, expectedRaw) => localWrite(data, undefined, expectedRaw),
    readStoredRaw: () => readAccountCacheRaw(projectUrl, userId),
    subscribe(listener) { dataListeners.add(listener); return () => { dataListeners.delete(listener); }; },
    getState: () => state,
    getPendingMerchantRules: () => disposed ? [] : readMerchantRuleIntents(cache?.pendingMerchantRules),
    subscribeState(listener) { stateListeners.add(listener); return () => { stateListeners.delete(listener); }; },
    start() {
      if (started || disposed) return; started = true;
      if (typeof window !== "undefined") { window.addEventListener("online", onWake); window.addEventListener("focus", onWake); window.addEventListener("storage", onStorage); }
      if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibilityChange);
      poll = setInterval(() => { if (typeof document === "undefined" || document.visibilityState === "visible") void refresh(); }, 30_000);
      void refresh();
    },
    refresh,
    retry: async () => { if (state.phase === "conflict") return; setState({ phase: "pending" }); await refresh(); },
    resolveConflict(choice) {
      if (disposed) return Promise.resolve();
      if (resolution) return resolution;
      const confirmedRaw = raw;
      resolution = (async () => {
        // A resolution is one serialized operation. Focus, polling and a second
        // button press must not start a competing read or push while it runs.
        if (flight) await flight;
        if (disposed) return;
        if (adoptExternal() || raw !== confirmedRaw) {
          setState({ phase: "conflict", message: "账本在确认后又有修改，请重新核对两个版本。" }); return;
        }
        controller = new AbortController(); const signal = controller.signal;
        setState({ phase: "syncing", message: "正在重新核对两个版本" });
        try {
          const snapshot = await io.load(signal); if (disposed || signal.aborted) return;
          if (adoptExternal() || raw !== confirmedRaw) {
            setState({ phase: "conflict", message: "账本在确认后又有修改，本机内容已保留，请重新选择。" }); return;
          }
          if (choice === "local" && !cache) throw new Error("本机版本无法安全读取，请恢复云端版本。");
          const data = choice === "cloud" ? snapshot.data : cache!.data;
          const pending = choice === "local" ? matchingMerchantRuleIntents(data, cache?.pendingMerchantRules ?? []) : [];
          const result = write({ version: 1, ownerId: userId.toLowerCase(), data, baseRevision: snapshot.revision, dirty: choice === "local", lastSyncedAt: snapshot.updatedAt,
            ...(pending.length ? { pendingMerchantRules: pending } : {}) }, true);
          if (!result.ok) return;
          setState({ phase: choice === "cloud" ? "saved" : "pending", message: choice === "cloud" ? "已采用云端版本" : "正在提交你确认的本机版本" }); emitData();
        } catch (error) { if (!disposed && !signal.aborted) setState({ phase: error instanceof CloudConflictError ? "conflict" : "error", message: error instanceof Error ? error.message : "恢复未完成" }); }
      })().finally(() => {
        resolution = null; controller = null;
        if (!disposed && cache?.dirty && state.phase === "pending" && isOnline()) queueMicrotask(() => void refresh());
      });
      return resolution;
    },
    clearCache() {
      const result = clearAccountCache(projectUrl, userId, raw);
      if (result.ok) { dispose(); cache = null; raw = null; }
      else if (result.conflict) adoptExternal();
      return result;
    },
    dispose,
  };
}
