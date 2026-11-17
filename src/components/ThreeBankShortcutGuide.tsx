import { useState } from "react";
import { getCompatibleSmsShortcutTemplate, getGenericSmsShortcutIphoneSteps, getGenericSmsShortcutSignCommand, getGenericSmsShortcutSource, isGenericSmsShortcutCompatible } from "../lib/bankOnboarding";
import type { SmsBankCode } from "../lib/smsBanks";

export default function ThreeBankShortcutGuide({ projectUrl, bankCode, enabled }: { projectUrl: string; bankCode: Exclude<SmsBankCode, "icbc">; enabled: boolean }) {
  const [notice, setNotice] = useState("");
  const template = getCompatibleSmsShortcutTemplate(projectUrl, bankCode);
  const source = getGenericSmsShortcutSource(bankCode);
  const compatible = isGenericSmsShortcutCompatible(projectUrl, bankCode);
  const title = source.version === 1 ? "农中建通用模板" : "通用银行模板（含招商银行）";
  const signCommand = getGenericSmsShortcutSignCommand(bankCode);
  const iphoneSteps = getGenericSmsShortcutIphoneSteps(bankCode);
  async function copy(value: string, message: string) {
    try { await navigator.clipboard.writeText(value); setNotice(message); }
    catch { setNotice("复制未完成，请选中文本后手动复制。"); }
  }
  return <section className="three-bank-guide" aria-label={title}>
    <h5>{title}</h5>
    <p>{source.version === 1 ? "农业银行、中国银行、建设银行" : "农业银行、中国银行、建设银行、招商银行"}的储蓄卡和信用卡共用一份「{source.name}」，每个人在安装时填写自己的令牌，并保留模板名称。</p>
    {enabled && template ? <a className="button primary sms-shortcut-install" href={template.url} target="_blank" rel="noopener noreferrer">安装支出快捷指令</a> : <button className="button secondary sms-shortcut-install" type="button" disabled>安装支出快捷指令</button>}
    <p>收到后先待确认。请核对金额、日期、商户及消费或转账性质，确认后才计入首页金额；未知格式可能需要手动补齐字段。</p>
    {!compatible ? <p className="sms-shortcut-caution">通用模板固定连接慢慢记账生产服务，与当前部署不匹配。请勿把当前账户令牌填入此模板，请使用下方高级配置中的当前项目地址与公开密钥制作配套指令。</p> : <>
      {!enabled && <p className="sms-shortcut-caution">请先在上方启用个人接入并保存令牌，再安装模板。</p>}
      {!template && <p className="sms-shortcut-caution">包含招商银行的新版共享安装链接尚未发布。旧农中建模板不会转发招商银行短信；请按下方步骤更新匹配规则并分享新版，或在 Mac 签名后安装。</p>}
      <details className="three-bank-maker" open={!template}>
        <summary>制作与分享模板（仅需一次）</summary>
        <p>{template ? "以下为维护者重新制作或分享模板时使用的说明。普通用户直接使用上方安装入口，无需重复制作。" : "新版可先由维护者按以下步骤制作和分享，再交给新用户安装。"}以下未签名源文件不是可直接安装的快捷指令。</p>
        <h6>使用 Mac 签名</h6>
        <p>下载未签名源文件到 Mac 的“下载”文件夹，在“终端”运行下面命令。生成的 .shortcut 文件可供 iPhone 导入；也可在 Mac 的“快捷指令”中导出给“任何人”使用。</p>
        <a className="button secondary small" href={`${import.meta.env.BASE_URL}${source.sourcePath.slice(1)}`} download>下载模板源文件</a>
        <pre><code>{signCommand}</code></pre>
        <button className="button secondary small" type="button" onClick={() => void copy(signCommand, "Mac 签名命令已复制。")}>复制 Mac 签名命令</button>
        <h6>使用 iPhone 制作</h6>
        <p>{source.version === 1 ? "复制现有基础模板并重命名。只改两处：在第一个“如果”之前增加“匹配文本”，再把该“如果”改为“匹配文本有任何值”。" : "复制已发布的农中建通用模板并重命名，将已有“匹配文本”的规则整体替换为新版，不要重复增加匹配操作。"}请求和通知沿用原结构。</p>
        <p>匹配文本的输入选“短信正文”，关闭区分大小写，粘贴下方规则。分享前将令牌文本和导入默认答案留空。</p>
        <pre className="three-bank-pattern"><code>{source.matchPattern}</code></pre>
        <div className="three-bank-actions"><button className="button secondary small" type="button" onClick={() => void copy(source.matchPattern, "匹配规则已复制，请完整粘贴到匹配文本操作。")}>复制匹配规则</button><button className="button secondary small" type="button" onClick={() => void copy(iphoneSteps, "iPhone 制作步骤已复制。")}>复制 iPhone 制作步骤</button></div>
        <p>用“分享 → 复制 iCloud 链接”发布空白副本。重新制作的链接需核验后再替换安装入口，网页更新不会自动更新手机上的指令。</p>
      </details>
      <p className="three-bank-copy-notice" role="status" aria-live="polite">{notice}</p>
    </>}
  </section>;
}
