import { useState } from "react";
import { isShortcutTemplateCompatible, SMS_SHORTCUT_TEMPLATE } from "../lib/shortcutTemplate";
import { getSmsBank, SMS_BANKS, type SmsBankCode } from "../lib/smsBanks";
import type { SmsConfig } from "../lib/smsClient";
import ThreeBankShortcutGuide from "./ThreeBankShortcutGuide";
import { THREE_BANK_TEMPLATE } from "../lib/bankOnboarding";

type Props = {
  projectUrl: string;
  config: SmsConfig;
  busy: boolean;
  onRefresh: () => void;
  bankCode?: SmsBankCode;
  onBankChange?: (code: SmsBankCode) => void;
};

const receiptTime = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Shanghai" });

export default function SmsShortcutSetup({ projectUrl, config, busy, onRefresh, bankCode: controlledBankCode, onBankChange }: Props) {
  const [localBankCode, setLocalBankCode] = useState<SmsBankCode>("icbc");
  const bankCode = controlledBankCode ?? localBankCode;
  const bank = getSmsBank(bankCode);
  const compatible = isShortcutTemplateCompatible(projectUrl);
  const canInstall = config.enabled && isShortcutTemplateCompatible(projectUrl, bankCode);
  const received = config.last_received_at ? new Date(config.last_received_at) : null;

  return <section className="sms-shortcut-setup" aria-label="iPhone 快捷指令安装">
    <h3 id="sms-shortcut-setup-title">在 iPhone 上接入</h3>
    <p className="sms-shortcut-intro">选择银行，查看短信转发配置。农行、中行、建行目前接收后先待确认，格式与字段需要逐条核对。</p>
    <label className="sms-shortcut-bank-picker"><span>要接入的银行</span><select aria-label="银行" value={bankCode} onChange={event => { const nextBank = event.target.value as SmsBankCode; setLocalBankCode(nextBank); onBankChange?.(nextBank); }}>{SMS_BANKS.map(item => <option key={item.code} value={item.code}>{item.name}{item.reviewOnly ? " · 接收后待确认" : " · 工行版模板"}</option>)}</select></label>
    <p className="sms-shortcut-bank-status" role="status">{bank.reviewOnly ? `${bank.name}：已登记接收，收到后先待确认；当前真实短信格式与手机转发仍需验证。` : "工商银行：在自动记录模式下，明确消费可自动入账；共享安装链接为工行版模板。"}</p>
    <p className="sms-shortcut-note">银行选择仅用于查看配置步骤，不会更换令牌或修改手机自动化。</p>
    <ol className="sms-shortcut-steps">
      <li>
        <div className="sms-shortcut-step-heading"><span aria-hidden="true">1</span><h4>启用个人接入</h4></div>
        <span className={`sms-shortcut-access-state${config.enabled ? " enabled" : ""}`}>{config.enabled ? "个人接入已启用" : "个人接入未启用"}</span>
        <p>使用上方按钮启用当前账户的个人接入。令牌只显示一次，请妥善保存；更换令牌会使旧令牌失效，所有仍在使用的设备与模板都需同步更新。</p>
        <p>已保存的有效令牌可继续使用，无需为安装模板再次更换。</p>
      </li>
      <li>
        <div className="sms-shortcut-step-heading"><span aria-hidden="true">2</span><h4>{bankCode === "icbc" ? "安装快捷指令" : "配置农中建通用模板"}</h4></div>
        {bankCode === "icbc" ? <>
          <p>用 iPhone 添加「{SMS_SHORTCUT_TEMPLATE.name}」工行版模板。导入时，在令牌问题中粘贴自己的个人令牌，并保留模板名称。</p>
          {canInstall ? <a className="button primary sms-shortcut-install" href={SMS_SHORTCUT_TEMPLATE.url} target="_blank" rel="noopener noreferrer">安装 iPhone 快捷指令</a> : <button className="button secondary sms-shortcut-install" type="button" disabled>安装 iPhone 快捷指令</button>}
          {!compatible ? <p className="sms-shortcut-caution">当前部署与此模板不匹配，请勿把当前账户令牌填入此模板。请使用下方「iPhone 配置步骤」中的高级手动配置指南，为当前部署配置快捷指令。</p> : !config.enabled && <p className="sms-shortcut-caution">请先在上方启用个人接入并保存令牌，再安装模板。</p>}
        </> : <>
          <ThreeBankShortcutGuide key={bankCode} compatible={compatible} />
          {!config.enabled && <p className="sms-shortcut-caution">请先在上方启用个人接入并保存令牌。</p>}
        </>}
      </li>
      <li>
        <div className="sms-shortcut-step-heading"><span aria-hidden="true">3</span><h4>创建短信自动化</h4></div>
        <p>在「快捷指令」App 进入「自动化」，新建「信息」触发：发件人选实际发送{bank.name}消费短信的号码（常见示例 {bank.senderExamples.join("、")}，以真实短信为准），信息包含「{bankCode === "icbc" ? "支出" : bank.name}」，选择「立即运行」。</p>
        <p>先添加「获取文本」，来源设为「快捷指令输入」；再添加「运行快捷指令」，选择{bankCode === "icbc" ? `「${SMS_SHORTCUT_TEMPLATE.name}」` : `「${THREE_BANK_TEMPLATE.name}」`}，将输入设为上一步得到的「文本」。</p>
        {bankCode === "icbc" ? <p className="sms-shortcut-note">当前模板用于工行消费短信。请保留其他设备或模板各自需要的触发与输入绑定。</p> : <>
          <p>储蓄卡和信用卡使用相同触发步骤。多家银行可各建一条自动化，运行同一份通用指令并沿用本账户令牌。</p>
          <p>通用指令会筛选银行名称、消费或扣款等词，并排除安全验证码。短信仍需通过输入变量传入。</p>
          <p className="sms-shortcut-note">正文需包含明确银行标记，如「【{bank.signatureNames[0]}】」或「（{bank.signatureNames[0]}）」。前后位置与写法由接收规则核对；缺少来源或格式未知时，不能据此视为已支持全部短信。</p>
        </>}
      </li>
      <li>
        <div className="sms-shortcut-step-heading"><span aria-hidden="true">4</span><h4>核对实际接收</h4></div>
        <div className="sms-shortcut-receipt"><span>服务器最近接收</span>{received && Number.isFinite(received.getTime()) ? <time dateTime={config.last_received_at!}>{receiptTime.format(received)}（北京时间）</time> : <strong>{config.last_received_at ? "接收时间暂不可用" : "尚未收到短信"}</strong>}</div>
        <button className="button secondary sms-shortcut-refresh" type="button" disabled={busy} onClick={onRefresh}>刷新接收状态</button>
        {!config.last_received_at && <p>尚无接收记录不代表手机设置有误，请等候符合条件的新短信。</p>}
        <p>历史接收时间不代表本次模板已验证。请等待一条新的真实{bank.name}消费短信，再刷新查看。</p>
        {bank.reviewOnly && <p>此银行收到后先待确认，不会自动增加消费。请核对或补齐金额、商户、日期和交易类型，再确认入账。</p>}
        <p>收到短信不等于已入账，请在收件箱核对「已入账」或「待确认」。</p>
      </li>
    </ol>
    <p className="sms-shortcut-boundary">「已启用」仅表示个人接入已打开，网页无法判断模板是否已安装、自动化是否已设置。手机上的安装与触发需按以上步骤实际核对。</p>
  </section>;
}
