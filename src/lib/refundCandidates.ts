import { isValidLocalDateTime, type Transaction } from "./ledger";
import { canRememberMerchant, merchantKey } from "./merchantClassification";

export function refundCandidates(transactions: Transaction[], refund: { date: string; merchant: string; amountCents: number }) {
  if (!isValidLocalDateTime(refund.date)) return { suggested: [], other: [] };

  const refundedAmounts = new Map<string, number>();
  for (const transaction of transactions) {
    if (transaction.kind === "refund" && transaction.linkedTransactionId) {
      const id = transaction.linkedTransactionId;
      refundedAmounts.set(id, (refundedAmounts.get(id) ?? 0) + transaction.amountCents);
    }
  }
  const eligible = transactions.filter(transaction =>
    transaction.kind === "expense" && transaction.date <= refund.date
    && transaction.amountCents - (refundedAmounts.get(transaction.id) ?? 0) >= Math.max(1, refund.amountCents),
  ).sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));

  // Only remove a refund marker from the edges, keeping the actual merchant and branch.
  const merchant = refund.merchant.normalize("NFKC").trim()
    .replace(/^(?:退款到账|退款)[-—:\s]*/, "")
    .replace(/\s*(?:\(\s*退款\s*\)|[-—:\s]*退款(?:到账)?)$/, "");
  const key = refund.amountCents > 0 && canRememberMerchant(merchant) ? merchantKey(merchant) : "";
  const suggested = key ? eligible.filter(transaction => merchantKey(transaction.merchant) === key)
    .sort((a, b) => Number(b.amountCents === refund.amountCents) - Number(a.amountCents === refund.amountCents))
    .slice(0, 3) : [];
  const suggestedIds = new Set(suggested.map(transaction => transaction.id));
  return { suggested, other: eligible.filter(transaction => !suggestedIds.has(transaction.id)) };
}
