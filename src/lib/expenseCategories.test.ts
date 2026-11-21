import { describe, expect, it } from "vitest";
import { normalizeTransactionCategory } from "./ledger";
import { classifyMerchant } from "./merchantClassification";
import { canOfferMerchantMemory } from "../components/merchantMemory";
import { importBackup } from "./storage";

describe("expense taxonomy compatibility", () => {
  it("maps a confirmed old purpose without guessing a platform or mixed retailer", () => {
    expect(normalizeTransactionCategory({ category: "本地生活", subcategory: "外卖" }))
      .toEqual({ category: "食品酒水", subcategory: "外卖" });
    expect(normalizeTransactionCategory({ category: "购物", subcategory: "超市便利" }))
      .toEqual({ category: "待分类", subcategory: "超市便利" });
    expect(normalizeTransactionCategory({ category: "本地生活" }))
      .toEqual({ category: "待分类" });
  });

  it("uses exact purchase evidence and learns an explicit expense correction", () => {
    expect(classifyMerchant("美团外卖")).toMatchObject({ category: "食品酒水", subcategory: "外卖" });
    expect(classifyMerchant("美团")).toMatchObject({ category: "待分类", requiresReview: true });
    expect(classifyMerchant("社区超市")).toMatchObject({ category: "待分类", requiresReview: true });
    expect(classifyMerchant("农贸市场买菜")).toMatchObject({ category: "食品酒水", subcategory: "买菜食材" });
    const draft = { kind: "expense", source: "sms", amountCents: 6800, date: "2026-11-21T12:00", merchant: "某餐厅", note: "", category: "食品酒水", subcategory: "堂食聚餐" } as const;
    expect(canOfferMerchantMemory(draft, { ...draft, subcategory: "外卖" }, true)).toBe(true);
    expect(classifyMerchant("财付通-某餐厅", [{ merchant: "某餐厅", category: "食品酒水", subcategory: "外卖" }]))
      .toMatchObject({ category: "食品酒水", subcategory: "外卖", reason: "个人商户规则" });
  });

  it("reads v1 books and keeps money, evidence, and linked refund purpose", () => {
    const expense = { id: "e", kind: "expense", source: "sms", amountCents: 6800, date: "2026-10-20T12:00", merchant: "美团", note: "午饭", category: "本地生活", subcategory: "外卖", smsEvidence: { text: "已脱敏" } };
    const refund = { ...expense, id: "r", kind: "refund", date: "2026-11-20T12:00", amountCents: 1500, linkedTransactionId: "e", subcategory: undefined };
    const restored = importBackup(JSON.stringify({ version: 1, transactions: [expense, refund], budgetCents: 10000, billCheckedMonths: [] }));
    expect(restored.transactions).toEqual([
      { ...expense, category: "食品酒水" },
      { ...refund, category: "食品酒水", subcategory: "外卖" },
    ]);
  });
});
