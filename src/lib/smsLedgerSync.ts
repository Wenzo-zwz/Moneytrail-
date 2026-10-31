import type { CloudStore } from "./cloudStore";

/** SMS writes are already committed even when refreshing the local ledger fails. */
export async function refreshSmsLedger(store: CloudStore): Promise<string> {
  await store.refresh();
  const state = store.getState();
  return state.ready && !state.dirty && state.phase === "saved" && !state.recoveryError
    ? ""
    : "首页账目尚未刷新。请重试同步或返回账本检查同步状态，已入账的短信无需再次确认。";
}
