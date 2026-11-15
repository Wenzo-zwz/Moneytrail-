import { describe, expect, it } from "vitest";
import { getCompatibleSmsShortcutTemplate, THREE_BANK_IPHONE_STEPS, THREE_BANK_SIGN_COMMAND, THREE_BANK_TEMPLATE } from "./bankOnboarding";
import { SMS_SHORTCUT_TEMPLATE } from "./shortcutTemplate";
import type { SmsBankCode } from "./smsBanks";

describe("shareable three-bank setup instructions", () => {
  it("keeps the audited three-bank installer fixed without personal parameters", () => {
    expect(THREE_BANK_TEMPLATE).toMatchObject({
      name: "MoneyTrail 农中建通用记账",
      url: "https://www.icloud.com/shortcuts/90ce49ad282d490481700cfe8868b82d",
      projectUrl: "https://ojcgabicpjipwpvwolzn.supabase.co",
      supportedBanks: ["abc", "boc", "ccb"],
    });
    const link = new URL(THREE_BANK_TEMPLATE.url);
    expect(link.protocol).toBe("https:");
    expect(link.hostname).toBe("www.icloud.com");
    expect(link.search + link.hash + link.username + link.password).toBe("");
  });

  it.each(["icbc", "abc", "boc", "ccb"] as const)("selects only the matching %s installer for the production deployment", bankCode => {
    const expected = bankCode === "icbc" ? SMS_SHORTCUT_TEMPLATE : THREE_BANK_TEMPLATE;
    for (const projectUrl of [expected.projectUrl, `${expected.projectUrl}/`, expected.projectUrl.toUpperCase()]) {
      expect(getCompatibleSmsShortcutTemplate(projectUrl, bankCode)).toBe(expected);
    }
  });

  it.each([
    "", "not a URL", "https://other.supabase.co",
    "http://ojcgabicpjipwpvwolzn.supabase.co",
    `${THREE_BANK_TEMPLATE.projectUrl}/rest/v1`, `${THREE_BANK_TEMPLATE.projectUrl}//`,
    `${THREE_BANK_TEMPLATE.projectUrl}/.`, `${THREE_BANK_TEMPLATE.projectUrl}/%2e`,
    `${THREE_BANK_TEMPLATE.projectUrl}:443`, `${THREE_BANK_TEMPLATE.projectUrl}?token=private`,
    `${THREE_BANK_TEMPLATE.projectUrl}#`, `${THREE_BANK_TEMPLATE.projectUrl} `,
    "https://person:password@ojcgabicpjipwpvwolzn.supabase.co",
    "https://ojcgabicpjipwpvwolzn.supabase.co@other.supabase.co",
  ])("never offers either production installer for an alternate or ambiguous project %s", projectUrl => {
    for (const bankCode of ["icbc", "abc", "boc", "ccb"] as const) {
      expect(getCompatibleSmsShortcutTemplate(projectUrl, bankCode)).toBeNull();
    }
  });

  it("does not fall back to a production installer for an unknown bank", () => {
    expect(getCompatibleSmsShortcutTemplate(THREE_BANK_TEMPLATE.projectUrl, "other" as SmsBankCode)).toBeNull();
  });

  it("signs the shipped source into the same shortcut name used by the automation guide", () => {
    const input = THREE_BANK_TEMPLATE.sourcePath.split("/").at(-1);
    expect(THREE_BANK_SIGN_COMMAND).toContain(`--input "$HOME/Downloads/${input}"`);
    expect(THREE_BANK_SIGN_COMMAND).toContain(`--output "$HOME/Downloads/${THREE_BANK_TEMPLATE.name}.shortcut"`);
    expect(THREE_BANK_SIGN_COMMAND).toContain("--mode anyone");
  });

  it("keeps the iPhone conversion recipe tied to the actual rule and blank public token", () => {
    expect(THREE_BANK_IPHONE_STEPS).toContain(THREE_BANK_TEMPLATE.matchPattern);
    expect(THREE_BANK_IPHONE_STEPS).toContain(THREE_BANK_TEMPLATE.name);
    expect(THREE_BANK_IPHONE_STEPS).toContain("默认答案也留空");
    expect(THREE_BANK_IPHONE_STEPS).not.toMatch(/mt_sms_|7044156f|1329/);
  });
});
