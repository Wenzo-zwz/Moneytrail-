import { CATEGORIES, copyTransaction, normalizeTransactionCategory, type Platform, type Transaction } from "./ledger";
import type { AppData } from "./storage";

export type MerchantRule = { merchant: string; category: string };
export type MerchantClassification = { category: string; subcategory?: string; platform?: Platform; reason: string; merchantKey: string; requiresReview: boolean };
export type CategoryChange = {
  id: string; merchant: string; fromCategory: string; toCategory: string; reason: string;
  before: Transaction; after: Transaction;
};

const fundWords = /转账|转出|转入|充值|提现|取现|取款|支取|还款|偿还|缴款|还贷|贷款|余额宝|零钱通|花呗|借呗|白条|网商贷|理财|基金|证券|买入|申购|赎回/;
const outcomeWords = /退款|退回|冲正|撤销|失败|未成功|取消/;
const channelPrefix = /^(?:(?:快捷支付[-\s]*)?(?:财付通|微信支付|微信|支付宝|美团支付|滴滴支付|银联商务|银联)|快捷支付)[-—－:：\s]*/;
const categoryRules: readonly [string, RegExp][] = [
  ["医疗", /药房|药店|医院|诊所|体检|买药/],
  ["居住", /酒店|宾馆|住宿|房租|水费|电费|燃气|物业|宽带|话费|流量|手机充值/],
  ["交通", /滴滴|嘀嘀无限|出租车|打车|网约车|公交|地铁|火车票|铁路|12306|加油|油站|停车|通行费|etc/i],
  ["学习", /课程|培训|教材|书店|学费|考试/],
  ["本地生活", /电影|影院|ktv|游戏|影音会员|视频会员|音乐会员|景区|门票|游乐园|台球|桌球|按摩|足浴|足疗|推拿|(^|[^a-z])spa([^a-z]|$)|剧本杀|密室|桌游|棋牌/i],
  ["本地生活", /外卖|餐厅|饭店|餐饮|咖啡|奶茶|早餐|烧烤|火锅|面馆|快餐|食堂/],
  ["购物", /烟酒|副食|超市|便利店|服饰|服装|数码|日用品/],
];

const detailRules: Record<string, readonly [string, RegExp][]> = {
  医疗: [["药品", /药房|药店|买药/], ["医疗服务", /医院|诊所|体检/]],
  居住: [["住宿", /酒店|宾馆|住宿/], ["房租", /房租/], ["生活缴费", /水费|电费|燃气|物业|宽带|话费|流量|手机充值/]],
  交通: [["打车", /滴滴|嘀嘀无限|出租车|打车|网约车/], ["公共交通", /公交|地铁|火车票|铁路|12306/], ["加油", /加油|油站/], ["停车通行", /停车|通行费|etc/i]],
  学习: [["教材", /教材|书店/], ["课程培训", /课程|培训|学费|考试/]],
  本地生活: [["按摩足疗", /按摩|足浴|足疗|推拿|(^|[^a-z])spa([^a-z]|$)/i], ["剧本杀密室", /剧本杀|密室/], ["桌游台球", /桌游|棋牌|台球|桌球/], ["电影影音", /电影|影院|ktv|游戏|影音会员|视频会员|音乐会员/i], ["景区游玩", /景区|门票|游乐园/], ["外卖", /外卖/], ["咖啡奶茶", /咖啡|奶茶/], ["餐饮", /餐厅|饭店|餐饮|早餐|烧烤|火锅|面馆|快餐|食堂/]],
  购物: [["烟酒副食", /烟酒|副食/], ["超市便利", /超市|便利店/], ["服饰", /服饰|服装/], ["数码", /数码/], ["日用品", /日用品/]],
};

export function detectPlatform(merchant: string): Platform | undefined {
  const text = merchant.normalize("NFKC");
  if (/美团/.test(text) || isPlatformOnlyMerchant(text)) return "美团";
  if (/京东/.test(text)) return "京东";
  if (/淘宝/.test(text)) return "淘宝";
  if (/天猫/.test(text)) return "天猫";
  if (/拼多多/.test(text)) return "拼多多";
  if (/滴滴|嘀嘀无限/.test(text)) return "滴滴";
  return undefined;
}

function normalizeMerchant(merchant: string, preservePlatform = false): string {
  let result = merchant.normalize("NFKC").trim().toLowerCase();
  let previous: string;
  do {
    previous = result;
    result = result.replace(/^(?:消费|支付(?!宝)|付款)[-—－:：\s]*/, "").trim();
    if (preservePlatform && result === "美团支付") break;
    result = result.replace(channelPrefix, "").trim();
  } while (result !== previous);
  return result;
}

function needsReview(merchant: string): boolean {
  // Phone service is a purchase; moving money to a wallet is a different event.
  const withoutPhone = merchant.replace(/(?:手机|话费|流量)充值/g, "");
  return /群收款/.test(merchant) || fundWords.test(withoutPhone) || outcomeWords.test(merchant);
}

/** Exact identity only: never remember a generic channel, group or transfer as a merchant. */
export function merchantKey(merchant: string): string {
  const normalized = normalizeMerchant(merchant);
  return !normalized || normalized.length > 200 || /[\u0000-\u001f\u007f]/.test(normalized) || needsReview(normalized) ? "" : normalized;
}

/** Shared platform identities do not identify an individual store or purchase purpose. */
export function isPlatformOnlyMerchant(merchant: string): boolean {
  if (merchant.length > 200 || /[\u0000-\u001f\u007f]/.test(merchant) || needsReview(merchant)) return false;
  const normalized = normalizeMerchant(merchant, true);
  return /^(?:美团|美团平台|美团平台商户|美团网|美团支付|美团北京三快在线科技有限公司|美团北京三快在线科技有限公|北京三快在线科技有限公司|北京三快科技有限公司)$/.test(normalized);
}

export function classifyMerchant(merchant: string, rules: MerchantRule[] = []): MerchantClassification {
  const key = merchantKey(merchant);
  const platform = detectPlatform(merchant);
  const metadata = platform ? { platform } : {};
  if (isPlatformOnlyMerchant(merchant)) return { category: "本地生活", reason: "美团平台默认本地生活", merchantKey: key, requiresReview: false, ...metadata };
  if (!key) return { category: "待分类", reason: "用途不明，请核对", merchantKey: "", requiresReview: true, ...metadata };
  const personal = rules.find(rule => merchantKey(rule.merchant) === key
    && rule.category !== "待分类" && [...CATEGORIES, "餐饮", "娱乐"].includes(rule.category));
  if (personal) {
    const normalized = normalizeTransactionCategory({ category: personal.category });
    const keywordCategory = categoryRules.find(([, pattern]) => pattern.test(key))?.[0];
    const subcategory = "subcategory" in normalized ? normalized.subcategory as string : keywordCategory === normalized.category ? detailRules[normalized.category]?.find(([, pattern]) => pattern.test(key))?.[0] : undefined;
    return { category: normalized.category, ...(subcategory ? { subcategory } : {}), reason: "个人商户规则", merchantKey: key, requiresReview: false, ...metadata };
  }
  for (const [category, pattern] of categoryRules) {
    if (pattern.test(key)) {
      const subcategory = detailRules[category]?.find(([, detailPattern]) => detailPattern.test(key))?.[0];
      return { category, ...(subcategory ? { subcategory } : {}), reason: `商户关键词：${category}`, merchantKey: key, requiresReview: false, ...metadata };
    }
  }
  if (/京东|淘宝|天猫|拼多多/.test(key)) return { category: "购物", reason: "电商平台默认购物", merchantKey: key, requiresReview: false, ...metadata };
  return { category: "待分类", reason: "未匹配分类，可保存具体商户规则", merchantKey: key, requiresReview: false, ...metadata };
}

/** A preview is a value, not a write. Keep the full records for later stale checks. */
export function planCategoryChanges(data: AppData, rules: MerchantRule[] = []): CategoryChange[] {
  return data.transactions.flatMap(transaction => {
    if (transaction.kind !== "expense" || transaction.category !== "待分类") return [];
    const match = classifyMerchant(transaction.merchant, rules);
    if (match.requiresReview || match.category === "待分类") return [];
    return [{ id: transaction.id, merchant: transaction.merchant, fromCategory: transaction.category,
      toCategory: match.category, reason: match.reason, before: copyTransaction(transaction), after: copyTransaction({ ...transaction, category: match.category, ...(match.subcategory ? { subcategory: match.subcategory } : {}), ...(match.platform ? { platform: match.platform } : {}) }) }];
  });
}

function sameTransaction(left: Transaction, right: Transaction): boolean {
  const fields = new Set([...Object.keys(left), ...Object.keys(right)] as (keyof Transaction)[]);
  return [...fields].every(field => {
    if (field !== "smsEvidence") return left[field] === right[field];
    const a = left.smsEvidence, b = right.smsEvidence;
    if (!a || !b) return a === b;
    return a.text === b.text && a.receivedAt === b.receivedAt && a.classificationReason === b.classificationReason && a.ruleVersion === b.ruleVersion;
  });
}

/** Update categories in place; never let a stale preview or undo overwrite a later edit. */
export function applyCategoryChanges(data: AppData, changes: CategoryChange[], undo = false): AppData {
  const byId = new Map<string, CategoryChange>();
  const current = new Map(data.transactions.map(transaction => [transaction.id, transaction]));
  for (const change of changes) {
    const transaction = current.get(change.id);
    if (byId.has(change.id) || !transaction || !sameTransaction(transaction, undo ? change.after : change.before)) {
      throw new Error("账目已改变，请重新预览；本次操作没有覆盖最新记录。");
    }
    byId.set(change.id, change);
  }
  const affectedMonths = new Set(changes.map(change => change.before.date.slice(0, 7)));
  return {
    ...data,
    transactions: data.transactions.map(transaction => {
      const change = byId.get(transaction.id);
      return change ? copyTransaction(undo ? change.before : change.after) : transaction;
    }),
    billCheckedMonths: data.billCheckedMonths.filter(month => !affectedMonths.has(month)),
  };
}
