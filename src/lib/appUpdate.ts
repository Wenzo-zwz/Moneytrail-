export type AppUpdatePhase = "unavailable" | "idle" | "checking" | "current" | "available" | "installing" | "error";
export type AppUpdateState = { phase: AppUpdatePhase; available: boolean; version: number; message: string };
type UpdateOperations = { check: () => Promise<boolean>; apply: (signal: AbortSignal) => Promise<void> };

export const UPDATE_CONFIRMATION = "更新会重新打开当前页面。请先保存正在填写的记录，确认尚未同步的修改已妥善保留。现在更新吗？";

export function createAppUpdater() {
  let state: AppUpdateState = { phase: "unavailable", available: false, version: 0, message: "当前环境不支持在线更新，请使用已发布的网页。" };
  let operations: UpdateOperations | null = null;
  let checking: Promise<void> | null = null;
  let applying: Promise<void> | null = null;
  let installTimer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<() => void>();
  function set(patch: Partial<AppUpdateState>) { state = { ...state, ...patch }; listeners.forEach(listener => listener()); }
  return {
    getState: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    configure(next: UpdateOperations) { operations = next; set({ phase: state.available ? "available" : "idle", message: "可主动检查网页新版本。" }); },
    announce() { set({ available: true, version: state.version + 1, phase: state.phase === "installing" || state.phase === "checking" ? state.phase : "available", message: "发现新版本，可以更新并重新打开。" }); },
    check(): Promise<void> {
      if (checking) return checking;
      if (applying || state.phase === "installing") return applying ?? Promise.resolve();
      if (!operations) return Promise.resolve();
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        set({ phase: "error", message: "当前离线，无法检查新版本。联网后请重试。" }); return Promise.resolve();
      }
      const current = operations;
      set({ phase: "checking", message: "正在检查更新…" });
      checking = Promise.resolve().then(async () => {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          const available = await Promise.race([current.check(), new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error("Update check timed out")), 20_000);
          })]);
          const hasUpdate = available || state.available;
          set({ available: hasUpdate, version: hasUpdate && !state.available ? state.version + 1 : state.version,
            phase: hasUpdate ? "available" : "current", message: hasUpdate ? "发现新版本，可以更新并重新打开。" : "当前已是最新版本。" });
        } catch { set({ phase: "error", message: "检查更新未完成，请检查网络后重试。" }); }
        finally { clearTimeout(timeout); }
      }).finally(() => { checking = null; });
      return checking;
    },
    install(): Promise<void> {
      if (applying) return applying;
      if (!operations || !state.available || checking || state.phase === "installing") return Promise.resolve();
      const current = operations;
      const controller = new AbortController();
      clearTimeout(installTimer);
      set({ phase: "installing", message: "正在更新并重新打开…" });
      const timeout = new Promise<never>((_, reject) => {
        installTimer = setTimeout(() => {
          controller.abort(); set({ phase: "error", message: "更新尚未完成，请检查网络后重试。" });
          reject(new Error("Update activation timed out"));
        }, 20_000);
      });
      applying = Promise.race([Promise.resolve().then(() => current.apply(controller.signal)), timeout]).catch(() => {
        clearTimeout(installTimer);
        controller.abort();
        set({ phase: "error", message: "更新未完成，请稍后重试。" });
      }).finally(() => { applying = null; });
      return applying;
    },
  };
}

export const appUpdater = createAppUpdater();
export const announceAppUpdate = () => appUpdater.announce();

/** update() can resolve before the new worker has finished downloading its files. */
export async function checkRegisteredUpdate(registration: ServiceWorkerRegistration): Promise<boolean> {
  await registration.update();
  const worker = registration.installing;
  if (worker) await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error("Worker install timed out")), 19_000);
    function finish(error?: Error) {
      clearTimeout(timeout); worker?.removeEventListener("statechange", changed);
      if (error) reject(error); else resolve();
    }
    function changed() {
      if (worker?.state === "redundant") finish(new Error("Worker install failed"));
      else if (worker?.state === "installed" || worker?.state === "activated") finish();
    }
    worker.addEventListener("statechange", changed); changed();
  });
  return Boolean(registration.waiting);
}

export async function requestAppUpdate(): Promise<void> {
  const state = appUpdater.getState();
  if (!state.available || state.phase === "checking" || state.phase === "installing" || !window.confirm(UPDATE_CONFIRMATION)) return;
  await appUpdater.install();
}
