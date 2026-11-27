export const INCOME_CATEGORIES = ["工资", "亲友赠与", "交易收入", "其他收入"] as const;
export type IncomeCategory = typeof INCOME_CATEGORIES[number];

const legacyIncomeCategories = new Map<string, IncomeCategory>([
  ["奖金", "工资"],
  ["劳务报酬", "交易收入"],
]);

export function incomeCategoryLabel(subcategory?: string): IncomeCategory {
  return INCOME_CATEGORIES.find(category => category === subcategory)
    ?? legacyIncomeCategories.get(subcategory ?? "")
    ?? "其他收入";
}
