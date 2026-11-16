import { isValidLocalDateTime, parseAmount, type Platform } from "./ledger";
import { classifyMerchant, type MerchantRule } from "./merchantClassification";
import { parseAlipayScreenshot } from "./alipayScreenshot";

export type PaymentScreenshotCandidate = {
  key: string;
  kind: "expense";
  source: "alipay" | "wechat" | "manual";
  merchant: string;
  amountCents: number;
  date?: string;
  category: string;
  subcategory?: string;
  platform?: Platform;
};
export type PaymentScreenshotResult = { candidates: PaymentScreenshotCandidate[]; warnings: string[]; error?: string };

const alipayHeading = /^(?:支付宝|支付宝(?:账单|付款|支付|交易)(?:详情)?|支付宝详情)$/;
const wechatHeading = /^(?:微信|微信支付|微信支付(?:账单|付款|支付|交易)(?:详情)?|微信支付凭证)$/;
const controls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\p{Cf}]/u;
const security = /验证码|驗證碼|校验码|校驗碼|动态码|動態碼|口令|密码|密碼|\b(?:otp|verification|one[ -]?time)(?:\b|(?=[0-9]))/i;
const foreign = /美元|美金|港币|港元|欧元|日元|英镑|澳元|加元|新加坡元|新西兰元|韩元|韓元|台币|台幣|新台币|新臺幣|泰铢|卢比|外币|\b(?:USD|HKD|EUR|JPY|GBP|AUD|CAD|SGD|CHF|NZD|KRW|TWD|THB|INR|MYR|VND|IDR|PHP)(?:\b|(?=[0-9]))|[$€£₩฿₹]/i;
const nonPurchase = /退款|退回|退货|冲正|撤销|转账|转出|转入|还款|偿还|提现|充值|收入|收款成功|收款到账|已收款|交易关闭|订单关闭|支付失败|交易失败|未成功|未支付|未付款|待付款|待支付|已取消|处理中|待处理|进行中|支付中|确认中|待确认/;
const status = /^(?:支付成功|付款成功|交易成功|支付完成|付款完成|支出|收入|转账|退款|处理中|待处理|交易详情|付款详情|账单详情|支付详情|收款成功)$/;
const merchantLabels = ["收款方全称", "商户全称", "商户名称", "商户名", "收款商户", "商户", "商家", "收款方"];
const amountLabels = ["实付金额", "实际付款", "支出金额", "支付金额", "付款金额", "交易金额", "实付", "金额"];
const otherAmounts = ["订单金额", "优惠金额", "手续费", "服务费", "退款金额", "账户余额", "余额", "合计"];
const dateLabels = ["交易时间", "付款时间", "支付时间"];
const directionLabels = ["收支类型", "交易类型", "收支"];
const knownLabels = [...merchantLabels, ...amountLabels, ...otherAmounts, ...dateLabels, ...directionLabels,
  "币种", "支付状态", "交易状态", "订单状态", "付款方式", "支付方式", "商品说明", "商品名称",
  "商家订单号", "商户订单号", "交易单号", "交易号", "订单编号", "订单号", "创建时间", "到账时间",
  "对方账户", "付款方", "付款人", "收款人", "收单机构", "账单分类", "商户编号", "商户号", "商户类型", "商户类别",
  "收款方账号", "收款方账户", "支付渠道", "付款渠道", "交易渠道"].sort((a, b) => b.length - a.length);
const duplicateWarning = "截图可能与银行短信或已导入账单重复，请逐笔核对后保存。";
function fail(error: string): PaymentScreenshotResult { return { candidates: [], warnings: [], error }; }

function fieldLabel(line: string): string | undefined {
  return knownLabels.find(label => line === label || (line.startsWith(label)
    && (/^[\s:：]/.test(line.slice(label.length))
      || ([...amountLabels, ...otherAmounts, ...dateLabels].includes(label) && /^[+\-−\d¥￥]/.test(line.slice(label.length))))));
}

/** Empty or adjacent fields remain empty; never use a status or another field as a merchant. */
function fields(lines: string[], labels: readonly string[]): (string | null)[] {
  const values: (string | null)[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index], label = fieldLabel(line);
    if (!label || !labels.includes(label)) continue;
    const tail = line.slice(label.length).replace(/^[\s:：]+/, "").trim();
    const next = tail || lines[index + 1];
    values.push(!next || fieldLabel(next) || (labels === merchantLabels && status.test(next))
      || alipayHeading.test(next) || wechatHeading.test(next) ? null : next);
  }
  return values;
}
function dateValue(value: string): string | undefined {
  const match = /^(\d{4})[年/.-](\d{1,2})[月/.-](\d{1,2})(?:日\s*|[ T]+)(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!match || (match[6] !== undefined && Number(match[6]) > 59)) return undefined;
  const date = `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}T${match[4].padStart(2, "0")}:${match[5]}`;
  return isValidLocalDateTime(date) ? date : undefined;
}

/** One screenshot entry point, with source-aware adapters and explicit user review. */
export function parsePaymentScreenshot(text: unknown, rules: MerchantRule[] = []): PaymentScreenshotResult {
  if (typeof text !== "string" || !text.trim() || text.length > 16000 || controls.test(text)) {
    return fail("截图文字为空、过长或含不可识别字符，请重新提取或手动录入。");
  }
  const raw = text.replace(/\r\n?|\u2028|\u2029/g, "\n").trim();
  const lines = raw.split("\n").map(line => line.trim()).filter(Boolean);
  const normalized = raw.normalize("NFKC"), normalizedLines = lines.map(line => line.normalize("NFKC"));
  if (security.test(normalized)) return fail("截图含验证码或安全口令，请使用不含此类信息的付款截图。");

  // Only exact page branding is evidence for a suggested source. A merchant or
  // payment method mentioning another platform must not change the source.
  const headings = normalizedLines.slice(0, 8).filter((_line, index) => index === 0
    || !knownLabels.some(label => normalizedLines[index - 1].replace(/[\s:：]+$/, "") === label));
  const alipay = headings.some(line => alipayHeading.test(line));
  const wechat = headings.some(line => wechatHeading.test(line));
  if (alipay && wechat) return fail("截图含多个支付平台，无法确定记录归属，请分开截图或手动核对。");
  const source: PaymentScreenshotCandidate["source"] = alipay ? "alipay" : wechat ? "wechat" : "manual";

  if (!wechat && /^你在[\s\S]*有一笔/m.test(raw)) {
    const parsed = parseAlipayScreenshot(raw, rules);
    return {
      ...parsed,
      candidates: parsed.candidates.map(value => ({ ...value, kind: "expense", source })),
      warnings: [
        ...parsed.warnings.map(warning => warning.replaceAll("支付宝", "支付平台")),
        ...(source === "manual" && parsed.candidates.length ? ["未确认支付平台，暂列为其他来源，请根据原画面选择支付来源。"] : []),
      ],
    };
  }

  if (foreign.test(normalized) || nonPurchase.test(normalized)) {
    return fail("截图涉及外币、收款、退款、转账或未完成交易，不能直接作为普通支出，请核对交易类型后手动录入。");
  }
  // A generic "交易成功" can describe incoming money too; require a payment
  // outcome or an explicit outgoing type rather than treating every success as spending.
  const completed = normalizedLines.some(line => /^(?:支付成功|付款成功|支付完成|付款完成)$/.test(line));
  const outgoing = fields(normalizedLines, directionLabels).some(value => value !== null
    && ["支出", "消费支出", "消费", "商户消费", "付款", "支付"].includes(value));
  if (!completed && !outgoing) return fail("未识别到明确的付款成功或支出记录，请使用完整支付详情或手动录入。");
  const directions = fields(normalizedLines, directionLabels);
  if (directions.some(value => value !== null && !["支出", "消费支出", "消费", "付款", "支付", "商户消费"].includes(value))) {
    return fail("截图的交易方向或类型不明确，请手动核对录入。");
  }
  const merchants = fields(lines, merchantLabels), amounts = fields(normalizedLines, amountLabels);
  if (merchants.length !== 1 || !merchants[0] || amounts.length !== 1 || !amounts[0]
    || fields(normalizedLines, [...amountLabels, ...otherAmounts]).length !== 1) {
    return fail("商户或支出金额缺失、存在多项，无法确定归属，请手动核对录入。");
  }
  const merchant = merchants[0];
  if (merchant.length > 200 || status.test(merchant.normalize("NFKC"))
    || /^(?:[¥￥]|人民币|CNY|RMB)?[+\-−]?\d[\d,.]*(?:元)?$/i.test(merchant.normalize("NFKC"))) {
    return fail("未识别到明确商户，请核对原截图后手动录入。");
  }
  const currencies = fields(normalizedLines, ["币种"]);
  if (currencies.some(value => !value || !/^(?:人民币|CNY|RMB)$/i.test(value))) {
    return fail("截图币种不是唯一明确的人民币，请手动核对录入。");
  }
  let amount = amounts[0].replace(/\s+/g, "").replace(/−/g, "-");
  if (amount.includes("+") || (!currencies.length && !/^(?:人民币|CNY|RMB|[¥￥])|元$|(?:CNY|RMB)$/i.test(amount))) {
    return fail("未识别到明确的人民币支出金额，请手动核对录入。");
  }
  amount = amount.replace(/^-/, "").replace(/^((?:人民币|CNY|RMB|[¥￥]))-/i, "$1");
  const amountCents = parseAmount(amount);
  const moneyText = normalized.replace(/[−–—]/g, "-");
  const markedMoney = [...moneyText.matchAll(/(?:人民币|\bCNY\b|\bRMB\b|[¥￥])\s*[+-]?\d[\d,]*(?:\.\d{1,2})?|[+-]?\d[\d,]*(?:\.\d{1,2})?\s*元/gi)].length;
  const bareMoneyLines = moneyText.split("\n").filter(line => /^[+-]?\d[\d,]*\.\d{1,2}$/.test(line.trim())).length;
  if (amountCents === null || markedMoney + bareMoneyLines > 1) {
    return fail("金额格式不正确或截图包含多个金额，请手动确定实际支出。");
  }
  const classification = classifyMerchant(merchant, rules);
  if (classification.requiresReview) return fail("商户或交易性质不明确，请手动核对录入。");
  const dates = fields(normalizedLines, dateLabels), parsedDates = dates.map(value => value ? dateValue(value) : undefined);
  const date = dates.length && parsedDates.every(Boolean) && new Set(parsedDates).size === 1 ? parsedDates[0] : undefined;
  return {
    candidates: [{ key: "payment-screenshot-0", kind: "expense", source, merchant, amountCents,
      ...(date ? { date } : {}), category: classification.category,
      ...(classification.subcategory ? { subcategory: classification.subcategory } : {}),
      ...(classification.platform ? { platform: classification.platform } : {}) }],
    warnings: [
      "仅按截图文字生成候选，请核对商户、金额、支付来源和交易类型。",
      ...(source === "manual" ? ["未确认支付平台，暂列为其他来源，请根据原画面选择支付来源。"] : []),
      ...(!date ? ["未识别到完整明确的交易时间，请填写实际交易日期；不会使用截图时钟或当前时间。"] : []),
      duplicateWarning,
    ],
  };
}
