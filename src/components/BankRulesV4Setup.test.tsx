import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BANK_RULES_PROJECT } from "../lib/bankRulesValidation";
import { BANK_RULES_V4_NAMES, type BankRulesV4Profile } from "../lib/bankRulesV4";
import BankRulesV4Setup from "./BankRulesV4Setup";

const release: BankRulesV4Profile = {
  version: 4, projectUrl: BANK_RULES_PROJECT, releaseVerified: true,
  smsUrl: "https://www.icloud.com/shortcuts/0123456789abcdef0123456789abcdef",
  updateUrl: "https://www.icloud.com/shortcuts/fedcba9876543210fedcba9876543210",
};
const render = (profile?: BankRulesV4Profile, projectUrl = BANK_RULES_PROJECT, enabled = true) =>
  renderToStaticMarkup(createElement(BankRulesV4Setup, { projectUrl, enabled, profile }));

describe("v4 onboarding publication", () => {
  it("describes private verification and pending public release without an install action", () => {
    const markup = render();
    expect(markup).toContain("v4 私有试用已有真机验证");
    expect(markup).toContain("公开版仍待签名、分享链接审核及首次安装验收");
    expect(markup).toContain("现有 v3 或旧版指引");
    expect(markup).not.toContain("安装 v4");
    expect(markup).not.toContain("icloud.com");
  });

  it("shows both released installers and one-time local setup requirements", () => {
    const markup = render(release);
    expect(markup).toContain(`href="${release.smsUrl}"`);
    expect(markup).toContain(`href="${release.updateUrl}"`);
    expect(markup).toContain('aria-label="银行收支 v4 设置"');
    expect(markup).toContain("安装 v4 记账指令");
    expect(markup).toContain("安装 v4 更新指令");
    expect(markup).toContain(BANK_RULES_V4_NAMES.sms);
    expect(markup).toContain(BANK_RULES_V4_NAMES.update);
    expect(markup).toContain("我的 iPhone");
    expect(markup).toContain("只需建立一次");
    expect(markup).toContain("读取与存储动作");
    expect(markup).toContain("同一个本机 MoneyTrail 文件夹");
    expect(markup).toContain("允许文件访问与公开规则下载");
    expect(markup).toContain("已有有效令牌可直接沿用");
    expect(markup).toContain("更新指令不填令牌");
    expect(markup).toContain("真实银行发件人");
    expect(markup).toContain("“信息包含”留空");
    expect(markup).toContain("特定时间");
    expect(markup).toContain("不要把规则下载串进短信自动化");
    expect(markup).toContain("手机锁屏时");
    expect(markup).not.toMatch(/deviceSpecific|crossDeviceItemID|mt_sms_/);
  });

  it.each([
    { ...release, releaseVerified: false }, { ...release, smsUrl: null }, { ...release, updateUrl: null },
    { ...release, updateUrl: release.smsUrl }, { ...release, smsUrl: "https://other.example/install" },
  ])("keeps unpublished or invalid profiles off the public install flow %#", profile => {
    const markup = render(profile);
    expect(markup).not.toContain("安装 v4");
    expect(markup).not.toContain('href=');
    expect(markup).not.toContain("准备本机文件夹");
  });

  it("does not leak production install links into a custom deployment", () => {
    expect(render(release, "https://other.supabase.co")).toBe("");
  });

  it("keeps the token-free updater separate while personal access is disabled", () => {
    const markup = render(release, BANK_RULES_PROJECT, false);
    expect(markup).not.toContain(`href="${release.smsUrl}"`);
    expect(markup).toContain(`href="${release.updateUrl}"`);
    expect(markup).toMatch(/<button[^>]+disabled=""[^>]*>安装 v4 记账指令<\/button>/);
    expect(markup).toContain("更新指令不需要个人令牌");
  });
});
