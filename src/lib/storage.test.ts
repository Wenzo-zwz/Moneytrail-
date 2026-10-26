import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Transaction } from "./ledger";
import { parseCsv } from "./parsers";
import {
  STORAGE_KEY,
  clearStoredData,
  emptyData,
  exportBackup,
  exportCsv,
  importBackup,
  loadData,
  readStoredRaw,
  restoreData,
  saveData,
  type AppData,
} from "./storage";

function transaction(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: "tx-lunch",
    kind: "expense",
    amountCents: 2_890,
    date: "2026-10-22T12:30",
    merchant: "午餐小馆",
    category: "本地生活",
    source: "wechat",
    note: "午饭",
    sourceRef: "wx-202610221230",
    ...overrides,
  };
}

function appData(): AppData {
  return {
    ...emptyData(),
    transactions: [transaction()],
    budgetCents: 300_000,
    billCheckedMonths: ["2026-09"],
  };
}

let store: Map<string, string>;
let localStore: Storage;

beforeEach(() => {
  store = new Map();
  localStore = {
    get length() {
      return store.size;
    },
    clear: vi.fn(() => store.clear()),
    getItem: vi.fn((key: string) => store.get(key) ?? null),
    key: vi.fn((index: number) => [...store.keys()][index] ?? null),
    removeItem: vi.fn((key: string) => {
      store.delete(key);
    }),
    setItem: vi.fn((key: string, value: string) => {
      store.set(key, value);
    }),
  };
  vi.stubGlobal("localStorage", localStore);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("local persistence and recovery", () => {
  it("opens a new ledger without writing or inventing transactions", () => {
    expect(loadData()).toEqual({ data: emptyData() });
    expect(localStore.setItem).not.toHaveBeenCalled();
    const first = emptyData();
    first.transactions.push(transaction());
    expect(emptyData().transactions).toEqual([]);
  });

  it("persists and reloads the whole ledger without losing financial fields", () => {
    const data = appData();
    data.transactions.push(
      transaction({
        id: "tx-refund",
        kind: "refund",
        amountCents: 500,
        linkedTransactionId: "tx-lunch",
        sourceRef: "wx-refund-123",
      }),
    );
    expect(saveData(data)).toEqual({ ok: true });
    expect(loadData()).toEqual({ data });
    expect(readStoredRaw()).toContain("wx-refund-123");
  });

  it("preserves corrupt raw data and refuses ordinary saves over it", () => {
    const corrupt = '{"version":1,"transactions":';
    store.set(STORAGE_KEY, corrupt);
    const loaded = loadData();
    expect(loaded.error).toContain("原始数据已保留");
    expect(loaded.data).toEqual(emptyData());
    expect(saveData(emptyData())).toMatchObject({ ok: false });
    expect(readStoredRaw()).toBe(corrupt);
    expect(localStore.setItem).not.toHaveBeenCalled();
  });

  it("allows a deliberate reset, followed by restoration from a verified backup", () => {
    const backup = exportBackup(appData());
    store.set(STORAGE_KEY, "broken");
    expect(readStoredRaw()).toBe("broken");
    expect(clearStoredData()).toEqual({ ok: true });
    expect(saveData(importBackup(backup))).toEqual({ ok: true });
    expect(loadData()).toEqual({ data: appData() });
  });

  it("reports quota failure and keeps the previous saved ledger", () => {
    const before = exportBackup(appData());
    store.set(STORAGE_KEY, before);
    vi.mocked(localStore.setItem).mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    const next = appData();
    next.budgetCents = 999_900;
    expect(saveData(next)).toEqual({
      ok: false,
      error:
        "本地存储空间不足，本次修改尚未保存。请先导出备份，再清理浏览器存储空间。",
    });
    expect(store.get(STORAGE_KEY)).toBe(before);
  });

  it("reports unavailable storage without claiming that edits were saved", () => {
    vi.mocked(localStore.getItem).mockImplementation(() => {
      throw new DOMException("disabled", "SecurityError");
    });
    expect(loadData().error).toContain("无法访问本地存储");
    expect(saveData(appData()).ok).toBe(false);
    expect(localStore.setItem).not.toHaveBeenCalled();
  });

  it("rejects a stale page edit without replacing another page’s update", () => {
    const original = appData();
    expect(saveData(original, emptyData())).toEqual({ ok: true });
    const otherPage = { ...original, budgetCents: 450_000 };
    expect(saveData(otherPage, original)).toEqual({ ok: true });
    const staleEdit = { ...original, budgetCents: 500_000 };
    vi.mocked(localStore.setItem).mockClear();
    expect(saveData(staleEdit, original)).toMatchObject({
      ok: false,
      conflict: true,
    });
    expect(loadData().data).toEqual(otherPage);
    expect(localStore.setItem).not.toHaveBeenCalled();
  });

  it("compares validated canonical data, ignoring JSON formatting and unrelated fields", () => {
    const original = appData();
    store.set(
      STORAGE_KEY,
      JSON.stringify({ extra: true, ...original }, null, 4),
    );
    const next = { ...original, budgetCents: 450_000 };
    expect(saveData(next, original)).toEqual({ ok: true });
    expect(loadData().data).toEqual(next);
  });

  it("rejects stale state when another page cleared the ledger", () => {
    const original = appData();
    const next = { ...original, budgetCents: 450_000 };
    expect(saveData(next, original)).toMatchObject({
      ok: false,
      conflict: true,
    });
    expect(readStoredRaw()).toBeNull();
  });

  it("restores a verified backup over corrupt data in one write", () => {
    const corrupt = '{"version":1,unfinished';
    store.set(STORAGE_KEY, corrupt);
    const expectedRaw = readStoredRaw();
    expect(restoreData(appData(), expectedRaw)).toEqual({ ok: true });
    expect(loadData()).toEqual({ data: appData() });
    expect(localStore.removeItem).not.toHaveBeenCalled();
    expect(localStore.setItem).toHaveBeenCalledTimes(1);
  });

  it("keeps corrupt original bytes if backup restoration runs out of storage", () => {
    const corrupt = '{"version":1,unfinished';
    store.set(STORAGE_KEY, corrupt);
    vi.mocked(localStore.setItem).mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    expect(restoreData(appData(), corrupt)).toMatchObject({ ok: false });
    expect(readStoredRaw()).toBe(corrupt);
    expect(localStore.removeItem).not.toHaveBeenCalled();
  });

  it("refuses restoration if storage changed after the confirmation snapshot", () => {
    const snapshot = '{"version":1,unfinished';
    store.set(STORAGE_KEY, exportBackup(appData()));
    const current = readStoredRaw();
    expect(restoreData(emptyData(), snapshot)).toMatchObject({
      ok: false,
      conflict: true,
    });
    expect(readStoredRaw()).toBe(current);
    expect(localStore.setItem).not.toHaveBeenCalled();
    expect(localStore.removeItem).not.toHaveBeenCalled();
  });

  it("rejects invalid replacements before touching old storage", () => {
    const corrupt = "must be preserved";
    store.set(STORAGE_KEY, corrupt);
    expect(restoreData({ ...appData(), budgetCents: -1 }, corrupt).ok).toBe(
      false,
    );
    expect(readStoredRaw()).toBe(corrupt);
    expect(localStore.setItem).not.toHaveBeenCalled();
  });
});

describe("backup validation", () => {
  it("round-trips a backup, accepts a UTF-8 BOM, and strips unrelated fields", () => {
    const raw = JSON.stringify({ ...appData(), extra: "do not restore" });
    const restored = importBackup("\uFEFF" + raw);
    expect(restored).toEqual(appData());
    expect(importBackup(exportBackup(restored))).toEqual(appData());
    expect(restored).not.toHaveProperty("extra");
  });

  it.each([
    ["invalid JSON", "{", "JSON"],
    [
      "unsupported version",
      JSON.stringify({ ...appData(), version: 2 }),
      "版本",
    ],
    [
      "negative budget",
      JSON.stringify({ ...appData(), budgetCents: -1 }),
      "预算",
    ],
    [
      "fractional cents",
      JSON.stringify({ ...appData(), budgetCents: 12.5 }),
      "预算",
    ],
    [
      "huge budget",
      JSON.stringify({ ...appData(), budgetCents: Number.MAX_SAFE_INTEGER }),
      "预算",
    ],
    [
      "missing list",
      JSON.stringify({ version: 1, budgetCents: 0, billCheckedMonths: [] }),
      "账目列表",
    ],
    [
      "bad month",
      JSON.stringify({ ...appData(), billCheckedMonths: ["2026-13"] }),
      "月份",
    ],
    [
      "duplicate month",
      JSON.stringify({
        ...appData(),
        billCheckedMonths: ["2026-09", "2026-09"],
      }),
      "月份",
    ],
    [
      "bad transaction date",
      JSON.stringify({
        ...appData(),
        transactions: [transaction({ date: "2026-02-30T12:00" })],
      }),
      "第 1 条",
    ],
    [
      "zero transaction",
      JSON.stringify({
        ...appData(),
        transactions: [transaction({ amountCents: 0 })],
      }),
      "第 1 条",
    ],
    [
      "negative transaction",
      JSON.stringify({
        ...appData(),
        transactions: [transaction({ amountCents: -100 })],
      }),
      "第 1 条",
    ],
    [
      "duplicate transaction id",
      JSON.stringify({
        ...appData(),
        transactions: [transaction(), transaction()],
      }),
      "编号重复",
    ],
    [
      "dangling refund link",
      JSON.stringify({
        ...appData(),
        transactions: [
          transaction({ kind: "refund", linkedTransactionId: "missing" }),
        ],
      }),
      "退款关联",
    ],
    [
      "link attached to an expense",
      JSON.stringify({
        ...appData(),
        transactions: [transaction({ linkedTransactionId: "tx-lunch" })],
      }),
      "退款关联",
    ],
    [
      "refund linked to an income",
      JSON.stringify({
        ...appData(),
        transactions: [
          transaction({ kind: "income" }),
          transaction({
            id: "tx-refund",
            kind: "refund",
            linkedTransactionId: "tx-lunch",
          }),
        ],
      }),
      "退款关联",
    ],
    [
      "refund linked to itself",
      JSON.stringify({
        ...appData(),
        transactions: [
          transaction({ kind: "refund", linkedTransactionId: "tx-lunch" }),
        ],
      }),
      "退款关联",
    ],
  ])("rejects %s without changing saved data", (_label, raw, message) => {
    store.set(STORAGE_KEY, exportBackup(appData()));
    const before = store.get(STORAGE_KEY);
    expect(() => importBackup(raw)).toThrow(message);
    expect(store.get(STORAGE_KEY)).toBe(before);
  });
});

describe("CSV export", () => {
  it("exports a BOM and escapes quotes, commas and multiline notes", () => {
    const csv = exportCsv([
      transaction({ merchant: '一家,"小店"', note: "第一行\n第二行" }),
    ]);
    expect(csv.startsWith("\uFEFF")).toBe(true);
    expect(csv).toContain('"一家,""小店"""');
    expect(csv).toContain('"第一行\n第二行"');
    expect(csv).toContain('"28.90"');
    expect(csv).toContain('"2026-10-22 12:30"');
  });

  it("prevents spreadsheet formulas in user-controlled text fields", () => {
    const csv = exportCsv([
      transaction({
        merchant: '=WEBSERVICE("example")',
        note: " \t+SUM(1,2)",
        sourceRef: "@DANGEROUS",
      }),
    ]);
    expect(csv).toContain("\"'=WEBSERVICE");
    expect(csv).toContain('"\' \t+SUM(1,2)"');
    expect(csv).toContain('"\'@DANGEROUS"');
  });

  it("can be reimported as canonical CSV without changing amount, date or kind", () => {
    const original = transaction({
      note: "核对过,\n可导入",
      merchant: "早餐铺",
    });
    const result = parseCsv(exportCsv([original]));
    expect(result.errors).toEqual([]);
    expect(result.drafts).toHaveLength(1);
    expect(result.drafts[0]).toMatchObject({
      kind: original.kind,
      amountCents: original.amountCents,
      date: original.date,
      merchant: original.merchant,
      category: original.category,
      sourceRef: original.sourceRef,
    });
  });
});
