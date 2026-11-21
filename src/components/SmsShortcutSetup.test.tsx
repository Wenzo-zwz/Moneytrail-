import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as v4 from "../lib/bankRulesV4";
import { SMS_SHORTCUT_TEMPLATE } from "../lib/shortcutTemplate";
import { BANK_ACTIVITY_TEMPLATE, GENERAL_BANK_TEMPLATE, THREE_BANK_TEMPLATE } from "../lib/bankOnboarding";
import type { SmsConfig } from "../lib/smsClient";
import type { SmsBankCode } from "../lib/smsBanks";
import SmsShortcutSetup from "./SmsShortcutSetup";

const config: SmsConfig = { enabled: false, mode: "auto", created_at: null, last_received_at: null, pending_count: 0 };
const realV4Resolver = v4.getReleasedBankRulesV4;
const realSmsResolver = v4.getReleasedBankSmsV4;
beforeEach(() => {
  vi.spyOn(v4, "getReleasedBankRulesV4").mockReturnValue(null);
  vi.spyOn(v4, "getReleasedBankSmsV4").mockReturnValue(null);
});
afterEach(() => { vi.restoreAllMocks(); });
function render(overrides: Partial<SmsConfig> = {}, projectUrl: string = SMS_SHORTCUT_TEMPLATE.projectUrl, busy = false, bankCode?: SmsBankCode) {
  return renderToStaticMarkup(createElement(SmsShortcutSetup, { projectUrl, config: { ...config, ...overrides }, busy, onRefresh: vi.fn(), bankCode, onBankChange: vi.fn() }));
}

describe("iPhone shortcut setup guidance", () => {
  it.each(["abc", "boc", "ccb"] as const)("honors the parent's %s bank selection when rendered again after access refresh", bankCode => {
    const markup = render({ enabled: true }, SMS_SHORTCUT_TEMPLATE.projectUrl, false, bankCode);
    expect(markup).toContain(`value="${bankCode}" selected=""`);
    expect(markup).not.toContain(SMS_SHORTCUT_TEMPLATE.url);
    expect(markup).toContain("配置收入与支出快捷指令");
    expect(markup).toContain("储蓄卡和信用卡共用");
    expect(markup).toContain(`href="${THREE_BANK_TEMPLATE.url}"`);
    expect(markup).toContain('target="_blank"');
    expect(markup).toContain('rel="noopener noreferrer"');
    expect(markup).toContain("收支新版共享安装链接尚未发布");
    expect(markup).toContain("收到后先待确认");
    expect(markup).toContain(`信息包含「${({ abc: "农业银行", boc: "中国银行", ccb: "建设银行" })[bankCode]}」`);
    expect(markup).toContain("复制匹配规则");
    expect(markup).toContain("复制 iPhone 制作步骤");
    expect(markup).toContain("复制 Mac 签名命令");
    expect(markup).toContain("未签名源文件");
    expect(markup).toContain('href="/shortcuts/moneytrail-three-bank-v1.unsigned.plist"');
  });

  it.each(["abc", "boc", "ccb"] as const)("requires personal access before offering the %s installer", bankCode => {
    const markup = render({}, SMS_SHORTCUT_TEMPLATE.projectUrl, false, bankCode);
    expect(markup).toMatch(/<button[^>]+disabled=""[^>]*>安装支出快捷指令<\/button>/);
    expect(markup).not.toContain(THREE_BANK_TEMPLATE.url);
    expect(markup).not.toContain(SMS_SHORTCUT_TEMPLATE.url);
    expect(markup).toContain("请先在上方启用个人接入并保存令牌");
    expect(markup).toContain("收到后先待确认");
  });

  it("lets users select all five banks while labelling the existing template as ICBC-only", () => {
    const markup = render({ enabled: true });
    expect(markup).toMatch(/<select[^>]+aria-label="银行"/);
    expect(markup).toContain('value="icbc" selected=""');
    expect(markup).toContain('value="abc"');
    expect(markup).toContain('value="boc"');
    expect(markup).toContain('value="ccb"');
    expect(markup).toContain('value="cmb"');
    expect(markup).toContain("农业银行");
    expect(markup).toContain("中国银行");
    expect(markup).toContain("建设银行");
    expect(markup).toContain("招商银行");
    expect(markup).toContain("工行版模板");
    expect(markup).toContain("新收入全部先待确认");
    expect(markup).toContain("银行选择仅用于查看配置步骤");
  });

  it("shows four steps with a disabled installer until personal access is enabled", () => {
    const markup = render();
    expect(markup).toContain('aria-label="iPhone 快捷指令安装"');
    expect(markup.match(/<li\b/g)).toHaveLength(4);
    expect(markup).toContain("启用个人接入");
    expect(markup).toContain("创建短信自动化");
    expect(markup).toContain("核对实际接收");
    expect(markup).toMatch(/<button[^>]+disabled=""[^>]*>安装支出快捷指令<\/button>/);
    expect(markup).not.toContain(SMS_SHORTCUT_TEMPLATE.url);
    expect(markup).toContain("尚未收到短信");
    expect(markup).toContain("尚无接收记录不代表手机设置有误");
  });

  it("offers only the fixed template link after access is enabled and explains the private token handoff", () => {
    const markup = render({ enabled: true });
    expect(markup).toContain(`href="${SMS_SHORTCUT_TEMPLATE.url}"`);
    expect(markup).not.toContain(THREE_BANK_TEMPLATE.url);
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
    expect(markup).not.toContain(THREE_BANK_TEMPLATE.url);
    expect(markup).toMatch(/<button[^>]+disabled=""[^>]*>安装支出快捷指令<\/button>/);
    expect(markup).toContain("当前部署与此模板不匹配");
    expect(markup).toContain("手动配置");
  });

  it.each(["abc", "boc", "ccb", "cmb"] as const)("keeps fixed-production generic source and conversion instructions unavailable to another project (%s)", bankCode => {
    const markup = render({ enabled: true }, "https://other.supabase.co", false, bankCode);
    expect(markup).toContain("与当前部署不匹配");
    expect(markup).not.toContain(SMS_SHORTCUT_TEMPLATE.url);
    expect(markup).not.toContain(THREE_BANK_TEMPLATE.url);
    expect(markup).toMatch(/<button[^>]+disabled=""[^>]*>安装支出快捷指令<\/button>/);
    expect(markup).not.toContain(`href="${BANK_ACTIVITY_TEMPLATE.sourcePath}"`);
    expect(markup).not.toContain("复制收支匹配规则");
    expect(markup).not.toContain('href="/shortcuts/moneytrail-three-bank-v1.unsigned.plist"');
    expect(markup).not.toContain('href="/shortcuts/moneytrail-general-bank-v2.unsigned.plist"');
    expect(markup).not.toContain("复制 iPhone 制作步骤");
    expect(markup).not.toContain("复制 Mac 签名命令");
  });

  it.each([false, true])("shows the CMB v2 update recipe without presenting the old installer (enabled %s)", enabled => {
    const markup = render({ enabled }, SMS_SHORTCUT_TEMPLATE.projectUrl, false, "cmb");
    expect(markup).toContain('value="cmb" selected=""');
    expect(markup).toContain("通用银行模板（含招商银行）");
    expect(markup).toContain("共享安装链接尚未发布");
    expect(markup).not.toContain("与当前部署不匹配");
    expect(markup).not.toContain(THREE_BANK_TEMPLATE.url);
    expect(markup).not.toContain(SMS_SHORTCUT_TEMPLATE.url);
    expect(markup).toContain(`href="${GENERAL_BANK_TEMPLATE.sourcePath}"`);
    expect(markup).toContain("复制匹配规则");
    expect(markup).toContain("将已有“匹配文本”的规则整体替换");
    expect(markup).toContain(`「${GENERAL_BANK_TEMPLATE.name}」`);
    expect(markup).toContain("“信息包含”留空");
    expect(markup).not.toContain("信息包含「招商银行」");
    expect(markup).toContain("〖招商银行〗");
    expect(markup).toContain("完整的「您尾号…的招行信用卡于…消费人民币…元」句式");
    expect(markup).toContain("95555、1065795555、106941995555");
    expect(markup).toContain("此银行收到后先待确认，不会自动增加消费");
  });

  it.each(["icbc", "abc", "boc", "ccb", "cmb"] as const)("gives %s an income-capable path distinct from frozen expense installers", bankCode => {
    const markup = render({ enabled: true }, SMS_SHORTCUT_TEMPLATE.projectUrl, false, bankCode);
    expect(markup).toContain('aria-label="收入与支出快捷指令"');
    expect(markup).toContain(`「${BANK_ACTIVITY_TEMPLATE.name}」`);
    expect(markup).toMatch(/<button[^>]+disabled=""[^>]*>安装收支快捷指令<\/button>/);
    expect(markup).toContain("仅接收支出：旧版模板与配置");
    expect(markup).toContain("不会因网页更新而新增收入筛选");
    expect(markup).toContain("“信息包含”留空");
    expect(markup).toContain("发件人选实际发送");
    expect(markup).toContain("遮罩金额需要补填");
    expect(markup).toContain(`href="${BANK_ACTIVITY_TEMPLATE.sourcePath}"`);
    expect(markup).toContain("复制收支匹配规则");
    expect(markup).toContain("复制收支iPhone步骤");
    expect(markup).toContain("复制收支Mac签名命令");
    expect(markup).not.toContain("安装 iPhone 快捷指令</");
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

  it("keeps v4 pending and all current installers unchanged before release", () => {
    const markup = render({ enabled: true });
    expect(markup).toContain("v4 私有试用已有真机验证");
    expect(markup).not.toContain("安装 v4 记账指令");
    expect(markup).not.toContain("安装 v4 更新指令");
    expect(markup).toContain(`href="${SMS_SHORTCUT_TEMPLATE.url}"`);
    expect(markup).toContain(`「${BANK_ACTIVITY_TEMPLATE.name}」`);
  });

  it("offers one signed shortcut in the primary guide, with cache setup in collapsed advanced options", () => {
    const original = realV4Resolver;
    const profile = { version: 4, projectUrl: SMS_SHORTCUT_TEMPLATE.projectUrl, releaseVerified: true,
      smsUrl: "https://www.icloud.com/shortcuts/0123456789abcdef0123456789abcdef",
      updateUrl: "https://www.icloud.com/shortcuts/fedcba9876543210fedcba9876543210" };
    vi.spyOn(v4, "getReleasedBankRulesV4").mockImplementation(projectUrl => original(projectUrl, profile));
    const smsProfile = { version: 4, projectUrl: profile.projectUrl, url: "https://www.icloud.com/shortcuts/abcdef0123456789abcdef0123456789" };
    vi.spyOn(v4, "getReleasedBankSmsV4").mockImplementation(projectUrl => realSmsResolver(projectUrl, smsProfile));
    const markup = render({ enabled: true });
    expect(markup).toContain(`href="${profile.smsUrl}"`);
    expect(markup).toContain(`href="${profile.updateUrl}"`);
    const [primary, advanced] = markup.split('<details class="three-bank-maker"><summary>高级配置：本机规则缓存与更新</summary>');
    expect(primary).toContain(`href="${smsProfile.url}"`);
    const [direct, compatibility] = primary.split('<details class="three-bank-maker"><summary>编辑页找不到「自动化」时</summary>');
    expect(direct).toContain(`编辑「${v4.BANK_SMS_V4_NAME}」`);
    expect(direct).toContain("「自动化」→「信息」");
    expect(direct).toContain("关闭「运行前确认」");
    expect(direct).not.toContain("添加「获取文本」");
    expect(compatibility).toContain("添加「获取文本」");
    expect(primary).not.toMatch(/定时|特定时间|文件夹|使用 Mac 签名|安装 v4 更新指令/);
    expect(advanced).toContain(profile.updateUrl);
    expect(advanced).toContain('aria-label="银行规则发布状态"');
    expect(primary).not.toContain("银行规则发布状态");
    expect(markup).not.toContain("仅接收支出：旧版模板与配置");
    expect(markup).not.toContain(SMS_SHORTCUT_TEMPLATE.url);
    expect(markup).not.toContain(THREE_BANK_TEMPLATE.url);
    expect(primary).not.toContain("服务器最近接收");
    expect(primary).not.toContain("刷新接收状态");
    expect(primary).not.toContain("历史接收时间");
    expect(primary).toContain("点收件箱的「刷新」");
    const custom = render({ enabled: true }, "https://other.supabase.co");
    expect(custom).not.toContain(smsProfile.url);
    expect(custom).not.toContain(profile.smsUrl);
    expect(custom).not.toContain(profile.updateUrl);
    expect(custom).not.toContain("安装 v4");
  });

  it("keeps the single installer consent-gated without reintroducing legacy setup", () => {
    vi.spyOn(v4, "getReleasedBankSmsV4").mockImplementation(projectUrl => realSmsResolver(projectUrl));
    const markup = render();
    expect(markup).toMatch(/<button[^>]+disabled=""[^>]*>安装收支快捷指令<\/button>/);
    expect(markup).not.toContain("安装支出快捷指令");
    expect(markup).not.toContain("复制匹配规则");
    expect(markup).not.toContain("服务器最近接收");
    expect(markup).toContain("编辑页找不到「自动化」时");
  });
});
