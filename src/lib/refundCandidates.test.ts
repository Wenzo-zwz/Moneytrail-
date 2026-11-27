import { expect, it } from "vitest";
import type { Transaction } from "./ledger";
import { refundCandidates } from "./refundCandidates";

function expense(id: string, merchant: string, amountCents: number, date = "2026-11-20T18:00"): Transaction {
  return { id, merchant, amountCents, date, kind: "expense", category: "食品酒水", source: "manual", note: "" };
}

it.each(["退款支付宝-清泉咖啡（东店）", "消费财付通-清泉咖啡（东店）退款"])("recommends earlier same-merchant charges with enough remaining value (%s)", merchant => {
  const exact = expense("same-amount", "财付通-清泉咖啡(东店)", 2000, "2026-11-01T18:00");
  const partial = expense("partial", "消费支付宝-清泉咖啡(东店)", 10000);
  const otherMerchant = expense("other", "迎春超市", 2000);
  const otherBranch = expense("west", "清泉咖啡(西店)", 2000);
  const future = expense("future", "清泉咖啡(东店)", 2000, "2026-11-27T19:01");
  const used = expense("used", "清泉咖啡(东店)", 2000);
  const priorRefunds: Transaction[] = [
    { ...partial, kind: "refund", id: "prior-partial", linkedTransactionId: partial.id, amountCents: 3000 },
    { ...used, kind: "refund", id: "prior-full", linkedTransactionId: used.id },
  ];
  const result = refundCandidates([future, otherMerchant, partial, exact, used, otherBranch, ...priorRefunds], {
    date: "2026-11-27T19:00", merchant, amountCents: 2000,
  });
  expect(result.suggested.map(item => item.id)).toEqual(["same-amount", "partial"]);
  expect(result.other.map(item => item.id)).toEqual(["other", "west"]);
});

it.each(["支付宝退款", "退款到账", "退款-美团"])("offers manual search without recommending a generic refund sender (%s)", merchant => {
  const record = expense("manual", "清泉咖啡", 2000);
  expect(refundCandidates([record], { date: "2026-11-27T19:00", merchant, amountCents: 2000 }))
    .toEqual({ suggested: [], other: [record] });
});
