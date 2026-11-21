import { isValidLocalDateTime, parseAmount, type Platform } from "./ledger";
import { classifyMerchant, merchantKey, type MerchantRule } from "./merchantClassification";
import { parseAlipayNotification } from "./alipayNotification";

export type AlipayScreenshotCandidate = {
  key: string;
  merchant: string;
  amountCents: number;
  date?: string;
  category: string;
  subcategory?: string;
  platform?: Platform;
};

export type AlipayScreenshotResult = {
  candidates: AlipayScreenshotCandidate[];
  warnings: string[];
  error?: string;
};

const unsafeControls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\p{Cf}]/u;
const securityText = /验证码|驗證碼|校验码|校驗碼|动态码|動態碼|口令|密码|密碼|\b(?:otp|verification|one[ -]?time)(?:\b|(?=[0-9]))/i;
const foreignCurrency = /美元|美金|港币|港元|欧元|日元|英镑|澳元|加元|新加坡元|新西兰元|韩元|韓元|台币|台幣|新台币|新臺幣|泰铢|卢比|外币|\b(?:USD|HKD|EUR|JPY|GBP|AUD|CAD|SGD|CHF|NZD|KRW|TWD|THB|INR|MYR|VND|IDR|PHP)(?:\b|(?=[0-9]))|[$€£₩฿₹]/i;
const uncertainOutcome = /退款|退回|退货|冲正|撤销|交易关闭|支付失败|交易失败|未成功|未支付|待付款|待支付|未付款|已取消|处理中|待处理|进行中|支付中|确认中|待确认|转账|转出|转入|还款|提现|收入|收款成功|到账提醒/;
const pageOrStatus = /^(?:支付宝(?:账单|付款|支付|交易)?(?:详情)?|微信(?:支付)?|账单详情|付款详情|交易详情|支付详情|支付成功|付款成功|交易成功|处理中|交易处理中|支付处理中|待处理|进行中|支付中|确认中|待确认)$/;
const fieldLabels = ["商户名称", "收款商户", "商户", "商家", "收款方", "实付金额", "支出金额", "付款金额", "实付", "金额", "交易时间", "付款时间", "支付时间", "商品说明", "订单金额", "优惠金额", "手续费", "服务费", "退款金额", "付款方式", "交易类型", "收支", "币种"];
const merchantLabels = ["商户名称", "收款商户", "商户", "商家", "收款方"];
const amountLabels = ["实付金额", "支出金额", "付款金额", "实付", "金额"];
const allAmountLabels = [...amountLabels, "订单金额", "优惠金额", "手续费", "服务费", "退款金额"];
const dateLabels = ["交易时间", "付款时间", "支付时间"];
const duplicateWarning = "截图可能与银行短信或已导入账单重复，请逐笔核对后保存。";

function failure(error: string): AlipayScreenshotResult {
  return { candidates: [], warnings: [], error };
}

function candidate(merchant: string, amountCents: number, index: number, rules: MerchantRule[], date?: string): AlipayScreenshotCandidate | null {
  if (!merchant || merchant.length > 200 || unsafeControls.test(merchant) || pageOrStatus.test(merchant.normalize("NFKC"))) return null;
  const classification = classifyMerchant(merchant, rules);
  if (!merchantKey(merchant)) return null;
  return {
    // A local preview position, not a payment ID or an idempotency key.
    key: `alipay-screenshot-${index}`, merchant, amountCents,
    ...(date ? { date } : {}), category: classification.category,
    ...(classification.subcategory ? { subcategory: classification.subcategory } : {}),
    ...(classification.platform ? { platform: classification.platform } : {}),
  };
}

function readFields(lines: string[], labels: string[]): string[] {
  const values: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const label = labels.find(value => line.startsWith(value));
    if (!label) continue;
    // Prefer the longest known label; e.g. 金额 must not consume a new field.
    const known = fieldLabels.find(value => line.startsWith(value));
    if (known !== label) continue;
    const tail = line.slice(label.length).replace(/^[\s:：]+/, "").trim();
    if (tail) values.push(tail);
    else {
      const next = lines[index + 1];
      if (next && !fieldLabels.some(value => next.startsWith(value)) && !pageOrStatus.test(next.normalize("NFKC"))) values.push(next);
    }
  }
  return values;
}

function explicitDate(value: string): string | undefined {
  const normalized = value.normalize("NFKC");
  const match = /^(\d{4})[年/.-](\d{1,2})[月/.-](\d{1,2})日?[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(normalized);
  if (!match || (match[6] !== undefined && Number(match[6]) > 59)) return undefined;
  const [, year, month, day, hour, minute] = match;
  const date = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}T${hour.padStart(2, "0")}:${minute}`;
  return isValidLocalDateTime(date) ? date : undefined;
}

function parseNotificationList(text: string, rules: MerchantRule[]): AlipayScreenshotResult | null {
  const starts = [...text.matchAll(/你在/gu)].map(match => match.index!);
  if (!starts.length) return null;
  const candidates: AlipayScreenshotCandidate[] = [];
  let ignored = 0;
  for (let index = 0; index < starts.length; index++) {
    const section = text.slice(starts[index], starts[index + 1] ?? text.length);
    const ending = /点此查看详情[。.]?/.exec(section);
    if (!ending) { ignored++; continue; }
    const body = section.slice(0, ending.index + ending[0].length);
    const bodyLines = body.split("\n").map(line => line.trim()).filter(Boolean);
    // Never join a merchant in one card to an amount in another card.
    if (body.length > 2000 || foreignCurrency.test(body.normalize("NFKC")) || bodyLines.slice(1, -1).some(line =>
      /(?:通知|提醒)(?:\s*(?:(?:今天|昨天|前天)\s*)?\d{1,2}:\d{2})?$/.test(line)
      || pageOrStatus.test(line.normalize("NFKC"))
      || /^(?:(?:今天|昨天|前天)\s*)?\d{1,2}:\d{2}$/.test(line))) {
      ignored++; continue;
    }
    const tail = section.slice(ending.index + ending[0].length);
    const sameLineTail = tail.split("\n", 1)[0].trim();
    const nextLine = tail.split("\n").slice(1).map(line => line.trim()).find(Boolean) ?? "";
    if (sameLineTail || (uncertainOutcome.test(nextLine) && !/提醒$|通知$/.test(nextLine))) {
      ignored++; continue;
    }
    const parsed = parseAlipayNotification({ title: "交易提醒", body: bodyLines.join("") }, rules);
    if (!parsed) { ignored++; continue; }
    const value = candidate(parsed.merchant, parsed.amountCents, candidates.length, rules);
    if (value) candidates.push(value);
    else ignored++;
  }
  if (!candidates.length) return failure("未识别到完整的支付宝付款通知，请换一张完整截图或手动录入。");
  return {
    candidates,
    warnings: [
      "截图文字无法验证通知来源，请确认候选来自支付宝。",
      "通知正文没有交易时间，请逐笔补充实际交易日期；顶部时钟和“昨天”不会作为交易时间。",
      duplicateWarning,
      ...(ignored ? ["有不完整或含义不明确的通知未生成候选，请对照截图核对。"] : []),
    ],
  };
}

/**
 * Parses OCR text into review candidates only. It does not authenticate the image,
 * invent dates/order IDs, join unrelated cards or deduplicate identical purchases.
 * Payment-detail support is deliberately limited until real samples are verified.
 */
export function parseAlipayScreenshot(text: unknown, rules: MerchantRule[] = []): AlipayScreenshotResult {
  if (typeof text !== "string" || !text.trim() || text.length > 16000 || unsafeControls.test(text)) {
    return failure("截图文字为空、过长或含不可识别字符，请重新提取或手动录入。");
  }
  const raw = text.replace(/\r\n?|\u2028|\u2029/g, "\n").trim();
  const normalized = raw.normalize("NFKC");
  if (securityText.test(normalized)) return failure("截图含验证码或安全口令，请使用不含此类信息的付款截图。");

  const notifications = parseNotificationList(raw, rules);
  if (notifications) return notifications;

  const lines = raw.split("\n").map(line => line.trim()).filter(Boolean);
  const normalizedLines = lines.map(line => line.normalize("NFKC"));
  if (!normalizedLines.slice(0, 8).some(line => /^支付宝(?:$|[ ·|]|(?:账单|付款|支付|交易)(?:详情)?$|详情$)/.test(line))) {
    return failure("未识别到支付宝付款页面，请使用支付宝的完整付款详情截图。");
  }
  if (foreignCurrency.test(normalized) || uncertainOutcome.test(normalized)) {
    return failure("截图涉及外币、退款、资金流转或不明确的交易状态，请手动核对录入。");
  }
  const completed = normalizedLines.some(line => /^(?:支付成功|付款成功|交易成功)$/.test(line));
  const expense = readFields(normalizedLines, ["交易类型", "收支"]).some(value => value === "支出");
  if (!completed && !expense) return failure("未识别到明确的已完成支出，请手动核对交易类型。");

  const merchants = readFields(lines, merchantLabels);
  const amounts = readFields(normalizedLines, amountLabels);
  if (merchants.length !== 1 || amounts.length !== 1 || readFields(normalizedLines, allAmountLabels).length !== 1) {
    return failure("商户或支出金额缺失、存在多项，无法确定归属，请手动核对录入。");
  }
  const currencies = readFields(normalizedLines, ["币种"]);
  if (currencies.some(value => !/^(?:人民币|CNY|RMB)$/i.test(value))) {
    return failure("截图币种不是唯一明确的人民币，请手动核对录入。");
  }
  const currencyLabel = currencies.length > 0;
  const amount = amounts[0].replace(/\s+/g, "");
  if (amount.startsWith("+") || (!currencyLabel && !/^(?:人民币|CNY|RMB|[¥￥])|元$|(?:CNY|RMB)$/i.test(amount))) {
    return failure("未识别到明确的人民币支出金额，请手动核对录入。");
  }
  const amountCents = parseAmount(amount.replace(/^((?:人民币|CNY|RMB|[¥￥])?)-/i, "$1"));
  const moneyMentions = [...normalized.matchAll(/(?:人民币|\bCNY\b|\bRMB\b|[¥￥])\s*-?\d[\d,]*(?:\.\d{1,2})?|\d[\d,]*(?:\.\d{1,2})?\s*元/gi)];
  if (amountCents === null || moneyMentions.length > 1) {
    return failure("金额格式不正确或截图包含多个金额，请手动确定实际支出。");
  }
  const dates = readFields(normalizedLines, dateLabels);
  const parsedDates = dates.map(explicitDate);
  const uniqueDates = new Set(parsedDates);
  const date = dates.length && parsedDates.every(Boolean) && uniqueDates.size === 1 ? parsedDates[0] : undefined;
  const value = candidate(merchants[0], amountCents, 0, rules, date);
  if (!value) return failure("商户或交易性质不明确，请手动核对录入。");
  return {
    candidates: [value],
    warnings: [
      "仅按截图文字生成候选，请核对截图来源、商户、金额和支出性质。",
      ...(!date ? ["未识别到完整明确的交易时间，请填写实际交易日期；不会使用截图时钟或当前时间。"] : []),
      duplicateWarning,
    ],
  };
}
