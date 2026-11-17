import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SmsActivitySummaryView } from "./SmsActivitySummary";
import type { SmsActivitySummary } from "../lib/smsClient";

const summary: SmsActivitySummary = { period_start: "2026-11-10T17:00:00Z", period_end: "2026-11-17T17:00:00Z", time_zone: "Asia/Shanghai", received_count: 12, recorded_count: 8, pending_count: 3, dismissed_count: 1 };

describe("received SMS activity scope", () => {
  it("shows the server window in Beijing time and distinguishes processing from the current ledger", () => {
    const markup = renderToStaticMarkup(<SmsActivitySummaryView state={{ status: "ready", summary }} onRetry={() => {}} />);
    expect(markup).toContain("近7天已接收短信");
    expect(markup).toContain("2026/11/11 01:00");
    expect(markup).toContain("2026/11/18 01:00");
    expect(markup).toContain("北京时间，168小时");
    expect(markup).toContain("按接收时间统计，显示当前处理状态");
    expect(markup).toContain("已处理入账");
    expect(markup).toContain("本期待确认");
    expect(markup).toContain("全部待确认还可能包含更早接收的短信");
    expect(markup).toContain("对应账目以当前账本为准");
    expect(markup).toMatch(/<dt>已接收<\/dt><dd>12<small>条<\/small><\/dd>/);
    expect(markup).toMatch(/<dt>已处理入账<\/dt><dd>8<small>条<\/small><\/dd>/);
    expect(markup).toMatch(/<dt>本期待确认<\/dt><dd>3<small>条<\/small><\/dd>/);
    expect(markup).toMatch(/<dt>已忽略<\/dt><dd>1<small>条<\/small><\/dd>/);
  });

  it.each([false, true])("keeps unavailable or timed-out statistics separate from the inbox (%s)", timedOut => {
    const markup = renderToStaticMarkup(<SmsActivitySummaryView state={{ status: "error", timedOut }} onRetry={() => {}} />);
    expect(markup).toContain(timedOut ? "统计读取超时" : "统计暂不可用");
    expect(markup).toContain("短信收件箱仍可照常使用");
    expect(markup).toContain("重试统计");
    expect(markup).not.toContain("sms-activity-counts");
  });

  it("does not turn a loading request into a zero-received claim", () => {
    const markup = renderToStaticMarkup(<SmsActivitySummaryView state={{ status: "loading" }} onRetry={() => {}} />);
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain("正在读取近7天接收记录");
    expect(markup).not.toContain("sms-activity-counts");
    expect(markup).toContain("仅包含成功上传后被接收的去重记录");
    expect(markup).toContain("不能发现手机上未触发或未提交的短信");
  });

  it("shows zero counts when the server successfully reports an empty window", () => {
    const empty = { ...summary, received_count: 0, recorded_count: 0, pending_count: 0, dismissed_count: 0 };
    const markup = renderToStaticMarkup(<SmsActivitySummaryView state={{ status: "ready", summary: empty }} onRetry={() => {}} />);
    expect(markup.match(/<dd>0<small>条<\/small><\/dd>/g)).toHaveLength(4);
    expect(markup).not.toContain("统计暂不可用");
  });
});
