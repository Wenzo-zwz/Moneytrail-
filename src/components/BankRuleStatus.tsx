import { useEffect, useState } from "react";
import { BANK_RULES_PATH, isBankRulesProjectCompatible, readPublishedBankRules } from "../lib/bankRules";
import type { BankRuleManifest } from "../lib/bankRulesValidation";
import { getReleasedBankRulesV4, getReleasedBankSmsV4 } from "../lib/bankRulesV4";

type RuleState = { phase: "loading" | "ready" | "error"; rule?: BankRuleManifest };

export default function BankRuleStatus({ projectUrl }: { projectUrl: string }) {
  const compatible = isBankRulesProjectCompatible(projectUrl);
  const v4 = getReleasedBankRulesV4(projectUrl);
  const sms = getReleasedBankSmsV4(projectUrl);
  const [state, setState] = useState<RuleState>({ phase: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    if (!compatible) return;
    const controller = new AbortController();
    setState({ phase: "loading" }); setNotice("");
    const requestTimer = setTimeout(() => { controller.abort(); setState({ phase: "error" }); }, 15_000);
    readPublishedBankRules(projectUrl, controller.signal).then(rule => {
      if (!controller.signal.aborted) setState({ phase: "ready", rule });
    }).catch(() => { if (!controller.signal.aborted) setState({ phase: "error" }); }).finally(() => clearTimeout(requestTimer));
    return () => { clearTimeout(requestTimer); controller.abort(); };
  }, [projectUrl, compatible, attempt]);
  async function copy() {
    if (!compatible || state.phase !== "ready" || !state.rule) return;
    try { await navigator.clipboard.writeText(state.rule.matchPattern); setNotice("已复制发布规则，供手动核验。手机使用的版本请在设备上核对。"); }
    catch { setNotice("复制未完成，请展开规则并手动复制。"); }
  }
  return <section className="three-bank-guide" aria-label="银行规则发布状态">
    <h4>银行规则发布状态</h4>
    {!compatible ? <p className="sms-shortcut-caution">当前项目没有配套的规则发布清单。请使用当前部署维护的模板与规则。</p> : <>
      <p>{v4 ? "缓存版可通过独立更新指令下载规则，更新结果请在手机上核对。" : "v4 私有试用已有真机验证。此清单供本机缓存版使用。"}{sms ? "单条记账指令使用内置筛选规则。" : "现有 v3 使用模板内置规则。"}</p>
      {state.phase === "ready" && state.rule ? <>
        <p role="status">网页已发布规则 v{state.rule.version} · 最低快捷指令版本 v{state.rule.minShortcutVersion}</p>
        <p className="help-text">发布时间：<time dateTime={state.rule.publishedAt}>{state.rule.publishedAt}</time></p>
        <details className="three-bank-maker"><summary>查看已发布匹配规则</summary><pre className="three-bank-pattern"><code>{state.rule.matchPattern}</code></pre></details>
        <button className="button secondary small" type="button" onClick={() => void copy()}>复制已发布匹配规则</button>
        <p className="help-text">复制供制作新版和手动核验使用，不能据此判断手机已安装或正在使用该版本。</p>
      </> : <p role="status">{state.phase === "loading" ? "正在读取网页规则版本…" : "规则版本读取未完成。现有快捷指令与收件箱继续按原配置运行，可稍后重试。"}</p>}
      <button className="button secondary small" type="button" disabled={state.phase === "loading"} onClick={() => setAttempt(value => value + 1)}>检查网页规则版本</button>
      <a className="button secondary small" href={BANK_RULES_PATH} target="_blank" rel="noopener noreferrer">查看规则清单</a>
      <p className="three-bank-copy-notice" role="status" aria-live="polite">{notice}</p>
    </>}
  </section>;
}
