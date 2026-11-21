import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { formatMoney, type Transaction } from "../lib/ledger";
import { setAnnualBudget } from "../lib/reviewBudget";
import { AnnualBudgetEditor, MonthlyReview, NextMonthBudgetEditor } from "./MonthlyReview";

const transactions: Transaction[] = [{
  id: "coffee",
  kind: "expense",
  amountCents: 1800,
  date: "2026-11-09T12:00",
  merchant: "午餐",
  category: "本地生活",
  subcategory: "餐饮",
  source: "manual",
  note: "",
}];
const editor = {
  month: "2026-11",
  today: "2026-11-21",
  transactions,
  budgets: [],
  onSave: () => true,
  onClose: () => {},
};

describe("monthly review and budgets", () => {
  it("offers equal-period and full-month comparisons in the active month's review", () => {
    const html = renderToStaticMarkup(<MonthlyReview {...editor} onEditAnnualBudget={() => {}} onEditNextMonth={() => {}} />);
    expect(html).toContain("月度复盘");
    expect(html).toContain("2026 年 11 月");
    expect(html).toContain("同期");
    expect(html).toContain("整月");
    expect(html).toContain("调整 12 月预算");
  });

  it("distinguishes a missing prior statement from a confirmed zero", () => {
    const render = (checkedMonths: string[]) => renderToStaticMarkup(<MonthlyReview {...editor} checkedMonths={checkedMonths} onEditAnnualBudget={() => {}} onEditNextMonth={() => {}} />);
    expect(render([])).toContain("上月同期暂无记录");
    expect(render(["2026-10"])).not.toContain("上月同期暂无记录");
  });

  it("shows a current budget variance and the annual remaining amount", () => {
    const budgets = setAnnualBudget([], { category: "食品酒水" }, "2026-01", 12_000);
    expect(renderToStaticMarkup(<MonthlyReview {...editor} budgets={budgets} onEditAnnualBudget={() => {}} onEditNextMonth={() => {}} />)).toContain(`食品酒水超出计划 ${formatMoney(800)}`);
    expect(renderToStaticMarkup(<AnnualBudgetEditor {...editor} budgets={budgets} />)).toContain(`剩余 ${formatMoney(10_200)}`);
  });

  it("shows both supported years and the monthly default while setting annual budgets", () => {
    const html = renderToStaticMarkup(<AnnualBudgetEditor {...editor} />);
    expect(html).toContain("2026 年");
    expect(html).toContain("2027 年");
    expect(html).toContain("全年额度 ÷ 12");
    expect(html).toContain("保存年度预算");
  });

  it("names the next calendar month across the year boundary and offers annual setup if missing", () => {
    const html = renderToStaticMarkup(<NextMonthBudgetEditor {...editor} month="2026-12" />);
    expect(html).toContain("2027 年 1 月");
    expect(html).toContain("请先设置年度预算");
  });

  it("does not present unelapsed days as the reviewed period or offer a next-month edit from the future", () => {
    const html = renderToStaticMarkup(<MonthlyReview {...editor} month="2026-12" onEditAnnualBudget={() => {}} onEditNextMonth={() => {}} />);
    expect(html).toContain("本月尚未开始");
    expect(html).not.toContain("调整 1 月预算");
  });

  it("distinguishes the next month's default and its remaining-budget suggestion", () => {
    const budgets = setAnnualBudget([], { category: "食品酒水" }, "2026-01", 12_000);
    const html = renderToStaticMarkup(<NextMonthBudgetEditor {...editor} budgets={budgets} />);
    expect(html).toContain(`默认月参考 ${formatMoney(1000)}`);
    expect(html).toContain(`采用建议 ${formatMoney(10_200)}`);
  });
});
