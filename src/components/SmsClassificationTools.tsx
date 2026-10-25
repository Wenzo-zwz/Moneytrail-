import { useEffect, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { CATEGORIES, formatMoney } from "../lib/ledger";
import type { CloudStore } from "../lib/cloudStore";
import { applyCategoryChanges, isPlatformOnlyMerchant, merchantKey, planCategoryChanges, type CategoryChange } from "../lib/merchantClassification";
import { applyPendingSms, fetchSmsCategoryRules, previewPendingSms, setSmsCategoryRule, type SmsCategoryRule, type SmsPendingPreview } from "../lib/smsClient";
import type { AppData } from "../lib/storage";

type Props = { client: SupabaseClient; userId: string; store: CloudStore; busy: boolean; canWrite: boolean; onServerWrite: () => void; run: (action: (signal: AbortSignal) => Promise<string | void>) => Promise<void> };
export default function SmsClassificationTools({ client, userId, store, busy, canWrite, onServerWrite, run }: Props) {
  const [rules, setRules] = useState<SmsCategoryRule[]>([]);
  const [pending, setPending] = useState<SmsPendingPreview | null>(null);
  const [batch, setBatch] = useState<{ snapshot: AppData; changes: CategoryChange[] } | null>(null);
  const [undo, setUndo] = useState<CategoryChange[] | null>(null);
  const [merchant, setMerchant] = useState("");
  const [category, setCategory] = useState("购物");
  const [remember, setRemember] = useState(false);
  const [ruleError, setRuleError] = useState("");
  useEffect(() => { setRules([]); setPending(null); setBatch(null); setUndo(null); setMerchant(""); setRuleError(""); }, [userId]);
  const platformOnly = isPlatformOnlyMerchant(merchant);
  const canRemember = Boolean(merchantKey(merchant)) && !platformOnly;
  function guard() {
    const s = store.getState();
    if (!s.ready || s.dirty || s.phase !== "saved" || s.recoveryError) throw new Error("请先完成账本同步或处理冲突，再进行批量操作。");
  }
  async function loadRules(signal: AbortSignal) {
    try { const next = await fetchSmsCategoryRules(client, userId, signal); if (!signal.aborted) { setRules(next); setRuleError(""); } return next; }
    catch (error) { if (!signal.aborted) setRuleError(error instanceof Error ? error.message : "暂时无法读取个人规则。"); throw error; }
  }
  function previewPending() { void run(async signal => { guard(); const next = await previewPendingSms(client, userId, signal); if (!signal.aborted) setPending(next); }); }
  function previewCategories() { void run(async signal => { guard(); const nextRules = await loadRules(signal); if (signal.aborted) return; guard(); const snapshot = store.loadData().data; setBatch({ snapshot, changes: planCategoryChanges(snapshot, nextRules) }); }); }
  function saveCategories(revert = false) { void run(async signal => {
    guard(); const changes = revert ? undo : batch?.changes;
    if (!changes?.length) return;
    const snapshot = revert ? store.loadData().data : batch!.snapshot;
    const next = applyCategoryChanges(snapshot, changes, revert);
    const result = store.saveData(next, snapshot);
    if (!result.ok) throw new Error(result.error || "账本已变化，请重新预览。");
    setBatch(null); setUndo(revert ? null : changes);
    await store.retry(); if (signal.aborted) return;
    const state = store.getState();
    return `${revert ? "已撤销本次分类" : `已更新 ${changes.length} 笔分类，相关月份需要重新核对`}。${state.phase === "saved" && !state.dirty ? "已同步。" : `已保存在本机，等待同步。${state.message}`}`;
  }); }
  return <section className="sms-classification" aria-label="分类整理工具">
    <h2>分类与历史整理</h2><p>先预览，再确认。只补全消费的“待分类”，保留已有分类和金额。</p>
    <div className="sms-tool-actions"><button className="button secondary small" disabled={busy || !canWrite} onClick={previewPending}>预览待确认短信</button><button className="button secondary small" disabled={busy || !canWrite} onClick={previewCategories}>预览账本待分类</button>{undo && <button className="button ghost small" disabled={busy || !canWrite} onClick={() => saveCategories(true)}>撤销本次分类</button>}</div>
    {pending && <div className="sms-classification-preview"><h3>待确认预览：可入账 {pending.recordable_count} 笔，保留确认 {pending.pending_count - pending.recordable_count} 笔</h3><p>仅应用本次列出的可入账记录；不改变收到新短信后的记录方式，相同记录不会重复入账。</p><ul>{pending.items.map(item => <li key={item.id}><strong>{item.draft?.merchant || "无法识别"}</strong><span>{item.draft ? `${formatMoney(item.draft.amountCents)} · ${item.draft.category}` : "需手动核对"} · {item.eligible ? "可入账" : "保留确认"}</span><small>{item.reason}</small>{item.draft && merchantKey(item.draft.merchant) && !isPlatformOnlyMerchant(item.draft.merchant) && <button className="button ghost small" disabled={busy} onClick={() => { setMerchant(item.draft!.merchant); setCategory(item.draft!.category === "待分类" ? "购物" : item.draft!.category); setRemember(false); }}>为这家设置分类</button>}</li>)}</ul><div className="sms-tool-actions"><button className="button primary small" disabled={busy || !canWrite || !pending.recordable_count} onClick={() => void run(async signal => { guard(); const response = await applyPendingSms(client, userId, pending.items.filter(item => item.eligible && item.draft).map(item => ({ id: item.id, draft: item.draft! })), signal); if (signal.aborted) return; setPending(null); await store.refresh(); if (!signal.aborted) onServerWrite(); return `已入账 ${response.recorded_count} 笔，仍有 ${response.pending_count} 笔待确认。`; })}>确认应用可入账记录</button><button className="button ghost small" disabled={busy} onClick={() => setPending(null)}>关闭预览</button></div></div>}
    {batch && <div className="sms-classification-preview"><h3>账本分类预览：{batch.changes.length} 笔</h3>{!batch.changes.length && <p>没有可补全分类的消费，账本没有变化。</p>}<ul>{batch.changes.map(change => <li key={change.id}><strong>{change.merchant}</strong><span>{change.fromCategory} → {change.toCategory}</span><small>{change.reason}</small></li>)}</ul><div className="sms-tool-actions"><button className="button primary small" disabled={busy || !canWrite || !batch.changes.length} onClick={() => saveCategories()}>确认更新分类</button><button className="button ghost small" disabled={busy} onClick={() => setBatch(null)}>关闭预览</button></div></div>}
    <details className="sms-rule-editor"><summary>个人商户分类规则</summary><p>只记住具体商户。美团等平台名称无法判断消费用途；群收款、通用渠道和不明转账仍需核对。</p><button className="button secondary small" disabled={busy} onClick={() => void run(async signal => { await loadRules(signal); })}>读取个人规则</button>{ruleError && <p role="alert">{ruleError}</p>}<label>具体商户<input maxLength={200} value={merchant} onChange={e => { setMerchant(e.target.value); setRemember(false); }} /></label><label>分类<select value={category} onChange={e => setCategory(e.target.value)}>{CATEGORIES.filter(value => value !== "待分类").map(value => <option key={value}>{value}</option>)}</select></label>{platformOnly ? <p>美团平台名称无法判断消费用途，请填写具体门店或用途；不能将整个平台记为一种分类。</p> : <label className="sms-remember"><input type="checkbox" checked={remember} disabled={!canRemember} onChange={e => setRemember(e.target.checked)} />以后这家都这样分类</label>}<button className="button secondary small" disabled={busy || !remember || !canRemember} onClick={() => void run(async signal => { const next = await setSmsCategoryRule(client, userId, merchant, category, signal); if (!signal.aborted) { setRules(next); setPending(null); setBatch(null); setRemember(false); setRuleError(""); } return "个人商户规则已保存。请重新预览历史记录。"; })}>保存商户规则</button><ul>{rules.map(rule => <li key={rule.merchant}><span>{rule.merchant} · {rule.category}</span><button className="button ghost small" disabled={busy} onClick={() => void run(async signal => { const next = await setSmsCategoryRule(client, userId, rule.merchant, null, signal); if (!signal.aborted) { setRules(next); setPending(null); setBatch(null); } return "个人商户规则已删除。"; })}>删除规则</button></li>)}</ul></details>
  </section>;
}
