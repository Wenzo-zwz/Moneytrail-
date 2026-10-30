import { describe, expect, it } from "vitest";
import type { DraftTransaction } from "../lib/ledger";
import { canOfferMerchantMemory } from "./merchantMemory";

const original: DraftTransaction = { kind: "expense", amountCents: 1200, date: "2026-10-22T12:30", merchant: "巷口体验馆(城东店)", category: "待分类", source: "sms", note: "" };
const selected = { ...original, category: "本地生活", subcategory: "桌游聚会" };

describe("explicit merchant memory choice", () => {
  it("offers safe unknown merchant after an explicit category/detail change", () => {
    expect(canOfferMerchantMemory(original, selected, true)).toBe(true);
    expect(canOfferMerchantMemory(original, selected, false)).toBe(false);
    expect(canOfferMerchantMemory(original, { ...original, note: "仅补备注" }, true)).toBe(false);
  });
  it("does not teach from raw import categories, known merchants or renamed unsafe originals", () => {
    expect(canOfferMerchantMemory(selected, selected, true)).toBe(false);
    expect(canOfferMerchantMemory({ ...original, merchant: "财付通-群收款" }, selected, true)).toBe(false);
    expect(canOfferMerchantMemory(original, { ...selected, merchant: "巷口体验馆(城西店)" }, true)).toBe(false);
    const known = { ...original, merchant: "巷口咖啡" };
    expect(canOfferMerchantMemory(known, { ...known, category: "购物" }, true)).toBe(false);
  });
  it("allows new safe merchants and explicit corrections of a saved personal rule", () => {
    expect(canOfferMerchantMemory({ ...original, merchant: "" }, selected, true, [], true)).toBe(true);
    const known = { ...original, merchant: "巷口咖啡", category: "本地生活", subcategory: "咖啡奶茶" };
    expect(canOfferMerchantMemory(known, { ...known, subcategory: "公司招待" }, true, [{ merchant: known.merchant, category: known.category, subcategory: known.subcategory }])).toBe(true);
  });
  it("excludes platforms and non-expense originals even when renamed", () => {
    expect(canOfferMerchantMemory(original, { ...selected, kind: "transfer" }, true)).toBe(false);
    expect(canOfferMerchantMemory({ ...original, kind: "transfer" }, selected, true)).toBe(false);
    expect(canOfferMerchantMemory({ ...original, merchant: "支付宝" }, { ...selected, merchant: "支付宝" }, true)).toBe(false);
  });
});
