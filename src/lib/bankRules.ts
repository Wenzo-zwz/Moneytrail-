import { BANK_RULES_PROJECT, parseBankRuleManifest, type BankRuleManifest } from "./bankRulesValidation";

export const BANK_RULES_PATH = `${import.meta.env.BASE_URL}shortcuts/bank-rules.json`;
export const BANK_RULES_MAX_RESPONSE_LENGTH = 32_000;

export function isBankRulesProjectCompatible(projectUrl: string): boolean {
  return projectUrl.replace(/\/$/, "").toLowerCase() === BANK_RULES_PROJECT;
}

/** Public metadata only. Does not read personal tokens, inboxes, or phone files. */
export async function readPublishedBankRules(projectUrl: string, signal?: AbortSignal): Promise<BankRuleManifest> {
  if (!isBankRulesProjectCompatible(projectUrl)) throw new Error("当前项目没有配套的规则发布清单。");
  const response = await fetch(BANK_RULES_PATH, { method: "GET", cache: "no-store", credentials: "omit", redirect: "error", signal });
  if (!response.ok) throw new Error("规则版本读取未完成，请稍后重试。");
  const text = await response.text();
  if (text.length > BANK_RULES_MAX_RESPONSE_LENGTH) throw new Error("规则清单超出大小限制。");
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new Error("规则清单不是有效的 JSON。"); }
  return parseBankRuleManifest(value);
}
