import { describe, expect, it } from "vitest";
import cases from "./merchantClassification.cases.json";
import { applyCategoryChanges, classifyMerchant, merchantKey, planCategoryChanges } from "./merchantClassification";
import { emptyData } from "./storage";
import type { Transaction } from "./ledger";

const transaction = (id: string, merchant: string, category = "待分类", kind: Transaction["kind"] = "expense"): Transaction => ({
  id, merchant, category, kind, amountCents: 2000, date: "2026-10-24T00:59", source: "sms", note: "保留备注", sourceRef: `ref-${id}`,
});

describe("merchant classification", () => {
  it.each(cases)("classifies $merchant as $category (review=$review)", ({ merchant, category, review }) => {
    expect(classifyMerchant(merchant)).toMatchObject({ category, requiresReview: review });
  });
  it("normalizes payment prefixes, fullwidth parentheses and Latin case without merging stores", () => {
    expect(merchantKey(" 消费财付通-示例商贸（烟酒副食） ")).toBe("示例商贸(烟酒副食)");
    expect(merchantKey("消费支付宝-ABC(东店)")).toBe(merchantKey("微信支付-abc（东店）"));
    expect(merchantKey("ABC(东店)")).not.toBe(merchantKey("ABC(西店)"));
    expect(merchantKey("支付宝")).toBe("");
    expect(merchantKey("财付通-群收款")).toBe("");
    expect(merchantKey("转账张三")).toBe("");
  });
  it("remembers only explicit exact merchant rules and never bypasses ambiguity", () => {
    const rules = [{ merchant: "示例科技有限公司", category: "娱乐" }, { merchant: "财付通-群收款", category: "餐饮" }];
    expect(classifyMerchant("消费财付通-示例科技有限公司", rules)).toMatchObject({ category: "娱乐", reason: "个人商户规则" });
    expect(classifyMerchant("示例科技有限公司东店", rules).category).toBe("待分类");
    expect(classifyMerchant("财付通-群收款", rules)).toMatchObject({ category: "待分类", requiresReview: true });
    expect(classifyMerchant("转账-示例科技有限公司", rules).requiresReview).toBe(true);
    expect(classifyMerchant("示例科技有限公司", [{ merchant: "示例科技有限公司", category: "无效类别" }]).category).toBe("待分类");
  });
});

describe("category backfill", () => {
  it("previews only uncategorized expenses without changing existing data", () => {
    const data = { ...emptyData(), budgetCents: 50000, billCheckedMonths: ["2026-10", "2026-09"], transactions: [
      transaction("ride", "滴滴出租车"), transaction("meal", "美团"), transaction("manual", "滴滴出租车", "其他"),
      transaction("group", "财付通-群收款"), transaction("unknown", "示例商店"), transaction("transfer", "滴滴", "待分类", "transfer"),
      transaction("refund", "滴滴", "待分类", "refund"),
    ] };
    const original = structuredClone(data);
    const changes = planCategoryChanges(data);
    expect(changes.map(change => [change.id, change.toCategory])).toEqual([["ride", "交通"], ["meal", "餐饮"]]);
    expect(data).toEqual(original);
    const next = applyCategoryChanges(data, changes);
    expect(next.transactions).toHaveLength(data.transactions.length);
    expect(next.transactions[0]).toEqual({ ...data.transactions[0], category: "交通" });
    expect(next.transactions[2]).toEqual(data.transactions[2]);
    expect(next.budgetCents).toBe(50000);
    expect(next.billCheckedMonths).toEqual(["2026-09"]);
    expect(data).toEqual(original);
    expect(planCategoryChanges(next)).toEqual([]);
    expect(applyCategoryChanges(next, changes, true).transactions).toEqual(data.transactions);
  });
  it("rejects stale apply and stale undo instead of overwriting a later edit", () => {
    const data = { ...emptyData(), transactions: [transaction("ride", "滴滴出租车")] };
    const changes = planCategoryChanges(data);
    expect(() => applyCategoryChanges({ ...data, transactions: [{ ...data.transactions[0], amountCents: 2100 }] }, changes)).toThrow(/改变|更新/);
    const next = applyCategoryChanges(data, changes);
    expect(() => applyCategoryChanges({ ...next, transactions: [{ ...next.transactions[0], category: "娱乐" }] }, changes, true)).toThrow(/改变|更新/);
    expect(() => applyCategoryChanges({ ...next, transactions: [] }, changes, true)).toThrow(/改变|更新/);
  });
  it("allows unrelated new records during undo and rejects duplicate selections", () => {
    const data = { ...emptyData(), transactions: [transaction("ride", "滴滴出租车")] };
    const changes = planCategoryChanges(data);
    const next = applyCategoryChanges(data, changes);
    const extra = transaction("new", "另一商店", "购物");
    expect(applyCategoryChanges({ ...next, transactions: [...next.transactions, extra] }, changes, true).transactions).toEqual([...data.transactions, extra]);
    expect(() => applyCategoryChanges(data, [...changes, ...changes])).toThrow();
  });
});
