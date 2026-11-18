import { afterEach, describe, expect, it, vi } from "vitest";
import canonical from "../../shortcuts/bank-rules.json";
import published from "../../public/shortcuts/bank-rules.json";
import frozenProfile from "../../public/shortcuts/bank-activity-profile.json";
import { BANK_RULES_MAX_PATTERN_LENGTH, BANK_RULES_PROJECT, parseBankRuleManifest, validateBankRuleManifest } from "./bankRulesValidation";
import { BANK_RULES_PATH, isBankRulesProjectCompatible, readPublishedBankRules } from "./bankRules";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("published bank rule manifest", () => {
  it("starts with the frozen v3 rule without claiming that v3 loads it", () => {
    expect(published).toEqual(canonical);
    expect(validateBankRuleManifest(published)).toMatchObject({ schemaVersion: 1, version: 1, minShortcutVersion: 4,
      projectUrl: BANK_RULES_PROJECT, matchPattern: frozenProfile.matchPattern });
    expect(Object.keys(published).sort()).toEqual(["schemaVersion", "version", "minShortcutVersion", "projectUrl", "publishedAt", "matchPattern"].sort());
  });

  it.each([
    null, [], "rules", {},
    { ...canonical, schemaVersion: 2 }, { ...canonical, version: 0 }, { ...canonical, version: 1.5 },
    { ...canonical, version: "1" }, { ...canonical, version: Number.MAX_SAFE_INTEGER + 1 },
    { ...canonical, minShortcutVersion: 3 }, { ...canonical, minShortcutVersion: -1 },
    { ...canonical, projectUrl: `${BANK_RULES_PROJECT}/` }, { ...canonical, projectUrl: "https://other.supabase.co" },
    { ...canonical, requestUrl: "https://other.example/collect" }, { ...canonical, token: "private" },
    { ...canonical, actions: [] }, { ...canonical, version: undefined },
    { ...canonical, publishedAt: "2026-02-30T18:02:46.000Z" }, { ...canonical, publishedAt: "2026-11-17" },
    { ...canonical, publishedAt: "2026-11-17T18:02:46+00:00" },
    { ...canonical, matchPattern: "" }, { ...canonical, matchPattern: "[" },
    { ...canonical, matchPattern: "x".repeat(BANK_RULES_MAX_PATTERN_LENGTH + 1) },
    { ...canonical, matchPattern: `${canonical.matchPattern}\n` },
  ])("rejects incompatible or malformed data without accepting transport overrides", value => {
    expect(() => validateBankRuleManifest(value)).toThrow();
  });

  it("does not make a custom expected project opt into production rules", () => {
    expect(() => validateBankRuleManifest({ ...canonical, projectUrl: "https://other.supabase.co" }, "https://other.supabase.co")).toThrow(/项目/);
  });

  it.each([
    "[\\s\\S]*",
    canonical.matchPattern.replace("验证码|", ""),
    canonical.matchPattern.replace("|驗證碼", ""),
    canonical.matchPattern.replace("银行[^【】", "店铺[^【】"),
    canonical.matchPattern.replace("{1,2000}", "{1,10000}"),
    canonical.matchPattern.replaceAll("\\p{Cf}", "\\p{Co}"),
  ])("rejects representative regressions in the published routing filter", matchPattern => {
    expect(() => validateBankRuleManifest({ ...canonical, matchPattern })).toThrow(/回归/);
  });

  it("allows later valid rule and minimum-shell versions without inventing a phone installation", () => {
    expect(validateBankRuleManifest({ ...canonical, version: 2, minShortcutVersion: 5 }).version).toBe(2);
  });

  it("keeps structural parsing distinct from publisher regression execution", () => {
    const value = { ...canonical, matchPattern: "(a+)+$" };
    const test = vi.spyOn(RegExp.prototype, "test");
    expect(parseBankRuleManifest(value).matchPattern).toBe(value.matchPattern);
    expect(test.mock.instances.some(pattern => pattern instanceof RegExp && pattern.source === value.matchPattern)).toBe(false);
    test.mockRestore();
    expect(() => validateBankRuleManifest(value)).toThrow(/回归/);
  });
});

describe("public bank rule reader", () => {
  it("reads only public metadata, bypassing caches and personal credentials", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(published), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    const controller = new AbortController();
    expect(await readPublishedBankRules(`${BANK_RULES_PROJECT}/`, controller.signal)).toEqual(published);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(BANK_RULES_PATH, { method: "GET", cache: "no-store", credentials: "omit", redirect: "error", signal: controller.signal });
  });

  it.each(["", "not a URL", "https://other.supabase.co", `${BANK_RULES_PROJECT}/rest/v1`, `${BANK_RULES_PROJECT}//`, `${BANK_RULES_PROJECT}:443`, `${BANK_RULES_PROJECT}?private=x`, `${BANK_RULES_PROJECT}#`, "https://person:password@ojcgabicpjipwpvwolzn.supabase.co"])("does not fetch production rules for an alternate project %s", async projectUrl => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    expect(isBankRulesProjectCompatible(projectUrl)).toBe(false);
    await expect(readPublishedBankRules(projectUrl)).rejects.toThrow(/项目/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    new Response("not JSON", { status: 200 }),
    new Response(JSON.stringify({ ...published, token: "private" }), { status: 200 }),
    new Response(" ".repeat(32_001), { status: 200 }),
    new Response("unavailable", { status: 503 }),
  ])("rejects unreadable responses without returning a stale or guessed version", async response => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    await expect(readPublishedBankRules(BANK_RULES_PROJECT)).rejects.toThrow();
  });

  it("leaves fetch errors visible to the status UI", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await expect(readPublishedBankRules(BANK_RULES_PROJECT)).rejects.toThrow("offline");
  });

  it("reads and displays a compiled pattern without running it on browser text", async () => {
    const rule = { ...published, matchPattern: "(a+)+$" };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(rule), { status: 200 })));
    const test = vi.spyOn(RegExp.prototype, "test");
    expect(await readPublishedBankRules(BANK_RULES_PROJECT)).toEqual(rule);
    expect(test.mock.instances.some(pattern => pattern instanceof RegExp && pattern.source === rule.matchPattern)).toBe(false);
    test.mockRestore();
  });
});
