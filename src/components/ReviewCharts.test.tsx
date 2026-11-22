import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { formatMoney } from "../lib/ledger";
import { SpendingDonut, SpendingTrend } from "./ReviewCharts";

describe("spending composition", () => {
  it("shows the selected category amount, share and refund separately", () => {
    const html = renderToStaticMarkup(<SpendingDonut
      slices={[{ category: "食品酒水", amountCents: 12_000 }, { category: "交通出行", amountCents: 8_000 }]}
      selectedCategory="食品酒水"
      onSelect={() => {}}
      refundCents={500}
    />);
    expect(html).toContain('aria-label="支出构成"');
    expect(html).toContain('data-category="食品酒水" aria-pressed="true"');
    expect(html).toMatch(/data-category="食品酒水"[^>]+transform:translate\((?!0px, 0px\))/);
    expect(html).toContain("60%");
    expect(html).toContain(formatMoney(12_000));
    expect(html).toContain("退款 " + formatMoney(500));
    expect(html).toContain('aria-label="查看交通出行"');
  });

  it("keeps an entire ring when a single category holds all spending", () => {
    const html = renderToStaticMarkup(<SpendingDonut
      slices={[{ category: "食品酒水", amountCents: 10_000 }]}
      selectedCategory="食品酒水"
      onSelect={() => {}}
      refundCents={0}
    />);
    expect(html).toContain("100%");
    const path = html.match(/<path[^>]+d="([^"]+)"/)?.[1] ?? "";
    expect(path.match(/A /g)).toHaveLength(4);
  });

  it("shows an empty state when the month has refunds only", () => {
    const html = renderToStaticMarkup(<SpendingDonut slices={[]} selectedCategory={null} onSelect={() => {}} refundCents={500} />);
    expect(html).toContain("本月暂无支出");
    expect(html).toContain("退款 " + formatMoney(500));
    expect(html).not.toContain("review-donut-wedge");
  });
});

describe("spending trend", () => {
  const base = {
    range: { startMonth: "2025-12", endMonth: "2026-03" },
    maxMonth: "2026-03",
    selectedCategory: "食品酒水",
    categoryOptions: ["食品酒水", "交通出行"],
    onSelectCategory: () => {},
    onRangeChange: () => {},
    onOpenMonth: () => {},
    throughDate: "2026-03-12",
  };
  it("offers a custom range and a selected category", () => {
    const html = renderToStaticMarkup(<SpendingTrend {...base} points={[]} />);
    expect(html).toContain("起始月份");
    expect(html).toContain("结束月份");
    expect(html).toContain('value="2025-12"');
    expect(html).toContain('value="2026-03"');
    expect(html).toContain("应用区间");
    expect(html).toContain('aria-label="趋势分类"');
    expect(html).toContain('value="食品酒水" selected=""');
  });

  it("leaves missing months unconnected and marks incomplete data", () => {
    const html = renderToStaticMarkup(<SpendingTrend {...base} points={[
      { month: "2025-12", amountCents: -2_000, isPartial: false },
      { month: "2026-01", amountCents: null, isPartial: false },
      { month: "2026-02", amountCents: 22_000, isPartial: false },
      { month: "2026-03", amountCents: 26_000, isPartial: true },
    ]} />);
    expect(html).toContain('data-month="2025-12" data-amount-cents="-2000"');
    expect(html).not.toContain('data-month="2026-01"');
    expect(html).not.toContain('data-from="2025-12"');
    expect(html).toContain('data-from="2026-02" data-to="2026-03"');
    expect(html).toContain("截至 12 日");
    expect(html).not.toContain("NaN");
  });

  it("keeps a readable zero axis when a small refund is below zero", () => {
    const html = renderToStaticMarkup(<SpendingTrend {...base} points={[
      { month: "2026-02", amountCents: -1, isPartial: false },
      { month: "2026-03", amountCents: 100_000, isPartial: true },
    ]} />);
    expect(html.match(/class="review-trend-guide"/g)).toHaveLength(1);
    expect(html).toContain('data-amount-cents="-1"');
    expect(html).toContain('class="review-trend-zero"');
  });
});
