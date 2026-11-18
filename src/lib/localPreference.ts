const KEY = "moneytrail:mode:v1";

export function prefersLocalLedger(): boolean {
  try { return globalThis.localStorage?.getItem(KEY) === "local"; }
  catch { return false; }
}

export function rememberLocalLedger(local: boolean): void {
  try {
    if (local) globalThis.localStorage?.setItem(KEY, "local");
    else globalThis.localStorage?.removeItem(KEY);
  } catch { /* The current choice can still work without a persistent preference. */ }
}
