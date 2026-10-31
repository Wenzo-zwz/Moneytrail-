import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SMS_SHORTCUT_TEMPLATE } from "../lib/shortcutTemplate";
import type { SmsConfig } from "../lib/smsClient";
import type { SmsBankCode } from "../lib/smsBanks";
import SmsShortcutSetup from "./SmsShortcutSetup";

const config: SmsConfig = { enabled: false, mode: "auto", created_at: null, last_received_at: null, pending_count: 0 };
function render(overrides: Partial<SmsConfig> = {}, projectUrl: string = SMS_SHORTCUT_TEMPLATE.projectUrl, busy = false, bankCode?: SmsBankCode) {
  return renderToStaticMarkup(createElement(SmsShortcutSetup, { projectUrl, config: { ...config, ...overrides }, busy, onRefresh: vi.fn(), bankCode, onBankChange: vi.fn() }));
}

describe("iPhone shortcut setup guidance", () => {
  it.each(["abc", "boc", "ccb"] as const)("honors the parent's %s bank selection when rendered again after access refresh", bankCode => {
    const markup = render({ enabled: true }, SMS_SHORTCUT_TEMPLATE.projectUrl, false, bankCode);
    expect(markup).toContain(`value="${bankCode}" selected=""`);
    expect(markup).not.toContain(SMS_SHORTCUT_TEMPLATE.url);
    expect(markup).toContain("手动配置发送步骤");
    expect(markup).toContain("收到后先待确认");
    expect(markup).toContain("信息包含「元」");
  });

  it("lets users select all four banks while labelling the existing template as ICBC-only", () => {
    const markup = render({ enabled: true });
    expect(markup).toMatch(/<select[^>]+aria-label="银行"/);
    expect(markup).toContain('value="icbc" selected=""');
    expect(markup).toContain('value="abc"');
    expect(markup).toContain('value="boc"');
    expect(markup).toContain('value="ccb"');
    expect(markup).toContain("农业银行");
    expect(markup).toContain("中国银行");
    expect(markup).toContain("建设银行");
    expect(markup).toContain("工行版模板");
    expect(markup).toContain("农行、中行、建行目前接收后先待确认");
    expect(markup).toContain("银行选择仅用于查看配置步骤");
  });

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
