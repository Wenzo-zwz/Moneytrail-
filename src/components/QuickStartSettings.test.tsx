import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import QuickStartSettings from "./QuickStartSettings";

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

  it("keeps the local-only path independent of bank templates", () => {
    const markup = renderToStaticMarkup(createElement(QuickStartSettings, handlers));
    expect(markup).toContain("当前为本机模式");
    expect(markup).not.toContain("收支新版共享安装链接待发布");
  });
});
