import { validateTransaction, type Transaction } from "./ledger";

export type AppData = {
  version: 1;
  transactions: Transaction[];
  budgetCents: number;
  billCheckedMonths: string[];
};

export type StorageWriteResult = {
  ok: boolean;
  error?: string;
  conflict?: boolean;
};

export const STORAGE_KEY = "moneytrail:v1";
const MAX_AMOUNT_CENTS = 1_000_000_000_000;
const MAX_TRANSACTIONS = 100_000;
const MAX_BACKUP_LENGTH = 20 * 1024 * 1024;

export function emptyData(): AppData {
  return {
    version: 1,
    transactions: [],
    budgetCents: 0,
    billCheckedMonths: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function copyTransaction(transaction: Transaction): Transaction {
  const copy: Transaction = {
    id: transaction.id,
    kind: transaction.kind,
    amountCents: transaction.amountCents,
    date: transaction.date,
    merchant: transaction.merchant,
    category: transaction.category,
    source: transaction.source,
    note: transaction.note,
  };
  if (transaction.sourceRef !== undefined)
    copy.sourceRef = transaction.sourceRef;
  if (transaction.linkedTransactionId !== undefined) {
    copy.linkedTransactionId = transaction.linkedTransactionId;
  }
  return copy;
}

function validateAppData(value: unknown): AppData {
  if (!isRecord(value) || value.version !== 1) {
    throw new Error(
      "备份格式或版本不受支持，请选择 Moneytrail 导出的 JSON 备份。",
    );
  }
  if (
    !Number.isSafeInteger(value.budgetCents) ||
    (value.budgetCents as number) < 0 ||
    (value.budgetCents as number) > MAX_AMOUNT_CENTS
  ) {
    throw new Error("预算金额无效，备份未导入。");
  }
  if (
    !Array.isArray(value.transactions) ||
    value.transactions.length > MAX_TRANSACTIONS
  ) {
    throw new Error("账目列表无效或超过 100,000 条，备份未导入。");
  }

  const ids = new Set<string>();
  const transactions = value.transactions.map((item, index) => {
    if (!validateTransaction(item)) {
      throw new Error(
        `第 ${index + 1} 条账目的格式、金额或日期无效，备份未导入。`,
      );
    }
    if (ids.has(item.id)) {
      throw new Error(`第 ${index + 1} 条账目的编号重复，备份未导入。`);
    }
    ids.add(item.id);
    return copyTransaction(item);
  });

  const byId = new Map(
    transactions.map((transaction) => [transaction.id, transaction]),
  );
  for (const [index, transaction] of transactions.entries()) {
    if (transaction.linkedTransactionId === undefined) continue;
    const original = byId.get(transaction.linkedTransactionId);
    if (transaction.kind !== "refund" || original?.kind !== "expense") {
      throw new Error(
        `第 ${index + 1} 条账目的退款关联无效，原消费必须存在，备份未导入。`,
      );
    }
  }

  if (
    !Array.isArray(value.billCheckedMonths) ||
    value.billCheckedMonths.length > 12_000 ||
    !value.billCheckedMonths.every(
      (month) =>
        typeof month === "string" &&
        /^(?!0000)\d{4}-(0[1-9]|1[0-2])$/.test(month),
    ) ||
    new Set(value.billCheckedMonths).size !== value.billCheckedMonths.length
  ) {
    throw new Error("账单核对月份无效，备份未导入。");
  }

  return {
    version: 1,
    transactions,
    budgetCents: value.budgetCents as number,
    billCheckedMonths: [...value.billCheckedMonths] as string[],
  };
}

function getStorage(): Storage {
  const storage = globalThis.localStorage;
  if (!storage) throw new Error("浏览器未提供本地存储。");
  return storage;
}

export function importBackup(text: string): AppData {
  if (text.length > MAX_BACKUP_LENGTH) {
    throw new Error("备份文件超过 20 MB，请先拆分或检查文件。");
  }
  let value: unknown;
  try {
    value = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    throw new Error("无法读取 JSON 备份，请检查文件是否完整。");
  }
  return validateAppData(value);
}

export function loadData(): { data: AppData; error?: string } {
  let raw: string | null;
  try {
    raw = getStorage().getItem(STORAGE_KEY);
  } catch {
    return {
      data: emptyData(),
      error:
        "无法访问本地存储。请检查浏览器设置；恢复可用前不会保存或修改账目。",
    };
  }
  if (raw === null) return { data: emptyData() };
  try {
    return { data: importBackup(raw) };
  } catch {
    return {
      data: emptyData(),
      error:
        "本地账目暂时无法读取，原始数据已保留。请先下载原始数据，再选择恢复备份或清空。",
    };
  }
}

function conflictResult(): StorageWriteResult {
  return {
    ok: false,
    conflict: true,
    error:
      "另一页面已更新账目，本次修改尚未保存。请重新载入最新账目，核对后重试。",
  };
}

function writeFailure(error: unknown): StorageWriteResult {
  if (error instanceof DOMException && error.name === "QuotaExceededError") {
    return {
      ok: false,
      error:
        "本地存储空间不足，本次修改尚未保存。请先导出备份，再清理浏览器存储空间。",
    };
  }
  return {
    ok: false,
    error: "未能保存账目，本次修改尚未生效。请检查浏览器存储权限并导出备份。",
  };
}

export function saveData(
  data: AppData,
  expected?: AppData,
): StorageWriteResult {
  try {
    const cleanData = validateAppData(data);
    const storage = getStorage();
    const current = storage.getItem(STORAGE_KEY);
    let currentData = emptyData();
    if (current !== null) {
      try {
        currentData = importBackup(current);
      } catch {
        return {
          ok: false,
          error:
            "现有本地数据无法读取，已阻止覆盖。请先下载原始数据并使用恢复操作。",
        };
      }
    }
    if (
      expected !== undefined &&
      JSON.stringify(currentData) !== JSON.stringify(validateAppData(expected))
    ) {
      return conflictResult();
    }
    const serialized = JSON.stringify(cleanData);
    if (serialized.length > MAX_BACKUP_LENGTH) {
      return { ok: false, error: "账目超过存储上限，请先导出备份并整理记录。" };
    }
    storage.setItem(STORAGE_KEY, serialized);
    return { ok: true };
  } catch (error) {
    return writeFailure(error);
  }
}

/** Replace in one write after explicit confirmation, including when old data is corrupt. */
export function restoreData(
  data: AppData,
  expectedRaw: string | null,
): StorageWriteResult {
  try {
    const serialized = JSON.stringify(validateAppData(data));
    if (serialized.length > MAX_BACKUP_LENGTH) {
      return { ok: false, error: "账目超过存储上限，请先导出备份并整理记录。" };
    }
    const storage = getStorage();
    if (storage.getItem(STORAGE_KEY) !== expectedRaw) return conflictResult();
    // Do not removeItem first: a failing setItem must leave the old bytes intact.
    storage.setItem(STORAGE_KEY, serialized);
    return { ok: true };
  } catch (error) {
    return writeFailure(error);
  }
}

/** Recovery helpers are only used after the user explicitly confirms recovery. */
export function readStoredRaw(): string | null {
  return getStorage().getItem(STORAGE_KEY);
}

export function clearStoredData(): { ok: boolean; error?: string } {
  try {
    getStorage().removeItem(STORAGE_KEY);
    return { ok: true };
  } catch {
    return { ok: false, error: "无法清除本地数据，请检查浏览器存储权限。" };
  }
}

export function exportBackup(data: AppData): string {
  return JSON.stringify(validateAppData(data), null, 2);
}

function csvCell(value: string): string {
  // A quote prefix stops spreadsheet apps executing user-controlled formula cells.
  const protectedValue = /^[\u0000-\u0020]*[=+\-@]|^[\t\r\n]/.test(value)
    ? `'${value}`
    : value;
  return `"${protectedValue.replace(/"/g, '""')}"`;
}

export function exportCsv(transactions: Transaction[]): string {
  const kinds: Record<Transaction["kind"], string> = {
    expense: "支出",
    refund: "退款",
    transfer: "转账",
    income: "收入",
  };
  const rows = [
    ["日期", "类型", "金额", "商户", "分类", "备注", "交易编号", "来源"],
  ];
  for (const transaction of transactions) {
    if (!validateTransaction(transaction))
      throw new Error("账目中存在无效记录，无法导出 CSV。");
    rows.push([
      transaction.date.replace("T", " "),
      kinds[transaction.kind],
      (transaction.amountCents / 100).toFixed(2),
      transaction.merchant,
      transaction.category,
      transaction.note,
      transaction.sourceRef ?? "",
      transaction.source,
    ]);
  }
  return (
    "\uFEFF" +
    rows.map((row) => row.map(csvCell).join(",")).join("\r\n") +
    "\r\n"
  );
}
