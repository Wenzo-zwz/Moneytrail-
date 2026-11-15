import { parseAmount, type Platform } from "./ledger";
import { classifyMerchant, type MerchantRule } from "./merchantClassification";

/** Input must first be extracted from a real notification by its caller. */
export type AlipayNotificationInput = { title: string; body: string };

/** A preview only: notification delivery time is not a transaction date. */
export type AlipayNotificationCandidate = {
  kind: "expense";
  source: "alipay";
  amountCents: number;
  merchant: string;
  category: string;
  subcategory?: string;
  platform?: Platform;
  classificationReason: string;
  requiresReview: true;
  warnings: string[];
};

const controls = /[\p{Cc}\p{Cf}\u2028\u2029]/u;
const securityText = /验证码|驗證碼|校验码|校驗碼|动态码|動態碼|口令|密码|密碼|\b(?:otp|verification|one[ -]?time)(?:\b|(?=[0-9]))/i;
const foreignCurrency = /美元|美金|港币|港元|欧元|日元|英镑|澳元|加元|新加坡元|外币|\b(?:USD|HKD|EUR|JPY|GBP|AUD|CAD|SGD|CHF)(?:\b|(?=[0-9]))|[$€£]/i;
const embeddedNotification = /有一笔|点此查看详情|免密[\/／]自动扣款|收入提醒|收款提醒|到账提醒|工资到账|促销提醒|优惠提醒|抽奖通知/;
const payment = /^你在[ \u00a0\u3000]*(.{1,200}?)有一笔[ \u00a0\u3000]*([0-9０-９][0-9０-９,，]*(?:[.．][0-9０-９]{1,2})?)[ \u00a0\u3000]*元的免密[\/／]自动扣款支付[，,][ \u00a0\u3000]*点此查看详情[。.]?$/u;
const yuanAmounts = /[0-9０-９][0-9０-９,，]*(?:[.．][0-9０-９]{1,2})?[ \u00a0\u3000]*元/gu;

/**
 * Recognizes only the complete, observed Alipay automatic-payment format.
 * Screen wrapping is not a newline in a notification. Reject actual line breaks
 * instead of joining fragments; a caller must verify the phone's input contract.
 * Fullwidth money and punctuation are supported without rewriting merchant names.
 * This function neither creates dates/order IDs nor suppresses repeated text.
 */
export function parseAlipayNotification(input: unknown, rules: MerchantRule[] = []): AlipayNotificationCandidate | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const { title, body } = input as Record<string, unknown>;
  if (typeof title !== "string" || typeof body !== "string"
    || title.length > 100 || body.length > 2000
    || controls.test(title) || controls.test(body)
    || title.normalize("NFKC").trim() !== "交易提醒") return null;

  const text = body.trim();
  const normalized = text.normalize("NFKC");
  if (securityText.test(normalized) || foreignCurrency.test(normalized)) return null;
  const match = payment.exec(text);
  if (!match || [...text.matchAll(yuanAmounts)].length !== 1) return null;
  const merchant = match[1].trim();
  if (!merchant || merchant.length > 200 || embeddedNotification.test(merchant)) return null;
  const amountCents = parseAmount(match[2].normalize("NFKC"));
  if (amountCents === null) return null;

  const classification = classifyMerchant(merchant, rules);
  // The observed purchase format must not reinterpret an uncertain transfer or
  // reversal identity as a new expense. Phone-service purchases remain supported.
  if (classification.requiresReview) return null;
  return {
    kind: "expense", source: "alipay", amountCents, merchant,
    category: classification.category,
    ...(classification.subcategory ? { subcategory: classification.subcategory } : {}),
    ...(classification.platform ? { platform: classification.platform } : {}),
    classificationReason: classification.reason,
    requiresReview: true,
    warnings: [
      "通知正文没有交易时间，请核对实际交易日期。",
      "通知正文没有订单编号，请核对是否已通过银行短信或账单记录。",
    ],
  };
}
