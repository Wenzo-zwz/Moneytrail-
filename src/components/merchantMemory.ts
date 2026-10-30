import { normalizeTransactionCategory, type DraftTransaction } from "../lib/ledger";
import { canRememberMerchant, classifyMerchant, merchantKey, type MerchantRule } from "../lib/merchantClassification";

/** A category choice is teaching only when the original identifies this safe merchant. */
export function canOfferMerchantMemory(original: DraftTransaction, draft: DraftTransaction, explicitChoice: boolean, rules: MerchantRule[] = [], isNew = false): boolean {
  if (!explicitChoice || draft.kind !== "expense" || draft.category === "待分类" || !canRememberMerchant(draft.merchant)) return false;
  if (!isNew && (original.kind !== "expense" || !canRememberMerchant(original.merchant) || merchantKey(original.merchant) !== merchantKey(draft.merchant))) return false;
  const before = normalizeTransactionCategory(original);
  if (before.category === draft.category && (before.subcategory || "未细分") === (draft.subcategory?.trim() || "未细分")) return false;
  return classifyMerchant(draft.merchant).category === "待分类" || rules.some(rule => merchantKey(rule.merchant) === merchantKey(draft.merchant));
}
