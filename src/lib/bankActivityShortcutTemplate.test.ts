import { describe, expect, it } from "vitest";
import profile from "../../public/shortcuts/bank-activity-profile.json";
import workflow from "../../shortcuts/moneytrail-bank-activity.template.json";
import previousWorkflow from "../../shortcuts/moneytrail-general-bank.template.json";
import previousProfile from "../../public/shortcuts/general-bank-profile.json";
import legacyProfile from "../../public/shortcuts/three-bank-profile.json";
import unsignedXml from "../../public/shortcuts/moneytrail-bank-activity-v3.unsigned.plist?raw";

// Shortcuts uses ICU Unicode properties; JS needs u for the same semantics.
const matches = (message: string) => new RegExp(profile.matchPattern, "iu").test(message);
const maskedSalary = "尾号0000卡11月10日14:50工商银行收入(2026年10月工资)18，xxx元，余额1xxx元。【工商银行】";
const syntheticSalary = maskedSalary.replace("18，xxx", "18,000");

describe("five-bank income and expense v3 shortcut source", () => {
  it("keeps the income-capable artifact separate from published expense installers", () => {
    expect(profile).toMatchObject({ version: 3, name: "MoneyTrail 银行收支记账", url: null,
      supportedBanks: ["icbc", "abc", "boc", "ccb", "cmb"], cardKinds: ["debit", "credit"],
      transactionKinds: ["expense", "income"], incomeReviewOnly: true,
      sourcePath: "/shortcuts/moneytrail-bank-activity-v3.unsigned.plist" });
    expect(previousProfile).toMatchObject({ version: 2, url: null, supportedBanks: ["abc", "boc", "ccb", "cmb"] });
    expect(legacyProfile).toMatchObject({ version: 1, supportedBanks: ["abc", "boc", "ccb"],
      url: "https://www.icloud.com/shortcuts/90ce49ad282d490481700cfe8868b82d" });
    for (const message of [maskedSalary, syntheticSalary, "测试收入1.00元【农业银行】"]) {
      expect(new RegExp(previousProfile.matchPattern, "iu").test(message)).toBe(false);
      expect(new RegExp(legacyProfile.matchPattern, "i").test(message)).toBe(false);
    }
    expect(unsignedXml).toContain("UNSIGNED SOURCE");
    expect(unsignedXml).toContain("Apple signing is required");
  });

  it.each([
    maskedSalary, syntheticSalary,
    "收入（工资）人民币18,000.00元，余额99999元【中国工商银行】",
    "【农业银行】测试账户入账人民币100.01元，余额200元。",
    "测试账户到账: CNY 100.01元（中国银行）",
    "（中国建设银行）测试账户存入金额为100.01元。",
    "〖招商银行〗测试账户转入（工资）金额：100.01元。",
    "收入RMB100.01元【招商银行】", "入账金额100.01元【建设银行】",
    "【中国银行】测试到账１００．０１元。", "存入18，xxx元【农业银行】",
    "收入×××元【工商银行】", "入账＊＊＊元【中国银行】",
    "到账•••元【建设银行】", "转入（用途待确认）100.00元【招商银行】",
  ])("routes a signed income candidate for review without parsing or guessing %s", message => {
    expect(matches(message)).toBe(true);
  });

  it.each([
    "【工商银行】测试储蓄卡支出1.00元。", "测试信用卡消费1.00元【中国工商银行】",
    "【农业银行】测试消费1.00元。", "测试代扣1.00元【中国银行】", "测试扣款1.00元【建设银行】",
    "【招商银行】测试消费1.00元。",
    "〖招商银行〗您账户0000于04月09日06:43在〖支付宝-示例商户〗快捷支付114.15元，余额9999.99元\u200c\ufffc\u200c\ufffc",
    "您尾号1234的招行信用卡于12月24日18时4分消费人民币256.05元",
    "您尾号xX*×的招行信用卡于12月24日18时4分消费人民币256.05元",
  ])("retains supported expense routing %s", message => {
    expect(matches(message)).toBe(true);
  });

  it.each([
    "", "工商银行收入100元", "测试到账100元【未知银行】",
    "收入提醒，余额100元【工商银行】", "账户到账，余额100元【农业银行】",
    "入账明细查询100元【中国银行】", "存入金额待查询，余额100元【建设银行】",
    "收入(工资)余额100元【招商银行】", "转入人民币100【招商银行】",
    "收入100美元【工商银行】", "收入USD100元【中国银行】",
    "您尾号1234的招行信用卡于12月24日18时4分收入人民币256.05元",
    "【工商银行】收入验证码123456元", "到账oＴＰ123456元【农业银行】",
    "入账验\u200c证码123456元【中国银行】", "〖招商银行〗到\u200c账100元",
    "收入100元【工商银行】【中国银行】", "【中国银行】到账100元〖未知银行〗",
    "〖招商银行〗转入100元（未知银行）", "收入100元【工商银行】额外尾注",
    "收入" + "x".repeat(2000) + "元【工商银行】",
    ...["【中国银行】", "〖招商银行〗", "【招商银行】"].flatMap(signature => [
      `您尾号1234的招行信用卡于12月24日18时4分消费人民币256.05元${signature}`,
      `${signature}您尾号xX*×的招行信用卡于12月24日18时4分消费人民币256.05元`,
    ]),
  ])("does not submit unsafe, unsigned or unrelated text %s", message => {
    expect(matches(message)).toBe(false);
  });

  it("changes only the existing routing rule and keeps the blank token and request graph", () => {
    const expected = structuredClone(previousWorkflow);
    expected.WFWorkflowActions[4].WFWorkflowActionParameters.WFMatchTextPattern = profile.matchPattern;
    expect(workflow).toEqual(expected);
    expect(workflow.WFWorkflowActions).toHaveLength(25);
    expect(workflow.WFWorkflowActions[0].WFWorkflowActionParameters.WFTextActionText).toBe("");
    expect(workflow.WFWorkflowImportQuestions).toMatchObject([{ ActionIndex: 0, DefaultValue: "" }]);
    expect(workflow.WFWorkflowActions[4].WFWorkflowActionParameters.WFMatchTextCaseSensitive).toBe(false);
    expect(JSON.stringify(workflow)).not.toMatch(/mt_sms_|owner_id|user_id|last4|卡尾号/);
  });
});
