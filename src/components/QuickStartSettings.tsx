import { ArrowRight, MessageSquare, Pencil, Smartphone, Wallet } from "lucide-react";

type Props = {
  onSmsAutomation?: () => void;
  onRecord: () => void;
  onBudget: () => void;
};

export default function QuickStartSettings({ onSmsAutomation, onRecord, onBudget }: Props) {
  return <section className="setting-card quick-start-card" aria-labelledby="quick-start-title">
    <div className="setting-heading"><Smartphone size={23} /><h2 id="quick-start-title">快速上手</h2></div>
    <p>{onSmsAutomation
      ? "连接 iPhone 快捷指令，让新收到的银行消费短信进入你的账户账本。"
      : "先记下第一笔消费，再设置月预算。当前为本机模式，短信自动接收需要登录已配置云端服务的账号版。"}</p>
    {onSmsAutomation && <>
      <div className="quick-start-support" aria-label="当前银行接入范围">
        <p><strong>工商银行</strong><span>开启自动记录后，明确消费可自动入账；群收款和不明确的记录仍需确认。</span></p>
        <p><strong>农行 · 中行 · 建行</strong><span>可安装农中建通用模板，收到后先待确认，核对后再入账。</span></p>
      </div>
      <button type="button" className="button primary" onClick={onSmsAutomation}><MessageSquare size={17} />开通短信自动记账<ArrowRight size={17} /></button>
      <details className="quick-start-checklist">
        <summary>查看开通步骤</summary>
        <ol>
          <li><strong>启用自己的接入</strong><span>同意转发后，复制并保存个人令牌。不要使用别人的令牌。</span></li>
          <li><strong>安装对应模板</strong><span>在安装时填写自己的令牌；根据银行查看可用模板与接收范围。</span></li>
          <li><strong>设置手机触发</strong><span>按 iPhone 中的指引选择银行发件人，将新短信正文传给快捷指令。</span></li>
          <li><strong>核对第一条真实短信</strong><span>等待新的消费短信，在收件箱核对接收时间、金额和“已入账／待确认”状态。</span></li>
        </ol>
        <p className="help-text">启用接入不代表手机已配置完成。历史短信不会自动导入，收到短信也不等于已经入账。</p>
      </details>
    </>}
    <div className="quick-start-other">
      <p>{onSmsAutomation ? "也可以先从一笔手动记录开始。" : "账目保存在当前设备与浏览器，换设备前请导出完整备份。"}</p>
      <div className="quick-start-actions">
        <button type="button" className={`button ${onSmsAutomation ? "secondary" : "primary"}`} onClick={onRecord}><Pencil size={17} />手动记一笔</button>
        <button type="button" className="button secondary" onClick={onBudget}><Wallet size={17} />设置月预算</button>
      </div>
    </div>
  </section>;
}
