import { describe, expect, it } from "vitest";
import type { Transaction } from "./ledger";
import {
  buildBudgetReview,
  parseAnnualBudgets,
  setAnnualBudget,
  setMonthlyOverride,
  type AnnualBudget,
  type BudgetScope,
} from "./reviewBudget";

const category = { category: "其他" };
const detail = { ...category, subcategory: "宠物用品" };

function transaction(id: string, date: string, amountCents: number, patch: Partial<Transaction> = {}): Transaction {
  return {
    id, date: `${date}T18:00`, amountCents, kind: "expense", merchant: "示例商户",
    category: category.category, source: "manual", note: "", ...patch,
  };
}

function reviewRow(
  transactions: Transaction[], budgets: AnnualBudget[], month: string, today: string, scope: BudgetScope = category,
) {
  const review = buildBudgetReview(transactions, budgets, month, today);
  return review.rows.find(row => row.category === scope.category && row.subcategory === scope.subcategory)!;
}

describe("calendar review", () => {
  it("compares this month through today with the same day of the last month, capping at the shorter month's end", () => {
    const transactions = [
      transaction("feb1", "2024-02-01", 200),
      transaction("feb29", "2024-02-29", 500),
      transaction("mar30", "2024-03-30", 600),
      transaction("mar31", "2024-03-31", 900),
    ];
    const review = buildBudgetReview(transactions, [], "2024-03", "2024-03-30");
    expect(review).toMatchObject({
      selectedMonth: "2024-03", currentThrough: "2024-03-30", priorMonth: "2024-02",
      priorThrough: "2024-02-29", isMonthToDate: true, nextMonth: "2024-04",
    });
    expect(reviewRow(transactions, [], "2024-03", "2024-03-30")).toMatchObject({
      currentNetCents: 600, priorNetCents: 700, yearNetCents: 1300,
    });
  });

  it("excludes later days in the prior month and crosses years without including that spend in year to date", () => {
    const transactions = [
      transaction("dec8", "2025-12-08", 900),
      transaction("dec9", "2025-12-09", 400),
      transaction("jan8", "2026-01-08", 1000),
    ];
    expect(reviewRow(transactions, [], "2026-01", "2026-01-08")).toMatchObject({
      currentNetCents: 1000, priorNetCents: 900, yearNetCents: 1000,
    });
  });

  it("compares complete historical months using the final date of each month", () => {
    const review = buildBudgetReview([], [], "2026-02", "2026-03-01");
    expect(review).toMatchObject({ currentThrough: "2026-02-28", priorThrough: "2026-01-31", isMonthToDate: false });
  });

  it("can compare the open month to the full previous month without moving the current budget cutoff", () => {
    const budgets = setAnnualBudget([], category, "2026-01", 12_000);
    const transactions = [
      transaction("prior", "2026-03-31", 2000),
      transaction("after", "2026-04-21", 5000),
    ];
    const review = buildBudgetReview(transactions, budgets, "2026-04", "2026-04-19", "full");
    expect(review).toMatchObject({ currentThrough: "2026-04-19", priorThrough: "2026-03-31", isMonthToDate: true });
    expect(review.rows.find(row => row.category === category.category && !row.subcategory)).toMatchObject({
      currentNetCents: 0, priorNetCents: 2000, yearNetCents: 2000, next: { suggestedCents: 1250 },
    });
  });

  it("counts each expense in its parent and explicit detail only, with refunds netted when received", () => {
    const transactions = [
      transaction("undefined", "2026-02-05", 1000),
      transaction("unknown", "2026-02-05", 100, { subcategory: "未细分" }),
      transaction("detail", "2026-02-03", 700, detail),
      transaction("other", "2026-02-05", 80, { subcategory: "书籍" }),
      transaction("transfer", "2026-02-05", 5000, { ...detail, kind: "transfer" }),
      transaction("income", "2026-02-05", 300, { ...detail, kind: "income" }),
      transaction("refund", "2026-03-04", 300, { ...detail, kind: "refund", linkedTransactionId: "detail" }),
    ];
    const budgets = setAnnualBudget(setAnnualBudget([], category, "2026-02", 12_000), detail, "2026-02", 6000);
    expect(reviewRow(transactions, budgets, "2026-03", "2026-03-05")).toMatchObject({
      currentNetCents: -300, priorNetCents: 1880, yearNetCents: 1580, annualRemainingCents: 10_420,
    });
    expect(reviewRow(transactions, budgets, "2026-03", "2026-03-05", detail)).toMatchObject({
      currentNetCents: -300, priorNetCents: 700, yearNetCents: 400, annualRemainingCents: 5600,
    });
    expect(buildBudgetReview(transactions, budgets, "2026-03", "2026-03-05").rows).not.toContainEqual(
      expect.objectContaining({ ...category, subcategory: "未细分" }),
    );
  });
});

describe("annual spending caps", () => {
  it("preserves earlier spending but begins monthly references in the first configured month", () => {
    const transactions = [transaction("jan", "2026-01-20", 1500)];
    const budgets = setAnnualBudget([], category, "2026-04", 12_001);
    expect(reviewRow(transactions, budgets, "2026-03", "2026-04-07")).toMatchObject({
      annualCapCents: null, monthlyReferenceCents: null, yearNetCents: 1500,
    });
    expect(reviewRow(transactions, budgets, "2026-04", "2026-04-07")).toMatchObject({
      annualCapCents: 12_001, monthlyReferenceCents: 1000, yearNetCents: 1500, annualRemainingCents: 10_501,
    });
  });

  it("changes and clears the active cap effective in the chosen month, preserving earlier reference amounts", () => {
    const budgets = setAnnualBudget([], category, "2026-01", 12_000);
    const revised = setAnnualBudget(budgets, category, "2026-03", 18_000);
    const removed = setAnnualBudget(revised, category, "2026-05", null);
    expect(reviewRow([], removed, "2026-02", "2026-06-01").monthlyReferenceCents).toBe(1000);
    expect(reviewRow([], removed, "2026-04", "2026-06-01").monthlyReferenceCents).toBe(1500);
    expect(reviewRow([], removed, "2026-05", "2026-06-01").monthlyReferenceCents).toBeNull();
    expect(budgets).toEqual([{ ...category, year: 2026, capChanges: [{ month: "2026-01", amountCents: 12_000 }], monthlyOverrides: [] }]);
  });

  it("uses the actual spending through the reviewed date to propose the next month's amount and clamps it at zero", () => {
    const budgets = setAnnualBudget([], category, "2026-01", 12_000);
    const early = transaction("early", "2026-04-02", 3900);
    const late = transaction("late", "2026-04-30", 8100);
    expect(reviewRow([early, late], budgets, "2026-04", "2026-04-05").next).toEqual({
      monthsRemaining: 8, suggestedCents: 1013, overrideCents: null, annualCapCents: 12_000, annualRemainingCents: 8100,
    });
    expect(reviewRow([early, { ...late, amountCents: 9000 }], budgets, "2026-04", "2026-05-01").next.suggestedCents).toBe(0);
  });

  it("keeps the override for only its own month while recalculating suggestions and actuals after corrections", () => {
    const budgets = setMonthlyOverride(setAnnualBudget([], category, "2026-01", 12_000), category, "2026-05", 700);
    const early = transaction("early", "2026-04-02", 3900);
    const corrected = { ...early, amountCents: 1600 };
    expect(reviewRow([early], budgets, "2026-04", "2026-05-08").next).toMatchObject({ suggestedCents: 1013, overrideCents: 700 });
    expect(reviewRow([corrected], budgets, "2026-04", "2026-05-08")).toMatchObject({
      currentNetCents: 1600, monthlyReferenceCents: 1000, next: { suggestedCents: 1300, overrideCents: 700 },
    });
    expect(reviewRow([corrected], budgets, "2026-05", "2026-05-08").monthlyReferenceCents).toBe(700);
    expect(reviewRow([corrected], budgets, "2026-06", "2026-06-30").monthlyReferenceCents).toBe(1000);
    expect(reviewRow([], setMonthlyOverride(budgets, category, "2026-05", null), "2026-05", "2026-05-08").monthlyReferenceCents).toBe(1000);
  });

  it("uses only an independently configured January cap when reviewing December", () => {
    const budgets = setAnnualBudget([], category, "2026-01", 12_000);
    const transactions = [transaction("dec", "2026-12-13", 8300), transaction("jan", "2027-01-01", 11000)];
    const createJanuary = setAnnualBudget(budgets, category, "2027-01", 24_000);
    expect(reviewRow(transactions, budgets, "2026-12", "2026-12-26").next).toEqual({
      monthsRemaining: 12, suggestedCents: null, overrideCents: null, annualCapCents: null, annualRemainingCents: null,
    });
    expect(reviewRow(transactions, createJanuary, "2026-12", "2026-12-26").next).toEqual({
      monthsRemaining: 12, suggestedCents: 2000, overrideCents: null, annualCapCents: 24_000, annualRemainingCents: 24_000,
    });
    const nextYearDetail = setAnnualBudget(budgets, detail, "2027-01", 12_000);
    expect(reviewRow([], nextYearDetail, "2026-12", "2026-12-26", detail)).toMatchObject({
      annualCapCents: null, next: { annualCapCents: 12_000, suggestedCents: 1000 },
    });
  });
});

describe("annual budget data validation", () => {
  const valid = {
    ...detail, year: 2026, capChanges: [{ month: "2026-01", amountCents: 100_000 }, { month: "2026-05", amountCents: null }],
    monthlyOverrides: [{ month: "2026-02", amountCents: 0 }],
  };

  it("copies a valid snapshot with zero overrides and discontinued budgets", () => {
    const parsed = parseAnnualBudgets([valid]);
    expect(parsed).toEqual([valid]);
    expect(parsed[0]).not.toBe(valid);
    expect(parsed[0].capChanges).not.toBe(valid.capChanges);
  });

  it.each([
    ["non-array", null],
    ["invalid year", [{ ...valid, year: 0 }]],
    ["unknown category", [{ ...valid, category: "伪造" }]],
    ["uncategorized budget", [{ ...valid, category: "待分类" }]],
    ["reserved detail", [{ ...valid, subcategory: "未细分" }]],
    ["blank detail", [{ ...valid, subcategory: " " }]],
    ["duplicate scope", [valid, valid]],
    ["empty cap history", [{ ...valid, capChanges: [] }]],
    ["invalid month", [{ ...valid, capChanges: [{ month: "2026-1", amountCents: 1 }] }]],
    ["wrong year", [{ ...valid, capChanges: [{ month: "2027-01", amountCents: 1 }] }]],
    ["non-integer cap", [{ ...valid, capChanges: [{ month: "2026-01", amountCents: 1.5 }] }]],
    ["negative cap", [{ ...valid, capChanges: [{ month: "2026-01", amountCents: -1 }] }]],
    ["over-limit cap", [{ ...valid, capChanges: [{ month: "2026-01", amountCents: 1e12 + 1 }] }]],
    ["unsorted revisions", [{ ...valid, capChanges: [...valid.capChanges].reverse() }]],
    ["duplicate revision month", [{ ...valid, capChanges: [valid.capChanges[0], valid.capChanges[0]] }]],
    ["null override", [{ ...valid, monthlyOverrides: [{ month: "2026-02", amountCents: null }] }]],
    ["unsorted overrides", [{ ...valid, monthlyOverrides: [{ month: "2026-03", amountCents: 1 }, ...valid.monthlyOverrides] }]],
    ["duplicate override month", [{ ...valid, monthlyOverrides: [...valid.monthlyOverrides, ...valid.monthlyOverrides] }]],
  ])("rejects %s", (_name, input) => {
    expect(() => parseAnnualBudgets(input)).toThrow();
  });
});
