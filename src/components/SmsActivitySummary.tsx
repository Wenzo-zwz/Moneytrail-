import { useEffect, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { RefreshCw } from "lucide-react";
import { fetchSmsActivitySummary, type SmsActivitySummary as ActivitySummary } from "../lib/smsClient";
import "./SmsActivitySummary.css";

type Props = { client: SupabaseClient; userId: string; refreshKey: number };
type ViewState = { status: "loading" } | { status: "ready"; summary: ActivitySummary } | { status: "error"; timedOut: boolean };
type Outcome = { owner: string; refreshKey: number; retryKey: number; state: ViewState };
const dateTime = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Shanghai" });

export function SmsActivitySummaryView({ state, onRetry }: { state: ViewState; onRetry: () => void }) {
  return <section className="sms-activity-summary" aria-label="近7天已接收短信" aria-busy={state.status === "loading"}>
    <h2>近7天已接收短信</h2>
    <p className="sms-activity-scope">仅包含成功上传后被接收的去重记录，不能发现手机上未触发或未提交的短信。</p>
    {state.status === "ready" ? <>
      <p className="sms-activity-period">{dateTime.format(new Date(state.summary.period_start))} 至 {dateTime.format(new Date(state.summary.period_end))}（北京时间，168小时）。按接收时间统计，显示当前处理状态。</p>
      <dl className="sms-activity-counts">
        <div><dt>已接收</dt><dd>{state.summary.received_count}<small>条</small></dd></div>
        <div><dt>已处理入账</dt><dd>{state.summary.recorded_count}<small>条</small></dd></div>
        <div><dt>本期待确认</dt><dd>{state.summary.pending_count}<small>条</small></dd></div>
        <div><dt>已忽略</dt><dd>{state.summary.dismissed_count}<small>条</small></dd></div>
      </dl>
      <p className="sms-activity-note">全部待确认还可能包含更早接收的短信。“已处理入账”表示短信曾完成入账处理，对应账目以当前账本为准。</p>
    </> : state.status === "error" ? <div className="sms-activity-unavailable">
      <p role="status">{state.timedOut ? "统计读取超时。" : "统计暂不可用。"}短信收件箱仍可照常使用。</p>
      <button type="button" className="button secondary small" onClick={onRetry}><RefreshCw size={15} />重试统计</button>
    </div> : <p role="status" className="sms-activity-loading">正在读取近7天接收记录…</p>}
  </section>;
}

export default function SmsActivitySummary({ client, userId, refreshKey }: Props) {
  const [retryKey, setRetryKey] = useState(0);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const current = outcome?.owner === userId && outcome.refreshKey === refreshKey && outcome.retryKey === retryKey ? outcome.state : { status: "loading" as const };

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      if (!active) return;
      controller.abort();
      setOutcome({ owner: userId, refreshKey, retryKey, state: { status: "error", timedOut: true } });
    }, 20_000);
    void fetchSmsActivitySummary(client, userId, controller.signal).then(summary => {
      if (active && !controller.signal.aborted) setOutcome({ owner: userId, refreshKey, retryKey, state: { status: "ready", summary } });
    }).catch(() => {
      if (active && !controller.signal.aborted) setOutcome({ owner: userId, refreshKey, retryKey, state: { status: "error", timedOut: false } });
    }).finally(() => clearTimeout(timeout));
    return () => { active = false; clearTimeout(timeout); controller.abort(); };
  }, [client, userId, refreshKey, retryKey]);

  return <SmsActivitySummaryView state={current} onRetry={() => setRetryKey(value => value + 1)} />;
}
