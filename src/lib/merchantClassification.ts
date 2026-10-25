import { CATEGORIES, type Transaction } from "./ledger";
import type { AppData } from "./storage";

export type MerchantRule = { merchant: string; category: string };
export type MerchantClassification = { category: string; reason: string; merchantKey: string; requiresReview: boolean };
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
  ["娱乐", /电影|影院|ktv|游戏|影音会员|视频会员|音乐会员|景区|门票|游乐园|台球|桌球/i],
  ["餐饮", /外卖|餐厅|饭店|餐饮|咖啡|奶茶|早餐|烧烤|火锅|面馆|快餐|食堂/],
  ["购物", /烟酒|副食|超市|便利店|服饰|服装|数码|日用品/],
];

function normalizeMerchant(merchant: string): string {
  let result = merchant.normalize("NFKC").trim().toLowerCase();
  let previous: string;
  do {
    previous = result;
    result = result.replace(/^(?:消费|支付(?!宝)|付款)[-—－:：\s]*/, "").replace(channelPrefix, "").trim();
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

export function classifyMerchant(merchant: string, rules: MerchantRule[] = []): MerchantClassification {
  const key = merchantKey(merchant);
  if (!key) return { category: "待分类", reason: "用途不明，请核对", merchantKey: "", requiresReview: true };
  const personal = rules.find(rule => merchantKey(rule.merchant) === key
    && rule.category !== "待分类" && CATEGORIES.includes(rule.category as typeof CATEGORIES[number]));
  if (personal) return { category: personal.category, reason: "个人商户规则", merchantKey: key, requiresReview: false };
  for (const [category, pattern] of categoryRules) {
    if (pattern.test(key)) return { category, reason: `商户关键词：${category}`, merchantKey: key, requiresReview: false };
  }
  if (/美团/.test(key)) return { category: "餐饮", reason: "美团默认餐饮", merchantKey: key, requiresReview: false };
  if (/京东|淘宝|天猫|拼多多/.test(key)) return { category: "购物", reason: "电商平台默认购物", merchantKey: key, requiresReview: false };
  return { category: "待分类", reason: "未匹配分类，可保存具体商户规则", merchantKey: key, requiresReview: false };
}

/** A preview is a value, not a write. Keep the full records for later stale checks. */
export function planCategoryChanges(data: AppData, rules: MerchantRule[] = []): CategoryChange[] {
  return data.transactions.flatMap(transaction => {
    if (transaction.kind !== "expense" || transaction.category !== "待分类") return [];
    const match = classifyMerchant(transaction.merchant, rules);
    if (match.requiresReview || match.category === "待分类") return [];
    return [{ id: transaction.id, merchant: transaction.merchant, fromCategory: transaction.category,
      toCategory: match.category, reason: match.reason, before: { ...transaction }, after: { ...transaction, category: match.category } }];
  });
}

function sameTransaction(left: Transaction, right: Transaction): boolean {
  const fields = new Set([...Object.keys(left), ...Object.keys(right)] as (keyof Transaction)[]);
  return [...fields].every(field => left[field] === right[field]);
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
      return change ? { ...(undo ? change.before : change.after) } : transaction;
    }),
    billCheckedMonths: data.billCheckedMonths.filter(month => !affectedMonths.has(month)),
  };
}
