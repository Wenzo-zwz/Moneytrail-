import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type FormEvent,
} from "react";
import {
  ArrowDownLeft,
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  ArrowUpToLine,
  BarChart3,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Coffee,
  CreditCard,
  FileText,
  Home,
  LayoutDashboard,
  Layers3,
  List,
  MessageSquare,
  Pencil,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  ShoppingBag,
  Smartphone,
  Trash2,
  Upload,
  Wallet,
  X,
} from "lucide-react";
import {
  CATEGORIES,
  currentMonth,
  findDuplicates,
  formatMoney,
  parseAmount,
  normalizeTransactionCategory,
  summarize,
  validateTransaction,
  type DraftTransaction,
  type Transaction,
  type TransactionKind,
  type Source,
} from "./lib/ledger";
import { parseCsv, parseSms } from "./lib/parsers";
import {
  emptyData,
  exportBackup,
  exportCsv,
  importBackup,
  type AppData,
} from "./lib/storage";
import type { LedgerSaveOptions, LedgerStore } from "./lib/cloudStore";
import { localLedgerStore } from "./lib/ledgerStore";
import { categoryText, DetailField, SmsEvidenceDisclosure } from "./components/TransactionMetadata";
import { canOfferMerchantMemory } from "./components/merchantMemory";
import { classifyMerchant, merchantKey, type MerchantRule, type MerchantRuleIntent } from "./lib/merchantClassification";

type Page = "overview" | "transactions" | "capture" | "settings";
type Preview = {
  key: string;
  draft: DraftTransaction;
  selected: boolean;
  warnings: string[];
  duplicates: Transaction[];
  original: DraftTransaction;
  remember?: boolean;
};
const KIND_NAMES: Record<TransactionKind, string> = {
  expense: "支出",
  refund: "退款",
  transfer: "转账 / 充值 / 还款",
  income: "收入",
};
const SOURCE_NAMES: Record<Source, string> = {
  manual: "手动",
  sms: "银行短信",
  wechat: "微信账单",
  alipay: "支付宝账单",
  csv: "账单导入",
};
const COLORS = [
  "#d0cdc6",
  "#a7a39a",
  "#c6b395",
  "#8f949f",
  "#7d7b83",
  "#b8aea7",
  "#757e85",
  "#9f968d",
  "#64666e",
];
const NAV = [
  { page: "overview", name: "总览", Icon: LayoutDashboard },
  { page: "transactions", name: "账目", Icon: List },
  { page: "capture", name: "录入", Icon: Plus },
  { page: "settings", name: "设置", Icon: Settings },
] as const;
const uid = () =>
  globalThis.crypto?.randomUUID?.() ??
  `mt-${Date.now()}-${Math.random().toString(36).slice(2)}`;
function localNow() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
function newDraft(): DraftTransaction {
  return {
    kind: "expense",
    amountCents: 0,
    date: localNow(),
    merchant: "",
    category: "待分类",
    source: "manual",
    note: "",
  };
}
function memoryIntent(draft: DraftTransaction, transactionId: string): MerchantRuleIntent {
  return { transactionId, merchant: draft.merchant, category: draft.category, ...(draft.subcategory ? { subcategory: draft.subcategory } : {}) };
}
function download(
  text: string,
  filename: string,
  type = "application/json;charset=utf-8",
) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function shiftMonth(month: string, delta: number) {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
function displayMonth(month: string) {
  const [year, m] = month.split("-");
  return `${year} 年 ${Number(m)} 月`;
}
function messageOf(error: unknown) {
  return error instanceof Error ? error.message : "操作未完成，请重试。";
}
function categoryIcon(category: string) {
  return category === "本地生活"
    ? Coffee
    : category === "购物"
      ? ShoppingBag
      : category === "居住"
        ? Home
        : Wallet;
}
function amountText(t: DraftTransaction) {
  return `${t.kind === "expense" ? "−" : t.kind === "transfer" ? "" : "+"}${formatMoney(t.amountCents)}`;
}

function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    const el = ref.current;
    el?.showModal();
    return () => el?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="modal"
      aria-labelledby={id}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          const r = e.currentTarget.getBoundingClientRect();
          if (
            e.clientX < r.left ||
            e.clientX > r.right ||
            e.clientY < r.top ||
            e.clientY > r.bottom
          )
            onClose();
        }
      }}
    >
      <div className="modal-header">
        <h2 id={id}>{title}</h2>
        <button
          className="button icon ghost"
          aria-label="关闭弹窗"
          onClick={onClose}
        >
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}

function TransactionEditor({
  initial,
  transactions,
  title,
  saveError,
  merchantRules,
  canLearn,
  isNew,
  initialRemember,
  memoryOriginal = initial,
  onSave,
  onClose,
}: {
  initial: DraftTransaction;
  transactions: Transaction[];
  title: string;
  saveError?: string;
  merchantRules: MerchantRule[];
  canLearn: boolean;
  isNew: boolean;
  initialRemember?: boolean;
  memoryOriginal?: DraftTransaction;
  onSave: (draft: DraftTransaction, remember: boolean, explicitChoice: boolean) => boolean;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(() => normalizeTransactionCategory(initial));
  const [amount, setAmount] = useState(
    initial.amountCents ? (initial.amountCents / 100).toFixed(2) : "",
  );
  const [error, setError] = useState("");
  const [explicitChoice, setExplicitChoice] = useState(initialRemember !== undefined);
  const [remember, setRemember] = useState(initialRemember ?? true);
  const automaticMerchant = useRef<string | null>(null);
  const canRemember = canLearn && canOfferMerchantMemory(memoryOriginal, draft, explicitChoice, merchantRules, isNew);
  function withPersonalCategory(next: DraftTransaction) {
    if (!isNew || explicitChoice) return next;
    const match = next.kind === "expense" ? classifyMerchant(next.merchant, merchantRules) : null;
    if (match?.reason === "个人商户规则") return { ...next, category: match.category, subcategory: match.subcategory || "未细分" };
    return automaticMerchant.current ? { ...next, category: initial.category, subcategory: initial.subcategory } : next;
  }
  function applyPersonalCategory(next: DraftTransaction) {
    const classified = withPersonalCategory(next);
    automaticMerchant.current = isNew && !explicitChoice && next.kind === "expense" && classifyMerchant(next.merchant, merchantRules).reason === "个人商户规则" ? merchantKey(next.merchant) : null;
    setDraft(classified);
  }
  function submit(e: FormEvent) {
    e.preventDefault();
    const cents = parseAmount(amount);
    if (cents === null) {
      setError("请输入大于 0 的人民币金额，最多两位小数。");
      return;
    }
    const classified = withPersonalCategory(draft);
    const next = {
      ...classified,
      amountCents: cents,
      merchant: draft.merchant.trim(),
      note: draft.note.trim(),
      ...(classified.subcategory ? { subcategory: classified.subcategory.trim() || "未细分" } : {}),
    };
    if (next.kind !== "refund") delete next.linkedTransactionId;
    if (!validateTransaction({ ...next, id: "validation" })) {
      setError("请检查金额、日期和商户，日期需为有效的本地时间。");
      return;
    }
    if (onSave(next, canRemember && remember, explicitChoice)) onClose();
  }
  return (
    <Modal title={title} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="modal-body">
          <p className="help-text">
            所有金额以人民币记录。退款计入实际到账月份，转账、充值和还款不计入消费。
          </p>
          <div className="form-grid">
            <div className="form-field">
              <label htmlFor="tx-kind">类型</label>
              <select
                id="tx-kind"
                value={draft.kind}
                onChange={(e) =>
                  applyPersonalCategory({
                    ...draft,
                    kind: e.target.value as TransactionKind,
                  })
                }
              >
                {Object.entries(KIND_NAMES).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-field">
              <label htmlFor="tx-amount">金额（元）</label>
              <input
                id="tx-amount"
                autoFocus
                inputMode="decimal"
                placeholder="0.00"
                required
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                maxLength={16}
              />
            </div>
            <div className="form-field full">
              <label htmlFor="tx-merchant">商户 / 对方</label>
              <input
                id="tx-merchant"
                required
                maxLength={150}
                placeholder="例如：楼下咖啡店"
                value={draft.merchant}
                onChange={(e) => {
                  const merchant = e.target.value;
                  if (!explicitChoice && automaticMerchant.current && merchantKey(merchant) !== automaticMerchant.current) {
                    automaticMerchant.current = null;
                    setDraft({ ...draft, merchant, category: initial.category, subcategory: initial.subcategory });
                  } else setDraft({ ...draft, merchant });
                }}
                onBlur={() => applyPersonalCategory(draft)}
              />
            </div>
            <div className="form-field">
              <label htmlFor="tx-date">发生时间</label>
              <input
                id="tx-date"
                type="datetime-local"
                required
                value={draft.date}
                onChange={(e) => setDraft({ ...draft, date: e.target.value })}
              />
            </div>
            <div className="form-field">
              <label htmlFor="tx-category">分类</label>
              <select
                id="tx-category"
                value={draft.category}
                onChange={(e) => {
                  setExplicitChoice(true);
                  automaticMerchant.current = null;
                  setDraft({ ...draft, category: e.target.value, subcategory: "未细分" });
                }}
              >
                {CATEGORIES.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </div>
            <DetailField category={draft.category} value={draft.subcategory} onChange={subcategory => { setExplicitChoice(true); automaticMerchant.current = null; setDraft({ ...draft, subcategory }); }} />
            {draft.platform && <div className="form-field"><label>消费平台</label><p className="help-text">{draft.platform}</p></div>}
            {draft.kind === "refund" && (
              <div className="form-field full">
                <label htmlFor="tx-linked">关联原消费（可选）</label>
                <select
                  id="tx-linked"
                  value={draft.linkedTransactionId ?? ""}
                  onChange={(e) => {
                    const original = transactions.find(
                      (t) => t.id === e.target.value,
                    );
                    setDraft({
                      ...draft,
                      linkedTransactionId: e.target.value || undefined,
                      category: original?.category ?? draft.category,
                      subcategory: original ? original.subcategory : draft.subcategory,
                      platform: original ? original.platform : draft.platform,
                    });
                  }}
                >
                  <option value="">暂不关联</option>
                  {transactions
                    .filter((t) => t.kind === "expense")
                    .sort((a, b) => b.date.localeCompare(a.date))
                    .map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.date.slice(0, 10)} · {t.merchant} ·{" "}
                        {formatMoney(t.amountCents)}
                      </option>
                    ))}
                </select>
              </div>
            )}
            <div className="form-field full">
              <label htmlFor="tx-note">备注（可选）</label>
              <textarea
                id="tx-note"
                rows={2}
                maxLength={1000}
                value={draft.note}
                placeholder="给这笔消费留个记号"
                onChange={(e) => setDraft({ ...draft, note: e.target.value })}
              />
            </div>
          </div>
          {canRemember && <label className="sms-remember"><input type="checkbox" checked={remember} onChange={event => setRemember(event.target.checked)} />以后这家都这样分类</label>}
          {canRemember && <p className="help-text">保存后，同一具体商户会沿用「{categoryText(draft)}」。不同分店分别确认。</p>}
          {draft.smsEvidence ? <SmsEvidenceDisclosure evidence={draft.smsEvidence} /> : draft.source === "sms" && <p className="help-text">此笔没有留存短信凭据。历史短信原文可能已清除，可用商户描述或支付账单补充用途。</p>}
          {saveError && (
            <p className="notice warning" role="alert">
              {saveError}
            </p>
          )}
          {error && (
            <p className="notice error" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="modal-footer">
          <button type="button" className="button secondary" onClick={onClose}>
            取消
          </button>
          <button className="button primary" type="submit">
            <Check size={17} />
            确认保存
          </button>
        </div>
      </form>
    </Modal>
  );
}

function TransactionRow({
  transaction: t,
  onEdit,
  onDelete,
}: {
  transaction: Transaction;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const Icon =
    t.kind === "refund"
      ? ArrowDownLeft
      : t.kind === "transfer"
        ? CreditCard
        : categoryIcon(t.category);
  return (
    <div className="transaction-row">
      <div className="transaction-icon">
        <Icon size={19} />
      </div>
      <div className="transaction-main">
        <div className="transaction-title">{t.merchant}</div>
        <div className="transaction-meta">
          {t.date.replace("T", " ").slice(5)} · {categoryText(t)} ·{" "}
          {SOURCE_NAMES[t.source]}
          {t.kind !== "expense" ? ` · ${KIND_NAMES[t.kind]}` : ""}
        </div>
        {t.note && <div className="transaction-meta">{t.note}</div>}
      </div>
      <div
        className={`transaction-amount ${t.kind === "refund" || t.kind === "income" ? "text-success" : t.kind === "transfer" ? "text-muted" : ""}`}
      >
        {amountText(t)}
      </div>
      <div className="transaction-actions">
        <button
          className="button icon ghost"
          aria-label={`编辑${t.merchant}`}
          onClick={onEdit}
        >
          <Pencil size={16} />
        </button>
        <button
          className="button icon ghost"
          aria-label={`删除${t.merchant}`}
          onClick={onDelete}
        >
          <Trash2 size={16} />
        </button>
      </div>
    </div>
  );
}

function Empty({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">
        <Layers3 size={28} />
      </div>
      <h3 className="empty-title">{title}</h3>
      <div className="empty-copy">{children}</div>
      {action}
    </div>
  );
}

export default function App({
  store = localLedgerStore,
  cloudMode = false,
  accountControls,
  accountPanel,
  onSmsAutomation,
  merchantRules = [],
  merchantRulesNotice,
  merchantRulesLoading = false,
}: {
  store?: LedgerStore;
  cloudMode?: boolean;
  accountControls?: ReactNode;
  accountPanel?: ReactNode;
  onSmsAutomation?: () => void;
  merchantRules?: MerchantRule[];
  merchantRulesNotice?: ReactNode;
  merchantRulesLoading?: boolean;
}) {
  const { loadData, saveData, restoreData, readStoredRaw } = store;
  const [initial] = useState(() => loadData());
  const [data, setData] = useState<AppData>(initial.data);
  const [recoveryError, setRecoveryError] = useState(initial.error ?? "");
  const [page, setPage] = useState<Page>("overview");
  const [month, setMonth] = useState(currentMonth());
  const [toast, setToast] = useState("");
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("全部");
  const [kindFilter, setKindFilter] = useState("全部");
  const [editor, setEditor] = useState<{
    draft: DraftTransaction;
    id?: string;
    previewKey?: string;
  } | null>(null);
  const [budgetOpen, setBudgetOpen] = useState(false);
  const [budgetInput, setBudgetInput] = useState("");
  const [captureMode, setCaptureMode] = useState<"sms" | "csv">("sms");
  const [smsText, setSmsText] = useState("");
  const [previews, setPreviews] = useState<Preview[]>([]);
  const [importMessages, setImportMessages] = useState<string[]>([]);
  const [importing, setImporting] = useState(false);
  const [previewLimit, setPreviewLimit] = useState(30);
  const csvRef = useRef<HTMLInputElement>(null);
  const backupRef = useRef<HTMLInputElement>(null);
  const hashProcessed = useRef(false);
  const stats = useMemo(
    () => summarize(data.transactions, month, data.budgetCents),
    [data, month],
  );
  const monthTransactions = useMemo(
    () =>
      data.transactions
        .filter((t) => t.date.startsWith(month))
        .sort((a, b) => b.date.localeCompare(a.date)),
    [data.transactions, month],
  );
  const filtered = monthTransactions.filter(
    (t) =>
      (category === "全部" || t.category === category) &&
      (kindFilter === "全部" || t.kind === kindFilter) &&
      `${t.merchant} ${t.note} ${t.category} ${t.subcategory || "未细分"} ${t.platform || ""}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 4500);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    function sync() {
      const loaded = loadData();
      setData(loaded.data);
      setRecoveryError(loaded.error ?? "");
      setNotice(cloudMode ? "账目已从云端或另一页面更新，请检查正在编辑的内容。" : "账目已与此设备的另一个页面同步，请检查正在编辑的内容。");
    }
    return store.subscribe(sync);
  }, [store, cloudMode]);
  useEffect(() => {
    if (hashProcessed.current) return;
    hashProcessed.current = true;
    const params = new URLSearchParams(location.hash.slice(1));
    const text = params.get("sms");
    if (text) {
      history.replaceState(null, "", location.pathname + location.search);
      setPage("capture");
      setCaptureMode("sms");
      if (text.length > 8000)
        setNotice("传入的短信过长，请仅粘贴一条消费短信。");
      else {
        setSmsText(text);
        setNotice("已收到短信内容，请识别并核对后保存。");
      }
    }
  }, []);
  function persist(next: AppData, success?: string, options?: LedgerSaveOptions) {
    if (recoveryError) {
      setNotice("当前数据需要恢复，请先导出原始数据或恢复备份。");
      return false;
    }
    if (next.transactions !== data.transactions) {
      const oldById = new Map(data.transactions.map((t) => [t.id, t]));
      const newById = new Map(next.transactions.map((t) => [t.id, t]));
      const changedMonths = new Set<string>();
      for (const id of new Set([...oldById.keys(), ...newById.keys()])) {
        const oldTx = oldById.get(id);
        const newTx = newById.get(id);
        if (JSON.stringify(oldTx) !== JSON.stringify(newTx)) {
          if (oldTx) changedMonths.add(oldTx.date.slice(0, 7));
          if (newTx) changedMonths.add(newTx.date.slice(0, 7));
        }
      }
      next = {
        ...next,
        billCheckedMonths: next.billCheckedMonths.filter(
          (m) => !changedMonths.has(m),
        ),
      };
    }
    const saved = saveData(next, data, options);
    if (!saved.ok) {
      if (saved.conflict) {
        const latest = loadData();
        setData(latest.data);
        setRecoveryError(latest.error ?? "");
      }
      setNotice(saved.error ?? "保存失败，账目未更改。");
      return false;
    }
    setData(next);
    if (success) setToast(success);
    return true;
  }
  function startBudget() {
    setBudgetInput(data.budgetCents ? (data.budgetCents / 100).toFixed(2) : "");
    setBudgetOpen(true);
  }
  function saveEditor(draft: DraftTransaction, remember: boolean, explicitChoice: boolean) {
    if (editor?.previewKey) {
      const others = previews
        .filter((p) => p.key !== editor.previewKey)
        .map((p) => ({ ...p.draft, id: p.key }));
      const duplicates = findDuplicates(draft, [
        ...data.transactions,
        ...others,
      ]);
      setPreviews((prev) =>
        prev.map((p) =>
          p.key === editor.previewKey
            ? {
                ...p,
                draft,
                duplicates,
                remember: canOfferMerchantMemory(p.original, draft, true, merchantRules) ? (explicitChoice ? remember : p.remember) : false,
                selected: duplicates.length ? false : p.selected,
              }
            : p,
        ),
      );
      return true;
    }
    if (editor?.id) {
      const editedId = editor.id;
      const current = data.transactions.find((t) => t.id === editedId);
      const fields = [
        "kind",
        "amountCents",
        "date",
        "merchant",
        "category",
        "source",
        "note",
        "sourceRef",
        "linkedTransactionId",
        "subcategory",
        "platform",
      ] as const;
      if (
        !current ||
        fields.some((field) => current[field] !== editor.draft[field]) ||
        (["text", "receivedAt", "classificationReason", "ruleVersion"] as const).some(field => current.smsEvidence?.[field] !== editor.draft.smsEvidence?.[field])
      ) {
        setNotice(
          "这笔记录已在其他页面修改或删除。本次内容尚未保存，请关闭弹窗并重新打开最新记录后修改。",
        );
        return false;
      }
      const transactions = data.transactions.map((t) => {
        if (t.id === editedId) return { ...draft, id: t.id };
        if (draft.kind !== "expense" && t.linkedTransactionId === editedId) {
          const next = { ...t };
          delete next.linkedTransactionId;
          return next;
        }
        return t;
      });
      return persist({ ...data, transactions }, "这笔账已更新", explicitChoice ? { forgetMerchantRulesFor: [editedId], merchantRules: remember ? [memoryIntent(draft, editedId)] : [] } : undefined);
    }
    const duplicates = findDuplicates(draft, data.transactions);
    if (
      duplicates.length &&
      !window.confirm(
        `发现 ${duplicates.length} 笔相近记录，可能重复。仍要保存为一笔新记录吗？`,
      )
    )
      return false;
    const transactionId = uid();
    return persist(
      {
        ...data,
        transactions: [...data.transactions, { ...draft, id: transactionId }],
      },
      "已记下一笔",
      remember ? { merchantRules: [memoryIntent(draft, transactionId)] } : undefined,
    );
  }
  function deleteTransaction(t: Transaction) {
    if (
      !window.confirm(
        `删除「${t.merchant}」${formatMoney(t.amountCents)}？此操作无法直接撤销，可通过备份恢复。`,
      )
    )
      return;
    const transactions = data.transactions
      .filter((x) => x.id !== t.id)
      .map((x) => {
        if (x.linkedTransactionId !== t.id) return x;
        const next = { ...x };
        delete next.linkedTransactionId;
        return next;
      });
    persist({ ...data, transactions }, "记录已删除");
  }
  function prepareDrafts(drafts: DraftTransaction[], warnings: string[] = []) {
    const known = new Set(
      data.transactions
        .filter((t) => t.sourceRef)
        .map((t) => `${t.source}:${t.kind}:${t.sourceRef}`),
    );
    const seen = new Set<string>();
    let skipped = 0;
    const pending: Preview[] = [];
    for (const draft of drafts) {
      const key = draft.sourceRef
        ? `${draft.source}:${draft.kind}:${draft.sourceRef}`
        : "";
      if (key && (known.has(key) || seen.has(key))) {
        skipped++;
        continue;
      }
      if (key) seen.add(key);
      // Also suggest matches within this import; never silently discard similar amounts.
      const prior = pending.map((p) => ({ ...p.draft, id: p.key }));
      const duplicates = findDuplicates(draft, [
        ...data.transactions,
        ...prior,
      ]);
      pending.push({
        key: uid(),
        draft,
        original: draft,
        selected: duplicates.length === 0,
        duplicates,
        warnings:
          draft.merchant === "待补充商户"
            ? ["短信未提供明确商户，请补充商户和分类。"]
            : [],
      });
    }
    setPreviews(pending);
    setPreviewLimit(30);
    setImportMessages([
      ...warnings,
      ...(skipped ? [`已跳过 ${skipped} 条具有相同来源交易编号的记录。`] : []),
    ]);
  }
  function parseMessage() {
    if (merchantRulesLoading) return;
    const result = parseSms(smsText, new Date(), merchantRules);
    if (!result.draft) {
      setPreviews([]);
      setImportMessages([
        result.error ?? "暂时无法识别，请改为手动记账。",
        ...result.warnings,
      ]);
      return;
    }
    prepareDrafts([result.draft], result.warnings);
    if (result.requiresReview) setPreviews(current => current.map(item => ({ ...item, selected: false, warnings: [...item.warnings, "请先判断实际用途，再选择是否作为支出保存。"] })));
  }
  async function readCsv(file?: File) {
    if (!file) return;
    setImporting(true);
    try {
      if (file.size > 5 * 1024 * 1024)
        throw new Error("文件超过 5 MB，请按月份拆分后导入。");
      if (!/\.csv$/i.test(file.name))
        throw new Error(
          "当前支持 CSV 文件，请先解压账单文件；Excel 文件请另存为 CSV。",
        );
      const bytes = await file.arrayBuffer();
      let text: string;
      let encodingNotice = "";
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        text = new TextDecoder("gb18030", { fatal: true }).decode(bytes);
        encodingNotice = "已按 GB18030 编码读取账单。";
      }
      const result = parseCsv(text);
      if (result.drafts.length > 2000)
        throw new Error("单次最多导入 2000 笔，请按月份拆分文件。");
      prepareDrafts(
        result.drafts,
        [
          encodingNotice,
          ...result.warnings,
          result.skipped
            ? `已跳过 ${result.skipped} 行非交易或未完成交易。`
            : "",
          ...result.errors.slice(0, 10),
          result.errors.length > 10
            ? `另有 ${result.errors.length - 10} 条错误，请检查原文件。`
            : "",
        ].filter(Boolean),
      );
      if (!result.drafts.length && !result.errors.length)
        setImportMessages([
          "没有找到可导入的人民币交易。请核对文件表头，或使用下方模板。",
        ]);
    } catch (error) {
      setImportMessages([messageOf(error)]);
      setPreviews([]);
    } finally {
      setImporting(false);
      if (csvRef.current) csvRef.current.value = "";
    }
  }
  function confirmPreview() {
    const selected = previews.filter((p) => p.selected);
    if (!selected.length) return;
    const refreshed = previews.map((p) => ({
      ...p,
      duplicates: findDuplicates(p.draft, [
        ...data.transactions,
        ...previews
          .filter((other) => other.key !== p.key)
          .map((other) => ({ ...other.draft, id: other.key })),
      ]),
    }));
    const newlyDuplicated = new Set(
      refreshed
        .filter(
          (p) =>
            p.selected &&
            p.duplicates.some(
              (t) =>
                !previews
                  .find((old) => old.key === p.key)!
                  .duplicates.some((old) => old.id === t.id),
            ),
        )
        .map((p) => p.key),
    );
    if (newlyDuplicated.size) {
      setPreviews(
        refreshed.map((p) =>
          newlyDuplicated.has(p.key) ? { ...p, selected: false } : p,
        ),
      );
      setNotice("发现新的疑似重复记录，已取消对应勾选。请核对后再选择保存。");
      return;
    }
    const tx = selected.map((p) => ({ ...p.draft, id: uid() }));
    if (tx.some((t) => !validateTransaction(t))) {
      setNotice("部分记录需要补充或修正，请编辑后再保存。");
      return;
    }
    if (
      persist(
        { ...data, transactions: [...data.transactions, ...tx] },
        `已保存 ${tx.length} 笔记录`,
        { merchantRules: tx.flatMap((transaction, index) => selected[index].remember && canOfferMerchantMemory(selected[index].original, transaction, true, merchantRules) ? [memoryIntent(transaction, transaction.id)] : []) },
      )
    ) {
      setPreviews((prev) => prev.filter((p) => !p.selected));
      setImportMessages([]);
      setSmsText("");
    }
  }
  async function restoreBackup(file?: File) {
    if (!file) return;
    try {
      if (file.size > 10 * 1024 * 1024)
        throw new Error("备份文件超过 10 MB，暂时无法导入。");
      const restored = importBackup(await file.text());
      const rawBeforeRestore = readStoredRaw();
      if (
        !window.confirm(
          `备份包含 ${restored.transactions.length} 笔记录。恢复将替换当前 ${data.transactions.length} 笔记录、预算及核对状态${cloudMode ? "，并同步至当前账户的其他设备" : ""}。建议先导出当前备份，确定继续吗？`,
        )
      )
        return;
      // Recovery uses an explicit restore; preserve the damaged raw before clearing it.
      if (recoveryError && rawBeforeRestore)
        download(
          rawBeforeRestore,
          `moneytrail-recovery-${Date.now()}.txt`,
          "text/plain;charset=utf-8",
        );
      const saved = restoreData(restored, rawBeforeRestore);
      if (!saved.ok) throw new Error(saved.error);
      setData(restored);
      setRecoveryError("");
      setPreviews([]);
      setToast("备份已恢复");
    } catch (error) {
      setNotice(messageOf(error));
    } finally {
      if (backupRef.current) backupRef.current.value = "";
    }
  }
  function clearAll() {
    try {
      const rawBeforeClear = readStoredRaw();
      if (
        !window.confirm(
          cloudMode ? "清空当前账户的全部账目、预算和核对状态？联网后会同步至其他设备。请先导出备份，此操作无法直接撤销。" : "清空当前设备的全部账目、预算和核对状态？请先导出备份。此操作无法直接撤销。",
        )
      )
        return;
      const result = restoreData(emptyData(), rawBeforeClear);
      if (!result.ok) {
        setNotice(result.error ?? "清空失败");
        return;
      }
      setData(emptyData());
      setRecoveryError("");
      setPreviews([]);
      setSmsText("");
      setToast(cloudMode ? "当前账户账本已清空，等待同步" : "当前设备的数据已清空");
    } catch (error) {
      setNotice(messageOf(error));
    }
  }
  function downloadRaw() {
    try {
      const raw = readStoredRaw();
      if (raw)
        download(raw, "moneytrail-recovery.txt", "text/plain;charset=utf-8");
      else setNotice("当前没有可下载的原始数据。");
    } catch {
      setNotice("浏览器阻止了读取，请先恢复本地存储权限。");
    }
  }
  function navigate(next: Page) {
    setPage(next);
    setNotice("");
    window.scrollTo({ top: 0, behavior: "instant" });
  }
  const row = (t: Transaction) => (
    <TransactionRow
      key={t.id}
      transaction={t}
      onEdit={() => setEditor({ draft: t, id: t.id })}
      onDelete={() => deleteTransaction(t)}
    />
  );
  const selectedCount = previews.filter((p) => p.selected).length;
  const isChecked = data.billCheckedMonths.includes(month);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a
          href="#"
          className="brand"
          onClick={(e) => {
            e.preventDefault();
            navigate("overview");
          }}
        >
          <div className="brand-mark">
            <svg
              viewBox="120 140 272 240"
              width="25"
              height="25"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="M150 334V178l106 114 106-114v156"
                stroke="currentColor"
                strokeWidth="27"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            </svg>
          </div>
          <div className="brand-copy">
            <strong>Moneytrail</strong>
            <small>个人消费账本</small>
          </div>
        </a>
        <nav className="sidebar-nav" aria-label="主导航">
          {NAV.map(({ page: p, name, Icon }) => (
            <button
              key={p}
              className={`nav-button ${page === p ? "active" : ""}`}
              onClick={() => navigate(p)}
              aria-current={page === p ? "page" : undefined}
            >
              <Icon size={19} />
              {name}
              {p === "capture" && <span className="pill neutral">＋</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <ShieldCheck size={20} />
          <strong>{cloudMode ? "独立账户 · 独立账本" : "你的账，只属于你"}</strong>
          <p>
            {cloudMode ? "账目按当前账户同步。" : "数据保存在当前设备。"}
            <br />
            {cloudMode ? "离线修改联网后同步。" : "记得定期导出备份。"}
          </p>
          <span>一点点，花得更明白。</span>
        </div>
      </aside>
      <main className="main-content">
        <header className="page-header">
          <div>
            <div className="eyebrow">MONEYTRAIL / PERSONAL LEDGER</div>
            <h1 className="page-title">
              {page === "overview"
                ? "每一笔，都有迹可循。"
                : page === "transactions"
                  ? "交易明细"
                  : page === "capture"
                    ? "记录一笔消费"
                    : "账本设置"}
            </h1>
          </div>
          <div className="header-actions">
            {onSmsAutomation && <button className="button secondary small" onClick={onSmsAutomation}><MessageSquare size={16} />短信自动记账</button>}
            {accountControls}
            {(page === "overview" || page === "transactions") && (
              <div className="month-picker">
                <button
                  aria-label="上个月"
                  onClick={() => setMonth(shiftMonth(month, -1))}
                >
                  <ChevronLeft size={17} />
                </button>
                <label className="sr-only" htmlFor="month">
                  查看月份
                </label>
                <input
                  id="month"
                  type="month"
                  value={month}
                  min="2000-01"
                  max="2199-12"
                  onChange={(e) => {
                    if (/^\d{4}-\d{2}$/.test(e.target.value))
                      setMonth(e.target.value);
                  }}
                />
                <button
                  aria-label="下个月"
                  onClick={() => setMonth(shiftMonth(month, 1))}
                >
                  <ChevronRight size={17} />
                </button>
              </div>
            )}
            <button
              className="button primary"
              disabled={!!recoveryError}
              onClick={() => setEditor({ draft: newDraft() })}
            >
              <Plus size={18} />
              记一笔
            </button>
          </div>
        </header>
        {merchantRulesNotice}
        {notice && (
          <div className="notice warning" role="alert">
            <span>{notice}</span>
            <button
              className="button icon ghost"
              aria-label="关闭提示"
              onClick={() => setNotice("")}
            >
              <X size={17} />
            </button>
          </div>
        )}
        {recoveryError ? (
          <section className="panel">
            <h2>先保护你的原始账目</h2>
            <p className="notice error" role="alert">
              {recoveryError}
            </p>
            <p>
              当前数据无法安全读取，录入已暂停。请下载原始数据留存，或恢复之前的
              JSON 备份。
            </p>
            <div className="form-actions">
              <button className="button primary" onClick={downloadRaw}>
                下载原始数据
              </button>
              <button
                className="button secondary"
                onClick={() => backupRef.current?.click()}
              >
                恢复备份
              </button>
              <button className="button danger" onClick={clearAll}>
                清空后重新开始
              </button>
            </div>
          </section>
        ) : (
          <>
            {page === "overview" && (
              <div className="page">
                {!data.transactions.length && (
                  <div className="onboarding-banner">
                    <div>
                      <span className="section-label">
                        从今天，开始了解自己的钱
                      </span>
                      <p>
                        粘贴一条消费短信，或记下今天的第一笔。从日常的小事，开始了解自己的消费。
                      </p>
                    </div>
                    <button
                      className="button secondary"
                      onClick={() => navigate("capture")}
                    >
                      试试短信识别
                      <ArrowRight size={16} />
                    </button>
                  </div>
                )}
                <div className="dashboard-grid">
                  <section className="hero-card">
                    <div className="hero-top">
                      <span className="hero-label">
                        {displayMonth(month)} · 已记录净支出
                      </span>
                      <span className="pill">
                        <Wallet size={14} />
                        人民币
                      </span>
                    </div>
                    <div className="hero-amount">
                      {formatMoney(stats.netCents)}
                    </div>
                    <div className="hero-sub">
                      支出 {formatMoney(stats.expenseCents)}
                      <span> · </span>退款 {formatMoney(stats.refundCents)}
                    </div>
                    <div className="hero-footer">
                      <span>
                        <span className="status-dot" />
                        {isChecked
                          ? "你已标记本月账单核对完成"
                          : "本月账单待核对，部分消费可能尚未记录"}
                      </span>
                      <ArrowUpRight size={22} />
                    </div>
                  </section>
                  <section className="budget-card">
                    <div className="budget-top">
                      <span className="stat-label">本月预算</span>
                      <button
                        className="button icon ghost"
                        aria-label="设置月预算"
                        onClick={startBudget}
                      >
                        <Pencil size={16} />
                      </button>
                    </div>
                    <div className="budget-value">
                      {data.budgetCents
                        ? formatMoney(data.budgetCents)
                        : "还没设置"}
                    </div>
                    <div
                      className="progress-track"
                      role="progressbar"
                      aria-label="预算已使用比例"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={
                        data.budgetCents
                          ? Math.min(
                              100,
                              Math.max(
                                0,
                                Math.round(
                                  (stats.netCents / data.budgetCents) * 100,
                                ),
                              ),
                            )
                          : 0
                      }
                    >
                      <div
                        className="progress-fill"
                        style={{
                          width: data.budgetCents
                            ? `${Math.min(100, Math.max(0, (stats.netCents / data.budgetCents) * 100))}%`
                            : "0%",
                          background:
                            stats.budgetRemainingCents < 0
                              ? "#d09a85"
                              : undefined,
                        }}
                      />
                    </div>
                    <p className="budget-note">
                      {data.budgetCents
                        ? stats.budgetRemainingCents >= 0
                          ? `还可以花 ${formatMoney(stats.budgetRemainingCents)}`
                          : `已超出 ${formatMoney(-stats.budgetRemainingCents)}`
                        : "给日常消费留一点边界感。"}
                    </p>
                    <button
                      className="button ghost small"
                      onClick={startBudget}
                    >
                      {data.budgetCents ? "调整预算" : "设置我的预算"}
                      <ArrowRight size={15} />
                    </button>
                  </section>
                  <section className="panel">
                    <div className="panel-heading">
                      <div>
                        <h2 className="panel-title">钱都花在哪了</h2>
                        <p className="panel-subtitle">
                          分类净支出 · 含本月到账退款
                        </p>
                      </div>
                      <BarChart3 size={20} className="text-muted" />
                    </div>
                    {stats.categories.some((c) => c.amountCents !== 0) ? (
                      <div className="category-list">
                        {stats.categories
                          .filter((c) => c.amountCents !== 0)
                          .sort((a, b) => b.amountCents - a.amountCents)
                          .map((c, i) => {
                            const total = Math.max(
                              ...stats.categories.map((x) =>
                                Math.abs(x.amountCents),
                              ),
                              1,
                            );
                            return (
                              <details className="category-group" key={c.category}>
                              <summary className="category-row" data-amount-cents={c.amountCents}>
                                <span
                                  className="category-dot"
                                  style={{
                                    background: COLORS[i % COLORS.length],
                                  }}
                                />
                                <span className="category-name">
                                  {c.category}<ChevronRight size={11} aria-hidden="true" />
                                </span>
                                <div className="category-bar">
                                  <div
                                    className="category-fill"
                                    style={{
                                      width: `${(Math.abs(c.amountCents) / total) * 100}%`,
                                      background: COLORS[i % COLORS.length],
                                    }}
                                  />
                                </div>
                                <span className="category-amount">
                                  {formatMoney(c.amountCents)}
                                </span>
                              </summary>
                              <div className="subcategory-list">{c.subcategories.map(detail => <div className="subcategory-row" data-amount-cents={detail.amountCents} key={detail.subcategory}><span>{detail.subcategory}</span><span>{formatMoney(detail.amountCents)}</span></div>)}</div>
                              </details>
                            );
                          })}
                      </div>
                    ) : (
                      <Empty title="消费去向，慢慢就清楚了">
                        记下消费并选好分类，这里就会长出你的月度画像。
                      </Empty>
                    )}
                  </section>
                  <section className="insight-card">
                    <div className="section-label">
                      <Layers3 size={17} />
                      账本小提醒
                    </div>
                    <h2>
                      {stats.uncategorizedCount
                        ? `${stats.uncategorizedCount} 笔，等你分个类`
                        : monthTransactions.length
                          ? "记得完整，比记得多更重要"
                          : "一杯咖啡，也是一个开始"}
                    </h2>
                    <p>
                      {stats.uncategorizedCount
                        ? "给待分类消费找个归属，才更容易看清自己的消费习惯。"
                        : "银行卡短信可能不包含零钱、余额支付。导入支付账单，补齐每月的消费拼图。"}
                    </p>
                    <button
                      className="button ghost small"
                      onClick={() => {
                        if (stats.uncategorizedCount) {
                          setCategory("待分类");
                          navigate("transactions");
                        } else navigate("capture");
                      }}
                    >
                      {stats.uncategorizedCount ? "去整理账目" : "补充我的账单"}
                      <ArrowRight size={16} />
                    </button>
                    <div className="stat-card">
                      <span className="stat-label">本月消费与退款记录</span>
                      <span className="stat-value">
                        {stats.count}
                        <small> 笔</small>
                      </span>
                      <span className="stat-note">转账和收入不计入净支出</span>
                    </div>
                  </section>
                  <section className="panel full-width">
                    <div className="panel-heading">
                      <div>
                        <h2 className="panel-title">最近的几笔</h2>
                        <p className="panel-subtitle">生活的细节，都在这里</p>
                      </div>
                      <button
                        className="button ghost small"
                        onClick={() => navigate("transactions")}
                      >
                        全部账目
                        <ArrowRight size={15} />
                      </button>
                    </div>
                    {monthTransactions.length ? (
                      <div className="transaction-list">
                        {monthTransactions.slice(0, 5).map(row)}
                      </div>
                    ) : (
                      <Empty title="这个月的账本还是空白">
                        从一条短信、一份账单，或一笔手动记录开始。
                        <br />
                        少一点猜测，多一点清楚。
                      </Empty>
                    )}
                  </section>
                  <section className="panel full-width">
                    <div className="panel-heading">
                      <div>
                        <h2 className="panel-title">本月账目核对</h2>
                        <p className="panel-subtitle">
                          金额完整性需要你结合各平台账单确认
                        </p>
                      </div>
                      <span
                        className={`pill ${isChecked ? "success" : "warning"}`}
                      >
                        {isChecked ? "已标记核对" : "待核对"}
                      </span>
                    </div>
                    <div className="coverage-list">
                      <div className="coverage-item">
                        <Smartphone size={19} />
                        <span>检查银行卡短信是否漏记</span>
                      </div>
                      <div className="coverage-item">
                        <CreditCard size={19} />
                        <span>补充零钱、余额消费和退款</span>
                      </div>
                      <div className="coverage-item">
                        <ShieldCheck size={19} />
                        <span>确认重复记录，再核对平台总额</span>
                      </div>
                    </div>
                    <button
                      className="button secondary small"
                      onClick={() =>
                        persist(
                          {
                            ...data,
                            billCheckedMonths: isChecked
                              ? data.billCheckedMonths.filter(
                                  (m) => m !== month,
                                )
                              : [...data.billCheckedMonths, month],
                          },
                          isChecked ? "已改为待核对" : "已标记本月核对完成",
                        )
                      }
                    >
                      {isChecked ? "改为待核对" : "我已核对本月账单"}
                    </button>
                  </section>
                </div>
              </div>
            )}
            {page === "transactions" && (
              <div className="page">
                <section className="panel">
                  <div className="panel-heading">
                    <div>
                      <h2 className="panel-title">
                        {displayMonth(month)}的账目
                      </h2>
                      <p className="panel-subtitle">
                        {monthTransactions.length} 笔记录 · 净支出{" "}
                        {formatMoney(stats.netCents)}
                      </p>
                    </div>
                    <button
                      className="button secondary small"
                      disabled={!monthTransactions.length}
                      onClick={() =>
                        download(
                          exportCsv(monthTransactions),
                          `moneytrail-${month}.csv`,
                          "text/csv;charset=utf-8",
                        )
                      }
                    >
                      <ArrowUpToLine size={16} />
                      导出本月
                    </button>
                  </div>
                  <div className="filter-row">
                    <div className="search-field">
                      <Search size={18} />
                      <input
                        aria-label="搜索商户或备注"
                        placeholder="搜索商户、备注…"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                      />
                    </div>
                    <select
                      aria-label="筛选分类"
                      value={category}
                      onChange={(e) => setCategory(e.target.value)}
                    >
                      <option>全部</option>
                      {CATEGORIES.map((c) => (
                        <option key={c}>{c}</option>
                      ))}
                    </select>
                    <select
                      aria-label="筛选记录类型"
                      value={kindFilter}
                      onChange={(e) => setKindFilter(e.target.value)}
                    >
                      <option value="全部">全部类型</option>
                      {Object.entries(KIND_NAMES).map(([k, v]) => (
                        <option key={k} value={k}>
                          {v}
                        </option>
                      ))}
                    </select>
                  </div>
                  {filtered.length ? (
                    <div className="transaction-list">{filtered.map(row)}</div>
                  ) : (
                    <Empty
                      title={
                        monthTransactions.length
                          ? "没有找到符合条件的记录"
                          : "这个月还没有记录"
                      }
                    >
                      {monthTransactions.length
                        ? "试试其他关键词或筛选条件。"
                        : "记下第一笔，就离了解自己的消费更近一步。"}
                    </Empty>
                  )}
                </section>
              </div>
            )}
            {page === "capture" && (
              <div className="page">
                <div className="capture-layout">
                  <section className="panel">
                    <div className="panel-heading">
                      <div>
                        <h2 className="panel-title">记录与导入</h2>
                        <p className="panel-subtitle">
                          识别结果需要核对，确认后才会存入账本
                        </p>
                      </div>
                      <FileText size={21} className="text-muted" />
                    </div>
                    <div className="tabs" role="tablist" aria-label="录入方式">
                      <button
                        id="sms-tab"
                        role="tab"
                        aria-selected={captureMode === "sms"}
                        aria-controls="sms-panel"
                        className={`tab ${captureMode === "sms" ? "active" : ""}`}
                        onClick={() => setCaptureMode("sms")}
                      >
                        粘贴银行短信
                      </button>
                      <button
                        id="csv-tab"
                        role="tab"
                        aria-selected={captureMode === "csv"}
                        aria-controls="csv-panel"
                        className={`tab ${captureMode === "csv" ? "active" : ""}`}
                        onClick={() => setCaptureMode("csv")}
                      >
                        导入账单
                      </button>
                    </div>
                    {captureMode === "sms" ? (
                      <div
                        id="sms-panel"
                        role="tabpanel"
                        aria-labelledby="sms-tab"
                      >
                        <div className="form-field">
                          <label htmlFor="sms-text">银行消费短信</label>
                          <textarea
                            id="sms-text"
                            rows={7}
                            maxLength={8000}
                            placeholder={
                              "例如：【示例银行】您尾号1234的账户于10月22日12:30在某某餐厅消费人民币38.50元，余额1000.00元。"
                            }
                            value={smsText}
                            onChange={(e) => setSmsText(e.target.value)}
                          />
                          <p className="help-text">
                            每次识别一条。自动提取金额和时间；短信没有的商户信息，需要你补充。
                          </p>
                          {onSmsAutomation && <button className="button secondary small" onClick={onSmsAutomation}><Smartphone size={16} />设置短信自动记账</button>}
                          {merchantRulesLoading && <p className="help-text" role="status">正在读取个人商户规则…</p>}
                        </div>
                        <div className="form-actions">
                          <button
                            className="button primary"
                            disabled={!smsText.trim() || merchantRulesLoading}
                            onClick={parseMessage}
                          >
                            <FileText size={17} />
                            识别短信
                          </button>
                          <button
                            className="button secondary"
                            onClick={() => setEditor({ draft: newDraft() })}
                          >
                            手动记一笔
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div
                        id="csv-panel"
                        role="tabpanel"
                        aria-labelledby="csv-tab"
                      >
                        <button
                          className="upload-zone"
                          onClick={() => csvRef.current?.click()}
                          disabled={importing}
                        >
                          <Upload size={30} />
                          <strong>
                            {importing ? "正在读取账单…" : "选择一份 CSV 账单"}
                          </strong>
                          <span>支持微信、支付宝及通用表头 · 最大 5 MB</span>
                        </button>
                        <p className="help-text">
                          文件在当前设备解析。请先解压账单；Excel 文件需另存为
                          CSV。首版仅支持人民币交易。
                        </p>
                        <button
                          className="button ghost small"
                          onClick={() =>
                            download(
                              "\uFEFF日期,类型,金额,商户,分类,细类,备注,交易编号\r\n2026-10-22 12:30,支出,38.50,示例餐厅,本地生活,餐饮,午餐,example-001\r\n",
                              "moneytrail-导入模板.csv",
                              "text/csv;charset=utf-8",
                            )
                          }
                        >
                          <ArrowDownToLine size={16} />
                          下载通用导入模板
                        </button>
                      </div>
                    )}
                    {importMessages.length > 0 && (
                      <div className="notice warning" role="status">
                        <ul>
                          {importMessages.map((m, i) => (
                            <li key={i}>{m}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </section>
                  <aside className="capture-intro">
                    <div className="section-label">一点小提示</div>
                    <h2>
                      信息越完整，
                      <br />
                      消费越明白。
                    </h2>
                    <div className="method-list">
                      <div className="method-card">
                        <Smartphone size={21} />
                        <div>
                          <strong>银行卡短信打底</strong>
                          <p>银行卡扣款通常有短信，余额支付可能没有。</p>
                        </div>
                      </div>
                      <div className="method-card">
                        <CreditCard size={21} />
                        <div>
                          <strong>支付账单补全</strong>
                          <p>用微信、支付宝账单补充商户与余额消费。</p>
                        </div>
                      </div>
                      <div className="method-card">
                        <ShieldCheck size={21} />
                        <div>
                          <strong>先核对，再入账</strong>
                          <p>相近金额和时间只提示疑似重复，由你决定保留。</p>
                        </div>
                      </div>
                    </div>
                    <p className="help-text">
                      {onSmsAutomation ? "在短信自动记账中连接 iPhone 快捷指令。群收款每次待确认，确认后才计入账本。" : "当前支持粘贴短信。登录云端账户后可连接 iPhone 快捷指令。"}
                    </p>
                  </aside>
                </div>
                {previews.length > 0 && (
                  <section className="panel">
                    <div className="panel-heading">
                      <div>
                        <h2 className="panel-title">入账前，再看一眼</h2>
                        <p className="panel-subtitle">
                          共 {previews.length} 笔，已选择 {selectedCount}{" "}
                          笔。疑似重复记录默认不勾选。
                        </p>
                      </div>
                      <button
                        className="button ghost small"
                        onClick={() => {
                          setPreviews([]);
                          setImportMessages([]);
                        }}
                      >
                        清空待确认记录
                      </button>
                    </div>
                    <div className="preview-list">
                      {previews.slice(0, previewLimit).map((p) => (
                        <div className="preview-card" key={p.key}>
                          <div className="preview-card-header">
                            <label>
                              <input
                                type="checkbox"
                                checked={p.selected}
                                onChange={(e) =>
                                  setPreviews((prev) =>
                                    prev.map((x) =>
                                      x.key === p.key
                                        ? { ...x, selected: e.target.checked }
                                        : x,
                                    ),
                                  )
                                }
                              />{" "}
                              <strong>{p.draft.merchant}</strong>
                            </label>
                            <strong>{amountText(p.draft)}</strong>
                          </div>
                          <div className="preview-card-body">
                            <span>
                              {p.draft.date.replace("T", " ")} ·{" "}
                              {categoryText(p.draft)} · {KIND_NAMES[p.draft.kind]} ·{" "}
                              {SOURCE_NAMES[p.draft.source]}
                            </span>
                            {p.duplicates.length > 0 && (
                              <p className="text-danger">
                                疑似重复：{p.duplicates[0].merchant} ·{" "}
                                {p.duplicates[0].date.replace("T", " ")}
                                。确认是另一笔消费后再勾选。
                              </p>
                            )}
                            {p.warnings.map((w, i) => (
                              <p className="text-danger" key={i}>
                                {w}
                              </p>
                            ))}
                          </div>
                          <div className="preview-card-actions">
                            <button
                              className="button secondary small"
                              onClick={() =>
                                setEditor({ draft: p.draft, previewKey: p.key })
                              }
                            >
                              <Pencil size={14} />
                              修改信息
                            </button>
                            <button
                              className="button ghost small"
                              onClick={() =>
                                setPreviews((prev) =>
                                  prev.filter((x) => x.key !== p.key),
                                )
                              }
                            >
                              跳过
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                    {previews.length > previewLimit && (
                      <button
                        className="button secondary"
                        onClick={() => setPreviewLimit(previewLimit + 30)}
                      >
                        再显示 30 笔
                      </button>
                    )}
                    <div className="form-actions">
                      <button
                        className="button primary"
                        disabled={!selectedCount}
                        onClick={confirmPreview}
                      >
                        <Check size={17} />
                        确认保存 {selectedCount} 笔
                      </button>
                      <span className="help-text">
                        仅保存勾选的记录，可在账目中继续修改。
                      </span>
                    </div>
                  </section>
                )}
              </div>
            )}
            {page === "settings" && (
              <div className="page settings-grid">
                {onSmsAutomation && <section className="setting-card sms-entry-card" aria-labelledby="sms-entry-title">
                  <div className="setting-heading"><MessageSquare size={23} /><h2 id="sms-entry-title">短信自动记账</h2></div>
                  <p>连接 iPhone 快捷指令，让新的工行消费短信进入你的账户账本。</p>
                  <p className="help-text">群收款每次待确认。首次使用，请在这里完成接入和手机配置。</p>
                  <button className="button primary" onClick={onSmsAutomation}>打开短信自动记账<ArrowRight size={17} /></button>
                </section>}
                {accountPanel}
                <section className="setting-card">
                  <div className="setting-heading">
                    <Wallet size={23} />
                    <h2>给每个月一个预算</h2>
                  </div>
                  <p>
                    当前月预算：
                    <strong>
                      {data.budgetCents
                        ? formatMoney(data.budgetCents)
                        : "未设置"}
                    </strong>
                  </p>
                  <p className="help-text">
                    这个额度用于各月的预算对照。净支出按消费发生月份减去该月到账退款计算。
                  </p>
                  <button className="button secondary" onClick={startBudget}>
                    调整月预算
                  </button>
                </section>
                <section className="setting-card">
                  <div className="setting-heading">
                    <ShieldCheck size={23} />
                    <h2>你的数据，你来保管</h2>
                  </div>
                  <p>
                    已保存 <strong>{data.transactions.length}</strong>{" "}
                    笔记录，{cloudMode ? "按当前账户同步至云端。" : "仅限当前设备与浏览器。"}
                  </p>
                  <p className="help-text">
                    {cloudMode ? "请确认显示“已同步”后再换设备。完整备份仍建议定期导出；恢复备份会替换当前账户账本并同步至其他设备。" : "换设备、清理浏览器数据前请先备份。主屏幕应用与浏览器也可能使用独立存储，可通过备份转移。"}
                  </p>
                  <div className="form-actions">
                    <button
                      className="button primary"
                      onClick={() =>
                        download(
                          exportBackup(data),
                          `moneytrail-backup-${localNow().slice(0, 10)}.json`,
                        )
                      }
                    >
                      <ArrowUpToLine size={17} />
                      导出完整备份
                    </button>
                    <button
                      className="button secondary"
                      onClick={() => backupRef.current?.click()}
                    >
                      <ArrowDownToLine size={17} />
                      恢复备份
                    </button>
                  </div>
                </section>
                <section className="setting-card">
                  <div className="setting-heading">
                    <Smartphone size={23} />
                    <h2>在 iPhone 上使用</h2>
                  </div>
                  <p>
                    使用 Safari
                    打开已部署的网站，点“分享”，再选择“添加到主屏幕”。
                  </p>
                  <p className="help-text">
                    {cloudMode ? "首次联网登录并读取账本后可离线记账，联网后同步。账单文件在本机解析，经你确认保存的记录会同步至当前账户。" : "首次联网加载后，生产版本支持离线记账。数据保存在本机，导入的账单不会上传到服务器。"}
                  </p>
                  <div className="notice warning">
                    {onSmsAutomation ? "短信自动接收需要在 iPhone 快捷指令中配置一次。仅明确识别的工行消费可自动入账，群收款和不明确的记录每次待确认。" : "当前支持粘贴短信与账单导入。登录云端账户后可配置 iPhone 快捷指令接收短信。"}
                  </div>
                </section>
                <section className="setting-card">
                  <div className="setting-heading">
                    <CircleHelp size={23} />
                    <h2>这本账，怎么算？</h2>
                  </div>
                  <p>
                    净支出 = 支出 −
                    退款。收入单独记录，转账、充值、信用卡还款不计消费；信用卡消费在购买时记录。
                  </p>
                  <p>
                    退款计入实际到账月份，可能使该月净支出为负。明确商户可按日常规则分类；账号模式下，仍是“待分类”的消费可在短信自动记账中预览并批量整理。
                  </p>
                  <p className="help-text">
                    相同来源交易编号会跳过重复导入；其他相近记录只给出提醒，不会自动删除。
                  </p>
                </section>
                <section className="setting-card">
                  <div className="setting-heading">
                    <ArrowUpToLine size={23} />
                    <h2>带走你的账本</h2>
                  </div>
                  <p>
                    CSV 适合表格查看；完整 JSON
                    备份可以恢复记录、预算、原始来源及退款关联。
                  </p>
                  <button
                    className="button secondary"
                    disabled={!data.transactions.length}
                    onClick={() =>
                      download(
                        exportCsv(data.transactions),
                        "moneytrail-全部账目.csv",
                        "text/csv;charset=utf-8",
                      )
                    }
                  >
                    导出全部 CSV
                  </button>
                </section>
                <section className="setting-card">
                  <div className="setting-heading">
                    <Trash2 size={23} />
                    <h2>重新开始</h2>
                  </div>
                  <p className="help-text">
                    {cloudMode ? "清空会同步至当前账户的其他设备。建议先导出完整备份，已删除的数据无法直接撤销。" : "清空仅影响当前设备。建议先导出完整备份，已删除的数据无法直接撤销。"}
                  </p>
                  <button className="button danger" onClick={clearAll}>
                    {cloudMode ? "清空账户账本" : "清空本机数据"}
                  </button>
                </section>
              </div>
            )}
          </>
        )}
        <footer className="app-footer">
          <Layers3 size={14} />
          <span>慢慢记账，明明白白生活。</span>
        </footer>
      </main>
      <nav className="mobile-nav" aria-label="移动端主导航">
        {NAV.map(({ page: p, name, Icon }) => (
          <button
            className={`nav-button ${page === p ? "active" : ""}`}
            key={p}
            onClick={() => navigate(p)}
            aria-current={page === p ? "page" : undefined}
          >
            <Icon size={21} />
            <span>{name}</span>
          </button>
        ))}
      </nav>
      <input
        ref={csvRef}
        type="file"
        accept=".csv,text/csv"
        className="sr-only"
        tabIndex={-1}
        aria-label="选择 CSV 账单文件"
        onChange={(e) => void readCsv(e.target.files?.[0])}
      />
      <input
        ref={backupRef}
        type="file"
        accept=".json,application/json"
        className="sr-only"
        tabIndex={-1}
        aria-label="选择 JSON 备份文件"
        onChange={(e) => void restoreBackup(e.target.files?.[0])}
      />
      {editor && (
        <TransactionEditor
          key={editor.id ?? editor.previewKey ?? "new"}
          initial={editor.draft}
          merchantRules={merchantRules}
          canLearn={cloudMode}
          isNew={!editor.id && !editor.previewKey}
          initialRemember={editor.previewKey ? previews.find(preview => preview.key === editor.previewKey)?.remember : undefined}
          memoryOriginal={editor.previewKey ? previews.find(preview => preview.key === editor.previewKey)?.original : editor.draft}
          transactions={data.transactions.filter((t) => t.id !== editor.id)}
          title={
            editor.previewKey
              ? "核对这笔记录"
              : editor.id
                ? "修改这笔记录"
                : "记下一笔"
          }
          onSave={saveEditor}
          saveError={notice}
          onClose={() => setEditor(null)}
        />
      )}
      {budgetOpen && (
        <Modal title="设置月预算" onClose={() => setBudgetOpen(false)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const amount =
                budgetInput.trim() === "" ||
                /^0(?:\.00?)?$/.test(budgetInput.trim())
                  ? 0
                  : parseAmount(budgetInput);
              if (amount === null) {
                setNotice("预算需为非负金额，最多两位小数。");
                return;
              }
              if (
                persist(
                  { ...data, budgetCents: amount },
                  amount ? "月预算已更新" : "已取消月预算",
                )
              )
                setBudgetOpen(false);
            }}
          >
            <div className="modal-body">
              {notice && (
                <p className="notice warning" role="alert">
                  {notice}
                </p>
              )}
              <div className="form-field">
                <label htmlFor="budget">每月计划花费（元）</label>
                <input
                  id="budget"
                  autoFocus
                  inputMode="decimal"
                  placeholder="例如：5000.00"
                  value={budgetInput}
                  onChange={(e) => setBudgetInput(e.target.value)}
                  maxLength={16}
                />
                <p className="help-text">
                  留空或填 0 可取消预算。该额度用于所有月份的对照。
                </p>
              </div>
            </div>
            <div className="modal-footer">
              <button
                type="button"
                className="button secondary"
                onClick={() => setBudgetOpen(false)}
              >
                取消
              </button>
              <button type="submit" className="button primary">
                保存预算
              </button>
            </div>
          </form>
        </Modal>
      )}
      {toast && (
        <div className="toast" role="status">
          <Check size={17} />
          {toast}
        </div>
      )}
    </div>
  );
}
