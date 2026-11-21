import { normalizeTransactionCategory, type DraftTransaction } from "../lib/ledger";
import { canRememberMerchant, merchantKey } from "../lib/merchantClassification";

/** A category choice is teaching only when the original identifies this safe merchant. */
export function canOfferMerchantMemory(original: DraftTransaction, draft: DraftTransaction, explicitChoice: boolean, isNew = false): boolean {
  if (!explicitChoice || draft.kind !== "expense" || draft.category === "待分类" || !canRememberMerchant(draft.merchant)) return false;
  if (!isNew && (original.kind !== "expense" || !canRememberMerchant(original.merchant) || merchantKey(original.merchant) !== merchantKey(draft.merchant))) return false;
  const before = normalizeTransactionCategory(original);
  const after = normalizeTransactionCategory(draft);
  return after.category !== "待分类" && (before.category !== after.category || (before.subcategory || "未细分") !== (after.subcategory || "未细分"));
}
