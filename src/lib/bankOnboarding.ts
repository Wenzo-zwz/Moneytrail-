import profile from "../../public/shortcuts/three-bank-profile.json";
import generalProfile from "../../public/shortcuts/general-bank-profile.json";
import { isShortcutTemplateCompatible, SMS_SHORTCUT_TEMPLATE } from "./shortcutTemplate";
import type { SmsBankCode } from "./smsBanks";

export const THREE_BANK_TEMPLATE = profile;
export const GENERAL_BANK_TEMPLATE = generalProfile;

type GenericBankProfile = {
  name: string; url: string | null; projectUrl: string; version: number;
  supportedBanks: readonly string[]; sourcePath: string; matchPattern: string;
};

type SmsShortcutTemplate = {
  name: string;
  url: string;
  projectUrl: string;
  version: number;
  supportedBanks: readonly string[];
};

export function getCompatibleSmsShortcutTemplate(projectUrl: string, bankCode: SmsBankCode): SmsShortcutTemplate | null {
  if (isShortcutTemplateCompatible(projectUrl, bankCode)) return SMS_SHORTCUT_TEMPLATE;
  // Compare the complete address without parsing away paths, credentials or ports.
  for (const template of [GENERAL_BANK_TEMPLATE, THREE_BANK_TEMPLATE] as readonly GenericBankProfile[]) {
    if (projectUrl.replace(/\/$/, "").toLowerCase() === template.projectUrl
      && template.supportedBanks.includes(bankCode) && template.url) return template as SmsShortcutTemplate;
  }
  return null;
}

export function getGenericSmsShortcutSource(bankCode: Exclude<SmsBankCode, "icbc">): GenericBankProfile {
  // Retain the audited v1 installer/source for its three banks until v2 is published.
  return bankCode === "cmb" || GENERAL_BANK_TEMPLATE.url ? GENERAL_BANK_TEMPLATE : THREE_BANK_TEMPLATE;
}

export function isGenericSmsShortcutCompatible(projectUrl: string, bankCode: Exclude<SmsBankCode, "icbc">): boolean {
  const template = getGenericSmsShortcutSource(bankCode);
  return projectUrl.replace(/\/$/, "").toLowerCase() === template.projectUrl && template.supportedBanks.includes(bankCode);
}

export function getGenericSmsShortcutSignCommand(bankCode: Exclude<SmsBankCode, "icbc">): string {
  const template = getGenericSmsShortcutSource(bankCode);
  return `shortcuts sign --mode anyone --input "$HOME/Downloads/${template.sourcePath.split("/").at(-1)}" --output "$HOME/Downloads/${template.name}.shortcut"`;
}

export function getGenericSmsShortcutIphoneSteps(bankCode: Exclude<SmsBankCode, "icbc">): string {
  const template = getGenericSmsShortcutSource(bankCode);
  if (template.version === 1) return THREE_BANK_IPHONE_STEPS;
  return [
    `1. 在 iPhone 安装或复制已发布的农中建通用模板：${THREE_BANK_TEMPLATE.url}。将空白副本重命名为「${template.name}」，保留原指令。`,
    '2. 找到现有的「匹配文本」，将匹配规则整体替换为下面内容。输入仍选「短信正文」，关闭区分大小写；不要另外叠加旧的银行筛选条件。',
    template.matchPattern,
    '3. 保留「如果 匹配文本有任何值」、网络请求和通知分支。输入仍由短信自动化传入，不修改请求地址或字段。',
    '4. 最上面的接入令牌文本留空，导入问题的默认答案也留空。分享这一份空白副本，个人令牌在各人安装时填写。',
    '5. 点击分享，复制新的 iCloud 链接，审核后发布。个人使用副本填自己的有效令牌，再配置招商银行短信自动化：发件人选择实际短信号码，“信息包含”留空，由本地模板筛选交易和排除验证码；收到后先待确认，未知格式需补齐字段。',
  ].join('\n\n');
}

export const THREE_BANK_SIGN_COMMAND = 'shortcuts sign --mode anyone --input "$HOME/Downloads/moneytrail-three-bank-v1.unsigned.plist" --output "$HOME/Downloads/MoneyTrail 农中建通用记账.shortcut"';
export const THREE_BANK_IPHONE_STEPS = [
  `1. 在 iPhone 安装或复制原工行基础模板：${SMS_SHORTCUT_TEMPLATE.url}。将副本重命名为「${profile.name}」，保留原指令。`,
  '2. 在「将变量 短信正文 设为 文本」之后、第一个「如果」之前，加「匹配文本」。文本选择「短信正文」，关闭区分大小写，将下面的匹配规则完整粘贴。',
  profile.matchPattern,
  '3. 将第一个「如果」改为「匹配文本 有任何值」，移除旧的「工商银行、支出」及其他旧条件；里面的网络请求、通知、否则、结束如果保持原结构。',
  '4. 最上面的接入令牌文本留空，导入问题的默认答案也留空。分享这一份空白副本，个人令牌在各人安装时填写。',
  '5. 点击分享，复制新的 iCloud 链接。用另一份个人副本填自己的令牌，核对真实短信触发与待确认状态。',
].join('\n\n');
