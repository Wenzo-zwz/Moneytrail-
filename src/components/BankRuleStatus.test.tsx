import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BANK_RULES_PROJECT } from "../lib/bankRulesValidation";
import BankRuleStatus from "./BankRuleStatus";

describe("bank rule version status", () => {
  it("keeps web publication separate from an unverified phone update", () => {
    const markup = renderToStaticMarkup(createElement(BankRuleStatus, { projectUrl: BANK_RULES_PROJECT }));
    expect(markup).toContain('aria-label="银行规则发布状态"');
    expect(markup).toContain("手机自动更新尚未实现或验证");
    expect(markup).toContain("网页版本不能证明手机已更新");
    expect(markup).toContain("现有 v3 不会自动读取此清单");
    expect(markup).toContain("正在读取网页规则版本");
    expect(markup).not.toContain("网页已发布规则 v1");
    expect(markup).toContain("检查网页规则版本");
    expect(markup).toContain("查看规则清单");
  });

  it("does not expose the production source or copy action to a different deployment", () => {
    const markup = renderToStaticMarkup(createElement(BankRuleStatus, { projectUrl: "https://other.supabase.co" }));
    expect(markup).toContain("当前项目没有配套的规则发布清单");
    expect(markup).not.toContain(BANK_RULES_PROJECT);
    expect(markup).not.toContain("bank-rules.json");
    expect(markup).not.toContain("复制已发布匹配规则");
    expect(markup).not.toContain("检查网页规则版本");
  });
});
