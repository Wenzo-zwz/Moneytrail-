import { useState } from "react";
import { ArrowRight, Copy, ScanText } from "lucide-react";
import { getCompatibleScreenshotShortcutTemplate, SCREENSHOT_SHORTCUT_TEMPLATE } from "../lib/screenshotShortcutTemplate";

type Props = { onOpenCapture: () => void };

function currentCapturePrefix(): string | null {
  if (typeof location === "undefined" || !["http:", "https:"].includes(location.protocol)) return null;
  const url = new URL(import.meta.env.BASE_URL, location.origin);
  url.hash = "screenshot=";
  return url.href;
}

export default function ScreenshotCaptureSettings({ onOpenCapture }: Props) {
  const [notice, setNotice] = useState("");
  const prefix = currentCapturePrefix();
  const template = prefix ? getCompatibleScreenshotShortcutTemplate(prefix) : null;

  async function copyPrefix() {
    if (!prefix) return;
    try {
      await navigator.clipboard.writeText(prefix);
      setNotice("地址前缀已复制。在快捷指令的“文本”中粘贴后，紧接着插入 URL 编码的结果变量。");
    } catch {
      setNotice("复制未完成，请选中下方地址后手动复制。");
    }
  }

  return <section className="screenshot-settings" aria-labelledby="screenshot-settings-title">
    <div className="setting-heading"><ScanText size={23} /><h2 id="screenshot-settings-title">轻点背面，截图记账</h2></div>
    <p>首次完成这三步，以后在付款详情页轻点手机背面两下，就能打开账本核对。请在打开的网页中确认自己的账户；本机模式的账目保存在当前浏览器。</p>
    <section className="screenshot-setup-step" aria-labelledby="screenshot-install-title">
      <h3 id="screenshot-install-title">1. 安装通用快捷指令</h3>
      {template ? <>
        <p>添加“{template.name}”，支付宝、微信支付等付款详情共用同一条指令，无需填写接入令牌。</p>
        <a className="button primary" href={template.url} target="_blank" rel="noopener noreferrer">安装截图记账快捷指令<ArrowRight size={17} /></a>
      </> : <details className="screenshot-setup-guide">
        <summary>配置 iPhone 截图快捷指令</summary>
        <p>新建快捷指令并命名为“{SCREENSHOT_SHORTCUT_TEMPLATE.name}”，按下面顺序添加操作。截图应是第一步，付款详情保持在屏幕上。</p>
        <ol>
          <li><strong>截屏</strong><span>获取当时的付款画面。</span></li>
          <li><strong>从图像提取文本</strong><span>图像输入选择上一步“截屏”的结果。</span></li>
          <li><strong>URL 编码</strong><span>输入选择上一步提取的文本，操作使用“编码”。</span></li>
          <li><strong>文本</strong><span>先粘贴下方地址前缀，再在末尾插入“URL 编码”的结果变量，两者之间不添加空格或换行。</span></li>
          <li><strong>打开 URL</strong><span>输入选择上一步完整的“文本”。</span></li>
        </ol>
        {prefix ? <div className="screenshot-url-field"><span>“文本”操作使用的地址前缀</span><code>{prefix}</code><button type="button" className="button secondary small" onClick={() => void copyPrefix()}><Copy size={16} />复制地址前缀</button><p>前缀后面插入编码结果的变量，不要手写变量名称。</p></div> : <p className="help-text">在当前部署的网页中打开此设置，即可复制对应地址前缀。</p>}
        {notice && <p className="screenshot-copy-notice" role="status">{notice}</p>}
      </details>}
    </section>
    <section className="screenshot-setup-step" aria-labelledby="screenshot-back-tap-title">
      <h3 id="screenshot-back-tap-title">2. 绑定轻点背面两下</h3>
      <p className="screenshot-back-tap-path">设置 → 辅助功能 → 触控 → 轻点背面 → 轻点两下 → 快捷指令 → {SCREENSHOT_SHORTCUT_TEMPLATE.name}</p>
      <p>选择整条“{SCREENSHOT_SHORTCUT_TEMPLATE.name}”快捷指令。首次运行如有系统权限提示，允许后回到付款详情页再试。</p>
    </section>
    <section className="screenshot-setup-step" aria-labelledby="screenshot-first-record-title">
      <h3 id="screenshot-first-record-title">3. 试记并保存第一笔</h3>
      <ol className="screenshot-first-record">
        <li>打开一笔已有的支付宝或微信付款详情，保持金额、商户和付款时间可见。</li>
        <li>手机解锁，轻点背面两下，等待打开 MoneyTrail。</li>
        <li>查看上方候选账目，选择支付来源，补齐缺失的商户、时间或分类。</li>
        <li>点“核对并记账”，检查后点“确认保存”，再到账目页查看记录。</li>
      </ol>
      <p className="screenshot-result-tip">上方候选卡显示金额，表示提取成功。下方整段原文只是核对依据，会保留原样；确认保存后才会入账。</p>
      <button type="button" className="button secondary" onClick={onOpenCapture}>打开截图识别<ArrowRight size={17} /></button>
      <details className="screenshot-setup-guide">
        <summary>遇到问题时</summary>
        <p><strong>背面没有触发：</strong>先把“轻点两下”临时设为系统“截屏”，确认能触发后改回整条记账指令。</p>
        <p><strong>只有金额：</strong>先核对是已完成的消费支出，再点“确认是支出并补全”，填写商户和实际时间。</p>
        <p><strong>打开旧页面：</strong>到“设置 → 应用更新”检查更新，更新后回原付款页重新截图。</p>
        <p>文字由手机提取，网页按付款信息生成候选。退款、转账、余额和含义不明的多个金额需要手动核对。</p>
      </details>
    </section>
  </section>;
}
