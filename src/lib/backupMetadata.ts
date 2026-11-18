const KEY = "moneytrail:local-backup:v1";
const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;

export type LocalBackupMetadata = {
  firstSeenAt: number;
  lastExportAt: number | null;
  dismissedMonth: string | null;
};

function monthOf(time: number): string {
  const date = new Date(time);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

export function readLocalBackupMetadata(): LocalBackupMetadata | null {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<LocalBackupMetadata>;
    if (!Number.isSafeInteger(value.firstSeenAt) || value.firstSeenAt! < 0
      || (value.lastExportAt !== null && (!Number.isSafeInteger(value.lastExportAt) || value.lastExportAt! < 0))
      || (value.dismissedMonth !== null && (typeof value.dismissedMonth !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value.dismissedMonth)))) return null;
    return value as LocalBackupMetadata;
  } catch { return null; }
}

function write(metadata: LocalBackupMetadata): LocalBackupMetadata {
  try { globalThis.localStorage?.setItem(KEY, JSON.stringify(metadata)); }
  catch { /* A reminder must never prevent ledger use or backup downloads. */ }
  return metadata;
}

export function observeLocalLedger(now: number): LocalBackupMetadata {
  return readLocalBackupMetadata() ?? write({ firstSeenAt: now, lastExportAt: null, dismissedMonth: null });
}

export function recordLocalBackupExport(now: number): LocalBackupMetadata {
  return write({ ...observeLocalLedger(now), lastExportAt: now, dismissedMonth: null });
}

export function dismissLocalBackupReminder(now: number): LocalBackupMetadata {
  return write({ ...observeLocalLedger(now), dismissedMonth: monthOf(now) });
}

export function clearLocalBackupMetadata(): void {
  try { globalThis.localStorage?.removeItem(KEY); } catch { /* Ledger clearing already reports its own result. */ }
}

export function localBackupReminderDue(metadata: LocalBackupMetadata | null, now: number): boolean {
  return metadata !== null && now - (metadata.lastExportAt ?? metadata.firstSeenAt) >= THIRTY_DAYS
    && metadata.dismissedMonth !== monthOf(now);
}
