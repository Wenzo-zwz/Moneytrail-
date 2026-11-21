import { isStoredExpenseCategory, normalizeExpenseCategory } from "./expenseCategories";
import { canRememberMerchant, merchantKey, type MerchantRuleIntent } from "./merchantClassification";
import type { AppData } from "./storage";

/** Operational intent is account-cache state, never part of a ledger export. */
export function readMerchantRuleIntents(value: unknown): MerchantRuleIntent[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 200) throw new Error("商户记忆队列无效或过大。");
  const ids = new Set<string>();
  return value.flatMap(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)
      || Object.keys(item).some(key => !["transactionId", "merchant", "category", "subcategory"].includes(key))
      || typeof item.transactionId !== "string" || !item.transactionId.trim() || item.transactionId.length > 200
      || ids.has(item.transactionId) || typeof item.merchant !== "string" || item.merchant.length > 200
      || !canRememberMerchant(item.merchant) || !isStoredExpenseCategory(item.category) || item.category === "待分类"
      || (item.subcategory !== undefined && (typeof item.subcategory !== "string" || !item.subcategory.trim() || item.subcategory.length > 40))) {
      throw new Error("商户记忆内容无效，请重新选择具体商户和分类。");
    }
    ids.add(item.transactionId);
    const normalized = normalizeExpenseCategory({ transactionId: item.transactionId, merchant: item.merchant, category: item.category,
      ...(item.subcategory !== undefined ? { subcategory: item.subcategory } : {}) });
    return normalized.category === "待分类" ? [] : [normalized];
  });
}

export function sameMerchantRuleIntent(a: MerchantRuleIntent, b: MerchantRuleIntent): boolean {
  return a.transactionId === b.transactionId && a.merchant === b.merchant
    && a.category === b.category && a.subcategory === b.subcategory;
}

/** One remembered purpose per merchant; later explicit examples take precedence. */
export function latestMerchantRuleIntents(intents: MerchantRuleIntent[]): MerchantRuleIntent[] {
  const latest = new Map<string, MerchantRuleIntent>();
  for (const intent of intents) {
    const key = merchantKey(intent.merchant);
    latest.delete(key);
    latest.set(key, intent);
  }
  return [...latest.values()];
}

/** Later edits/deletions invalidate an unsent example rather than publish stale choices. */
export function matchingMerchantRuleIntents(data: AppData, intents: MerchantRuleIntent[]): MerchantRuleIntent[] {
  const transactions = new Map(data.transactions.map(transaction => [transaction.id, transaction]));
  return intents.filter(intent => {
    const transaction = transactions.get(intent.transactionId);
    return transaction?.kind === "expense" && transaction.merchant === intent.merchant
      && transaction.category === intent.category && transaction.subcategory === intent.subcategory;
  });
}
