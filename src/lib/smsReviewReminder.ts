const PREFIX = "moneytrail:sms-review:v1:";
const WEEK = 7 * 24 * 60 * 60 * 1000;
export type SmsReviewState = { openedAt: number; dismissedAt?: number };

export function readSmsReviewState(scope: string): SmsReviewState | null {
  try {
    const value = JSON.parse(localStorage.getItem(PREFIX + scope) ?? "null");
    if (!value || !Number.isFinite(value.openedAt) || value.openedAt < 0
      || (value.dismissedAt !== undefined && (!Number.isFinite(value.dismissedAt) || value.dismissedAt < 0))) return null;
    return { openedAt: value.openedAt, ...(value.dismissedAt !== undefined ? { dismissedAt: value.dismissedAt } : {}) };
  } catch { return null; }
}

export function isSmsReviewDue(state: SmsReviewState | null, now: number): boolean {
  return Boolean(state && now - Math.max(state.openedAt, state.dismissedAt ?? 0) >= WEEK);
}

export function recordSmsReviewOpened(scope: string): void {
  try { localStorage.setItem(PREFIX + scope, JSON.stringify({ openedAt: Date.now() })); }
  catch { /* Reminder metadata must not interrupt the ledger or inbox. */ }
}

export function dismissSmsReview(scope: string): void {
  const state = readSmsReviewState(scope);
  if (!state) return;
  try { localStorage.setItem(PREFIX + scope, JSON.stringify({ ...state, dismissedAt: Date.now() })); }
  catch { /* Dismissal still takes effect in the current view. */ }
}
