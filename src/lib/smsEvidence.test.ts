import { describe, expect, it } from "vitest";
import { buildSmsEvidence, redactSmsEvidence } from "./smsEvidence";

describe("retained SMS masking", () => {
  it.each([
    "尾号1234卡", "尾号为１２３４的信用卡", "卡号**** 1234", "卡号6222-1234-5678-9012", "账号6222 1234 5678 9012", "您1234账户", "银行卡（１２３４）",
  ])("hides a supported card identifier: %s", value => {
    expect(redactSmsEvidence(value)).not.toMatch(/1234|１２３４|6222|5678|9012/);
  });
  it.each(["余额1,234.56元", "可用余额人民币１，２３４．５６元", "账户余额为￥1,234.56元", "余额xxxx.86元", "余额8xxxx元", "余额：RMB 12 345.67元"])("hides the complete balance: %s", value => {
    expect(redactSmsEvidence(value)).toContain("[已隐藏]");
    expect(redactSmsEvidence(value)).not.toMatch(/\d|xxxx/);
  });
  it("preserves merchant digits, debit amount, date and signature", () => {
    const text = "尾号1234卡2026-10-25 12:30在123号便利店消费20.00元，余额999.99元。【测试银行】";
    expect(redactSmsEvidence(text)).toContain("2026-10-25 12:30在123号便利店消费20.00元");
    expect(redactSmsEvidence(text)).toContain("【测试银行】");
  });
  it.each(["信用卡1234", "储蓄卡１２３４", "借记卡1234", "银行卡6222 1234 5678 9012", "账户1234"])("masks identifiers written after a specific account label: %s", account => {
    const text = `【测试银行】您${account}于2026-10-25 12:30在美团消费20元，余额100元。`;
    const masked = redactSmsEvidence(text);
    expect(masked).not.toMatch(/1234|１２３４|6222|5678|9012|100元/);
    expect(masked).toContain("于2026-10-25 12:30在美团消费20元");
    expect(masked).toContain("【测试银行】");
  });
  it("keeps digits in a kart merchant's name", () => {
    expect(redactSmsEvidence("在1234卡丁车消费20元，余额100元。")).toContain("在1234卡丁车消费20元");
  });
  it.each(["卡1234于", "卡１２３４在", "卡：1234消费"])("masks a bare card identifier followed by a transaction event: %s", account => {
    const text = `您的${account}2026年10月25日12:00在1234卡丁车支出20元，余额200元。【工商银行】`;
    const masked = redactSmsEvidence(text);
    expect(masked).toMatch(/卡:?\[已隐藏\]/);
    expect(masked).toContain("2026年10月25日12:00在1234卡丁车支出20元");
    expect(masked).not.toContain("200元");
    expect(redactSmsEvidence(masked)).toBe(masked);
  });
  it("retains explicit entry context and rejects invalid evidence bounds", () => {
    expect(buildSmsEvidence("消费20元", { receivedAt: "2026-10-25T04:30:00.000Z", classificationReason: "人工确认：本地生活" })).toEqual({ text: "消费20元", receivedAt: "2026-10-25T04:30:00.000Z", classificationReason: "人工确认：本地生活", ruleVersion: "local-life-v1" });
    expect(() => buildSmsEvidence(" ")).toThrow();
    expect(() => buildSmsEvidence("x".repeat(3001))).toThrow();
  });
});
