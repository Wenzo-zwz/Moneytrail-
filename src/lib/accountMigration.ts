import type { Transaction } from "./ledger";
import { importBackup, type AppData } from "./storage";

export type LegacyMigrationPlan = {
  data: AppData;
  added: number;
  duplicates: number;
  renamed: number;
};

// An identifier fingerprint, not a security primitive. Every possible match is
// still compared in full, and differing records receive a separate ID.
function fingerprint(value: string): string {
  return [2166136261, 2246822507, 3266489909, 668265263].map((seed) => {
    let hash = seed;
    for (let index = 0; index < value.length; index += 1) {
      hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }).join("");
}

/** Plan only: the caller must obtain consent before saving or uploading this data. */
export function planLegacyMigration(
  legacy: AppData,
  current: AppData,
  idFactory?: () => string,
): LegacyMigrationPlan {
  // Validate and copy both books before planning any changes. Canonical copies
  // also give comparisons a stable property order.
  const oldBook = importBackup(JSON.stringify(legacy));
  const accountBook = importBackup(JSON.stringify(current));
  const existing = new Map(accountBook.transactions.map((item) => [item.id, item]));
  const reservedIds = new Set([
    ...existing.keys(),
    ...oldBook.transactions.map((item) => item.id),
  ]);
  const mappedIds = new Map<string, string>();
  const planned = new Map<string, Transaction>();
  const addedMonths = new Set<string>();
  let added = 0;
  let duplicates = 0;
  let renamed = 0;

  function replacement(item: Transaction): { item: Transaction; duplicate: boolean } {
    const stableId = fingerprint(JSON.stringify(item));
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const candidate = idFactory ? idFactory() : `legacy-${stableId}-${attempt}`;
      if (
        typeof candidate === "string" && candidate.trim().length > 0 &&
        candidate.length <= 128
      ) {
        const rewritten = { ...item, id: candidate };
        const previous = existing.get(candidate);
        if (previous && JSON.stringify(previous) === JSON.stringify(rewritten)) {
          return { item: rewritten, duplicate: true };
        }
        if (!reservedIds.has(candidate)) {
          reservedIds.add(candidate);
          return { item: rewritten, duplicate: false };
        }
      }
    }
    throw new Error("无法为迁移账目生成独立编号，请重试。原账本未修改。");
  }

  function plan(item: Transaction): void {
    let candidate = { ...item };
    if (candidate.linkedTransactionId !== undefined) {
      // All expenses are planned first, even when a refund appears before its
      // original purchase in the input file.
      candidate.linkedTransactionId = mappedIds.get(candidate.linkedTransactionId)!;
    }
    const collision = existing.get(item.id);
    if (collision && JSON.stringify(collision) === JSON.stringify(candidate)) {
      mappedIds.set(item.id, item.id);
      duplicates += 1;
      return;
    }
    if (collision) {
      const result = replacement(candidate);
      candidate = result.item;
      if (result.duplicate) {
        mappedIds.set(item.id, candidate.id);
        duplicates += 1;
        return;
      }
      renamed += 1;
    }
    mappedIds.set(item.id, candidate.id);
    planned.set(item.id, candidate);
    addedMonths.add(candidate.date.slice(0, 7));
    added += 1;
  }

  for (const item of oldBook.transactions) {
    if (item.kind !== "refund") plan(item);
  }
  for (const item of oldBook.transactions) {
    if (item.kind === "refund") plan(item);
  }

  const data = importBackup(JSON.stringify({
    version: 1,
    transactions: [
      ...accountBook.transactions,
      ...oldBook.transactions.flatMap((item) => {
        const candidate = planned.get(item.id);
        return candidate ? [candidate] : [];
      }),
    ],
    budgetCents: accountBook.budgetCents || oldBook.budgetCents,
    billCheckedMonths: accountBook.billCheckedMonths.filter((month) => !addedMonths.has(month)),
  }));
  return { data, added, duplicates, renamed };
}
