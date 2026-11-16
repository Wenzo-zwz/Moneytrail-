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
  const [editorOpen, setEditorOpen] = useState(false);
  const textField = useRef<HTMLTextAreaElement>(null);
  const resultsHeading = useRef<HTMLHeadingElement>(null);
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
      setNotice("已收到截图文字。");
      setEditorOpen(false);
      requestAnimationFrame(() => resultsHeading.current?.focus());
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
    setNotice("已使用新截图文字。");
    setEditorOpen(false);
    requestAnimationFrame(() => resultsHeading.current?.focus());
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
    setEditorOpen(false);
    requestAnimationFrame(() => resultsHeading.current?.focus());
  }

  function editText() {
    setEditorOpen(true);
    requestAnimationFrame(() => textField.current?.focus());
  }

  return <div className="screenshot-capture" aria-labelledby={`${id}-title`}>
    <div className="screenshot-capture-heading">
      <ScanText size={22} aria-hidden="true" />
      <div><h3 id={`${id}-title`}>支付截图识别</h3><p>核对商户、金额、付款时间和支付来源，确认保存后记入当前账本。</p></div>
    </div>
    {waiting.length > 0 && <div className="notice warning screenshot-incoming" role="status">
      <div><strong>收到新的截图文字</strong><p>当前文字和识别结果已保留。使用新截图将替换这里的内容。{waiting.length > 1 && `还有 ${waiting.length - 1} 份等待处理。`}</p></div>
      <div className="screenshot-actions"><button type="button" className="button secondary small" disabled={rulesLoading} onClick={useIncoming}>使用新截图</button><button type="button" className="button ghost small" onClick={ignoreIncoming}>忽略新截图</button></div>
    </div>}
    {notice && <p className="notice screenshot-notice" role="status">{notice}</p>}
    {rulesLoading && <p className="help-text" role="status">正在读取个人商户规则，稍后显示识别结果…</p>}
    {result && <div className="screenshot-results" aria-labelledby={`${id}-results`}>
      <h3 ref={resultsHeading} id={`${id}-results`} tabIndex={-1}>截图识别结果{result.candidates.length > 0 && ` · ${result.candidates.length} 笔待核对`}</h3>
      {result.error && result.candidates.length > 0 && <p className="notice warning" role="alert">{result.error}</p>}
      {result.candidates.length === 0 && <div className="screenshot-failure">
        <h4>暂未识别出可核对的账目</h4>
        <p role="alert">{result.error || "请检查付款详情是否完整，或展开识别文字进行补充。"}</p>
        <button type="button" className="button secondary small" onClick={editText}>检查识别文字</button>
      </div>}
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
          {(sourceChoices[candidate.key] ?? paymentSource(candidate.source)) === "manual" && <p>请根据原付款页面选择支付来源，也可以保留“其他或未确认”。</p>}
        </div>
        <p>请与原画面核对；相近消费会在保存时提示疑似重复。</p>
        <button type="button" className="button secondary" onClick={() => onReview({ ...candidate, source: sourceChoices[candidate.key] ?? paymentSource(candidate.source) })}>核对并记账<ArrowRight size={17} /></button>
      </article>)}</div>
      {result.warnings.length > 0 && <div className="notice warning screenshot-review-warnings" role="status"><ul>{result.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></div>}
    </div>}
    {!result && !text && !rulesLoading && <div className="screenshot-empty">
      <p>在付款详情页轻点手机背面两下，或粘贴付款详情中的文字开始识别。</p>
      <button type="button" className="button secondary small" onClick={editText}>粘贴付款详情文字</button>
    </div>}
    <details className="screenshot-text-editor" open={editorOpen} onToggle={event => setEditorOpen(event.currentTarget.open)}>
      <summary>查看或编辑识别文字</summary>
      <div className="form-field">
        <label htmlFor={`${id}-text`}>截图提取的文字</label>
        <textarea ref={textField} id={`${id}-text`} rows={6} maxLength={MAX_TEXT_LENGTH} value={text}
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
        <p className="help-text">识别文字的排列可能与原页面不同。手机时钟、“昨天”等不作为交易日期；请核对原付款详情。</p>
      </div>
      <div className="form-actions screenshot-actions">
        <button type="button" className="button primary" disabled={!text.trim() || rulesLoading} onClick={recognize}><FileText size={17} />识别截图文字</button>
        <button type="button" className="button ghost" disabled={!text && !result} onClick={() => { setText(""); setResult(null); setSourceChoices({}); setNotice(""); }}>清空截图文字</button>
      </div>
    </details>
  </div>;
}
