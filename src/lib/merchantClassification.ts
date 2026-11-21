import { isStoredExpenseCategory } from "./expenseCategories";
import { copyTransaction, normalizeTransactionCategory, type Platform, type Transaction } from "./ledger";
import type { AppData } from "./storage";

export type MerchantRule = { merchant: string; category: string; subcategory?: string };
export type MerchantRuleIntent = MerchantRule & { transactionId: string };
export type MerchantClassification = { category: string; subcategory?: string; platform?: Platform; reason: string; merchantKey: string; requiresReview: boolean };
export type CategoryChange = {
  id: string; merchant: string; fromCategory: string; toCategory: string; reason: string;
  before: Transaction; after: Transaction;
};

const fundWords = /转账|转出|转入|充值|提现|取现|取款|支取|还款|偿还|缴款|还贷|贷款|余额宝|零钱通|花呗|借呗|白条|网商贷|理财|基金|证券|买入|申购|赎回/;
const outcomeWords = /退款|退回|冲正|撤销|失败|未成功|取消/;
const channelPrefix = /^(?:(?:快捷支付[-\s]*)?(?:财付通|微信支付|微信|支付宝|美团支付|滴滴支付|抖音支付|银联商务|银联)|快捷支付)[-—－:：\s]*/;
const purposeRules: readonly [string, string, RegExp][] = [
  ["其他", "宠物", /宠物|猫粮|狗粮|猫砂|兽医/],
  ["其他", "保险保费", /保费|人寿保险|商业保险|医疗保险|车险/],
  ["人情往来", "礼金红包", /份子钱|礼金|结婚红包|婚礼红包/],
  ["人情往来", "家庭支持", /孝敬父母|赡养费/],
  ["人情往来", "送礼", /生日礼物|送礼/],
  ["通讯", "家庭宽带", /宽带/],
  ["通讯", "手机话费与流量", /话费|流量|手机充值/],
  ["医疗保健", "药品", /药房|药店|买药/],
  ["医疗保健", "体检", /体检/],
  ["医疗保健", "保健品", /保健品/],
  ["医疗保健", "医疗服务", /医院|诊所|挂号|看病/],
  ["居住与家用", "住宿", /酒店|宾馆|住宿/],
  ["居住与家用", "房租", /房租/],
  ["居住与家用", "水电燃气", /水费|电费|燃气/],
  ["居住与家用", "物业", /物业/],
  ["居住与家用", "家居维修", /家居维修/],
  ["居住与家用", "日用品", /日用品|纸巾|清洁用品/],
  ["交通出行", "打车", /滴滴|嘀嘀无限|出租车|打车|网约车/],
  ["交通出行", "机票火车", /机票|火车票|铁路|12306/],
  ["交通出行", "公共交通", /公交|地铁/],
  ["交通出行", "加油充电", /加油|油站|充电桩|充电站/],
  ["交通出行", "停车通行", /停车|通行费|etc/i],
  ["交通出行", "车辆保养维修", /汽修|车辆维修|车辆保养|汽车维修|汽车保养/],
  ["学习培训", "教材", /教材|书店|书籍/],
  ["学习培训", "考试报名", /考试/],
  ["学习培训", "课程培训", /课程|培训|学费/],
  ["休闲娱乐", "按摩足疗", /按摩|足浴|足疗|推拿|(^|[^a-z])spa([^a-z]|$)/i],
  ["休闲娱乐", "剧本杀密室", /剧本杀|密室/],
  ["休闲娱乐", "桌游台球", /桌游|棋牌|台球|桌球/],
  ["休闲娱乐", "影音会员", /影音会员|视频会员|音乐会员/],
  ["休闲娱乐", "电影演出", /电影|影院|ktv|演出/i],
  ["休闲娱乐", "游戏", /游戏/],
  ["休闲娱乐", "健身", /健身/],
  ["休闲娱乐", "旅行团", /旅行团|跟团游/],
  ["休闲娱乐", "景区游玩", /景区|游乐园/],
  ["食品酒水", "买菜食材", /买菜|农贸市场|菜市场|生鲜食材/],
  ["食品酒水", "外卖", /外卖/],
  ["食品酒水", "咖啡奶茶", /咖啡|奶茶/],
  ["食品酒水", "堂食聚餐", /餐厅|饭店|餐饮|早餐|烧烤|火锅|面馆|快餐|食堂|聚餐/],
  ["食品酒水", "零食饮料", /零食|饮料/],
  ["食品酒水", "酒水", /酒水/],
  ["食品酒水", "烟酒副食", /烟酒|副食/],
  ["衣着与美妆", "衣物", /服饰|服装|衣物/],
  ["衣着与美妆", "鞋包", /鞋店|鞋包/],
  ["衣着与美妆", "配饰", /配饰/],
  ["衣着与美妆", "护肤美妆", /护肤|美妆|化妆品/],
  ["其他", "快递费", /快递费|寄件费/],
  ["其他", "数码", /数码/],
];

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

/** A shared platform or a placeholder cannot identify a concrete merchant to remember. */
export function canRememberMerchant(merchant: string): boolean {
  const key = merchantKey(merchant);
  return Boolean(key) && !isPlatformOnlyMerchant(merchant)
    && !/^(?:京东|京东商城|京东平台|淘宝|淘宝网|淘宝平台|天猫|天猫商城|天猫平台|拼多多|拼多多平台|滴滴|滴滴出行|抖音|抖音平台)$/.test(key)
    && !/^(?:待补充商户|待补充|未知商户|未知|不详|超市|便利店|商场|商户不详|未提供商户|未识别商户|无商户|[-—]+)$/.test(key);
}

export function classifyMerchant(merchant: string, rules: MerchantRule[] = []): MerchantClassification {
  const key = merchantKey(merchant);
  const platform = detectPlatform(merchant);
  const metadata = platform ? { platform } : {};
  if (!key || !canRememberMerchant(merchant)) {
    return { category: "待分类", reason: "用途不明，请核对", merchantKey: key, requiresReview: true, ...metadata };
  }
  const match = purposeRules.find(([, , pattern]) => pattern.test(key));
  const matchingRules = rules.filter(rule =>
    merchantKey(rule.merchant) === key && isStoredExpenseCategory(rule.category));
  const personal = matchingRules.find(rule => rule.merchant === key) ?? matchingRules[0];
  if (personal) {
    const normalized = normalizeTransactionCategory(personal);
    if (normalized.category !== "待分类") {
      const subcategory = normalized.subcategory ?? (match?.[0] === normalized.category ? match[1] : undefined);
      return { category: normalized.category, ...(subcategory ? { subcategory } : {}),
        reason: "个人商户规则", merchantKey: key, requiresReview: false, ...metadata };
    }
  }
  if (match) {
    const [category, subcategory] = match;
    return { category, subcategory, reason: `商户关键词：${category}`, merchantKey: key, requiresReview: false, ...metadata };
  }
  return { category: "待分类", reason: "用途不明，请核对", merchantKey: key, requiresReview: true, ...metadata };
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
