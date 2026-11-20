import { describe, expect, it } from "vitest";
import { BANK_RULES_PROJECT } from "./bankRulesValidation";
import { BANK_RULES_V4_PROFILE, BANK_SMS_V4_NAME, getReleasedBankRulesV4, getReleasedBankSmsV4, type BankRulesV4Profile } from "./bankRulesV4";

export const releaseFixture: BankRulesV4Profile = {
  version: 4, projectUrl: BANK_RULES_PROJECT, releaseVerified: true,
  smsUrl: "https://www.icloud.com/shortcuts/0123456789abcdef0123456789abcdef",
  updateUrl: "https://www.icloud.com/shortcuts/fedcba9876543210fedcba9876543210",
};

describe("public v4 release gate", () => {
  it("offers the single shortcut only with a valid published link for the official project", () => {
    const sms = { version: 4, projectUrl: BANK_RULES_PROJECT, url: releaseFixture.smsUrl };
    expect(getReleasedBankSmsV4(BANK_RULES_PROJECT, sms)).toEqual({ name: BANK_SMS_V4_NAME, url: sms.url });
    expect(getReleasedBankSmsV4(BANK_RULES_PROJECT, { ...sms, url: null })).toBeNull();
    expect(getReleasedBankSmsV4(BANK_RULES_PROJECT, { ...sms, url: `${sms.url}?token=secret` })).toBeNull();
    expect(getReleasedBankSmsV4("https://other.supabase.co", sms)).toBeNull();
  });
  it("keeps the live profile structurally valid and consistent with its release gate", () => {
    expect(BANK_RULES_V4_PROFILE.version).toBe(4);
    expect(BANK_RULES_V4_PROFILE.projectUrl).toBe(BANK_RULES_PROJECT);
    expect(typeof BANK_RULES_V4_PROFILE.releaseVerified).toBe("boolean");
    for (const url of [BANK_RULES_V4_PROFILE.smsUrl, BANK_RULES_V4_PROFILE.updateUrl]) {
      if (url !== null) expect(url).toMatch(/^https:\/\/www\.icloud\.com\/shortcuts\/[a-fA-F0-9]{32}(?![\s\S])/);
    }
    if (BANK_RULES_V4_PROFILE.smsUrl && BANK_RULES_V4_PROFILE.updateUrl) {
      expect(BANK_RULES_V4_PROFILE.smsUrl.toLowerCase()).not.toBe(BANK_RULES_V4_PROFILE.updateUrl.toLowerCase());
    }
    expect(getReleasedBankRulesV4(BANK_RULES_PROJECT)).toEqual(BANK_RULES_V4_PROFILE.releaseVerified ? BANK_RULES_V4_PROFILE : null);
  });

  it("keeps explicit staged profiles hidden even with two valid share links", () => {
    expect(getReleasedBankRulesV4(BANK_RULES_PROJECT, { ...releaseFixture, releaseVerified: false })).toBeNull();
    expect(getReleasedBankRulesV4(BANK_RULES_PROJECT, { ...releaseFixture, releaseVerified: false, smsUrl: null, updateUrl: null })).toBeNull();
  });

  it.each([BANK_RULES_PROJECT, `${BANK_RULES_PROJECT}/`, BANK_RULES_PROJECT.toUpperCase()])("offers both independently verified links for the official project %s", projectUrl => {
    expect(getReleasedBankRulesV4(projectUrl, releaseFixture)).toEqual(releaseFixture);
  });

  it.each([
    "", "https://other.supabase.co", `${BANK_RULES_PROJECT}/rest/v1`, `${BANK_RULES_PROJECT}//`,
    `${BANK_RULES_PROJECT}/.`, `${BANK_RULES_PROJECT}/%2e`, `${BANK_RULES_PROJECT}:443`,
    `${BANK_RULES_PROJECT}?token=secret`, `${BANK_RULES_PROJECT}#`, `${BANK_RULES_PROJECT}\n`,
    "https://user:password@ojcgabicpjipwpvwolzn.supabase.co",
    "https://ojcgabicpjipwpvwolzn.supabase.co@other.supabase.co",
  ])("does not offer production installers for another or ambiguous project %s", projectUrl => {
    expect(getReleasedBankRulesV4(projectUrl, releaseFixture)).toBeNull();
  });

  it.each([
    null, "", "http://www.icloud.com/shortcuts/0123456789abcdef0123456789abcdef",
    "https://icloud.com/shortcuts/0123456789abcdef0123456789abcdef",
    "https://example.com/shortcuts/0123456789abcdef0123456789abcdef",
    "https://www.icloud.com:443/shortcuts/0123456789abcdef0123456789abcdef",
    "https://person@www.icloud.com/shortcuts/0123456789abcdef0123456789abcdef",
    "https://www.icloud.com/shortcuts/0123456789abcdef0123456789abcdef?token=secret",
    "https://www.icloud.com/shortcuts/0123456789abcdef0123456789abcdef#",
    "https://www.icloud.com/shortcuts/0123456789abcdef0123456789abcdef/",
    "https://www.icloud.com/shortcuts/0123456789abcdef0123456789abcdeg",
    "https://www.icloud.com/shortcuts/0123456789abcdef0123456789abcdef\n",
    " https://www.icloud.com/shortcuts/0123456789abcdef0123456789abcdef",
  ])("requires both URLs to be strict iCloud shortcut links %#", url => {
    expect(getReleasedBankRulesV4(BANK_RULES_PROJECT, { ...releaseFixture, smsUrl: url })).toBeNull();
    expect(getReleasedBankRulesV4(BANK_RULES_PROJECT, { ...releaseFixture, updateUrl: url })).toBeNull();
  });

  it.each([
    { ...releaseFixture, releaseVerified: false },
    { ...releaseFixture, releaseVerified: "true" },
    { ...releaseFixture, version: 3 },
    { ...releaseFixture, version: "4" },
    { ...releaseFixture, projectUrl: "https://other.supabase.co" },
    { ...releaseFixture, projectUrl: `${BANK_RULES_PROJECT}/` },
    { ...releaseFixture, updateUrl: releaseFixture.smsUrl },
    { ...releaseFixture, updateUrl: releaseFixture.smsUrl!.slice(0, -32) + releaseFixture.smsUrl!.slice(-32).toUpperCase() },
    { ...releaseFixture, ownerId: "private" },
    { ...releaseFixture, smsUrl: null },
    { ...releaseFixture, updateUrl: null },
  ])("requires the exact release profile and two distinct shortcut IDs %#", value => {
    expect(getReleasedBankRulesV4(BANK_RULES_PROJECT, value as BankRulesV4Profile)).toBeNull();
  });
});
