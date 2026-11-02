import { useState } from "react";
import { THREE_BANK_IPHONE_STEPS, THREE_BANK_SIGN_COMMAND, THREE_BANK_TEMPLATE } from "../lib/bankOnboarding";

export default function ThreeBankShortcutGuide({ compatible }: { compatible: boolean }) {
  const [notice, setNotice] = useState("");
  async function copy(value: string, message: string) {
    try { await navigator.clipboard.writeText(value); setNotice(message); }
    catch { setNotice("复制未完成，请选中文本后手动复制。"); }
  }
  return <section className="three-bank-guide" aria-label="农中建通用模板">
    <h5>农中建通用模板</h5>
    <p>农业银行、中国银行、建设银行的储蓄卡和信用卡共用一份「{THREE_BANK_TEMPLATE.name}」，每个人在安装时填写自己的令牌。</p>
    <p className="sms-shortcut-caution">共享安装链接尚未发布。未签名源文件需要先由 Apple 设备签名或制作分享，完成后才能交给同事直接安装。</p>
    <p>收到后先待确认。请核对金额、日期、商户及消费或转账性质，确认后才计入首页金额；未知格式可能需要手动补齐字段。</p>
    {!compatible ? <p className="sms-shortcut-caution">通用模板固定连接慢慢记账生产服务，与当前部署不匹配。请使用下方高级配置中的当前项目地址与公开密钥制作配套指令。</p> : <>
      <details className="three-bank-maker">
        <summary>制作与分享模板（仅需一次）</summary>
        <p>制作者完成签名或分享后，其他人可使用同一份模板。以下源文件不是可直接安装的快捷指令。</p>
        <h6>使用 Mac 签名</h6>
        <p>下载未签名源文件到 Mac 的“下载”文件夹，在“终端”运行下面命令。生成的 .shortcut 文件可供 iPhone 导入；也可在 Mac 的“快捷指令”中导出给“任何人”使用。</p>
        <a className="button secondary small" href={`${import.meta.env.BASE_URL}${THREE_BANK_TEMPLATE.sourcePath.slice(1)}`} download>下载模板源文件</a>
        <pre><code>{THREE_BANK_SIGN_COMMAND}</code></pre>
        <button className="button secondary small" type="button" onClick={() => void copy(THREE_BANK_SIGN_COMMAND, "Mac 签名命令已复制。")}>复制 Mac 签名命令</button>
        <h6>使用 iPhone 制作</h6>
        <p>复制现有基础模板并重命名。只改两处：在第一个“如果”之前增加“匹配文本”，再把该“如果”改为“匹配文本有任何值”。请求和通知沿用原结构。</p>
        <p>匹配文本的输入选“短信正文”，关闭区分大小写，粘贴下方规则。分享前将令牌文本和导入默认答案留空。</p>
        <pre className="three-bank-pattern"><code>{THREE_BANK_TEMPLATE.matchPattern}</code></pre>
        <div className="three-bank-actions"><button className="button secondary small" type="button" onClick={() => void copy(THREE_BANK_TEMPLATE.matchPattern, "匹配规则已复制，请完整粘贴到匹配文本操作。")}>复制匹配规则</button><button className="button secondary small" type="button" onClick={() => void copy(THREE_BANK_IPHONE_STEPS, "iPhone 制作步骤已复制。")}>复制 iPhone 制作步骤</button></div>
        <p>用“分享 → 复制 iCloud 链接”发布空白副本。新链接审查通过前，网页仍保留待发布状态。</p>
      </details>
      <p className="three-bank-copy-notice" role="status" aria-live="polite">{notice}</p>
    </>}
  </section>;
}
