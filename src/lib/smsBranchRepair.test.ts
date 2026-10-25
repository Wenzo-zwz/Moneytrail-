import { describe, expect, it } from "vitest";
import { repairMissingBranchBracket } from "./smsBranchRepair";
import { parseSms } from "./parsers";

const message = (merchant: string, amount = "88", balance = "12,345.94") => `尾号xxxx卡10月24日21:17支出(${merchant})${amount}元，余额${balance}元。【工商银行】`;
const raw = message("消费财付通-示例台球俱乐部（青年路店");

describe("one missing fullwidth branch bracket", () => {
  it("repairs only the missing branch close, preserving the bank event and independent amount", () => {
    expect(repairMissingBranchBracket(raw)).toBe(message("消费财付通-示例台球俱乐部（青年路店）"));
    expect(parseSms(raw, new Date(2026, 9, 24, 22)).draft).toMatchObject({ kind: "expense", amountCents: 8800, merchant: "消费财付通-示例台球俱乐部(青年路店)", category: "娱乐" });
  });
  it.each(["青年路店", "青年路分店", "中心营业部", "测试支行"])("accepts an explicit branch label: %s", label => {
    const text = message(`消费示例商户（${label}`);
    expect(repairMissingBranchBracket(text)).toBe(message(`消费示例商户（${label}）`));
  });
  it("leaves already balanced ASCII and fullwidth merchant text unchanged", () => {
    for (const text of [message("示例台球(青年路店)"), message("示例台球（青年路店）")]) expect(repairMissingBranchBracket(text)).toBe(text);
  });
  it.each(["商户(青年路店", "商户（一般描述", "商户（分店（青年路店", "商户）青年路店", `商户（${"长".repeat(41)}店`])("does not repair unsupported merchant damage: %s", merchant => {
    const text = message(merchant);
    expect(repairMissingBranchBracket(text)).toBe(text);
    expect(parseSms(text, new Date(2026, 9, 24, 22)).draft).toBeNull();
  });
  it("requires a complete bank envelope and never accepts an additional event or malformed debit", () => {
    for (const text of [raw.replace("工商银行", "建设银行"), raw.replace(")88元", "88元"), raw + raw, message("商户（青年路店", "88.001"), message("商户（青年路店", "8,8")]) expect(repairMissingBranchBracket(text)).toBe(text);
  });
  it("cannot turn group collections and personal transfers into clear expenses", () => {
    for (const merchant of ["转账财付通-群收款（青年路店", "转账-张三（青年路店"]) expect(parseSms(message(merchant), new Date(2026, 9, 24, 22)).requiresReview).toBe(true);
  });
});
