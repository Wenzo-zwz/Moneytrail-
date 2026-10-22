import { describe, expect, it } from "vitest";
import { planLegacyMigration } from "./accountMigration";
import type { Transaction } from "./ledger";
import { emptyData, type AppData } from "./storage";

const expense = (id: string, overrides: Partial<Transaction> = {}): Transaction => ({
  id, kind: "expense", amountCents: 1800, date: "2026-10-20T12:30",
  merchant: "午餐", category: "餐饮", source: "manual", note: "", ...overrides,
});
const book = (transactions: Transaction[], overrides: Partial<AppData> = {}): AppData => ({
  ...emptyData(), transactions, ...overrides,
});

describe("explicit legacy account migration planning", () => {
  it("copies a validated plan without changing either input", () => {
    const legacy = book([expense("old")], { budgetCents: 50000, billCheckedMonths: ["2026-09"] });
    const current = book([expense("account", { date: "2026-09-01T10:00" })], {
      billCheckedMonths: ["2026-09", "2026-10"],
    });
    const before = JSON.stringify({ legacy, current });
    const result = planLegacyMigration(legacy, current);
    expect(result).toEqual({
      data: book([expense("account", { date: "2026-09-01T10:00" }), expense("old")], {
        budgetCents: 50000, billCheckedMonths: ["2026-09"],
      }),
      added: 1, duplicates: 0, renamed: 0,
    });
    expect(JSON.stringify({ legacy, current })).toBe(before);
    result.data.transactions[0].merchant = "修改结果";
    expect(current.transactions[0].merchant).toBe("午餐");
  });

  it("only skips identical IDs and content, preserving a nonzero account budget", () => {
    const same = expense("same", { sourceRef: "bill-123" });
    const result = planLegacyMigration(book([same, expense("other")], { budgetCents: 100 }),
      book([same], { budgetCents: 300, billCheckedMonths: ["2026-10"] }));
    expect(result.added).toBe(1);
    expect(result.duplicates).toBe(1);
    expect(result.renamed).toBe(0);
    expect(result.data.transactions.map((item) => item.id)).toEqual(["same", "other"]);
    expect(result.data.budgetCents).toBe(300);
    expect(result.data.billCheckedMonths).toEqual([]);
  });

  it("keeps checked months when every imported transaction is already present", () => {
    const current = book([expense("same")], { billCheckedMonths: ["2026-10"] });
    expect(planLegacyMigration(current, current)).toEqual({
      data: current, added: 0, duplicates: 1, renamed: 0,
    });
  });

  it("renames colliding purchases and rebases their refunds regardless of input order", () => {
    const refund = expense("refund", { kind: "refund", amountCents: 500, linkedTransactionId: "purchase" });
    const current = book([expense("purchase", { merchant: "另一笔消费" }), refund]);
    const legacy = book([refund, expense("purchase")]);
    const ids = ["purchase", "refund", "new-purchase", "new-refund"];
    const result = planLegacyMigration(legacy, current, () => ids.shift()!);
    expect(result).toMatchObject({ added: 2, duplicates: 0, renamed: 2 });
    expect(result.data.transactions).toEqual([
      ...current.transactions,
      { ...refund, id: "new-refund", linkedTransactionId: "new-purchase" },
      expense("new-purchase"),
    ]);
  });

  it("keeps an existing exact expense and refund instead of cloning them", () => {
    const purchase = expense("purchase");
    const refund = expense("refund", { kind: "refund", linkedTransactionId: "purchase" });
    const result = planLegacyMigration(book([refund, purchase]), book([purchase, refund]));
    expect(result).toMatchObject({ added: 0, duplicates: 2, renamed: 0 });
    expect(result.data.transactions).toEqual([purchase, refund]);
  });

  it("does not duplicate renamed purchases or rebased refunds when migration is repeated", () => {
    const refund = expense("refund", { kind: "refund", linkedTransactionId: "purchase" });
    const current = book([expense("purchase", { merchant: "账号已有消费" }), refund]);
    const legacy = book([refund, expense("purchase")]);
    const first = planLegacyMigration(legacy, current);
    expect(first).toMatchObject({ added: 2, duplicates: 0, renamed: 2 });
    const second = planLegacyMigration(legacy, first.data);
    expect(second).toEqual({ data: first.data, added: 0, duplicates: 2, renamed: 0 });
    const purchaseId = first.data.transactions[3].id;
    expect(first.data.transactions[2].linkedTransactionId).toBe(purchaseId);
  });

  it("preserves different content under a generated ID and remains repeatable after retrying", () => {
    const legacy = book([expense("purchase")]);
    const current = book([expense("purchase", { merchant: "账号已有消费" })]);
    const generated = planLegacyMigration(legacy, current).data.transactions[1];
    const withCollision = book([...current.transactions, { ...generated, note: "不同账目占用编号" }]);
    const result = planLegacyMigration(legacy, withCollision);
    expect(result).toMatchObject({ added: 1, duplicates: 0, renamed: 1 });
    expect(result.data.transactions.slice(0, 2)).toEqual(withCollision.transactions);
    expect(result.data.transactions[2].id).not.toBe(generated.id);
    expect(planLegacyMigration(legacy, result.data)).toEqual({
      data: result.data, added: 0, duplicates: 1, renamed: 0,
    });
  });

  it("reserves future legacy IDs when allocating replacements", () => {
    const legacy = book([expense("collision"), expense("later")]);
    const current = book([expense("collision", { note: "不同内容" })]);
    const ids = ["later", "collision", "replacement"];
    const result = planLegacyMigration(legacy, current, () => ids.shift()!);
    expect(result.data.transactions.map((item) => item.id)).toEqual(["collision", "replacement", "later"]);
  });

  it("fails safely if the ID factory cannot produce a valid unique ID", () => {
    const legacy = book([expense("collision")]);
    const current = book([expense("collision", { note: "不同内容" })]);
    expect(() => planLegacyMigration(legacy, current, () => "collision")).toThrow("无法为迁移账目生成独立编号");
    expect(current.transactions).toEqual([expense("collision", { note: "不同内容" })]);
  });

  it("rejects invalid input, including broken refund links, before merging", () => {
    expect(() => planLegacyMigration(book([expense("x", { amountCents: -1 })]), emptyData())).toThrow();
    expect(() => planLegacyMigration(emptyData(), book([expense("x", { kind: "refund", linkedTransactionId: "missing" })]))).toThrow();
  });
});
