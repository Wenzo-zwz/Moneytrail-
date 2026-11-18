import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearLocalBackupMetadata, dismissLocalBackupReminder, localBackupReminderDue, observeLocalLedger, readLocalBackupMetadata, recordLocalBackupExport } from "./backupMetadata";
import { emptyData, exportBackup, exportCsv } from "./storage";

const DAY = 86400000;
const start = new Date(2026, 0, 1).getTime();
let values: Map<string, string>;
beforeEach(() => {
  values = new Map([["moneytrail:v1", "ledger bytes"]]);
  vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
});
afterEach(() => vi.unstubAllGlobals());

it("starts a grace period when first observed without claiming an old transaction was never backed up", () => {
  expect(readLocalBackupMetadata()).toBeNull();
  const metadata = observeLocalLedger(start);
  expect(metadata).toEqual({ firstSeenAt: start, lastExportAt: null, dismissedMonth: null });
  expect(observeLocalLedger(start + DAY)).toEqual(metadata);
  expect(localBackupReminderDue(metadata, start + 29 * DAY)).toBe(false);
  expect(localBackupReminderDue(metadata, start + 30 * DAY)).toBe(true);
  expect(values.get("moneytrail:v1")).toBe("ledger bytes");
});

it("remembers a dismissal for this month, then reminds on a later month's opening", () => {
  observeLocalLedger(start);
  const february = new Date(2026, 1, 1).getTime();
  const metadata = dismissLocalBackupReminder(february);
  expect(localBackupReminderDue(metadata, february)).toBe(false);
  expect(localBackupReminderDue(metadata, new Date(2026, 1, 28).getTime())).toBe(false);
  expect(localBackupReminderDue(metadata, new Date(2026, 2, 1).getTime())).toBe(true);
});

it("only resets the interval when a full JSON download is explicitly recorded", () => {
  const metadata = observeLocalLedger(start);
  exportBackup(emptyData());
  exportCsv([]);
  expect(readLocalBackupMetadata()).toEqual(metadata);
  const next = recordLocalBackupExport(start + 40 * DAY);
  expect(next.lastExportAt).toBe(start + 40 * DAY);
  expect(localBackupReminderDue(next, start + 69 * DAY)).toBe(false);
  expect(localBackupReminderDue(next, start + 70 * DAY)).toBe(true);
});

it("tolerates corrupted or unavailable reminder storage without modifying ledger bytes", () => {
  values.set("moneytrail:local-backup:v1", "not json");
  expect(readLocalBackupMetadata()).toBeNull();
  expect(observeLocalLedger(start).firstSeenAt).toBe(start);
  vi.stubGlobal("localStorage", { getItem: () => { throw Error("blocked"); }, setItem: () => { throw Error("blocked"); }, removeItem: () => { throw Error("blocked"); } });
  expect(readLocalBackupMetadata()).toBeNull();
  expect(() => recordLocalBackupExport(start)).not.toThrow();
  expect(() => clearLocalBackupMetadata()).not.toThrow();
  expect(values.get("moneytrail:v1")).toBe("ledger bytes");
});

it("clears reminder state independently so a deliberately cleared book gets a new grace period", () => {
  recordLocalBackupExport(start);
  clearLocalBackupMetadata();
  expect(readLocalBackupMetadata()).toBeNull();
  expect(observeLocalLedger(start + 50 * DAY).firstSeenAt).toBe(start + 50 * DAY);
  expect(values.get("moneytrail:v1")).toBe("ledger bytes");
});
