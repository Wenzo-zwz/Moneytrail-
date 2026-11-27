import { useId, useState } from "react";
import { formatMoney, type DraftTransaction, type SmsEvidence, type Transaction } from "../lib/ledger";
import { EXPENSE_DETAILS } from "../lib/expenseCategories";
import { INCOME_CATEGORIES, incomeCategoryLabel, type IncomeCategory } from "../lib/incomeCategories";

const CUSTOM_DETAIL = "__custom__";

export function categoryText(transaction: Pick<DraftTransaction, "category" | "subcategory" | "platform"> & Partial<Pick<DraftTransaction, "kind">>) {
  if (transaction.kind === "income") return incomeCategoryLabel(transaction.subcategory);
  return `${transaction.category} · ${transaction.subcategory || "未细分"}${transaction.platform ? ` · ${transaction.platform}` : ""}`;
}

export function IncomeCategoryField({ value, onChange, disabled, full }: {
  value?: string;
  onChange: (value: IncomeCategory) => void;
  disabled?: boolean;
  full?: boolean;
}) {
  const id = useId();
  return <div className={full ? "form-field full" : "form-field"}>
    <label htmlFor={id}>收入类别</label>
    <select id={id} value={incomeCategoryLabel(value)} onChange={event => onChange(incomeCategoryLabel(event.target.value))} disabled={disabled}>
      {INCOME_CATEGORIES.map(category => <option key={category}>{category}</option>)}
    </select>
  </div>;
}

export function RefundOriginalField({ value, onChange, suggested, other, disabled, full }: {
  value?: string;
  onChange: (value: string) => void;
  suggested?: Transaction[];
  other: Transaction[];
  disabled?: boolean;
  full?: boolean;
}) {
  const id = useId();
  const missing = Boolean(value && !suggested?.some(transaction => transaction.id === value) && !other.some(transaction => transaction.id === value));
  function option(transaction: Transaction) {
    return <option key={transaction.id} value={transaction.id}>
      {transaction.date.replace("T", " ")} · {transaction.merchant} · {formatMoney(transaction.amountCents)}
    </option>;
  }
  return <div className={full ? "form-field full" : "form-field"}>
    <label htmlFor={id}>关联原消费（可选）</label>
    <select id={id} value={value ?? ""} onChange={event => onChange(event.target.value)} disabled={disabled}>
      <option value="">暂不关联</option>
      {missing && <option value={value} disabled>所选原消费已不可关联</option>}
      {suggested ? <>
        {suggested.length > 0 && <optgroup label="建议关联">{suggested.map(option)}</optgroup>}
        {other.length > 0 && <optgroup label="其他支出">{other.map(option)}</optgroup>}
      </> : other.map(option)}
    </select>
  </div>;
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
