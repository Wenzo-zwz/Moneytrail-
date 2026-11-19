import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as v4 from "../lib/bankRulesV4";
import { BANK_RULES_PROJECT } from "../lib/bankRulesValidation";
import QuickStartSettings from "./QuickStartSettings";

afterEach(() => { vi.restoreAllMocks(); });

function enableFixtureRelease() {
  const original = v4.getReleasedBankRulesV4;
  const profile = { version: 4, projectUrl: BANK_RULES_PROJECT, releaseVerified: true,
    smsUrl: "https://www.icloud.com/shortcuts/0123456789abcdef0123456789abcdef",
    updateUrl: "https://www.icloud.com/shortcuts/fedcba9876543210fedcba9876543210" };
  vi.spyOn(v4, "getReleasedBankRulesV4").mockImplementation(projectUrl => original(projectUrl, profile));
}

describe("quick start bank income guidance", () => {
  const handlers = { onScreenshotSetup: vi.fn(), onRecord: vi.fn(), onBudget: vi.fn() };
  it("explains the new income route and the limits of old shared installers", () => {
    const markup = renderToStaticMarkup(createElement(QuickStartSettings, { ...handlers, onSmsAutomation: vi.fn() }));
    expect(markup).toContain("银行收入与支出短信");
    expect(markup).toContain("工资等收入先待确认");
    expect(markup).toContain("农行 · 中行 · 建行 · 招商银行");
    expect(markup).toContain("收支新版共享安装链接待发布");
    expect(markup).toContain("旧工行、农中建安装模板仅筛选支出");
    expect(markup).toContain("“信息包含”留空");
    expect(markup).toContain("网页更新不会升级手机上已安装的旧模板");
    expect(markup).toContain("收到短信也不等于已经入账");
  });

  it("uses the existing entry for a verified official v4 release and its separate updater", () => {
    enableFixtureRelease();
    const markup = renderToStaticMarkup(createElement(QuickStartSettings, { ...handlers, projectUrl: BANK_RULES_PROJECT, onSmsAutomation: vi.fn() }));
    expect(markup).toContain("安装两条 v4 指令");
    expect(markup).toContain("同一本机 MoneyTrail 文件夹");
    expect(markup).toContain("更新指令不填令牌");
    expect(markup).toContain("另建特定时间自动化");
    expect(markup).toContain("锁屏时");
    expect(markup).toContain("开通短信自动记账");
    expect(markup).toContain("设置截图记账");
    expect(markup).not.toContain("收支新版共享安装链接待发布");
  });

  it("keeps custom and unspecified deployments out of the production v4 promotion", () => {
    enableFixtureRelease();
    for (const projectUrl of [undefined, "https://other.supabase.co"]) {
      const markup = renderToStaticMarkup(createElement(QuickStartSettings, { ...handlers, projectUrl, onSmsAutomation: vi.fn() }));
      expect(markup).not.toContain("安装两条 v4 指令");
      expect(markup).not.toContain("icloud.com");
      expect(markup).not.toContain(BANK_RULES_PROJECT);
      expect(markup).toContain("设置截图记账");
    }
  });

  it("keeps the local-only path independent of bank templates", () => {
    const markup = renderToStaticMarkup(createElement(QuickStartSettings, handlers));
    expect(markup).toContain("当前为本机模式");
    expect(markup).not.toContain("收支新版共享安装链接待发布");
  });
});
