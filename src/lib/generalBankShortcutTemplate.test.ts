import { describe, expect, it } from "vitest";
import profile from "../../public/shortcuts/general-bank-profile.json";
import workflow from "../../shortcuts/moneytrail-general-bank.template.json";
import unsignedXml from "../../public/shortcuts/moneytrail-general-bank-v2.unsigned.plist?raw";
import legacy from "../../public/shortcuts/three-bank-profile.json";

describe("generic bank v2 shortcut source", () => {
  it("includes CMB without claiming the legacy iCloud artifact was updated", () => {
    expect(profile).toMatchObject({ version: 2, name: "MoneyTrail 通用银行记账", url: null,
      supportedBanks: ["abc", "boc", "ccb", "cmb"], cardKinds: ["debit", "credit"],
      sourcePath: "/shortcuts/moneytrail-general-bank-v2.unsigned.plist" });
    expect(legacy.supportedBanks).toEqual(["abc", "boc", "ccb"]);
    expect(legacy.url).toBe("https://www.icloud.com/shortcuts/90ce49ad282d490481700cfe8868b82d");
    expect(unsignedXml).toContain("UNSIGNED SOURCE");
    expect(unsignedXml).toContain("Apple signing is required");
  });

  it.each([
    "【招商银行】测试储蓄卡消费1.00元。", "测试信用卡支出1.00元【招商银行】",
    "(招商银行) 测试消费1.00元。", "测试代扣1.00元（招商银行）。",
    "【农业银行】测试消费1.00元。", "测试消费1.00元【中国银行】", "测试扣款1.00元【建设银行】",
    "〖招商银行〗您账户0000于04月09日06:43在〖支付宝-示例商户〗快捷支付114.15元，余额9999.99元\u200c\ufffc\u200c\ufffc",
    "您尾号1234的招行信用卡于12月24日18时4分消费人民币256.05元",
    "您尾号1234的招行信用卡于04月09日06时03分消费人民币0.01元。",
    "您尾号1234的招行信用卡于12月24日18时4分消费人民币256.05元\u200c\ufffc",
    "您尾号xX*×的招行信用卡于12月24日18时4分消费人民币256.05元",
    "您尾号••••的招行信用卡于12月24日18时4分消费人民币256.05元",
    "您尾号１２Ｘ＊的招行信用卡于12月24日18时4分消费人民币256.05元",
  ])("routes only the included bank's signed debit text %s", message => {
    // Shortcuts uses ICU Unicode properties; JS needs u for the same semantics.
    expect(new RegExp(profile.matchPattern, "iu").test(message)).toBe(true);
  });

  it.each([
    "测试消费验证码123456【招商银行】", "测试消费oＴＰ123456【招商银行】", "测试动态码扣款1.00元【招商银行】",
    "测试消费1.00元【招商银行】【农业银行】", "【招商银行】测试消费1.00元（未知银行）",
    "测试消费1.00元【工商银行】", "测试消费1.00元【未知银行】", "招商银行测试消费1.00元",
    "测试消费1.00元【招商银行】额外尾注", "测试消费1.00元【招商银行信用卡】",
    "测试收入1.00元【招商银行】", "测试消费" + "x".repeat(2000) + "【招商银行】", "",
    "〖招商银行〗消费1元〖未知银行〗", "【招商银行】消费1元〖未知银行〗",
    "〖未知银行〗消费1元【招商银行】", "〖农业银行〗消费1元〖招商银行〗",
    "【农业银行】消费1元〖未知银行〗", "〖招商银行〗快捷支付验证码123456",
    "〖招商银行〗快捷支付验\u200c证码123456", "〖招商银行〗快捷支付O\u200cTP123456",
    "〖招商银行〗快捷支付验\u00ad证码123456", "〖招商银行〗快捷支付O\u{E0001}TP123456",
    "〖招商银行〗快捷\u200c支付114.15元", "〖招商银行〗快捷支付1元〖未知银\u200c行〗",
    "【农业银行】快捷支付1元", "快捷支付1元【中国银行】",
    "招行信用卡消费人民币256.05元", "您尾号1234的招行信用卡消费人民币256.05元",
    "您尾号1234的招行信用卡于12月24日消费人民币256.05元",
    "您尾号1234的招行信用卡于13月24日18时4分消费人民币256.05元",
    "您尾号1234的招行信用卡于12月24日24时4分消费人民币256.05元",
    "您尾号1234的招行信用卡于12月24日18时60分消费人民币256.05元",
    "您尾号1234的招行信用卡于12月24日18时4分消费人民币0元",
    "您尾号1234的招行信用卡于12月24日18时4分消费人民币256.055元",
    "您尾号1234的招行信用卡于12月24日18时4分消费人民币256.05元【未知银行】",
    "您尾号1234的招行信用卡于12月24日18时4分消费人民币256.05元验证码123456",
    "其他文案您尾号1234的招行信用卡于12月24日18时4分消费人民币256.05元",
    ...["【中国银行】", "〖招商银行〗", "【招商银行】"].flatMap(signature => [
      `您尾号1234的招行信用卡于12月24日18时4分消费人民币256.05元${signature}`,
      `${signature}您尾号1234的招行信用卡于12月24日18时4分消费人民币256.05元`,
      `您尾号xX*×的招行信用卡于12月24日18时4分消费人民币256.05元${signature}`,
      `${signature}您尾号１２Ｘ＊的招行信用卡于12月24日18时4分消费人民币256.05元`,
    ]),
  ])("rejects unsafe or ambiguous bank text %s", message => {
    expect(new RegExp(profile.matchPattern, "iu").test(message)).toBe(false);
  });

  it("changes the routing filter while keeping account binding blank and request fields unchanged", () => {
    const actions = workflow.WFWorkflowActions;
    expect(actions).toHaveLength(25);
    expect(actions[0].WFWorkflowActionParameters.WFTextActionText).toBe("");
    expect(workflow.WFWorkflowImportQuestions).toMatchObject([{ ActionIndex: 0, DefaultValue: "" }]);
    expect(actions[4].WFWorkflowActionParameters.WFMatchTextPattern).toBe(profile.matchPattern);
    expect(actions[4].WFWorkflowActionParameters.WFMatchTextCaseSensitive).toBe(false);
    const requests = actions.filter(action => action.WFWorkflowActionIdentifier === "is.workflow.actions.downloadurl");
    expect(requests).toHaveLength(1);
    expect(requests[0].WFWorkflowActionParameters).toMatchObject({ WFHTTPMethod: "POST",
      WFURL: "https://ojcgabicpjipwpvwolzn.supabase.co/rest/v1/rpc/moneytrail_receive_sms" });
    const json = JSON.stringify(workflow);
    expect(json).not.toMatch(/mt_sms_|owner_id|user_id|last4|卡尾号|工商银行/);
  });
});
