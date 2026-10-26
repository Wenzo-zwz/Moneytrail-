import { describe, expect, it } from "vitest";
import { CATEGORIES, copyTransaction, summarize, validateTransaction, type Transaction } from "./ledger";
import { applyCategoryChanges, classifyMerchant, planCategoryChanges } from "./merchantClassification";
import { emptyData, exportBackup, exportCsv, importBackup } from "./storage";
import { parseCsv, parseSms } from "./parsers";

const item = (patch: Record<string, unknown> = {}): Transaction => ({ id: "one", kind: "expense", amountCents: 2000, date: "2026-10-25T12:30", merchant: "美团", category: "本地生活", source: "sms", note: "", ...patch } as Transaction);

describe("local life metadata", () => {
  it("exposes only the new categories and accepts legacy input", () => {
    expect([...CATEGORIES]).toEqual(["本地生活", "购物", "交通", "居住", "医疗", "学习", "其他", "待分类"]);
    expect(validateTransaction(item({ category: "餐饮" }))).toBe(true);
    expect(validateTransaction(item({ category: "娱乐" }))).toBe(true);
  });
  it("validates detail, platform and bounded evidence", () => {
    expect(validateTransaction(item({ subcategory: "外卖", platform: "美团", smsEvidence: { text: "消费20元", receivedAt: "2026-10-25T04:30:00.000Z", classificationReason: "平台默认", ruleVersion: "v1" } }))).toBe(true);
    for (const patch of [{ subcategory: "" }, { subcategory: "x".repeat(41) }, { platform: "未知" }, { smsEvidence: { text: "" } }, { smsEvidence: { text: "x".repeat(3001) } }, { smsEvidence: { text: "a", receivedAt: "yesterday" } }, { smsEvidence: { text: "a", classificationReason: "x".repeat(201) } }, { smsEvidence: { text: "a", ruleVersion: "x".repeat(65) } }, { smsEvidence: { text: "a", raw: "secret" } }]) expect(validateTransaction(item(patch)), JSON.stringify(patch)).toBe(false);
  });
  it("normalizes legacy records and preserves optional metadata in JSON and CSV", () => {
    const original = item({ category: "餐饮", subcategory: "外卖", platform: "美团", smsEvidence: { text: "=消费20元,商户美团", classificationReason: "平台默认", ruleVersion: "v1" } });
    const data = importBackup(JSON.stringify({ ...emptyData(), transactions: [original] }));
    expect(data.transactions[0]).toEqual({ ...original, category: "本地生活" });
    expect(importBackup(exportBackup(data))).toEqual(data);
    expect(parseCsv(exportCsv(data.transactions)).drafts[0]).toEqual((({ id: _id, ...draft }) => draft)(data.transactions[0]));
    expect(importBackup(JSON.stringify({ ...emptyData(), transactions: [item({ category: "娱乐" })] })).transactions[0]).toMatchObject({ category: "本地生活", subcategory: "休闲娱乐" });
  });
  it("copies only supported fields and never admits unrelated raw message keys", () => {
    const original = item({ extra: "ignore", raw_text: "private", smsEvidence: { text: "脱敏凭据" } });
    const copy = copyTransaction(original);
    expect(copy).not.toHaveProperty("extra");
    expect(copy).not.toHaveProperty("raw_text");
    expect(importBackup(exportBackup({ ...emptyData(), transactions: [original] })).transactions[0]).toEqual(copy);
    copy.smsEvidence!.text = "独立副本";
    expect(original.smsEvidence!.text).toBe("脱敏凭据");
  });
  it("groups detail net totals, including unknown and cross-month refunds", () => {
    const result = summarize([item({ category: "餐饮" }), item({ id: "two", subcategory: "外卖", amountCents: 1000 }), item({ id: "three", amountCents: 500 }), item({ id: "refund", kind: "refund", subcategory: "外卖", amountCents: 300 })], "2026-10", 10000);
    expect(result.categories).toEqual([{ category: "本地生活", amountCents: 3200, subcategories: [{ subcategory: "餐饮", amountCents: 2000 }, { subcategory: "外卖", amountCents: 700 }, { subcategory: "未细分", amountCents: 500 }] }]);
  });
  it("classifies platform defaults and precise purposes without inventing detail", () => {
    expect(classifyMerchant("美团", [{ merchant: "美团", category: "餐饮" }])).toMatchObject({ category: "本地生活", platform: "美团" });
    expect(classifyMerchant("美团").subcategory).toBeUndefined();
    expect(classifyMerchant("美团-示例科技有限公司").category).toBe("待分类");
    expect(classifyMerchant("美团外卖")).toMatchObject({ category: "本地生活", subcategory: "外卖", platform: "美团" });
    expect(classifyMerchant("美团-舒心按摩")).toMatchObject({ category: "本地生活", subcategory: "按摩足疗", platform: "美团" });
    expect(classifyMerchant("淘宝教材")).toMatchObject({ category: "学习", subcategory: "教材", platform: "淘宝" });
    expect(classifyMerchant("京东")).toMatchObject({ category: "购物", platform: "京东" });
    expect(classifyMerchant("京东").subcategory).toBeUndefined();
    expect(classifyMerchant("美团咖啡", [{ merchant: "美团咖啡", category: "购物" }]).subcategory).toBeUndefined();
    expect(classifyMerchant("康复医院按摩", [{ merchant: "康复医院按摩", category: "本地生活" }]).subcategory).toBeUndefined();
  });
  it("compares evidence by value regardless of property order", () => {
    const data = { ...emptyData(), transactions: [item({ category: "待分类", smsEvidence: { text: "凭据", classificationReason: "未匹配" } })] };
    const changes = planCategoryChanges(data);
    const equivalent = { ...data, transactions: [item({ category: "待分类", smsEvidence: { classificationReason: "未匹配", text: "凭据" } })] };
    expect(() => applyCategoryChanges(equivalent, changes)).not.toThrow();
  });
  it("keeps independent nested evidence in previews and allows equivalent object reads", () => {
    const data = { ...emptyData(), transactions: [item({ category: "待分类", smsEvidence: { text: "脱敏凭据" } })] };
    const changes = planCategoryChanges(data);
    expect(changes).toHaveLength(1);
    expect(applyCategoryChanges(structuredClone(data), changes).transactions[0]).toMatchObject({ category: "本地生活", smsEvidence: { text: "脱敏凭据" } });
    data.transactions[0].smsEvidence!.text = "最新凭据";
    expect(changes[0].before.smsEvidence!.text).toBe("脱敏凭据");
    expect(() => applyCategoryChanges(data, changes)).toThrow(/改变|更新/);
  });
  it.each([
    "【测试银行】尾号1234卡于2026-10-25 12:30在美团消费人民币20.00元，余额1,234.56元。",
    "【测试银行】尾号１２３４卡于2026-10-25 12:30在美团消费人民币20.00元，可用余额人民币１，２３４．５６元。",
    "【测试银行】卡号**** 1234于2026-10-25 12:30在美团消费人民币20.00元，账户余额为￥1,234.56元。",
  ])("retains masked evidence from a future pasted SMS: %s", text => {
    const draft = parseSms(text).draft;
    expect(draft).toMatchObject({ amountCents: 2000, category: "本地生活", platform: "美团" });
    expect(draft?.smsEvidence?.text).toContain("20.00元");
    expect(draft?.smsEvidence?.text).toContain("测试银行");
    expect(draft?.smsEvidence?.text).not.toMatch(/1234|１２３４|1,234\.56|１，２３４．５６/);
    expect(draft?.smsEvidence?.classificationReason).toBeTruthy();
    expect(draft?.smsEvidence?.ruleVersion).toBeTruthy();
    expect(draft?.smsEvidence?.receivedAt).toBeUndefined();
  });
  it("accepts harmless surrounding whitespace without retaining it as oversized evidence", () => {
    expect(() => parseSms(" ".repeat(3001) + "2026-10-25 12:30在美团消费20元。" + " ".repeat(3001))).not.toThrow();
  });
});
