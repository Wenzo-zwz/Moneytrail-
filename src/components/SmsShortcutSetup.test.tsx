import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SMS_SHORTCUT_TEMPLATE } from "../lib/shortcutTemplate";
import type { SmsConfig } from "../lib/smsClient";
import SmsShortcutSetup from "./SmsShortcutSetup";

const config: SmsConfig = { enabled: false, mode: "auto", created_at: null, last_received_at: null, pending_count: 0 };
function render(overrides: Partial<SmsConfig> = {}, projectUrl: string = SMS_SHORTCUT_TEMPLATE.projectUrl, busy = false) {
  return renderToStaticMarkup(createElement(SmsShortcutSetup, { projectUrl, config: { ...config, ...overrides }, busy, onRefresh: vi.fn() }));
}

describe("iPhone shortcut setup guidance", () => {
  it("shows four steps with a disabled installer until personal access is enabled", () => {
    const markup = render();
    expect(markup).toContain('aria-label="iPhone 快捷指令安装"');
    expect(markup.match(/<li\b/g)).toHaveLength(4);
    expect(markup).toContain("启用个人接入");
    expect(markup).toContain("创建短信自动化");
    expect(markup).toContain("核对实际接收");
    expect(markup).toMatch(/<button[^>]+disabled=""[^>]*>安装 iPhone 快捷指令<\/button>/);
    expect(markup).not.toContain(SMS_SHORTCUT_TEMPLATE.url);
    expect(markup).toContain("尚未收到短信");
    expect(markup).toContain("尚无接收记录不代表手机设置有误");
  });

  it("offers only the fixed template link after access is enabled and explains the private token handoff", () => {
    const markup = render({ enabled: true });
    expect(markup).toContain(`href="${SMS_SHORTCUT_TEMPLATE.url}"`);
    expect(markup).toContain('target="_blank"');
    expect(markup).toContain('rel="noopener noreferrer"');
    expect(markup).toContain("MoneyTrail 慢慢记账");
    expect(markup).toContain("只显示一次");
    expect(markup).toContain("更换令牌会使旧令牌失效");
    expect(markup).toContain("导入时");
    expect(markup).toContain("95588");
    expect(markup).toContain("支出");
    expect(markup).toContain("立即运行");
    expect(markup).toContain("快捷指令输入");
    expect(markup).toContain("运行快捷指令");
  });

  it("keeps the production installer unavailable for another deployment and points to its manual guide", () => {
    const markup = render({ enabled: true }, "https://other.supabase.co");
    expect(markup).not.toContain(SMS_SHORTCUT_TEMPLATE.url);
    expect(markup).toMatch(/<button[^>]+disabled=""[^>]*>安装 iPhone 快捷指令<\/button>/);
    expect(markup).toContain("当前部署与此模板不匹配");
    expect(markup).toContain("手动配置");
  });

  it("shows actual server receipt history without claiming installation or booking is complete", () => {
    const received = "2026-10-20T04:30:00.000Z";
    const markup = render({ enabled: true, last_received_at: received });
    expect(markup).toContain(received);
    expect(markup).toContain("网页无法判断模板是否已安装");
    expect(markup).toContain("历史接收时间不代表本次模板已验证");
    expect(markup).toContain("收到短信不等于已入账");
    expect(markup).toContain("已入账");
    expect(markup).toContain("待确认");
    expect(markup).toContain("刷新接收状态");
    expect(markup).not.toContain("连接测试");
  });

  it("disables refresh while the parent is busy", () => {
    expect(render({}, SMS_SHORTCUT_TEMPLATE.projectUrl, true)).toMatch(/<button[^>]+disabled=""[^>]*>刷新接收状态<\/button>/);
  });
});
