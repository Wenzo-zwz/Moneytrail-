import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { formatMoney, summarize, type Transaction } from "../lib/ledger";
import { setAnnualBudget } from "../lib/reviewBudget";
import { AnnualBudgetEditor, MonthlyReview, MonthlyReviewSummary, NextMonthBudgetEditor } from "./MonthlyReview";

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

describe("overview review summary", () => {
  function render(items: Transaction[]) {
    return renderToStaticMarkup(<MonthlyReviewSummary
      month={editor.month}
      today={editor.today}
      stats={summarize(items, editor.month, 0)}
      onOpen={() => {}}
    />);
  }

  it("shows current spending and the unclassified share without a budget or last month's data", () => {
    const html = render([
      { ...transactions[0], id: "unknown", category: "待分类", amountCents: 3_500 },
      { ...transactions[0], id: "housing", category: "居住与家用", amountCents: 3_200 },
      { ...transactions[0], id: "food", category: "食品酒水", amountCents: 3_000 },
      { ...transactions[0], id: "transport", category: "交通出行", amountCents: 2_900 },
      { ...transactions[0], id: "leisure", category: "休闲娱乐", amountCents: 400 },
    ]);
    expect(html).toMatch(/^<button\b/);
    expect(html).toContain("2026 年 11 月 · 进行中");
    expect(html).toContain(`已分类支出最多：居住与家用 ${formatMoney(3_200)}`);
    expect(html).toContain(`待分类：${formatMoney(3_500)}（占本月净支出约 27%）`);
  });

  it("shows a zero amount and no share when the month has no spending", () => {
    const html = render([]);
    expect(html).toContain("本月暂无已分类支出");
    expect(html).toContain(`待分类：${formatMoney(0)}`);
    expect(html).not.toContain("%");
  });

  it("shows the unclassified amount without a misleading share when refunds make it exceed net spending", () => {
    const html = render([
      { ...transactions[0], id: "unknown", category: "待分类", amountCents: 3_500 },
      { ...transactions[0], id: "refund", category: "食品酒水", kind: "refund", amountCents: 500 },
    ]);
    expect(html).toContain("本月暂无已分类支出");
    expect(html).toContain(`待分类：${formatMoney(3_500)}`);
    expect(html).not.toContain("%");
  });
});

describe("monthly review and budgets", () => {
  it("offers equal-period and full-month comparisons in the active month's review", () => {
    const html = renderToStaticMarkup(<MonthlyReview {...editor} onEditAnnualBudget={() => {}} onEditNextMonth={() => {}} />);
    expect(html).toContain("月度复盘");
    expect(html).toMatch(/^<section\b/);
    expect(html).not.toContain("<summary");
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
    expect(renderToStaticMarkup(<MonthlyReview {...editor} budgets={budgets} onEditAnnualBudget={() => {}} onEditNextMonth={() => {}} />)).toContain(`>超出</dt><dd class="text-danger">${formatMoney(800)}`);
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
