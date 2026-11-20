import { useState } from "react";
import { BANK_ACTIVITY_IPHONE_STEPS, BANK_ACTIVITY_SIGN_COMMAND, BANK_ACTIVITY_TEMPLATE, getCompatibleBankActivityTemplate, isBankActivityTemplateCompatible } from "../lib/bankOnboarding";
import type { SmsBankCode } from "../lib/smsBanks";

export default function BankActivityShortcutGuide({ projectUrl, bankCode, enabled }: { projectUrl: string; bankCode: SmsBankCode; enabled: boolean }) {
  const [notice, setNotice] = useState("");
  const installer = getCompatibleBankActivityTemplate(projectUrl, bankCode);
  const compatible = isBankActivityTemplateCompatible(projectUrl, bankCode);
  async function copy(value: string, message: string) {
    try { await navigator.clipboard.writeText(value); setNotice(message); }
    catch { setNotice("复制未完成，请选中文本后手动复制。"); }
  }
  return <section className="three-bank-guide" aria-label="收入与支出快捷指令">
    <h5>收入与支出快捷指令</h5>
    <p>「{BANK_ACTIVITY_TEMPLATE.name}」用于工行、农行、中行、建行、招商银行的新收入与支出短信。收入全部先待确认，核对交易类型、金额与时间后才入账；遮罩金额需要补填，不会猜测。</p>
    {enabled && installer ? <a className="button primary sms-shortcut-install" href={installer.url} target="_blank" rel="noopener noreferrer">安装收支快捷指令</a> : <button className="button secondary sms-shortcut-install" type="button" disabled>安装收支快捷指令</button>}
    {!compatible ? <p className="sms-shortcut-caution">收支模板固定连接生产服务，与当前部署不匹配。请使用当前项目的接收地址与公开密钥制作配套指令，勿把当前账户令牌填入生产模板。</p> : <>
      {!enabled && <p className="sms-shortcut-caution">请先启用个人接入并保存自己的令牌。</p>}
      {!installer && <p className="sms-shortcut-caution">收支新版共享安装链接尚未发布。已发布的工行版和农中建版仅接收支出。</p>}
      <details className="three-bank-maker">
        <summary>维护者选项：制作与签名收支模板</summary>
        <p>从空白农中建模板复制后，替换现有“匹配文本”的整条规则，保留请求与通知。个人令牌和导入默认答案在分享副本中留空。</p>
        <pre className="three-bank-pattern"><code>{BANK_ACTIVITY_TEMPLATE.matchPattern}</code></pre>
        <div className="three-bank-actions"><button className="button secondary small" type="button" onClick={() => void copy(BANK_ACTIVITY_TEMPLATE.matchPattern, "收支匹配规则已复制。")}>复制收支匹配规则</button><button className="button secondary small" type="button" onClick={() => void copy(BANK_ACTIVITY_IPHONE_STEPS, "收支制作步骤已复制。")}>复制收支iPhone步骤</button></div>
        <h6>使用 Mac 签名</h6>
        <p>以下为未签名源文件，不能直接在 iPhone 安装。下载到 Mac 的“下载”文件夹后签名，再导入或分享。</p>
        <a className="button secondary small" href={`${import.meta.env.BASE_URL}${BANK_ACTIVITY_TEMPLATE.sourcePath.slice(1)}`} download>下载收支模板源文件</a>
        <pre><code>{BANK_ACTIVITY_SIGN_COMMAND}</code></pre>
        <button className="button secondary small" type="button" onClick={() => void copy(BANK_ACTIVITY_SIGN_COMMAND, "收支签名命令已复制。")}>复制收支Mac签名命令</button>
        <p>发布新 iCloud 链接前需核对实际产物。网页更新不会改动手机上已安装的旧指令。</p>
      </details>
      <p className="three-bank-copy-notice" role="status" aria-live="polite">{notice}</p>
    </>}
  </section>;
}
