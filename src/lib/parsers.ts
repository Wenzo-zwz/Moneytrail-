import {
  CATEGORIES,
  isValidLocalDateTime,
  parseAmount,
  type DraftTransaction,
  type Source,
  type TransactionKind,
} from "./ledger";

export interface SmsParseResult {
  draft: DraftTransaction | null;
  warnings: string[];
  error?: string;
}

export interface CsvParseResult {
  drafts: DraftTransaction[];
  warnings: string[];
  skipped: number;
  errors: string[];
}

const pad = (value: number) => String(value).padStart(2, "0");
const localTime = (date: Date) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;

const foreignCurrency =
  /美元|美金|港币|港元|欧元|日元|英镑|澳元|加元|新加坡元|\b(?:USD|HKD|EUR|JPY|GBP|AUD|CAD|SGD|CHF)\b|[$€£]/i;
const actionPattern =
  /消费|支出|支付(?!宝)|付款|扣款|扣费|代扣|购货|支取|退款|退回|退货|冲正|撤销|入账|到账|收入|收款|充值|还款|转账|转出|转入|提现|取现|取款|存入|交易金额|发生额/g;
const excludedAmountPattern =
  /余额|剩余|可用|额度|积分|手续费|利息|限额|年费减免|应还款|最低还款|可退金额|可退款|账单金额/g;

function detectKind(text: string): TransactionKind | null {
  const actions = text
    .replace(/(?:到期)?还款日(?:期)?[为是:：\s\d年月日/-]*/g, "")
    .replace(/可退款|退款政策/g, "");
  if (/退款|退货|退回|冲正|撤销/.test(actions)) return "refund";
  if (/还款|偿还|转账|转出|转入|充值|提现|取现|取款/.test(actions))
    return "transfer";
  if (/消费|支出|支付(?!宝)|付款|扣款|扣费|代扣|购货|支取/.test(actions))
    return "expense";
  if (/入账|到账|收入|收款|存入|工资/.test(actions)) return "income";
  return null;
}

function lastMatchIndex(pattern: RegExp, text: string): number {
  pattern.lastIndex = 0;
  let latest = -1;
  for (const match of text.matchAll(pattern))
    latest = (match.index ?? 0) + match[0].length;
  return latest;
}

function extractAmount(text: string): number | null {
  const money =
    /(?<![\d.,+−-])(?:人民币\s*|RMB\s*|CNY\s*|[¥￥]\s*)([+−-]?\d+(?:[,.]\d+)*)|(?<![\d.,+−-])([+−-]?\d+(?:[,.]\d+)*)\s*元/gi;
  const candidates: { cents: number; score: number }[] = [];
  for (const match of text.matchAll(money)) {
    const context = text.slice(
      Math.max(0, (match.index ?? 0) - 50),
      match.index,
    );
    const actionIndex = lastMatchIndex(actionPattern, context);
    const excludedIndex = lastMatchIndex(excludedAmountPattern, context);
    if (excludedIndex >= 0 && excludedIndex >= actionIndex) continue;
    const cents = parseAmount(match[1] ?? match[2]);
    if (cents !== null)
      candidates.push({
        cents,
        score: actionIndex >= 0 ? context.length - actionIndex : 100,
      });
  }
  if (!candidates.length) {
    // Some banks omit the currency unit; require an immediately adjacent action.
    if (/应还款|最低还款|账单金额/.test(text)) return null;
    const match = text.match(
      /(?:消费|支出|扣款|扣费|退款|入账|到账|还款|充值|转出|转入)\s*(?:金额(?:为|是)?\s*)?[：:]?\s*([+−-]?\d+(?:[,.]\d+)*)(?![\d.,])/,
    );
    return match ? parseAmount(match[1]) : null;
  }
  candidates.sort((a, b) => a.score - b.score);
  // Multiple plausible amounts cannot be safely resolved automatically.
  const best = candidates[0];
  if (candidates.some((candidate) => candidate.cents !== best.cents))
    return null;
  return best.cents;
}

interface ParsedDate {
  date: string | null;
  missingTime: boolean;
}

function makeDate(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
): string | null {
  const result = `${String(year).padStart(4, "0")}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}`;
  return isValidLocalDateTime(result) ? result : null;
}

function parseDate(value: string): ParsedDate {
  const text = value.trim().replace(/^'/, "");
  const match = text.match(
    /^(\d{4})[年/.-](\d{1,2})[月/.-](\d{1,2})(?:日)?(?:[T\s]+(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/,
  );
  if (!match || (match[6] && Number(match[6]) > 59))
    return { date: null, missingTime: false };
  return {
    date: makeDate(
      Number(match[1]),
      Number(match[2]),
      Number(match[3]),
      Number(match[4] ?? 0),
      Number(match[5] ?? 0),
    ),
    missingTime: !match[4],
  };
}

function smsDate(
  text: string,
  referenceDate: Date,
  warnings: string[],
): string | null {
  const full = text.match(
    /(?<!\d)(\d{4})[年/.-](\d{1,2})[月/.-](\d{1,2})日?(?:[T\s]*(\d{1,2}):(\d{2})(?::\d{2})?)?/,
  );
  const short = text.match(
    /(?<!\d)(\d{1,2})月(\d{1,2})日(?:\s*(\d{1,2}):(\d{2})(?::\d{2})?)?|(?<!\d)(\d{1,2})[/-](\d{1,2})\s+(\d{1,2}):(\d{2})(?::\d{2})?/,
  );
  if (full) {
    if (!full[4])
      warnings.push("短信缺少交易时刻，暂按当日 00:00 记录，请核对。");
    return makeDate(
      Number(full[1]),
      Number(full[2]),
      Number(full[3]),
      Number(full[4] ?? 0),
      Number(full[5] ?? 0),
    );
  }
  if (short) {
    const month = Number(short[1] ?? short[5]);
    const day = Number(short[2] ?? short[6]);
    const hour = Number(short[3] ?? short[7] ?? 0);
    const minute = Number(short[4] ?? short[8] ?? 0);
    let year = referenceDate.getFullYear();
    let result = makeDate(year, month, day, hour, minute);
    if (!result) return null;
    const candidate = new Date(year, month - 1, day, hour, minute);
    if (candidate.getTime() > referenceDate.getTime() + 2 * 86400000)
      result = makeDate(--year, month, day, hour, minute);
    warnings.push("短信没有年份，已按接近当前日期的年份推定，请核对。");
    if (!short[3] && !short[7])
      warnings.push("短信缺少交易时刻，暂按当日 00:00 记录，请核对。");
    return result;
  }
  warnings.push("未识别到交易日期，暂用当前时间，请核对。");
  return localTime(referenceDate);
}

function extractMerchant(text: string): string | null {
  const labelled = text.match(
    /(?:商户(?:名称)?|交易对方)\s*[：:]\s*([^，,。;；\n]{1,200})/,
  );
  if (labelled) return labelled[1].trim();
  const atMerchant = text.match(
    /在\s*([^，,。;；\n]{1,80}?)(?:消费|支付|付款|扣款|购货)/,
  );
  if (atMerchant && !/^\d{1,4}[年/月.-]/.test(atMerchant[1]))
    return atMerchant[1].trim();
  const bracketed = text.match(
    /(?:消费|支付|付款|扣款)[（(]([^）)\n]{1,80})[）)]/,
  );
  return bracketed?.[1].trim() ?? null;
}

/** Parse a single bank message into an editable draft. No data is saved here. */
export function parseSms(
  rawText: string,
  referenceDate = new Date(),
): SmsParseResult {
  const text = rawText.normalize("NFKC").trim();
  const warnings: string[] = [];
  if (!text)
    return { draft: null, warnings, error: "请先粘贴一条银行消费短信。" };
  if (text.length > 2000)
    return {
      draft: null,
      warnings,
      error: "请每次解析一条短信，内容不超过 2000 字。",
    };
  if (!Number.isFinite(referenceDate.getTime()))
    return { draft: null, warnings, error: "参考日期无效，请手动录入日期。" };
  if (/验证码|动态口令|一次性密码/.test(text))
    return { draft: null, warnings, error: "验证码短信不属于账目，请勿导入。" };
  if (foreignCurrency.test(text))
    return {
      draft: null,
      warnings,
      error: "暂仅支持人民币账目，外币交易请换算后手动录入。",
    };
  if (/(?:人民币|RMB|CNY|[¥￥])?\s*[-−]\s*\d+(?:\.\d+)?\s*元/i.test(text))
    return {
      draft: null,
      warnings,
      error: "短信含有负数金额，请手动确认交易类型和金额。",
    };
  const kind = detectKind(text);
  if (!kind)
    return {
      draft: null,
      warnings,
      error: "没有识别到消费、退款、收入或转账信息，请手动录入。",
    };
  const amountCents = extractAmount(text);
  if (amountCents === null)
    return {
      draft: null,
      warnings,
      error:
        "未能确定唯一的交易金额，请核对短信或手动录入；余额不会作为消费金额。",
    };
  const date = smsDate(text, referenceDate, warnings);
  if (!date)
    return {
      draft: null,
      warnings,
      error: "短信中的交易日期无效，请手动核对日期。",
    };
  const merchant = extractMerchant(text) ?? "待补充商户";
  if (merchant === "待补充商户")
    warnings.push("短信未提供具体商户，请补充商户并选择分类。");
  else if (
    /^(?:财付通|微信(?:支付)?|支付宝|银联(?:商务)?|快捷支付)$/.test(merchant)
  )
    warnings.push("短信仅提供支付渠道，具体商户和分类仍需补充。");
  if (kind === "transfer")
    warnings.push(
      "已识别为转账、充值、提现或还款，不计入消费；请确认实际用途。",
    );
  if (kind === "refund")
    warnings.push("退款按到账月份抵减支出，可在确认时关联原消费。");
  return {
    draft: {
      kind,
      amountCents,
      date,
      merchant,
      category: "待分类",
      source: "sms",
      note: "",
    },
    warnings,
  };
}

function splitCsv(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (quoted) quoted = false;
      else if (!field.trim()) {
        field = "";
        quoted = true;
      } else field += char;
    } else if (!quoted && char === delimiter) {
      row.push(field.trim());
      field = "";
    } else if (!quoted && (char === "\n" || char === "\r")) {
      if (char === "\r" && text[i + 1] === "\n") i++;
      row.push(field.trim());
      rows.push(row);
      row = [];
      field = "";
    } else field += char;
  }
  if (quoted) throw new Error("CSV 含有未闭合的引号，请检查文件格式。");
  if (field || row.length) {
    row.push(field.trim());
    rows.push(row);
  }
  return rows;
}

const normalHeader = (value: string) =>
  value.toLowerCase().replace(/[\s\uFEFF()（）/\-_：:]/g, "");
const dateHeaders = [
  "日期",
  "交易时间",
  "交易日期",
  "交易创建时间",
  "付款时间",
  "记账时间",
  "入账时间",
  "date",
];
const amountHeaders = [
  "金额",
  "金额元",
  "交易金额",
  "交易金额元",
  "消费金额",
  "amount",
];

function indexOfHeader(headers: string[], choices: string[]): number {
  return headers.findIndex((header) => choices.includes(header));
}

function billKind(
  explicit: string,
  flow: string,
  status: string,
): TransactionKind | null {
  const direct: Record<string, TransactionKind> = {
    expense: "expense",
    refund: "refund",
    transfer: "transfer",
    income: "income",
    支出: "expense",
    消费: "expense",
    退款: "refund",
    退货: "refund",
    收入: "income",
    转账: "transfer",
    充值: "transfer",
    还款: "transfer",
    提现: "transfer",
    转出: "transfer",
    转入: "transfer",
  };
  if (
    /退款|退货|退回|冲正/.test(explicit) ||
    (/退款成功/.test(status) && /收入|退款/.test(flow))
  )
    return "refund";
  if (/还款|转账|转出|转入|充值|提现|取现|取款/.test(explicit))
    return "transfer";
  if (direct[explicit]) return direct[explicit];
  if (/^(?:收入|收款)$/.test(flow)) return "income";
  if (/^(?:支出|付款)$/.test(flow)) return "expense";
  if (/不计收支|不计收\/支|中性/.test(flow)) return "transfer";
  return detectKind(explicit);
}

function parseSource(raw: string, detected: Source): Source {
  const map: Record<string, Source> = {
    manual: "manual",
    sms: "sms",
    wechat: "wechat",
    alipay: "alipay",
    csv: "csv",
    手动: "manual",
    手动录入: "manual",
    短信: "sms",
    银行短信: "sms",
    微信: "wechat",
    微信账单: "wechat",
    支付宝: "alipay",
    支付宝账单: "alipay",
    CSV: "csv",
    账单导入: "csv",
  };
  return map[raw] ?? detected;
}

/** Supports canonical, WeChat and Alipay RMB CSV exports. Returns drafts for review. */
export function parseCsv(rawText: string): CsvParseResult {
  const result: CsvParseResult = {
    drafts: [],
    warnings: [],
    skipped: 0,
    errors: [],
  };
  const text = rawText.replace(/^\uFEFF/, "");
  if (!text.trim()) {
    result.errors.push("文件为空，请选择包含交易明细的 CSV 文件。");
    return result;
  }
  let rows: string[][];
  try {
    // A valid header must include both date and amount; this also identifies the delimiter.
    rows = [];
    let quoteError: Error | null = null;
    for (const delimiter of [",", "\t", ";"]) {
      try {
        const items = splitCsv(text, delimiter);
        if (
          items.some((row) => {
            const normalized = row.map(normalHeader);
            return (
              indexOfHeader(normalized, dateHeaders) >= 0 &&
              indexOfHeader(normalized, amountHeaders) >= 0
            );
          })
        ) {
          rows = items;
          break;
        }
      } catch (error) {
        quoteError = error as Error;
      }
    }
    if (!rows.length && quoteError) throw quoteError;
  } catch (error) {
    result.errors.push((error as Error).message);
    return result;
  }
  if (!rows.length) {
    result.errors.push(
      "未识别到日期和金额列。支持微信、支付宝 CSV 明细，或下载页面中的标准模板。",
    );
    return result;
  }
  if (rows.length > 30000) {
    result.errors.push("文件超过 30,000 行，请按月拆分后导入。");
    return result;
  }
  const headerRow = rows.findIndex((row) => {
    const normalized = row.map(normalHeader);
    return (
      indexOfHeader(normalized, dateHeaders) >= 0 &&
      indexOfHeader(normalized, amountHeaders) >= 0
    );
  });
  const headers = rows[headerRow].map(normalHeader);
  const col = (choices: string[]) => indexOfHeader(headers, choices);
  const columns = {
    date: col(dateHeaders),
    amount: col(amountHeaders),
    kind: col(["类型", "交易类型", "type", "kind"]),
    flow: col(["收支", "资金流向"]),
    merchant: col(["商户", "交易对方", "商户名称", "对方名称", "merchant"]),
    title: col(["商品", "商品说明", "商品名称"]),
    category: col(["分类", "交易分类", "消费分类", "category"]),
    note: col(["备注", "说明", "note"]),
    id: col(["交易编号", "交易单号", "交易号", "交易订单号", "transactionid"]),
    status: col(["当前状态", "交易状态", "状态"]),
    source: col(["来源", "source"]),
    refund: col(["成功退款元", "成功退款", "退款金额", "退款金额元"]),
    currency: col(["币种", "货币", "currency"]),
  };
  const intro = rows.slice(0, headerRow).flat().join(" ");
  const detected: Source =
    /微信/.test(intro) || headers.includes("当前状态")
      ? "wechat"
      : /支付宝/.test(intro) ||
          headers.includes("交易订单号") ||
          headers.includes("交易创建时间")
        ? "alipay"
        : "csv";
  const warnings = new Set<string>();
  for (let index = headerRow + 1; index < rows.length; index++) {
    const row = rows[index];
    if (row.every((value) => !value.trim())) continue;
    if (
      /^[-—=]{3,}/.test(row[0] ?? "") ||
      /^(?:共\s*\d|总计|合计|收入[:：]|支出[:：]|说明[:：]|温馨提示|导出时间)/.test(
        row[0] ?? "",
      )
    ) {
      result.skipped++;
      continue;
    }
    const value = (column: number) =>
      column >= 0 ? (row[column] ?? "").trim() : "";
    const fail = (message: string) => {
      result.errors.push(`第 ${index + 1} 行：${message}`);
      result.skipped++;
    };
    const status = value(columns.status);
    if (
      /失败|关闭|未支付|待支付|等待付款|待付款|处理中|进行中|已取消|已撤销|交易取消/.test(
        status,
      )
    ) {
      result.skipped++;
      continue;
    }
    const amountText = value(columns.amount);
    const currency = value(columns.currency);
    if (
      foreignCurrency.test(amountText) ||
      (currency && !/^(?:人民币|元|CNY|RMB)$/i.test(currency))
    ) {
      fail("暂仅支持人民币，外币交易请换算后手动录入。");
      continue;
    }
    const amountCents = parseAmount(amountText);
    if (amountCents === null) {
      fail("金额无效，必须是大于零且最多两位小数的人民币金额。");
      continue;
    }
    const parsedDate = parseDate(value(columns.date));
    if (!parsedDate.date) {
      fail("交易日期无效，应为 YYYY-MM-DD HH:mm。");
      continue;
    }
    const explicitKind = value(columns.kind);
    const flow = value(columns.flow);
    const kind = billKind(explicitKind, flow, status);
    if (!kind) {
      fail("无法确定收支类型，请使用支出、退款、转账或收入。");
      continue;
    }
    const refundAmount = value(columns.refund)
      ? parseAmount(value(columns.refund))
      : null;
    if (
      (kind === "expense" && /退款|退货/.test(status)) ||
      (kind === "expense" && refundAmount !== null)
    ) {
      fail("订单包含退款，请分别核对原消费和退款到账金额、日期后手动录入。");
      continue;
    }
    if (parsedDate.missingTime)
      warnings.add("部分记录仅有日期，已按当日 00:00 记录，请核对。");
    let merchant =
      value(columns.merchant) || value(columns.title) || "待补充商户";
    if (merchant === "待补充商户")
      warnings.add("部分记录缺少商户，已标为“待补充商户”。");
    if (merchant.length > 200) {
      fail("商户名称超过 200 字。");
      continue;
    }
    const originalCategory = value(columns.category);
    const category = (CATEGORIES as readonly string[]).includes(
      originalCategory,
    )
      ? originalCategory
      : "待分类";
    if (
      originalCategory &&
      category === "待分类" &&
      originalCategory !== "待分类"
    )
      warnings.add("未匹配的账单分类已放入“待分类”，请在预览中调整。");
    const title = value(columns.title);
    const noteParts = [
      value(columns.note),
      title && title !== merchant ? `商品：${title}` : "",
    ].filter(Boolean);
    const note = noteParts.join("；");
    if (note.length > 2000) {
      fail("备注超过 2000 字。");
      continue;
    }
    const rawId = value(columns.id).replace(/^'/, "");
    const sourceRef =
      rawId && rawId !== "/" && rawId !== "-" ? rawId : undefined;
    if (sourceRef && sourceRef.length > 200) {
      fail("交易编号超过 200 字。");
      continue;
    }
    result.drafts.push({
      kind,
      amountCents,
      date: parsedDate.date,
      merchant,
      category,
      source: parseSource(value(columns.source), detected),
      note,
      ...(sourceRef ? { sourceRef } : {}),
    });
  }
  result.warnings = [...warnings];
  if (!result.drafts.length && !result.errors.length)
    result.warnings.push(
      "没有可导入的成功交易，请检查是否只包含失败、关闭或汇总记录。",
    );
  return result;
}
