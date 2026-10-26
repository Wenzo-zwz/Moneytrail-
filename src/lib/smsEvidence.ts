import { validateSmsEvidence, type SmsEvidence } from "./ledger";

export const SMS_CLASSIFICATION_RULE_VERSION = "local-life-v1";

/** Retain transaction facts while removing card identifiers and account balances. */
export function redactSmsEvidence(text: string): string {
  return text.normalize("NFKC")
    .replace(/((?:银行卡|信用卡|储蓄卡|借记卡|卡|账户|账号)\s*\(\s*)[\d*xX×•]+(?:[ -][\d*xX×•]{4})*(\s*\))/g, "$1[已隐藏]$2")
    .replace(/((?:信用卡|储蓄卡|借记卡|银行卡|账户)(?:为|是)?\s*[:：]?\s*)[\d*xX×•]{4,}(?:[ -][\d*xX×•]{4})*/g, "$1[已隐藏]")
    .replace(/(卡\s*[:：]?\s*)[\d*xX×•]{4,}(?=\s*(?:于|在|支出|消费|支付|付款|扣款|退款|转账|[，,。；;]))/g, "$1[已隐藏]")
    .replace(/((?:尾号|末四位|末4位|卡号|账号)(?:为|是)?\s*[:：]?\s*)[\d*xX×•]+(?:[ -][\d*xX×•]{4})*/g, "$1[已隐藏]")
    .replace(/[\d*xX×•]{4,}(?=的?(?:信用卡|储蓄卡|借记卡|银行卡|账户|账号|卡(?=于|在|消费|支付|支出|付款|扣款|退款|转账|\d|[\s，,。;；:]|$)))/g, "[已隐藏]")
    .replace(/((?:(?:账户|可用|活期|信用卡)?余额|剩余(?:金额|余额)?|可用额度)(?:为|是)?\s*[:：]?\s*)(?:(?:人民币|RMB|CNY|[¥￥])\s*)?[+−-]?[\d*xX×•]+(?:[,.\s][\d*xX×•]+)*/gi, "$1[已隐藏]");
}

export function buildSmsEvidence(text: string, context: { receivedAt?: string; classificationReason?: string } = {}): SmsEvidence {
  const evidence = { text: redactSmsEvidence(text), ...context, ruleVersion: SMS_CLASSIFICATION_RULE_VERSION };
  if (!validateSmsEvidence(evidence)) throw new Error("短信凭据格式无效。");
  return evidence;
}
