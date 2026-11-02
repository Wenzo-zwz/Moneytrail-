import { describe, expect, it } from "vitest";
import profileSource from "../../public/shortcuts/three-bank-profile.json?raw";
import templateSource from "../../shortcuts/moneytrail-three-bank.template.json?raw";
import unsignedXml from "../../public/shortcuts/moneytrail-three-bank-v1.unsigned.plist?raw";

const profilePath = "public/shortcuts/three-bank-profile.json";
const templatePath = "shortcuts/moneytrail-three-bank.template.json";
const load = (path: string) => JSON.parse(path === profilePath ? profileSource : templateSource);

describe("three-bank shortcut source", () => {
  it("ships a bank-scoped unsigned source without an installation claim", () => {
    const profile = load(profilePath);
    expect(profile).toMatchObject({
      name: "MoneyTrail 农中建通用记账", version: 1,
      supportedBanks: ["abc", "boc", "ccb"], cardKinds: ["debit", "credit"],
      sourcePath: "/shortcuts/moneytrail-three-bank-v1.unsigned.plist",
    });
    expect(profile).not.toHaveProperty("url");
    expect(unsignedXml.startsWith("<?xml")).toBe(true);
    expect(unsignedXml).toContain("UNSIGNED SOURCE");
    expect(unsignedXml).toContain("Apple signing");
  });

  it.each([
    ["abc", "debit", "【农业银行】测试储蓄卡消费1.00元。"],
    ["abc", "credit", "测试信用卡支出1.00元【中国农业银行】"],
    ["boc", "debit", "(中国银行) 测试储蓄卡代扣1.00元。"],
    ["boc", "credit", "测试信用卡消费1.00元（中国银行）。"],
    ["ccb", "debit", "（建设银行）。 测试储蓄卡转出1.00元。"],
    ["ccb", "credit", "测试信用卡扣款1.00元 (中国建设银行)． "],
  ])("routes synthetic %s %s notifications without card-specific templates", (_bank, _card, message) => {
    expect(new RegExp(load(profilePath).matchPattern, "i").test(message)).toBe(true);
  });

  it.each([
    "测试消费验证码123456【农业银行】", "测试消费校验码123456【农业银行】",
    "测试消费动态码123456【农业银行】", "测试消费短信口令123456【农业银行】",
    "测试消费一次性密码123456【中国银行】", "测试消费oＴＰ123456【中国银行】",
    "测试消费ｖｅｒｉｆｉｃａｔｉｏｎ123【建设银行】",
    "测试消费ｏｎｅ－ｔｉｍｅ123【建设银行】", "测试消费One Time123【中国银行】",
    "测试收入1.00元【农业银行】", "农业银行测试消费1.00元",
    "测试消费1.00元【工商银行】", "测试消费1.00元【未知银行】",
    "测试消费1.00元【中国农业银行】【建设银行】",
    "【农业银行】测试消费1.00元（未知银行）",
    "测试消费1.00元【农业银行】测试尾注", "测试(中国银行)消费1.00元",
    "测试消费1.00元【农业银行)", "测试消费1.00元【农业银行】\n额外内容",
    "测试消费" + "x".repeat(2000) + "【农业银行】", "",
  ])("rejects unsafe or ambiguous synthetic text %j", message => {
    expect(new RegExp(load(profilePath).matchPattern, "i").test(message)).toBe(false);
  });

  it.each(["支出", "消费", "扣款", "扣费", "批扣", "代扣", "转出", "支取"])("accepts the independent debit keyword %s", keyword => {
    expect(new RegExp(load(profilePath).matchPattern, "i").test(`测试${keyword}1.00元【中国银行】`)).toBe(true);
  });

  it("keeps account binding blank and posts only the original text with the imported token", () => {
    const template = load(templatePath);
    const actions = template.WFWorkflowActions;
    expect(actions).toHaveLength(25);
    expect(actions[0].WFWorkflowActionParameters.WFTextActionText).toBe("");
    expect(template.WFWorkflowImportQuestions).toEqual([{
      ParameterKey: "WFTextActionText", Category: "Parameter", ActionIndex: 0,
      Text: "请粘贴你在MoneyTrail慢慢记账网页中生成的个人短信接入令牌", DefaultValue: "",
    }]);
    expect(actions[4].WFWorkflowActionIdentifier).toBe("is.workflow.actions.text.match");
    expect(actions[4].WFWorkflowActionParameters.WFMatchTextPattern).toBe(load(profilePath).matchPattern);
    expect(actions[4].WFWorkflowActionParameters.WFMatchTextCaseSensitive).toBe(false);
    const condition = actions[5].WFWorkflowActionParameters;
    expect(condition.WFCondition).toBe(100);
    expect(condition).not.toHaveProperty("WFConditions");
    expect(condition.WFInput.Variable.Value.OutputUUID).toBe(actions[4].WFWorkflowActionParameters.UUID);
    const requests = actions.filter((action: { WFWorkflowActionIdentifier: string }) => action.WFWorkflowActionIdentifier === "is.workflow.actions.downloadurl");
    expect(requests).toHaveLength(1);
    const request = requests[0].WFWorkflowActionParameters;
    expect(request.WFHTTPMethod).toBe("POST");
    expect(request.WFURL).toBe("https://ojcgabicpjipwpvwolzn.supabase.co/rest/v1/rpc/moneytrail_receive_sms");
    const fields = request.WFJSONValues.Value.WFDictionaryFieldValueItems;
    expect(fields.map((field: { WFKey: { Value: { string: string } } }) => field.WFKey.Value.string)).toEqual(["p_token", "p_message"]);
    expect(fields.map((field: { WFValue: { Value: { attachmentsByRange: Record<string, { VariableName: string }> } } }) => field.WFValue.Value.attachmentsByRange["{0, 1}"].VariableName)).toEqual(["接入令牌", "短信正文"]);
    const contents = JSON.stringify(template);
    expect(contents).not.toMatch(/mt_sms_|owner_id|user_id|last4|卡尾号|工商银行/);
  });

  it("has resolvable output references and balanced conditional groups", () => {
    const actions = load(templatePath).WFWorkflowActions;
    const defined = new Set<string>();
    const groups: string[] = [];
    const check = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      const object = value as Record<string, unknown>;
      if (typeof object.OutputUUID === "string") expect(defined.has(object.OutputUUID)).toBe(true);
      Object.values(object).forEach(check);
    };
    for (const action of actions) {
      const parameters = action.WFWorkflowActionParameters;
      check(parameters);
      if (parameters.WFControlFlowMode === 0) groups.push(parameters.GroupingIdentifier);
      if (parameters.WFControlFlowMode === 1) expect(groups.at(-1)).toBe(parameters.GroupingIdentifier);
      if (parameters.WFControlFlowMode === 2) expect(groups.pop()).toBe(parameters.GroupingIdentifier);
      if (parameters.UUID) defined.add(parameters.UUID);
    }
    expect(groups).toEqual([]);
  });

});
