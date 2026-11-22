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
  it("shows spending to date and its largest category without month-over-month changes while the month is open", () => {
    const items: Transaction[] = [
      ...transactions,
      { ...transactions[0], id: "prior", date: "2026-10-09T12:00", amountCents: 1200 },
      { ...transactions[0], id: "late-prior", date: "2026-10-29T12:00", amountCents: 90000 },
      { ...transactions[0], id: "future", date: "2026-11-29T12:00", amountCents: 200000, category: "居住与家用" },
    ];
    const html = renderToStaticMarkup(<MonthlyReview {...editor} transactions={items} onEditAnnualBudget={() => {}} onEditNextMonth={() => {}} />);
    expect(html).toContain(`class="review-headline-title">本月已记净支出 ${formatMoney(1800)}`);
    expect(html).toContain("本月截至 11 月 21 日");
    expect(html).toContain(`已分类支出最多：食品酒水 ${formatMoney(1800)}`);
    expect(html).not.toMatch(/较上月|比上月|全月对比/);
  });

  it("compares both calendar months in full when reviewing a finished month", () => {
    const items: Transaction[] = [
      { ...transactions[0], date: "2026-10-30T12:00" },
      { ...transactions[0], id: "prior", date: "2026-09-30T12:00", amountCents: 1200 },
    ];
    const html = renderToStaticMarkup(<MonthlyReview {...editor} month="2026-10" transactions={items} onEditAnnualBudget={() => {}} onEditNextMonth={() => {}} />);
    expect(html).toContain(`比上月多花 ${formatMoney(600)}`);
    expect(html).toContain("2026 年 10 月全月，和 9 月全月对比");
    expect(html).toContain("增加最多：食品酒水");
    expect(html).toContain("<dt>较上月</dt>");
  });

  it("shows the actual net spend and largest classified expense when the prior period is missing", () => {
    const html = renderToStaticMarkup(<MonthlyReview {...editor} onEditAnnualBudget={() => {}} onEditNextMonth={() => {}} />);
    expect(html).toContain(`本月已记净支出 ${formatMoney(1800)}`);
    expect(html).toContain(`已分类支出最多：食品酒水 ${formatMoney(1800)}`);
    expect(html).not.toContain("比上月");
  });

  it("puts the review conclusion in a standalone card before the charts and details", () => {
    const html = renderToStaticMarkup(<MonthlyReview {...editor} onEditAnnualBudget={() => {}} onEditNextMonth={() => {}} />);
    expect(html).toContain("月度复盘");
    expect(html).toMatch(/^<section\b/);
    expect(html).toMatch(/<section[^>]+aria-label="月度复盘结论"[^>]*>.*?<\/section><section[^>]+aria-label="支出构成"/);
    expect(html).not.toContain("对比区间");
    expect(html).toContain("调整 12 月预算");
  });

  it("distinguishes a missing prior statement from a confirmed zero", () => {
    const items = [{ ...transactions[0], date: "2026-10-09T12:00" }];
    const render = (checkedMonths: string[]) => renderToStaticMarkup(<MonthlyReview {...editor} month="2026-10" transactions={items} checkedMonths={checkedMonths} onEditAnnualBudget={() => {}} onEditNextMonth={() => {}} />);
    expect(render([])).toContain("上月暂无记录");
    expect(render(["2026-09"])).toContain(`比上月多花 ${formatMoney(1800)}`);
  });

  it("keeps prior category details available for a finished month with no records of its own", () => {
    const items = [{ ...transactions[0], date: "2026-09-30T12:00" }];
    const html = renderToStaticMarkup(<MonthlyReview {...editor} month="2026-10" transactions={items} onEditAnnualBudget={() => {}} onEditNextMonth={() => {}} />);
    expect(html).toContain("本月暂无记录");
    expect(html).toContain("食品酒水</button>");
    expect(html).not.toContain("<dt>较上月</dt>");
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
