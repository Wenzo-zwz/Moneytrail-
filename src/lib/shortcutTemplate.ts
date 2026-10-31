import type { SmsBankCode } from "./smsBanks";

export const SMS_SHORTCUT_TEMPLATE = {
  url: "https://www.icloud.com/shortcuts/86d33de8ff704d6581c173b82f3f4f21",
  name: "MoneyTrail 慢慢记账",
  projectUrl: "https://ojcgabicpjipwpvwolzn.supabase.co",
  version: 1,
  supportedBanks: ["icbc"],
} as const;

export function isShortcutTemplateCompatible(projectUrl: string, bankCode: SmsBankCode = "icbc"): boolean {
  // Compare the full address so URL parsing cannot hide credentials or normalize a path.
  return projectUrl.replace(/\/$/, "").toLowerCase() === SMS_SHORTCUT_TEMPLATE.projectUrl
    && SMS_SHORTCUT_TEMPLATE.supportedBanks.some(code => code === bankCode);
}
