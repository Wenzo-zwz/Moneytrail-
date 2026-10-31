import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkRegisteredUpdate, createAppUpdater } from "./appUpdate";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

beforeEach(() => { vi.stubGlobal("navigator", { onLine: true }); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("shared app updater", () => {
  it("stays unavailable until operations are configured and notifies only active subscribers", async () => {
    const updater = createAppUpdater(); const changed = vi.fn(); const unsubscribe = updater.subscribe(changed);
    const initial = updater.getState(); await updater.check(); await updater.install();
    expect(updater.getState()).toBe(initial);
    updater.configure({ check: vi.fn(), apply: vi.fn() });
    expect(updater.getState()).toMatchObject({ phase: "idle", available: false });
    expect(changed).toHaveBeenCalledTimes(1);
    unsubscribe(); updater.announce();
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("shares a concurrent check and retains an update announced while it is running", async () => {
    const result = deferred<boolean>(); const check = vi.fn(() => result.promise);
    const updater = createAppUpdater(); updater.configure({ check, apply: vi.fn() });
    const first = updater.check(); const second = updater.check();
    expect(first).toBe(second); expect(updater.getState().phase).toBe("checking");
    await settle(); expect(check).toHaveBeenCalledTimes(1);
    updater.announce(); result.resolve(false); await first;
    expect(updater.getState()).toMatchObject({ phase: "available", available: true, version: 1 });
  });

  it("keeps an announced update checking until the in-flight check settles", async () => {
    const result = deferred<boolean>(); const apply = vi.fn();
    const updater = createAppUpdater(); updater.configure({ check: () => result.promise, apply });
    const checking = updater.check(); await settle(); updater.announce();
    expect(updater.getState()).toMatchObject({ phase: "checking", available: true });
    void updater.install(); await settle(); expect(apply).not.toHaveBeenCalled();
    result.resolve(false); await checking;
    expect(updater.getState()).toMatchObject({ phase: "available", available: true });
  });

  it("reports offline checks as an error and retries after reconnecting", async () => {
    const connection = { onLine: false }; vi.stubGlobal("navigator", connection);
    const check = vi.fn(async () => false); const updater = createAppUpdater(); updater.configure({ check, apply: vi.fn() });
    await updater.check();
    expect(updater.getState()).toMatchObject({ phase: "error", available: false });
    expect(check).not.toHaveBeenCalled();
    connection.onLine = true; await updater.check();
    expect(updater.getState()).toMatchObject({ phase: "current", available: false });
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("keeps a known update available after a failed check and permits retry", async () => {
    const check = vi.fn().mockRejectedValueOnce(new Error("network")).mockResolvedValueOnce(false);
    const updater = createAppUpdater(); updater.configure({ check, apply: vi.fn() }); updater.announce();
    await updater.check(); expect(updater.getState()).toMatchObject({ phase: "error", available: true });
    await updater.check(); expect(updater.getState()).toMatchObject({ phase: "available", available: true, version: 1 });
  });

  it("allows a timed-out check to retry without a late result overwriting the new state", async () => {
    vi.useFakeTimers(); const stalled = deferred<boolean>();
    const check = vi.fn().mockReturnValueOnce(stalled.promise).mockResolvedValueOnce(false);
    const updater = createAppUpdater(); updater.configure({ check, apply: vi.fn() });
    const pending = updater.check(); await vi.advanceTimersByTimeAsync(20_000); await pending;
    expect(updater.getState().phase).toBe("error");
    await updater.check(); expect(updater.getState().phase).toBe("current");
    stalled.resolve(true); await settle();
    expect(updater.getState()).toMatchObject({ phase: "current", available: false });
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("shares installation attempts and rejects competing checks until activation", async () => {
    vi.useFakeTimers(); const pending = deferred<void>();
    const check = vi.fn(); const apply = vi.fn((_signal: AbortSignal) => pending.promise);
    const updater = createAppUpdater(); updater.configure({ check, apply }); updater.announce();
    const first = updater.install(); const second = updater.install(); const checking = updater.check();
    expect(first).toBe(second); expect(checking).toBe(first);
    await settle(); expect(apply).toHaveBeenCalledTimes(1); expect(check).not.toHaveBeenCalled();
    pending.resolve(); await first;
    expect(updater.getState().phase).toBe("installing");
    await updater.check(); expect(check).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(updater.getState()).toMatchObject({ phase: "error", available: true });
    expect((apply.mock.calls[0][0] as AbortSignal).aborted).toBe(true);
  });

  it("retains the update after an installation error and retries with a fresh signal", async () => {
    vi.useFakeTimers();
    const apply = vi.fn().mockRejectedValueOnce(new Error("activation")).mockResolvedValueOnce(undefined);
    const updater = createAppUpdater(); updater.configure({ check: vi.fn(), apply }); updater.announce();
    await updater.install(); expect(updater.getState()).toMatchObject({ phase: "error", available: true });
    expect((apply.mock.calls[0][0] as AbortSignal).aborted).toBe(true);
    await updater.install(); expect(updater.getState().phase).toBe("installing");
    expect((apply.mock.calls[1][0] as AbortSignal).aborted).toBe(false);
    expect(apply).toHaveBeenCalledTimes(2);
  });

  it("releases a timed-out installation so the user can retry", async () => {
    vi.useFakeTimers();
    const stalled = deferred<void>();
    const apply = vi.fn().mockReturnValueOnce(stalled.promise).mockResolvedValueOnce(undefined);
    const updater = createAppUpdater(); updater.configure({ check: vi.fn(), apply }); updater.announce();
    void updater.install(); await settle();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(updater.getState()).toMatchObject({ phase: "error", available: true });
    void updater.install(); await settle();
    expect(apply).toHaveBeenCalledTimes(2);
    expect((apply.mock.calls[0][0] as AbortSignal).aborted).toBe(true);
    expect((apply.mock.calls[1][0] as AbortSignal).aborted).toBe(false);
    expect(updater.getState().phase).toBe("installing");
    stalled.reject(new Error("late failure")); await settle();
    expect(updater.getState().phase).toBe("installing");
  });
});

describe("registered worker update check", () => {
  function registration() {
    const worker = Object.assign(new EventTarget(), { state: "installing" as ServiceWorkerState });
    const registration = { update: vi.fn(async () => undefined), installing: worker as unknown as ServiceWorker | null, waiting: null as ServiceWorker | null };
    const changed = (state: ServiceWorkerState) => { worker.state = state; worker.dispatchEvent(new Event("statechange")); };
    return { worker, registration: registration as unknown as ServiceWorkerRegistration, changed };
  }

  it("waits for worker downloading to finish before reporting the waiting update", async () => {
    const { worker, registration: current, changed } = registration();
    const removed = vi.spyOn(worker, "removeEventListener"); let completed = false;
    const result = checkRegisteredUpdate(current).then(available => { completed = true; return available; });
    await settle(); expect(completed).toBe(false);
    Object.assign(current, { waiting: worker }); changed("installed");
    expect(await result).toBe(true);
    expect(current.update).toHaveBeenCalledTimes(1);
    expect(removed).toHaveBeenCalledWith("statechange", expect.any(Function));
  });

  it("reports a failed worker install and removes its listener", async () => {
    const { worker, registration: current, changed } = registration(); const removed = vi.spyOn(worker, "removeEventListener");
    const result = expect(checkRegisteredUpdate(current)).rejects.toThrow("Worker install failed");
    await settle(); changed("redundant"); await result;
    expect(removed).toHaveBeenCalledWith("statechange", expect.any(Function));
  });

  it("times out stalled worker downloading and removes its listener", async () => {
    vi.useFakeTimers(); const { worker, registration: current } = registration(); const removed = vi.spyOn(worker, "removeEventListener");
    const result = expect(checkRegisteredUpdate(current)).rejects.toThrow("Worker install timed out");
    await vi.advanceTimersByTimeAsync(19_000); await result;
    expect(removed).toHaveBeenCalledWith("statechange", expect.any(Function));
  });

  it.each([false, true])("reports waiting=%s after checking a registration without a downloading worker", async waiting => {
    const { worker, registration: current } = registration();
    Object.assign(current, { installing: null, waiting: waiting ? worker : null });
    expect(await checkRegisteredUpdate(current)).toBe(waiting);
    expect(current.update).toHaveBeenCalledTimes(1);
  });

  it("propagates a failed registration request instead of claiming the app is current", async () => {
    const { registration: current } = registration();
    vi.mocked(current.update).mockRejectedValue(new Error("network unavailable"));
    await expect(checkRegisteredUpdate(current)).rejects.toThrow("network unavailable");
  });
});
