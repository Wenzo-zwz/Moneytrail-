import { describe, expect, it } from "vitest";
import type { Transaction } from "./ledger";
import { buildBudgetReview } from "./reviewBudget";
import { buildSpendingMix, buildSpendingTrend, defaultTrendRange, findLargestReviewChange } from "./reviewSpending";

function transaction(id: string, date: string, amountCents: number, overrides: Partial<Transaction> = {}): Transaction {
  return {
    id, date: date + "T18:00", amountCents, kind: "expense", merchant: "示例商户",
    category: "食品酒水", source: "manual", note: "", ...overrides,
  };
}

describe("review spending mix", () => {
  it("uses original expenses through the selected day and groups normalized primary categories", () => {
    const transactions = [
      transaction("food", "2026-11-01", 1200, { subcategory: "外卖" }),
      transaction("legacy", "2026-11-22", 500, { category: "餐饮" }),
      transaction("pending", "2026-11-12", 2000, { category: "待分类" }),
      transaction("refund", "2026-11-08", 200, { kind: "refund" }),
      transaction("transfer", "2026-11-08", 10000, { kind: "transfer" }),
      transaction("income", "2026-11-08", 10000, { kind: "income" }),
      transaction("future", "2026-11-23", 9000),
      transaction("outside", "2026-10-31", 8000),
    ];

    expect(buildSpendingMix(transactions, "2026-11", "2026-11-22")).toEqual([
      { category: "待分类", amountCents: 2000 },
      { category: "食品酒水", amountCents: 1700 },
    ]);
  });

  it("returns no slices when the period contains refunds only", () => {
    const refund = transaction("refund", "2026-11-02", 2000, { kind: "refund" });
    expect(buildSpendingMix([refund], "2026-11", "2026-11-22")).toEqual([]);
  });
});

describe("review spending trend", () => {
  it("defaults to the selected month and five predecessors, respecting the current month and calendar lower bound", () => {
    expect(defaultTrendRange("2026-02", "2026-11-22")).toEqual({ startMonth: "2025-09", endMonth: "2026-02" });
    expect(defaultTrendRange("2027-01", "2026-11-22")).toEqual({ startMonth: "2026-06", endMonth: "2026-11" });
    expect(defaultTrendRange("2000-02", "2026-11-22")).toEqual({ startMonth: "2000-01", endMonth: "2000-02" });
  });

  it("spans years and distinguishes an unrecorded month from a zero value", () => {
    const transactions = [
      transaction("dec", "2025-12-31", 500, { category: "餐饮" }),
      transaction("jan", "2026-01-01", 1000, { category: "居住与家用" }),
      transaction("apr-expense", "2026-04-05", 250),
      transaction("apr-refund", "2026-04-06", 250, { kind: "refund" }),
      transaction("may-refund", "2026-05-01", 150, { kind: "refund" }),
      transaction("may-beyond", "2026-05-10", 900),
      transaction("jun", "2026-06-01", 700),
    ];
    const range = { startMonth: "2025-12", endMonth: "2026-06" };

    expect(buildSpendingTrend(transactions, range, "2026-05-08", "食品酒水", ["2026-03"])).toEqual([
      { month: "2025-12", amountCents: 500, isPartial: false },
      { month: "2026-01", amountCents: 0, isPartial: false },
      { month: "2026-02", amountCents: null, isPartial: false },
      { month: "2026-03", amountCents: 0, isPartial: false },
      { month: "2026-04", amountCents: 0, isPartial: false },
      { month: "2026-05", amountCents: -150, isPartial: true },
    ]);
  });

  it("lets all categories include uncategorized expenses and excludes income and transfers from spending", () => {
    const transactions = [
      transaction("food", "2026-10-01", 3000),
      transaction("pending", "2026-10-10", 2000, { category: "待分类" }),
      transaction("transfer", "2026-10-15", 10000, { kind: "transfer" }),
      transaction("income", "2026-10-20", 20000, { kind: "income" }),
      transaction("refund", "2026-10-31", 1500, { kind: "refund" }),
    ];
    const range = { startMonth: "2026-10", endMonth: "2026-10" };

    expect(buildSpendingTrend(transactions, range, "2026-11-22", null)).toEqual([
      { month: "2026-10", amountCents: 3500, isPartial: false },
    ]);
  });

  it("returns no points for incomplete, inverted, or entirely future ranges", () => {
    expect(buildSpendingTrend([], { startMonth: "", endMonth: "2026-10" }, "2026-11-22", null)).toEqual([]);
    expect(buildSpendingTrend([], { startMonth: "2026-10", endMonth: "2026-03" }, "2026-11-22", null)).toEqual([]);
    expect(buildSpendingTrend([], { startMonth: "2026-12", endMonth: "2027-02" }, "2026-11-22", null)).toEqual([]);
  });
});

describe("review's largest classified change", () => {
  it("finds the primary category and a contributing detail moving in the direction of the total", () => {
    const transactions = [
      transaction("food-old", "2026-10-03", 500, { subcategory: "外卖" }),
      transaction("food-new", "2026-11-03", 1200, { subcategory: "外卖" }),
      transaction("snacks", "2026-11-03", 200, { subcategory: "零食饮料" }),
      transaction("housing-old", "2026-10-04", 2000, { category: "居住与家用" }),
      transaction("housing-new", "2026-11-04", 800, { category: "居住与家用" }),
      transaction("pending", "2026-11-06", 1800, { category: "待分类" }),
    ];
    const { rows } = buildBudgetReview(transactions, [], "2026-11", "2026-11-22");

    expect(findLargestReviewChange(rows, 1500)).toEqual({
      category: "食品酒水", deltaCents: 900, detail: { subcategory: "外卖", deltaCents: 700 },
    });
    expect(findLargestReviewChange(rows, 0)).toEqual({ category: "居住与家用", deltaCents: -1200 });
  });

  it("omits a classified driver when the only movement in the total direction is uncategorized", () => {
    const transactions = [
      transaction("food-old", "2026-10-03", 500),
      transaction("food-new", "2026-11-03", 300),
      transaction("pending", "2026-11-06", 1000, { category: "待分类" }),
    ];
    const { rows } = buildBudgetReview(transactions, [], "2026-11", "2026-11-22");
    expect(findLargestReviewChange(rows, 800)).toBeUndefined();
  });
});
