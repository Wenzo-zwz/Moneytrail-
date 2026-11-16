import { useEffect, useId, useRef, useState } from "react";
import { ArrowRight, FileText, ScanText } from "lucide-react";
import { formatMoney } from "../lib/ledger";
import type { MerchantRule } from "../lib/merchantClassification";
import { parsePaymentScreenshot, type PaymentScreenshotCandidate } from "../lib/paymentScreenshot";

export type ScreenshotIncoming = { id: number; text: string; error?: string };

type Props = {
  incoming?: ScreenshotIncoming | null;
  rules?: MerchantRule[];
  rulesLoading?: boolean;
  onReview: (candidate: PaymentScreenshotCandidate) => void;
  onConsumeIncoming: (id: number) => void;
};

const MAX_TEXT_LENGTH = 16_000;
type PaymentSource = PaymentScreenshotCandidate["source"];

function paymentSource(value: unknown): PaymentSource {
  return value === "alipay" || value === "wechat" ? value : "manual";
}

export default function AlipayScreenshotCapture({ incoming, rules = [], rulesLoading = false, onReview, onConsumeIncoming }: Props) {
  const [text, setText] = useState("");
  const [result, setResult] = useState<ReturnType<typeof parsePaymentScreenshot> | null>(null);
  const [sourceChoices, setSourceChoices] = useState<Record<string, PaymentSource>>({});
  const [notice, setNotice] = useState("");
  const [waiting, setWaiting] = useState<ScreenshotIncoming[]>([]);
  const lastIncomingId = useRef<number | null>(null);
  const id = useId();

  useEffect(() => {
    if (!incoming || lastIncomingId.current === incoming.id || rulesLoading) return;
    lastIncomingId.current = incoming.id;
    if (incoming.error) {
      setNotice(incoming.error);
      onConsumeIncoming(incoming.id);
      return;
    }
    if (!text.trim() && !result && waiting.length === 0) {
      setText(incoming.text);
      setResult(parsePaymentScreenshot(incoming.text, rules));
      setSourceChoices({});
      setNotice("已收到快捷指令传来的截图文字，请核对识别结果。");
      onConsumeIncoming(incoming.id);
    } else {
      setWaiting(previous => [...previous, incoming]);
    }
  }, [incoming, rules, rulesLoading, text, result, waiting.length, onConsumeIncoming]);

  function useIncoming() {
    const next = waiting[0];
    if (!next || rulesLoading) return;
    setText(next.text);
    setResult(parsePaymentScreenshot(next.text, rules));
    setSourceChoices({});
    setNotice("已使用新截图文字，请核对识别结果。");
    setWaiting(previous => previous.filter(item => item.id !== next.id));
    onConsumeIncoming(next.id);
  }

  function ignoreIncoming() {
    const next = waiting[0];
    if (!next) return;
    setWaiting(previous => previous.filter(item => item.id !== next.id));
    onConsumeIncoming(next.id);
  }

  function recognize() {
    if (rulesLoading || !text.trim()) return;
    setNotice("");
    setResult(parsePaymentScreenshot(text, rules));
    setSourceChoices({});
  }

  return <div className="screenshot-capture" aria-labelledby={`${id}-title`}>
    <div className="screenshot-capture-heading">
      <ScanText size={22} aria-hidden="true" />
      <div><h3 id={`${id}-title`}>支付截图识别</h3><p>支付宝、微信支付或其他付款详情中的文字先在这里核对，确认保存后才会记入当前账本。</p></div>
    </div>
    {waiting.length > 0 && <div className="notice warning screenshot-incoming" role="status">
      <div><strong>收到新的截图文字</strong><p>当前文字和识别结果已保留。使用新截图将替换这里的内容。{waiting.length > 1 && `还有 ${waiting.length - 1} 份等待处理。`}</p></div>
      <div className="screenshot-actions"><button type="button" className="button secondary small" disabled={rulesLoading} onClick={useIncoming}>使用新截图</button><button type="button" className="button ghost small" onClick={ignoreIncoming}>忽略新截图</button></div>
    </div>}
    {notice && <p className="notice screenshot-notice" role="status">{notice}</p>}
    <div className="form-field">
      <label htmlFor={`${id}-text`}>截图提取的文字</label>
      <textarea id={`${id}-text`} rows={8} maxLength={MAX_TEXT_LENGTH} value={text}
        placeholder="通过 iPhone 快捷指令接收截图文字，或在这里粘贴支付宝、微信支付及其他付款详情中的文字。"
        onPaste={event => {
          const pasted = event.clipboardData.getData("text");
          const target = event.currentTarget;
          if (text.length - (target.selectionEnd - target.selectionStart) + pasted.length > MAX_TEXT_LENGTH) {
            event.preventDefault();
            setNotice("截图文字过长，请只保留一张付款详情的文字后重试。当前内容已保留。");
          }
        }}
        onChange={event => {
          if (event.target.value.length > MAX_TEXT_LENGTH) {
            setNotice("截图文字过长，请只保留一张付款详情的文字后重试。");
            return;
          }
          setText(event.target.value); setResult(null); setSourceChoices({}); setNotice("");
        }} />
      <p className="help-text">优先使用付款详情页。截图中的手机时钟、通知接收时间和“昨天”不作为交易日期；未识别的字段需要补充。</p>
    </div>
    <div className="form-actions screenshot-actions">
      <button type="button" className="button primary" disabled={!text.trim() || rulesLoading} onClick={recognize}><FileText size={17} />识别截图文字</button>
      <button type="button" className="button ghost" disabled={!text && !result} onClick={() => { setText(""); setResult(null); setSourceChoices({}); setNotice(""); }}>清空截图文字</button>
    </div>
    {rulesLoading && <p className="help-text" role="status">正在读取个人商户规则，稍后显示识别结果…</p>}
    {result && <div className="screenshot-results" aria-labelledby={`${id}-results`}>
      <h3 id={`${id}-results`}>截图识别结果{result.candidates.length > 0 && ` · ${result.candidates.length} 笔待核对`}</h3>
      {result.error && <p className="notice warning" role="alert">{result.error}</p>}
      {result.warnings.length > 0 && <div className="notice warning" role="status"><ul>{result.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></div>}
      {result.candidates.length === 0 && !result.error && <p className="screenshot-empty">未找到可核对的支出，请检查文字是否完整，或使用手动录入。</p>}
      <div className="screenshot-candidates">{result.candidates.map((candidate, index) => <article className="screenshot-candidate" key={candidate.key}>
        <div className="screenshot-candidate-heading"><h4>{candidate.merchant}</h4><strong>{formatMoney(candidate.amountCents)}</strong></div>
        <dl><div><dt>交易时间</dt><dd className={candidate.date ? undefined : "screenshot-missing"}>{candidate.date ? candidate.date.replace("T", " ") : "需填写"}</dd></div><div><dt>分类</dt><dd>{candidate.category}{candidate.subcategory && ` · ${candidate.subcategory}`}</dd></div></dl>
        <div className="screenshot-source-field">
          <label htmlFor={`${id}-source-${index}`}>支付来源</label>
          <select id={`${id}-source-${index}`} aria-label={`支付来源：${candidate.merchant}`}
            value={sourceChoices[candidate.key] ?? paymentSource(candidate.source)}
            onChange={event => setSourceChoices(previous => ({ ...previous, [candidate.key]: paymentSource(event.target.value) }))}>
            <option value="alipay">支付宝</option>
            <option value="wechat">微信支付</option>
            <option value="manual">其他或未确认</option>
          </select>
          {(sourceChoices[candidate.key] ?? paymentSource(candidate.source)) === "manual" && <p>支付平台未确认，请根据原画面选择；也可以保留“其他或未确认”。</p>}
        </div>
        <p>请与原画面核对金额、时间和支付来源；相近消费会在记账表单中提示疑似重复。</p>
        <button type="button" className="button secondary" onClick={() => onReview({ ...candidate, source: sourceChoices[candidate.key] ?? paymentSource(candidate.source) })}>核对并记账<ArrowRight size={17} /></button>
      </article>)}</div>
    </div>}
  </div>;
}
