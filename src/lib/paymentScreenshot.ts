import { isValidLocalDateTime, parseAmount, type Platform } from "./ledger";
import { classifyMerchant, merchantKey, type MerchantRule } from "./merchantClassification";
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
export type PaymentScreenshotResult = {
  candidates: PaymentScreenshotCandidate[];
  warnings: string[];
  error?: string;
  partial?: { amountCents: number; source: PaymentScreenshotCandidate["source"] };
};

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
  "对方账户", "付款方", "付款人", "收款人", "收单机构", "清算机构", "账单分类", "商户编号", "商户号", "商户类型", "商户类别",
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
  const match = /^(\d{4})[年/.–-](\d{1,2})[月/.–-](\d{1,2})(?:日\s*|[ T]+)(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!match || (match[6] !== undefined && Number(match[6]) > 59)) return undefined;
  const date = `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}T${match[4].padStart(2, "0")}:${match[5]}`;
  return isValidLocalDateTime(date) ? date : undefined;
}

/**
 * Observed domestic wallet bill layout: the merchant and outgoing amount have
 * no field labels. Do not generalize every "交易成功" or negative number into
 * spending. All of the surrounding bill and settlement fields must agree.
 * These layout clues do not authenticate a payment platform or its currency.
 */
type WalletBill = { merchant: string; amount: string; date: string };
const billNavigation = /^(?:全部账单|极速付款|管理极速付款|账单管理|更多|标签|请选择|支付宝|微信支付)$/;
function walletMerchant(value: string): boolean {
  const normalized = value.normalize("NFKC");
  const navigation = normalized.replace(/[\s>›〉~]+$/, "");
  return /[\p{L}]/u.test(value) && !fieldLabel(navigation) && !status.test(navigation) && !billNavigation.test(navigation);
}
function walletAmount(value: string): string | undefined {
  const normalized = value.replace(/−/g, "-");
  return /^-(?:\d+|\d{1,3}(?:,\d{3})+)\.\d{2}$/.test(normalized) ? normalized : undefined;
}
const walletMethod = /^(?:余额宝|支付宝余额)(?:\s*[>›〉])?$/;
const settlementCompany = /^[\p{Script=Han}（）()·\s]{2,100}有限公司$/u;

function domesticWalletBill(lines: string[], normalizedLines: string[]): WalletBill | undefined {
  const heading = normalizedLines.findIndex(line => /^账单详情(?:\s*全部账单)?$/.test(line));
  const success = normalizedLines.indexOf("交易成功");
  if (heading < 0 || heading > 7 || success < heading + 3 || success > 12
    || normalizedLines.filter(line => /^账单详情(?:\s*全部账单)?$/.test(line)).length !== 1
    || normalizedLines.filter(line => line === "交易成功").length !== 1) return undefined;
  const navigation = normalizedLines.slice(heading + 1, success - 2);
  if (/全部账单$/.test(normalizedLines[heading]) ? navigation.length !== 0
    : navigation.length !== 1 || navigation[0] !== "全部账单") return undefined;
  const amount = walletAmount(normalizedLines[success - 1]);
  const merchant = lines[success - 2];
  if (!amount || !merchant || !walletMerchant(merchant)) return undefined;
  const methods = fields(normalizedLines, ["付款方式"]);
  const collectors = fields(normalizedLines, ["收单机构"]);
  const clearing = fields(normalizedLines, ["清算机构"]);
  const dates = fields(normalizedLines, dateLabels);
  if (methods.length !== 1 || !methods[0] || !walletMethod.test(methods[0])
    || collectors.length !== 1 || !collectors[0] || !settlementCompany.test(collectors[0])
    || clearing.length !== 1 || clearing[0] !== "中国银联股份有限公司"
    || dates.length !== 1 || !dates[0] || !dateValue(dates[0])
    || fields(normalizedLines, merchantLabels).length
    || fields(normalizedLines, [...amountLabels, ...otherAmounts]).length) return undefined;
  // A second bare decimal can be embedded in a line rather than standing alone.
  // Ignore the validated date and the two parsed summary values, but no other
  // decimal-looking content in this narrowly supported bill layout.
  if (normalizedLines.some((line, index) => index !== success - 1 && index !== success - 2
    && line !== dates[0] && !dateLabels.includes(fieldLabel(line) ?? "")
    && /[+\-−–—]?\d[\d,]*\.\d{1,2}(?!\d)/.test(line))) return undefined;
  return { merchant, amount, date: dateValue(dates[0])! };
}

/**
 * Apple OCR can serialize the labels down the left column before the centered
 * summary and right-column values. Restore only this observed bill structure;
 * do not find unrelated dates, wallet names and company names across the text.
 */
function columnWalletBill(lines: string[], normalizedLines: string[]): WalletBill | undefined {
  const heading = normalizedLines.findIndex(line => line === "账单详情");
  const success = normalizedLines.indexOf("交易成功");
  const labelGroup = ["支付时间", "付款方式", "支付奖励", "收单机构", "清算机构", "交易详情"];
  const labelStart = normalizedLines.indexOf(labelGroup[0]);
  if (heading < 0 || heading > 7 || success < 2 || labelStart <= heading
    || normalizedLines.filter(line => line === "账单详情").length !== 1
    || normalizedLines.filter(line => line === "全部账单").length !== 1
    || normalizedLines.filter(line => line === "交易成功").length !== 1
    || !normalizedLines.slice(heading + 1, labelStart).includes("全部账单")
    || !labelGroup.every((label, offset) => normalizedLines[labelStart + offset] === label
      && normalizedLines.filter(line => fieldLabel(line) === label || line === label).length === 1)
    || fields(normalizedLines, dateLabels).length !== 1
    || fields(normalizedLines, [...merchantLabels, ...amountLabels, ...otherAmounts, ...directionLabels]).length
    || normalizedLines.some(line => wechatHeading.test(line))) return undefined;

  const merchantIndex = success - 2, merchant = lines[merchantIndex];
  const amount = walletAmount(normalizedLines[success - 1]);
  if (merchantIndex < labelStart + labelGroup.length || !merchant || !walletMerchant(merchant) || !amount) return undefined;
  const summaryPrefix = normalizedLines.slice(labelStart + labelGroup.length, merchantIndex);
  // In the observed order a product can precede the merchant. Recognize that
  // two-line Meituan item block explicitly, so a missing merchant cannot cause
  // its product name (or half a wrapped merchant name) to be used as a merchant.
  if (summaryPrefix.length !== 0 && (summaryPrefix.length !== 2
    || !/^(?:\S{1,4}\s+)?美团点餐\s*[>›〉]?$/.test(summaryPrefix[0])
    || !walletMerchant(summaryPrefix[1]))) return undefined;

  const dateIndex = success + 2, date = dateValue(normalizedLines[dateIndex] ?? "");
  const method = normalizedLines[dateIndex + 1] ?? "";
  const reward = normalizedLines[dateIndex + 2] ?? "";
  const collector = normalizedLines[dateIndex + 3] ?? "";
  const clearing = normalizedLines[dateIndex + 4];
  if (normalizedLines[success + 1] !== "极速付款" || !date || !walletMethod.test(method)
    || !/^(?:[vV✓√]\s*)?立即领取\d+积分$/.test(reward)
    || !settlementCompany.test(collector) || clearing !== "中国银联股份有限公司"
    || normalizedLines.filter(line => dateValue(line)).length !== 1
    || normalizedLines.filter(line => walletMethod.test(line)).length !== 1
    || normalizedLines.filter(line => line === "中国银联股份有限公司").length !== 1
    || normalizedLines.some((line, index) => index !== dateIndex && index !== success - 1 && index !== merchantIndex
      && /[+\-−–—]?\d[\d,]*\.\d{1,2}(?!\d)/.test(line))) return undefined;
  return { merchant, amount, date };
}

/** One screenshot entry point, with source-aware adapters and explicit user review. */
function parseStructuredPaymentScreenshot(text: unknown, rules: MerchantRule[] = []): PaymentScreenshotResult {
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
  const walletBill = wechat ? undefined : domesticWalletBill(lines, normalizedLines) ?? columnWalletBill(lines, normalizedLines);
  // A generic "交易成功" can describe incoming money too; require a payment
  // outcome or an explicit outgoing type rather than treating every success as spending.
  const completed = normalizedLines.some(line => /^(?:支付成功|付款成功|支付完成|付款完成)$/.test(line));
  const outgoing = fields(normalizedLines, directionLabels).some(value => value !== null
    && ["支出", "消费支出", "消费", "商户消费", "付款", "支付"].includes(value));
  if (!completed && !outgoing && !walletBill) return fail("未识别到明确的付款成功或支出记录，请使用完整支付详情或手动录入。");
  const directions = fields(normalizedLines, directionLabels);
  if (directions.some(value => value !== null && !["支出", "消费支出", "消费", "付款", "支付", "商户消费"].includes(value))) {
    return fail("截图的交易方向或类型不明确，请手动核对录入。");
  }
  const merchants = walletBill ? [walletBill.merchant] : fields(lines, merchantLabels);
  const amounts = walletBill ? [walletBill.amount] : fields(normalizedLines, amountLabels);
  if (merchants.length !== 1 || !merchants[0] || amounts.length !== 1 || !amounts[0]
    || fields(normalizedLines, [...amountLabels, ...otherAmounts]).length !== (walletBill ? 0 : 1)) {
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
  if (amount.includes("+") || (!walletBill && !currencies.length && !/^(?:人民币|CNY|RMB|[¥￥])|元$|(?:CNY|RMB)$/i.test(amount))) {
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
  if (!merchantKey(merchant)) return fail("商户或交易性质不明确，请手动核对录入。");
  const dates = fields(normalizedLines, dateLabels), parsedDates = dates.map(value => value ? dateValue(value) : undefined);
  const date = walletBill?.date ?? (dates.length && parsedDates.every(Boolean) && new Set(parsedDates).size === 1 ? parsedDates[0] : undefined);
  return {
    candidates: [{ key: "payment-screenshot-0", kind: "expense", source, merchant, amountCents,
      ...(date ? { date } : {}), category: classification.category,
      ...(classification.subcategory ? { subcategory: classification.subcategory } : {}),
      ...(classification.platform ? { platform: classification.platform } : {}) }],
    warnings: [
      "仅按截图文字生成候选，请核对商户、金额、支付来源和交易类型。",
      ...(source === "manual" ? ["未确认支付平台，暂列为其他来源，请根据原画面选择支付来源。"] : []),
      ...(walletBill && !currencies.length ? ["截图未显示币种，按此国内钱包账单版式生成了人民币候选，请核对实际币种。"] : []),
      ...(!date ? ["未识别到完整明确的交易时间，请填写实际交易日期；不会使用截图时钟或当前时间。"] : []),
      duplicateWarning,
    ],
  };
}

/** Recover reliable fields even when OCR drops titles or changes column order. */
function negativePaymentScreenshot(text: unknown, rules: MerchantRule[]): PaymentScreenshotResult | null {
  if (typeof text !== "string" || !text.trim() || text.length > 16000 || controls.test(text)) return null;
  const lines = text.replace(/\r\n?|\u2028|\u2029/g, "\n").split("\n").map(line => line.trim()).filter(Boolean);
  const normalizedLines = lines.map(line => line.normalize("NFKC").replace(/[−–—﹣]/g, "-"));
  const normalized = normalizedLines.join("\n");
  const negative: { index: number; amountCents: number }[] = [];
  for (let index = 0; index < normalizedLines.length; index++) {
    let value = normalizedLines[index];
    const label = fieldLabel(value);
    if (label && amountLabels.includes(label)) value = value.slice(label.length).replace(/^[\s:：]+/, "");
    const match = /^(?:(?:人民币|CNY|RMB|[¥￥])\s*)?-\s*(?:(?:人民币|CNY|RMB|[¥￥])\s*)?(\d[\d,]*(?:\.\d{1,2})?)(?:\s*(?:元|CNY|RMB))?$/i.exec(value);
    // Bare integers can be IDs or other counters. A bare monetary value needs
    // decimals; explicit currency also permits a whole-yuan amount.
    if (!match || (!match[1].includes(".") && !/人民币|CNY|RMB|[¥￥元]/i.test(value))) continue;
    const amountCents = parseAmount(match[1]);
    if (amountCents !== null) negative.push({ index, amountCents });
  }
  if (!negative.length) return null;
  if (security.test(normalized) || foreign.test(normalized) || nonPurchase.test(normalized)) {
    return fail("截图涉及安全口令、外币、收款、退款、转账或未完成交易，请核对交易类型后手动录入。");
  }
  if (negative.length !== 1) return fail("识别到多个金额，请保留一笔付款详情后重试，或手动确定实际支出。");
  const selected = negative[0];
  const nonPaymentLabels = [...otherAmounts, "可用余额", "剩余余额", "余额变动", "余额变化", "账户欠款", "负债"];
  if (normalizedLines.some(line => nonPaymentLabels.some(label => line === label
    || (line.startsWith(label) && /^[\s:：+\-\d¥￥]/.test(line.slice(label.length)))))) {
    return fail("金额可能属于余额、优惠或其他账单字段，无法确定实际支出，请手动核对。");
  }
  const previousLabel = fieldLabel(normalizedLines[selected.index - 1] ?? "");
  if (previousLabel && ["商家订单号", "商户订单号", "交易单号", "交易号", "订单编号", "订单号", "商户编号", "商户号", "对方账户", "收款方账号", "收款方账户"].includes(previousLabel)) {
    return fail("负数紧邻其他字段，无法确认它是付款金额，请手动核对。");
  }
  // Count each currency/decimal token once, including inline extra amounts.
  // Dates are identified by their shape here and validated separately below.
  let monetaryTokens = 0;
  for (const line of normalizedLines) {
    const label = fieldLabel(line);
    const value = label && [...dateLabels, "创建时间", "到账时间"].includes(label)
      ? line.slice(label.length).replace(/^[\s:：]+/, "") : line;
    if (/^\d{4}[年/.\-]\d{1,2}[月/.\-]\d{1,2}(?:日\s*|[ T]+)\d{1,2}:\d{2}(?::\d{2})?$/.test(value)) continue;
    monetaryTokens += [...line.matchAll(/(?:人民币|\bCNY\b|\bRMB\b|[¥￥])\s*[+-]?\s*\d[\d,]*(?:\.\d+)?|[+-]?\s*\d[\d,]*(?:\.\d+)?\s*(?:元|\bCNY\b|\bRMB\b)|[+-]?\s*\d[\d,]*\.\d+/gi)].length;
  }
  if (monetaryTokens !== 1) return fail("截图包含多个金额或金额格式不明确，请手动确定实际支出。");

  const headings = normalizedLines.slice(0, 8).filter((_line, index) => index === 0
    || !knownLabels.some(label => normalizedLines[index - 1].replace(/[\s:：]+$/, "") === label));
  const alipay = headings.some(line => alipayHeading.test(line));
  const wechat = headings.some(line => wechatHeading.test(line));
  if (alipay && wechat) return fail("截图含多个支付平台，请分开截图或手动核对支付来源。");
  if (wechat && (fields(normalizedLines, ["付款方式", "支付方式"]).some(value => value && walletMethod.test(value))
    || normalizedLines.some(line => walletMethod.test(line)))) return fail("页面平台和付款方式存在冲突，请手动核对支付来源。");
  const source: PaymentScreenshotCandidate["source"] = alipay ? "alipay" : wechat ? "wechat" : "manual";
  const currencies = fields(normalizedLines, ["币种"]);
  if (currencies.some(value => !value || !/^(?:人民币|CNY|RMB)$/i.test(value))) return fail("截图币种不明确，请手动核对。");
  const explicitYuan = currencies.length > 0 || /人民币|CNY|RMB|[¥￥元]/i.test(normalizedLines[selected.index]);
  const directions = fields(normalizedLines, directionLabels);
  if (directions.some(value => value !== null && !["支出", "消费支出", "消费", "付款", "支付", "商户消费"].includes(value))) {
    return fail("截图的交易方向或类型不明确，请手动核对录入。");
  }
  const stateValues = [...normalizedLines, ...fields(normalizedLines, ["支付状态", "交易状态", "订单状态"]).filter((value): value is string => value !== null)];
  const completed = stateValues.some(value => /^(?:支付成功|付款成功|支付完成|付款完成)$/.test(value));
  const paymentContext = normalizedLines.some(line => [...dateLabels, "付款方式", "支付方式"].includes(fieldLabel(line) ?? ""));
  const outgoing = directions.some(value => value !== null && ["支出", "消费支出", "消费", "付款", "支付", "商户消费"].includes(value));
  const warnings = [
    ...(!explicitYuan ? ["截图未显示币种，暂按人民币金额展示，请核对实际币种。"] : []),
    ...(source === "manual" ? ["未确认支付平台，请根据原画面选择支付来源。"] : []),
  ];
  if (!completed && !(stateValues.includes("交易成功") && (paymentContext || outgoing))) {
    return { candidates: [], partial: { amountCents: selected.amountCents, source }, warnings,
      error: "仅识别到一个负数金额，尚不能确认它是已完成的消费支出，请先核对交易类型和状态。" };
  }

  let merchant = "";
  const explicitMerchants = fields(lines, merchantLabels);
  let summaryMerchant = "";
  if (stateValues.includes("交易成功")) {
    const index = selected.index, before = normalizedLines[index - 2] ?? "";
    const meituan = normalizedLines.slice(0, index).map(line => /^(?:\S{1,4}\s+)?美团点餐\s*[>›〉]?$/.test(line)).lastIndexOf(true);
    const summary = normalizedLines[index + 1] === "交易成功" && walletMerchant(lines[index - 1] ?? "");
    if (summary && (meituan === index - 3 || (meituan < 0 && /^(?:全部账单|账单详情(?:\s*全部账单)?)$/.test(before)))) summaryMerchant = lines[index - 1];
  }
  if (explicitMerchants.length === 1 && explicitMerchants[0] && walletMerchant(explicitMerchants[0])
    && (!summaryMerchant || explicitMerchants[0] === summaryMerchant)) merchant = explicitMerchants[0];
  else if (!explicitMerchants.length) merchant = summaryMerchant;
  if (merchant.length > 150 || /^(?:[¥￥]|人民币|CNY|RMB)?[+\-]?\d[\d,.]*(?:元)?$/i.test(merchant.normalize("NFKC"))) merchant = "";
  let classification = merchant ? classifyMerchant(merchant, rules) : undefined;
  if (classification && !merchantKey(merchant)) { merchant = ""; classification = undefined; }

  let date: string | undefined;
  const dateFields = fields(normalizedLines, dateLabels);
  const parsedDates = dateFields.map(value => value ? dateValue(value) : undefined);
  if (dateFields.length && parsedDates.every(Boolean) && new Set(parsedDates).size === 1) date = parsedDates[0];
  else if (dateFields.length === 1 && dateFields[0] === null
    && !normalizedLines.some(line => /^(?:创建时间|到账时间|入账时间|下单时间|订单时间|退款时间|结算时间)(?:[\s:：\d]|$)/.test(line))) {
    const dateLines = normalizedLines.filter(line => /^\d{4}[年/.\-]\d{1,2}[月/.\-]\d{1,2}(?:日\s*|[ T]+)\d{1,2}:\d{2}(?::\d{2})?$/.test(line));
    if (dateLines.length === 1) date = dateValue(dateLines[0]);
  }
  return {
    candidates: [{ key: "payment-screenshot-0", kind: "expense", source, merchant, amountCents: selected.amountCents,
      ...(date ? { date } : {}), category: classification?.category ?? "待分类",
      ...(classification?.subcategory ? { subcategory: classification.subcategory } : {}),
      ...(classification?.platform ? { platform: classification.platform } : {}) }],
    warnings: [...warnings, ...(!merchant ? ["未确认商户，请在核对表单中补充；不会使用商品名或界面按钮代替商户。"] : []),
      ...(!date ? ["未确认完整付款时间，请填写实际交易日期。"] : []), duplicateWarning],
  };
}

export function parsePaymentScreenshot(text: unknown, rules: MerchantRule[] = []): PaymentScreenshotResult {
  const structured = parseStructuredPaymentScreenshot(text, rules);
  const recovered = negativePaymentScreenshot(text, rules);
  // Ambiguous amounts or non-purchase evidence also invalidate an otherwise
  // complete structured result. Missing optional layout information does not.
  if (recovered?.error && !recovered.partial && !recovered.candidates.length) return recovered;
  if (structured.candidates.length) return structured;
  return recovered ?? structured;
}
