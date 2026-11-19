import profile from "../../public/shortcuts/bank-rules-v4-profile.json";
import { BANK_RULES_PROJECT } from "./bankRulesValidation";

export type BankRulesV4Profile = {
  version: number;
  projectUrl: string;
  releaseVerified: boolean;
  smsUrl: string | null;
  updateUrl: string | null;
};

export const BANK_RULES_V4_PROFILE: BankRulesV4Profile = profile;
export const BANK_RULES_V4_NAMES = { sms: "MoneyTrail 银行收支记账 v4", update: "MoneyTrail 更新银行规则 v4" } as const;

export function isBankRulesV4ProjectCompatible(projectUrl: string): boolean {
  return projectUrl.replace(/\/$/, "").toLowerCase() === BANK_RULES_PROJECT;
}

export function getReleasedBankRulesV4(projectUrl: string, value: BankRulesV4Profile = BANK_RULES_V4_PROFILE):
  (BankRulesV4Profile & { version: 4; releaseVerified: true; smsUrl: string; updateUrl: string }) | null {
  const fields = ["version", "projectUrl", "releaseVerified", "smsUrl", "updateUrl"];
  const validUrl = (url: unknown): url is string => typeof url === "string"
    && /^https:\/\/www\.icloud\.com\/shortcuts\/[a-fA-F0-9]{32}(?![\s\S])/.test(url);
  if (!isBankRulesV4ProjectCompatible(projectUrl) || !value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== fields.length || fields.some(field => !Object.hasOwn(value, field))
    || value.version !== 4 || value.projectUrl !== BANK_RULES_PROJECT || value.releaseVerified !== true
    || !validUrl(value.smsUrl) || !validUrl(value.updateUrl)
    || value.smsUrl.toLowerCase() === value.updateUrl.toLowerCase()) return null;
  return { ...value, version: 4, releaseVerified: true, smsUrl: value.smsUrl, updateUrl: value.updateUrl };
}
