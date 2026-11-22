import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EXPENSE_DETAILS } from "../lib/expenseCategories";
import { DetailField } from "./TransactionMetadata";

function renderDetail(category: string, value?: string) {
  return renderToStaticMarkup(<DetailField category={category} value={value} onChange={() => {}} />);
}

describe("transaction detail picker", () => {
  it("renders the selected category's built-in options in a native select", () => {
    const markup = renderDetail("食品酒水", "咖啡奶茶");
    expect(markup).toContain("二级分类（可选）");
    expect(markup).toContain("<select");
    expect(markup).toContain('value="未细分"');
    for (const detail of EXPENSE_DETAILS.食品酒水) {
      expect(markup).toContain(`>${detail}</option>`);
    }
    expect(markup).toContain('value="咖啡奶茶" selected=""');
    expect(markup).toContain(">自定义…</option>");
    expect(markup).not.toContain(`>${EXPENSE_DETAILS.交通出行[0]}</option>`);
  });

  it("provides disabled guidance until a primary category is selected", () => {
    const markup = renderDetail("待分类");
    expect(markup).toMatch(/<select[^>]* disabled=""/);
    expect(markup).toContain(">请先选择一级分类</option>");
    expect(markup).not.toContain("自定义二级分类");
  });

  it("opens the custom field with a previously saved custom detail", () => {
    const markup = renderDetail("休闲娱乐", "桌游聚会");
    expect(markup).toMatch(/<option[^>]* selected="">自定义…<\/option>/);
    expect(markup).toContain("自定义二级分类");
    expect(markup).toMatch(/<input[^>]* value="桌游聚会"/);
  });
});
