import { ArrowRight, MessageSquare, Pencil, ScanText, Smartphone, Wallet } from "lucide-react";
import { SCREENSHOT_SHORTCUT_TEMPLATE } from "../lib/screenshotShortcutTemplate";
import { BANK_ACTIVITY_TEMPLATE } from "../lib/bankOnboarding";
import { getReleasedBankSmsV4 } from "../lib/bankRulesV4";

type Props = {
  projectUrl?: string;
  onSmsAutomation?: () => void;
  onScreenshotSetup: () => void;
  onRecord: () => void;
  onBudget: () => void;
};

export default function QuickStartSettings({ projectUrl, onSmsAutomation, onScreenshotSetup, onRecord, onBudget }: Props) {
  const bankSms = projectUrl ? getReleasedBankSmsV4(projectUrl) : null;
  return <section className="setting-card quick-start-card" aria-labelledby="quick-start-title">
    <div className="setting-heading"><Smartphone size={23} /><h2 id="quick-start-title">快速上手</h2></div>
    <p>选择适合你的记账方式，按指引完成设置，再核对第一笔记录。</p>
    <div className="quick-start-methods">
      <article className="quick-start-method" aria-labelledby="quick-start-screenshot-title">
        <div className="quick-start-method-heading"><ScanText size={20} aria-hidden="true" /><h3 id="quick-start-screenshot-title">截图记账</h3></div>
        <p>适合支付宝、微信支付等单笔付款详情。轻点手机背面两下，识别金额、商户和时间，再由你核对保存。</p>
        <ol className="quick-start-screenshot-steps">
          <li><strong>添加通用快捷指令</strong><span>按指引添加“{SCREENSHOT_SHORTCUT_TEMPLATE.name}”。</span></li>
          <li><strong>绑定轻点背面两下</strong><span>在付款详情页主动触发整条指令。</span></li>
          <li><strong>核对并保存第一笔</strong><span>查看候选账目，补齐缺项后确认保存。</span></li>
        </ol>
        <p className="help-text">提取结果显示在候选卡中，原始识别文字保留供核对。</p>
        <button type="button" className="button primary" onClick={onScreenshotSetup}>设置截图记账<ArrowRight size={17} /></button>
      </article>
      <article className="quick-start-method" aria-labelledby="quick-start-sms-title">
        <div className="quick-start-method-heading"><MessageSquare size={20} aria-hidden="true" /><h3 id="quick-start-sms-title">短信自动记账</h3></div>
        {onSmsAutomation ? <>
          <p>连接 iPhone 短信自动化，接收新收到的银行收入与支出短信。工资等收入先待确认，核对后再入账。</p>
          <div className="quick-start-support" aria-label="当前银行接入范围">
            <p><strong>工商银行</strong><span>开启自动记录后，明确消费可自动入账；收入、群收款和不明确的记录仍需确认。</span></p>
            <p><strong>农行 · 中行 · 建行 · 招商银行</strong><span>新收入与支出收到后先待确认，核对后再入账；未知格式或遮罩金额需补填。</span></p>
            <p><strong>手机设置</strong><span>{bankSms ? "添加一条记账快捷指令，再设置一次收到银行短信时运行。" : BANK_ACTIVITY_TEMPLATE.url ? "安装收支新版，并设置短信自动化触发条件。" : "收支新版共享安装链接待发布。旧工行、农中建安装模板仅筛选支出。"}</span></p>
          </div>
          <button type="button" className="button secondary" onClick={onSmsAutomation}>开通短信自动记账<ArrowRight size={17} /></button>
          <details className="quick-start-checklist">
            <summary>查看开通步骤</summary>
            <ol>
              <li><strong>启用自己的接入</strong><span>同意转发后，复制并保存个人令牌。不要使用别人的令牌。</span></li>
              <li><strong>添加记账快捷指令</strong><span>{bankSms ? `安装「${bankSms.name}」，粘贴个人令牌。` : "按指引选择模板，安装时填写自己的令牌。网页更新不会升级手机上已安装的旧模板。"}</span></li>
              <li><strong>设置手机触发</strong><span>选择真实银行短信发件人，{bankSms ? "收到短信时运行记账指令。" : "收支新版的“信息包含”留空，将新短信正文传给收支指令。"}</span></li>
            </ol>
            <p className="help-text">启用接入不代表手机已配置完成。历史短信不会自动导入，收到短信也不等于已经入账。</p>
          </details>
        </> : <>
          <p>短信自动接收需要登录已配置云端服务的账号版。</p>
          <p className="help-text">当前为本机模式，可以先使用截图记账或手动记账。</p>
        </>}
      </article>
    </div>
    <div className="quick-start-other">
      <p>{onSmsAutomation ? "也可以直接手动记账，或设置每月预算。" : "账目保存在当前设备与浏览器，换设备前请导出完整备份。"}</p>
      <div className="quick-start-actions">
        <button type="button" className="button secondary" onClick={onRecord}><Pencil size={17} />手动记一笔</button>
        <button type="button" className="button secondary" onClick={onBudget}><Wallet size={17} />设置月预算</button>
      </div>
    </div>
  </section>;
}
