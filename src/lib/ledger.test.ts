import { describe, expect, it } from "vitest";
import {
  currentMonth,
  findDuplicates,
  formatMoney,
  isValidLocalDateTime,
  parseAmount,
  summarize,
  validateTransaction,
  type Transaction,
} from "./ledger";

const transaction = (patch: Partial<Transaction> = {}): Transaction => ({
  id: "one",
  kind: "expense",
  amountCents: 1234,
  date: "2026-10-22T12:30",
  merchant: "午饭",
  category: "餐饮",
  source: "manual",
  note: "",
  ...patch,
});

describe("decimal yuan to integer cents", () => {
  it.each([
    ["0.01", 1],
    ["0.29", 29],
    ["12.3", 1230],
    ["￥1,234.56", 123456],
    ["人民币 100元", 10000],
    ["CNY 12.34", 1234],
    ["10,000,000,000.00", 1e12],
  ])("parses %s exactly", (input, expected) =>
    expect(parseAmount(input)).toBe(expected),
  );

  it.each([
    "",
    "0",
    "-1",
    "+1",
    "1.005",
    "NaN",
    "Infinity",
    "1e3",
    "$12",
    "USD12",
    "12美元",
    "1,00.00",
    "1,2345",
    "10,000,000,000.01",
    "10000000000000000000",
  ])("rejects %s", (input) => {
    expect(parseAmount(input)).toBeNull();
  });

  it("formats integer cents as yuan", () => {
    expect(formatMoney(29)).toContain("0.29");
    expect(formatMoney(-1200)).toContain("-");
  });
});

describe("strict local financial dates and restore validation", () => {
  it.each(["2024-02-29T23:59", "2000-02-29T00:00", "2026-10-22T12:30"])(
    "accepts %s",
    (date) => {
      expect(isValidLocalDateTime(date)).toBe(true);
    },
  );
  it.each([
    "2025-02-29T12:00",
    "1900-02-29T12:00",
    "2026-04-31T12:00",
    "2026-00-22T12:00",
    "2026-10-00T12:00",
    "2026-10-22T24:00",
    "2026-10-22T12:60",
    "2026-10-22",
    "2026-10-22T12:30Z",
  ])("rejects %s", (date) => {
    expect(isValidLocalDateTime(date)).toBe(false);
  });
  it("validates required and optional fields instead of accepting arbitrary backups", () => {
    expect(validateTransaction(transaction())).toBe(true);
    expect(validateTransaction(transaction({ amountCents: 1.2 }))).toBe(false);
    expect(validateTransaction(transaction({ amountCents: 0 }))).toBe(false);
    expect(validateTransaction(transaction({ category: "unknown" }))).toBe(
      false,
    );
    expect(validateTransaction(transaction({ merchant: " " }))).toBe(false);
    expect(validateTransaction(transaction({ note: "x".repeat(2001) }))).toBe(
      false,
    );
    expect(validateTransaction(transaction({ sourceRef: "" }))).toBe(false);
    expect(validateTransaction({ ...transaction(), kind: "other" })).toBe(
      false,
    );
  });
  it("uses the requested local calendar month", () => {
    expect(currentMonth(new Date(2026, 0, 1, 0, 1))).toBe("2026-01");
  });
});

describe("monthly financial meaning", () => {
  it("separates refunds, transfers, and income, retaining exact cents", () => {
    const entries = [
      transaction({ amountCents: 29 }),
      transaction({ id: "two", amountCents: 71 }),
      transaction({ id: "refund", kind: "refund", amountCents: 30 }),
      transaction({ id: "repayment", kind: "transfer", amountCents: 100_000 }),
      transaction({ id: "salary", kind: "income", amountCents: 900_000 }),
      transaction({ id: "old", date: "2026-09-30T23:59", amountCents: 500 }),
    ];
    expect(summarize(entries, "2026-10", 1000)).toEqual({
      expenseCents: 100,
      refundCents: 30,
      netCents: 70,
      incomeCents: 900_000,
      budgetRemainingCents: 930,
      count: 3,
      uncategorizedCount: 0,
      categories: [{ category: "餐饮", amountCents: 70 }],
    });
  });
  it("accounts for a cross-month refund when it is received", () => {
    const entries = [
      transaction({ date: "2026-09-30T20:00", amountCents: 10000 }),
      transaction({
        id: "refund",
        kind: "refund",
        amountCents: 10000,
        linkedTransactionId: "one",
      }),
    ];
    expect(summarize(entries, "2026-09", 50000).netCents).toBe(10000);
    const october = summarize(entries, "2026-10", 50000);
    expect(october.netCents).toBe(-10000);
    expect(october.categories[0].amountCents).toBe(-10000);
  });
  it("counts uncategorized consumption without treating transfers as consumption", () => {
    const entries = [
      transaction({ category: "待分类" }),
      transaction({ id: "two", kind: "transfer", category: "待分类" }),
    ];
    expect(summarize(entries, "2026-10", 1000).uncategorizedCount).toBe(1);
  });
});

describe("duplicate review suggestions", () => {
  it("suggests equal kind and amount within ten minutes across sources", () => {
    const saved = transaction({ source: "sms" });
    const candidate = transaction({
      id: "two",
      source: "wechat",
      date: "2026-10-22T12:36",
    });
    expect(findDuplicates(candidate, [saved])).toEqual([saved]);
    expect(
      findDuplicates({ ...candidate, date: "2026-10-22T12:41" }, [saved]),
    ).toEqual([]);
    expect(findDuplicates({ ...candidate, kind: "refund" }, [saved])).toEqual(
      [],
    );
  });
  it("handles midnight without changing calendar timezone", () => {
    const saved = transaction({ date: "2026-10-21T23:59" });
    expect(
      findDuplicates(transaction({ date: "2026-10-22T00:02" }), [saved]),
    ).toEqual([saved]);
  });
  it("flags a stable source reference even when the imported amount conflicts", () => {
    const saved = transaction({ source: "alipay", sourceRef: "order-1" });
    expect(
      findDuplicates(
        transaction({
          source: "alipay",
          sourceRef: "order-1",
          amountCents: 8000,
        }),
        [saved],
      ),
    ).toEqual([saved]);
    expect(
      findDuplicates(
        transaction({
          source: "wechat",
          sourceRef: "order-1",
          amountCents: 8000,
        }),
        [saved],
      ),
    ).toEqual([]);
  });
});
