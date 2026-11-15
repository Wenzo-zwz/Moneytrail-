import { useState } from "react";
import { ArrowRight, Copy, ScanText } from "lucide-react";

type Props = { onOpenCapture: () => void };

function currentCapturePrefix(): string | null {
  if (typeof location === "undefined" || !["http:", "https:"].includes(location.protocol)) return null;
  const url = new URL(import.meta.env.BASE_URL, location.origin);
  url.hash = "alipay-screenshot=";
  return url.href;
}

export default function ScreenshotCaptureSettings({ onOpenCapture }: Props) {
  const [notice, setNotice] = useState("");
  const prefix = currentCapturePrefix();

  async function copyPrefix() {
    if (!prefix) return;
    try {
      await navigator.clipboard.writeText(prefix);
      setNotice("地址前缀已复制。在快捷指令的“文本”中粘贴后，紧接着插入 URL 编码的结果变量。");
    } catch {
      setNotice("复制未完成，请选中下方地址后手动复制。");
    }
  }

  return <section className="setting-card screenshot-settings" aria-labelledby="screenshot-settings-title">
    <div className="setting-heading"><ScanText size={23} /><h2 id="screenshot-settings-title">轻点背面，截图记账</h2></div>
    <p>在支付宝付款详情页轻点手机背面两下，运行截屏与文字提取，再打开账本核对。iOS 18 可配置这条流程，无需先升级。</p>
    <button type="button" className="button secondary" onClick={onOpenCapture}>打开截图识别<ArrowRight size={17} /></button>
    <details className="screenshot-setup-guide">
      <summary>配置 iPhone 截图快捷指令</summary>
      <p>新建快捷指令并命名为“MoneyTrail 支付宝截图”，按下面顺序添加操作。截图应是第一步，付款详情保持在屏幕上。</p>
      <ol>
        <li><strong>截屏</strong><span>获取当时的付款画面。</span></li>
        <li><strong>从图像提取文本</strong><span>图像输入选择上一步的“截屏”。</span></li>
        <li><strong>URL 编码</strong><span>输入选择上一步提取的文本，操作使用“编码”。</span></li>
        <li><strong>文本</strong><span>先粘贴下方地址前缀，再在末尾插入“URL 编码”的结果变量，两者之间不添加空格或换行。</span></li>
        <li><strong>打开 URL</strong><span>输入选择上一步完整的“文本”。</span></li>
      </ol>
      {prefix ? <div className="screenshot-url-field"><span>“文本”操作使用的地址前缀</span><code>{prefix}</code><button type="button" className="button secondary small" onClick={() => void copyPrefix()}><Copy size={16} />复制地址前缀</button><p>前缀后面插入编码结果的变量，不要手写变量名称。</p></div> : <p className="help-text">在当前部署的网页中打开此设置，即可复制对应地址前缀。</p>}
      {notice && <p className="screenshot-copy-notice" role="status">{notice}</p>}
      <h3>绑定轻点背面两下</h3>
      <p className="screenshot-back-tap-path">设置 → 辅助功能 → 触控 → 轻点背面 → 轻点两下 → 快捷指令 → MoneyTrail 支付宝截图</p>
      <p>这里选择整条“MoneyTrail 支付宝截图”快捷指令，才能接着识别和打开账本。首次运行可能需要确认系统权限；完成后回到付款详情页再运行。</p>
      <p className="help-text">在手机已解锁、付款详情完整可见时使用。文字在手机提取，快捷指令无需个人接入令牌。识别结果还需核对并保存；遮挡、缺失或识别不清的字段不能自动补全。</p>
    </details>
  </section>;
}
