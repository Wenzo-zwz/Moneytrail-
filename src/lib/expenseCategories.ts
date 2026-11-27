export const EXPENSE_CATEGORIES = [
  "食品酒水", "居住与家用", "交通出行", "衣着与美妆", "休闲娱乐", "医疗保健",
  "学习培训", "人情往来", "通讯", "其他", "待分类",
] as const;

export const EXPENSE_DETAILS: Record<string, readonly string[]> = {
  食品酒水: ["买菜食材", "食品采购", "堂食聚餐", "外卖", "咖啡奶茶", "零食饮料", "酒水", "烟酒副食"],
  居住与家用: ["房租", "水电燃气", "物业", "日用品", "家居维修", "住宿"],
  交通出行: ["公共交通", "打车", "机票火车", "加油充电", "停车通行", "车辆保养维修"],
  衣着与美妆: ["衣物", "鞋包", "配饰", "护肤美妆"],
  休闲娱乐: ["电影演出", "游戏", "健身", "影音会员", "景区游玩", "旅行团", "休闲娱乐", "按摩足疗", "剧本杀密室", "电影影音", "桌游台球"],
  医疗保健: ["医疗服务", "药品", "体检", "保健品"],
  学习培训: ["教材", "课程培训", "考试报名"],
  人情往来: ["礼金红包", "送礼", "家庭支持"],
  通讯: ["手机话费与流量", "家庭宽带"],
  其他: ["宠物", "快递费", "保险保费", "数码"],
};

const LEGACY_CATEGORIES = ["本地生活", "购物", "居住", "交通", "医疗", "学习", "餐饮", "娱乐"];
const STORED_CATEGORIES = new Set<string>([...EXPENSE_CATEGORIES, ...LEGACY_CATEGORIES]);

export function isStoredExpenseCategory(category: unknown): category is string {
  return typeof category === "string" && STORED_CATEGORIES.has(category);
}

function normalizedDetail(category: string, detail: string | undefined): string | undefined {
  if (category === "食品酒水" && /^(餐饮|堂食)$/.test(detail ?? "")) return "堂食聚餐";
  if (category === "衣着与美妆" && /^(服饰|服装)$/.test(detail ?? "")) return "衣物";
  if (category === "交通出行" && detail === "加油") return "加油充电";
  return detail;
}

export function normalizeExpenseCategory<T extends { category: string; subcategory?: string; merchant?: string }>(transaction: T): T {
  const detail = transaction.subcategory?.trim();
  let category = transaction.category;
  let subcategory = detail;

  switch (category) {
    case "餐饮":
      category = "食品酒水";
      if (!detail || detail === "未细分") subcategory = "堂食聚餐";
      break;
    case "娱乐":
      category = "休闲娱乐";
      if (!detail || detail === "未细分") subcategory = "休闲娱乐";
      break;
    case "本地生活": {
      if (detail && (EXPENSE_DETAILS.食品酒水.includes(detail) || /^(餐饮|堂食)$/.test(detail))) category = "食品酒水";
      else if (detail && EXPENSE_DETAILS.休闲娱乐.includes(detail)) category = "休闲娱乐";
      else category = "待分类";
      break;
    }
    case "购物": {
      if (detail && (EXPENSE_DETAILS.衣着与美妆.includes(detail) || /^(服饰|服装)$/.test(detail))) category = "衣着与美妆";
      else if (detail && ["日用品", "家居维修"].includes(detail)) category = "居住与家用";
      else if (detail && ["烟酒副食", "买菜食材", "零食饮料", "酒水"].includes(detail)) category = "食品酒水";
      else category = detail === "数码" ? "其他" : "待分类";
      break;
    }
    case "居住":
      if (/^(话费|流量|手机话费|手机话费与流量)$/.test(detail ?? "")) {
        category = "通讯";
        subcategory = "手机话费与流量";
      } else if (/^(宽带|家庭宽带)$/.test(detail ?? "")) {
        category = "通讯";
        subcategory = "家庭宽带";
      } else if (detail === "通讯") {
        category = "通讯";
      } else if (detail === "生活缴费") {
        const purpose = transaction.merchant ?? "";
        if (/宽带/.test(purpose)) [category, subcategory] = ["通讯", "家庭宽带"];
        else if (/话费|手机充值|流量/.test(purpose)) [category, subcategory] = ["通讯", "手机话费与流量"];
        else if (/水费|电费|燃气/.test(purpose)) [category, subcategory] = ["居住与家用", "水电燃气"];
        else if (/物业/.test(purpose)) [category, subcategory] = ["居住与家用", "物业"];
        else category = "待分类";
      } else {
        category = "居住与家用";
      }
      break;
    case "交通": category = "交通出行"; break;
    case "医疗": category = "医疗保健"; break;
    case "学习": category = "学习培训"; break;
  }

  subcategory = normalizedDetail(category, subcategory);
  if (category === transaction.category && subcategory === transaction.subcategory) return transaction;
  return { ...transaction, category, ...(subcategory === undefined ? {} : { subcategory }) };
}
