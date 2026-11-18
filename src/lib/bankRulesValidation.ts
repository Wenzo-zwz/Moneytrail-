/** Shared by the browser reader and the Node 24 publication check. No network or file access. */
export const BANK_RULES_PROJECT = "https://ojcgabicpjipwpvwolzn.supabase.co";
export const BANK_RULES_SCHEMA_VERSION = 1;
export const BANK_RULES_MIN_SHORTCUT_VERSION = 4;
export const BANK_RULES_MAX_PATTERN_LENGTH = 8_000;

export type BankRuleManifest = {
  schemaVersion: 1;
  version: number;
  minShortcutVersion: number;
  projectUrl: string;
  publishedAt: string;
  matchPattern: string;
};

const keys = ["schemaVersion", "version", "minShortcutVersion", "projectUrl", "publishedAt", "matchPattern"];
const positiveFixtures = [
  "尾号0000卡11月10日14:50工商银行收入(2026年10月工资)18，xxx元，余额1xxx元。【工商银行】",
  "尾号0000卡11月10日14:50工商银行收入(2026年10月工资)18,000元，余额1xxx元。【工商银行】",
  ...["工商银行", "农业银行", "中国银行", "建设银行", "招商银行"].flatMap(bank => [
    `测试消费1.00元【${bank}】`, `测试收入1.00元【${bank}】`,
  ]),
  "〖招商银行〗您账户0000于04月09日06:43在〖支付宝-示例商户〗快捷支付114.15元，余额9999.99元\u200c\ufffc",
  "您尾号1234的招行信用卡于12月24日18时4分消费人民币256.05元",
];
const negativeFixtures = [
  "", "工商银行收入100元", "收入提醒，余额100元【工商银行】",
  "收入100元【未知银行】", "收入100元【工商银行】【中国银行】",
  "【中国银行】到账100元〖未知银行〗", "〖招商银行〗转入100元（未知银行）",
  "收入100元【工商银行】额外尾注",
  "您尾号1234的招行信用卡于12月24日18时4分消费人民币256.05元【中国银行】",
  "入账100元，验\u200c证码123456【中国银行】", "〖招商银行〗到账100元\u200c更多",
  ...["验证码", "驗證碼", "校验码", "校驗碼", "动态码", "動態碼", "口令", "密码", "密碼", "oＴＰ", "ｖｅｒｉｆｉｃａｔｉｏｎ", "One Time"].map(word => `收入1.00元，${word}123456【工商银行】`),
  "备注" + "x".repeat(2_000) + "收入1.00元【工商银行】",
];

/** Browser-safe structural check: compile the syntax without executing the remote pattern. */
export function parseBankRuleManifest(value: unknown, expectedProject: string = BANK_RULES_PROJECT): BankRuleManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("规则清单格式无效。");
  const item = value as Record<string, unknown>;
  if (Object.keys(item).length !== keys.length || keys.some(key => !Object.hasOwn(item, key))) {
    throw new Error("规则清单字段不匹配。");
  }
  if (item.schemaVersion !== BANK_RULES_SCHEMA_VERSION) throw new Error("规则清单格式版本不受支持。");
  if (!Number.isSafeInteger(item.version) || (item.version as number) < 1
    || !Number.isSafeInteger(item.minShortcutVersion) || (item.minShortcutVersion as number) < BANK_RULES_MIN_SHORTCUT_VERSION) {
    throw new Error("规则或快捷指令版本无效。");
  }
  if (expectedProject !== BANK_RULES_PROJECT || item.projectUrl !== expectedProject) throw new Error("规则清单与当前项目不匹配。");
  if (typeof item.publishedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(item.publishedAt)
    || !Number.isFinite(Date.parse(item.publishedAt)) || new Date(item.publishedAt).toISOString() !== item.publishedAt) {
    throw new Error("规则发布时间无效。");
  }
  if (typeof item.matchPattern !== "string" || !item.matchPattern.length || item.matchPattern.length > BANK_RULES_MAX_PATTERN_LENGTH
    || /[\u0000-\u001f\u007f]/.test(item.matchPattern)) throw new Error("匹配规则长度或格式无效。");
  try { new RegExp(item.matchPattern, "iu"); }
  catch { throw new Error("匹配规则无法编译。"); }
  return { schemaVersion: 1, version: item.version as number, minShortcutVersion: item.minShortcutVersion as number,
    projectUrl: item.projectUrl as string, publishedAt: item.publishedAt, matchPattern: item.matchPattern };
}

/** Publisher only, inside its bounded child process; fixed cases do not prove arbitrary regex safety. */
export function validateBankRuleManifest(value: unknown, expectedProject: string = BANK_RULES_PROJECT): BankRuleManifest {
  const rule = parseBankRuleManifest(value, expectedProject);
  const pattern = new RegExp(rule.matchPattern, "iu");
  if (positiveFixtures.some(text => !pattern.test(text)) || negativeFixtures.some(text => pattern.test(text))) {
    throw new Error("匹配规则未通过固定银行与安全回归检查。");
  }
  return rule;
}
