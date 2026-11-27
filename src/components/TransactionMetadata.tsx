import { useId, useState } from "react";
import type { DraftTransaction, SmsEvidence } from "../lib/ledger";

import { EXPENSE_DETAILS } from "../lib/expenseCategories";

const CUSTOM_DETAIL = "__custom__";

export function categoryText(transaction: Pick<DraftTransaction, "category" | "subcategory" | "platform">) {
  return `${transaction.category} · ${transaction.subcategory || "未细分"}${transaction.platform ? ` · ${transaction.platform}` : ""}`;
}

export function TransactionDateInput({ id, value, onChange, disabled }: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return <span className="transaction-date-control">
    <input id={id} type="datetime-local" required value={value} onChange={event => onChange(event.target.value)} disabled={disabled} />
  </span>;
}

type DetailFieldProps = {
  category: string;
  value?: string;
  onChange: (value: string) => void;
  disabled?: boolean;
};

export function DetailField(props: DetailFieldProps) {
  return <DetailPicker key={props.category} {...props} />;
}

function DetailPicker({ category, value, onChange, disabled = false }: DetailFieldProps) {
  const id = useId();
  const [customText, setCustomText] = useState<string | null>(null);
  const details = EXPENSE_DETAILS[category];
  const detail = value || "未细分";
  const editingCustom = customText !== null && detail === (customText.trim() ? customText : "未细分");
  const isCustom = editingCustom || (detail !== "未细分" && !details?.includes(detail));

  return <div className="form-field">
    <label htmlFor={id}>二级分类（可选）</label>
    <select
      id={id}
      value={details ? (isCustom ? CUSTOM_DETAIL : detail) : ""}
      disabled={disabled || !details}
      onChange={event => {
        const selected = event.target.value;
        const custom = selected === CUSTOM_DETAIL;
        setCustomText(custom ? "" : null);
        onChange(custom ? "未细分" : selected);
      }}
    >
      {details ? <>
        <option value="未细分">未细分</option>
        {details.map(option => <option key={option} value={option}>{option}</option>)}
        <option value={CUSTOM_DETAIL}>自定义…</option>
      </> : <option value="">请先选择一级分类</option>}
    </select>
    {details && isCustom && <div className="form-field">
      <label htmlFor={`${id}-custom`}>自定义二级分类</label>
      <input
        id={`${id}-custom`}
        value={editingCustom ? customText : detail}
        maxLength={40}
        disabled={disabled}
        onChange={event => {
          const next = event.target.value;
          setCustomText(next);
          onChange(next.trim() ? next : "未细分");
        }}
      />
    </div>}
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
