import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as v4 from "../lib/bankRulesV4";
import { BANK_RULES_PROJECT } from "../lib/bankRulesValidation";
import QuickStartSettings from "./QuickStartSettings";

afterEach(() => { vi.restoreAllMocks(); });

function enableFixtureRelease() {
  const original = v4.getReleasedBankSmsV4;
  const profile = { version: 4, projectUrl: BANK_RULES_PROJECT,
    url: "https://www.icloud.com/shortcuts/0123456789abcdef0123456789abcdef" };
  vi.spyOn(v4, "getReleasedBankSmsV4").mockImplementation(projectUrl => original(projectUrl, profile));
}

describe("quick start bank income guidance", () => {
  const handlers = { onScreenshotSetup: vi.fn() };
  it("explains the new income route and the limits of old shared installers", () => {
    const markup = renderToStaticMarkup(createElement(QuickStartSettings, { ...handlers, onSmsAutomation: vi.fn() }));
    expect(markup).toContain("银行收入与支出短信");
    expect(markup).toContain("明确消费和工资可按记录方式入账");
    expect(markup).toContain("农行 · 中行 · 建行 · 招商银行");
    expect(markup).toContain("收支新版共享安装链接待发布");
    expect(markup).toContain("旧工行、农中建安装模板仅筛选支出");
    expect(markup).toContain("“信息包含”留空");
    expect(markup).toContain("网页更新不会升级手机上已安装的旧模板");
    expect(markup).toContain("收到短信也不等于已经入账");
  });

  it("uses the existing entry for the single SMS shortcut", () => {
    enableFixtureRelease();
    const markup = renderToStaticMarkup(createElement(QuickStartSettings, { ...handlers, projectUrl: BANK_RULES_PROJECT, onSmsAutomation: vi.fn() }));
    expect(markup).toContain("添加一条记账快捷指令");
    expect(markup).toContain(v4.BANK_SMS_V4_NAME);
    expect(markup).not.toMatch(/文件夹|更新指令|定时/);
    expect(markup).toContain("开通短信自动记账");
    expect(markup).toContain("设置截图记账");
    expect(markup).toContain("添加到 iPhone 主屏幕");
    expect(markup).not.toMatch(/手动记一笔|设置月预算/);
    expect(markup).not.toContain("收支新版共享安装链接待发布");
  });

  it("keeps custom and unspecified deployments out of the production v4 promotion", () => {
    enableFixtureRelease();
    for (const projectUrl of [undefined, "https://other.supabase.co"]) {
      const markup = renderToStaticMarkup(createElement(QuickStartSettings, { ...handlers, projectUrl, onSmsAutomation: vi.fn() }));
      expect(markup).not.toContain(v4.BANK_SMS_V4_NAME);
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
