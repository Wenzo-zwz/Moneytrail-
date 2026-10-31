import { describe, expect, it } from "vitest";
import { isShortcutTemplateCompatible, SMS_SHORTCUT_TEMPLATE } from "./shortcutTemplate";

const projectUrl = "https://ojcgabicpjipwpvwolzn.supabase.co";

describe("verified SMS shortcut template", () => {
  it("keeps the audited shared template and project fixed without personal parameters", () => {
    expect(SMS_SHORTCUT_TEMPLATE).toEqual({
      url: "https://www.icloud.com/shortcuts/86d33de8ff704d6581c173b82f3f4f21",
      name: "MoneyTrail 慢慢记账",
      projectUrl,
      version: 1,
      supportedBanks: ["icbc"],
    });
    const link = new URL(SMS_SHORTCUT_TEMPLATE.url);
    expect(link.protocol).toBe("https:");
    expect(link.search).toBe("");
    expect(link.hash).toBe("");
    expect(link.username).toBe("");
    expect(link.password).toBe("");
  });

  it.each([projectUrl, `${projectUrl}/`, "https://OJCGABICPJIPWPVWOLZN.SUPABASE.CO/"])("accepts only the matching full project address %s", value => {
    expect(isShortcutTemplateCompatible(value)).toBe(true);
  });

  it.each(["abc", "boc", "ccb"] as const)("does not advertise the ICBC-only shared template for %s", bankCode => {
    expect(isShortcutTemplateCompatible(projectUrl, bankCode)).toBe(false);
  });

  it("keeps explicit ICBC compatibility subject to the deployment guard", () => {
    expect(isShortcutTemplateCompatible(projectUrl, "icbc")).toBe(true);
    expect(isShortcutTemplateCompatible("https://other.supabase.co", "icbc")).toBe(false);
  });

  it.each([
    "", "not a URL", "ojcgabicpjipwpvwolzn.supabase.co", "//ojcgabicpjipwpvwolzn.supabase.co",
    "http://ojcgabicpjipwpvwolzn.supabase.co", "https://other.supabase.co", "http://localhost:54321",
    `${projectUrl}.example.com`, `${projectUrl}/rest/v1`, `${projectUrl}//`, `${projectUrl}/.`,
    `${projectUrl}/%2e`, `${projectUrl}:443`, `${projectUrl}:8443`, `${projectUrl}?token=private`,
    `${projectUrl}?`, `${projectUrl}/#private`, `${projectUrl}#`, `${projectUrl} `, ` ${projectUrl}`,
    "https://person:password@ojcgabicpjipwpvwolzn.supabase.co", "https://@ojcgabicpjipwpvwolzn.supabase.co",
    "https://ojcgabicpjipwpvwolzn.supabase.co@other.supabase.co", `${projectUrl}\\`,
  ])("rejects alternate projects and non-root or ambiguous URLs %s", value => {
    expect(isShortcutTemplateCompatible(value)).toBe(false);
  });
});
