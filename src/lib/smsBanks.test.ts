import { describe, expect, expectTypeOf, it } from "vitest";
import { getSmsBank, SMS_BANKS, type SmsBankCode } from "./smsBanks";

describe("registered SMS banks", () => {
  it("registers exactly the four agreed banks with stable codes and names", () => {
    expectTypeOf<SmsBankCode>().toEqualTypeOf<"icbc" | "abc" | "boc" | "ccb">();
    expectTypeOf(getSmsBank).parameter(0).toEqualTypeOf<SmsBankCode>();
    expect(SMS_BANKS.map(({ code, name }) => ({ code, name }))).toEqual([
      { code: "icbc", name: "工商银行" },
      { code: "abc", name: "农业银行" },
      { code: "boc", name: "中国银行" },
      { code: "ccb", name: "建设银行" },
    ]);
  });

  it.each([
    { code: "icbc", signatureNames: ["工商银行"], senderExamples: ["95588"], reviewOnly: false },
    { code: "abc", signatureNames: ["中国农业银行", "农业银行"], senderExamples: ["95599", "1069095599", "10690955998"], reviewOnly: true },
    { code: "boc", signatureNames: ["中国银行"], senderExamples: ["95566"], reviewOnly: true },
    { code: "ccb", signatureNames: ["中国建设银行", "建设银行"], senderExamples: ["95533", "106980095533"], reviewOnly: true },
  ] as const)("keeps $code signatures, official sender examples and review status explicit", expected => {
    expect(getSmsBank(expected.code)).toMatchObject(expected);
  });

  it("returns the registered member for each valid bank code", () => {
    for (const bank of SMS_BANKS) expect(getSmsBank(bank.code)).toBe(bank);
  });

  it.each(["cmb", "", "ICBC", "农业银行", "__proto__"])("rejects unsupported code %j without substituting another bank", code => {
    expect(() => getSmsBank(code as SmsBankCode)).toThrow("不支持的短信银行");
  });
});
