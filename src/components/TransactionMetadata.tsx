import { useId } from "react";
import type { DraftTransaction, SmsEvidence } from "../lib/ledger";

const DETAILS: Record<string, string[]> = {
  本地生活: ["餐饮", "外卖", "堂食", "咖啡奶茶", "休闲娱乐", "按摩足疗", "剧本杀密室", "电影影音", "桌游台球", "景区游玩"],
  购物: ["烟酒副食", "超市便利", "服饰", "数码", "日用品"],
};

export function categoryText(transaction: Pick<DraftTransaction, "category" | "subcategory" | "platform">) {
  return `${transaction.category} · ${transaction.subcategory || "未细分"}${transaction.platform ? ` · ${transaction.platform}` : ""}`;
}

export function DetailField({ category, value, onChange, disabled = false }: { category: string; value?: string; onChange: (value: string) => void; disabled?: boolean }) {
  const id = useId();
  return <div className="form-field">
    <label htmlFor={id}>细类（可选）</label>
    <input id={id} list={`${id}-options`} value={value === "未细分" ? "" : value || ""} onChange={event => onChange(event.target.value.trim() ? event.target.value : "未细分")} maxLength={40} placeholder="未细分，可选择或填写" disabled={disabled} />
    <datalist id={`${id}-options`}>{(DETAILS[category] || []).map(detail => <option key={detail} value={detail} />)}</datalist>
  </div>;
}

export function SmsEvidenceDisclosure({ evidence }: { evidence: SmsEvidence }) {
  return <details className="sms-evidence">
    <summary>查看脱敏短信凭据</summary>
    <p className="sms-evidence-text">{evidence.text}</p>
    {evidence.receivedAt && <p>接收时间：{new Date(evidence.receivedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}（北京时间）</p>}
    {evidence.classificationReason && <p>入账时分类依据：{evidence.classificationReason}</p>}
    <p className="help-text">凭据长期保留在账本中，卡号尾号与余额已隐藏。只有平台名称时，具体订单用途仍需账单或订单补充。</p>
  </details>;
}
