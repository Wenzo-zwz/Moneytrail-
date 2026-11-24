import { useEffect, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { CATEGORIES, formatMoney } from "../lib/ledger";
import type { CloudStore } from "../lib/cloudStore";
import { applyCategoryChanges, canRememberMerchant, isPlatformOnlyMerchant, merchantKey, planCategoryChanges, type CategoryChange } from "../lib/merchantClassification";
import { applyPendingSms, fetchSmsCategoryRules, fetchSmsMerchantRules, previewPendingSms, setSmsCategoryRule, setSmsMerchantRule, type SmsCategoryRule, type SmsMerchantRule, type SmsPendingPreview } from "../lib/smsClient";
import { categoryText, DetailField } from "./TransactionMetadata";
import type { AppData } from "../lib/storage";
import { refreshSmsLedger } from "../lib/smsLedgerSync";

type Props = { client: SupabaseClient; userId: string; store: CloudStore; busy: boolean; canWrite: boolean; iphoneAvailable: boolean; onServerWrite: () => void; onRulesChanged?: () => void; run: (action: (signal: AbortSignal) => Promise<string | void>) => Promise<void> };
type EditableRule = SmsCategoryRule & Partial<Pick<SmsMerchantRule, "auto_record">>;
export default function SmsClassificationTools({ client, userId, store, busy, canWrite, iphoneAvailable, onServerWrite, onRulesChanged, run }: Props) {
  const [rules, setRules] = useState<EditableRule[]>([]);
  const [pending, setPending] = useState<SmsPendingPreview | null>(null);
  const [batch, setBatch] = useState<{ snapshot: AppData; changes: CategoryChange[] } | null>(null);
  const [undo, setUndo] = useState<CategoryChange[] | null>(null);
  const [merchant, setMerchant] = useState("");
  const [category, setCategory] = useState("");
  const [subcategory, setSubcategory] = useState<string | undefined>("未细分");
  const [remember, setRemember] = useState(false);
  const [autoRecord, setAutoRecord] = useState(false);
  const [merchantRpcAvailable, setMerchantRpcAvailable] = useState(true);
  const [ruleError, setRuleError] = useState("");
  useEffect(() => { setRules([]); setPending(null); setBatch(null); setUndo(null); setMerchant(""); setAutoRecord(false); setMerchantRpcAvailable(true); setRuleError(""); }, [userId]);
  const canSetAutoRecord = iphoneAvailable && merchantRpcAvailable;
  const platformOnly = isPlatformOnlyMerchant(merchant);
  const canRemember = canRememberMerchant(merchant);
  const pendingRules = store.getPendingMerchantRules();
  function guard() {
    const s = store.getState();
    if (!s.ready || s.dirty || s.phase !== "saved" || s.recoveryError) throw new Error("请先完成账本同步或处理冲突，再进行批量操作。");
  }
  async function loadRules(signal: AbortSignal) {
    try {
      const merchantRules = iphoneAvailable ? await fetchSmsMerchantRules(client, userId, signal) : null;
      const next = merchantRules ?? await fetchSmsCategoryRules(client, userId, signal);
      if (!signal.aborted) {
        setMerchantRpcAvailable(merchantRules !== null);
        setRules(next);
        setRuleError("");
      }
      return next;
    }
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
  function cancelMemory(transactionId: string) { void run(async signal => {
    if (store.getState().phase === "syncing") throw new Error("正在同步，请等待本次同步结束后再取消记忆。");
    const snapshot = store.loadData();
    if (snapshot.error) throw new Error(snapshot.error);
    const result = store.saveData(snapshot.data, snapshot.data, { forgetMerchantRulesFor: [transactionId] });
    if (!result.ok) throw new Error(result.error || "账本已变化，请刷新后重试。");
    await store.retry(); if (signal.aborted) return;
    const state = store.getState();
    return `该笔账目仍保留，已取消这次待同步记忆。${state.phase === "saved" && !state.dirty ? "账目已同步。" : `账目等待同步。${state.message}`}`;
  }); }
  function editRule(rule: EditableRule, existingRule: boolean) {
    setMerchant(rule.merchant);
    setCategory(rule.category === "待分类" ? "" : rule.category);
    setSubcategory(rule.subcategory || "未细分");
    setRemember(existingRule);
    setAutoRecord(existingRule && rule.auto_record === true);
  }

  function saveRule(ruleMerchant: string, ruleCategory: string | null, ruleSubcategory?: string) {
    void run(async signal => {
      guard();
      const next = canSetAutoRecord
        ? await setSmsMerchantRule(client, userId, ruleMerchant, ruleCategory, ruleSubcategory, ruleCategory !== null && autoRecord, signal)
        : await setSmsCategoryRule(client, userId, ruleMerchant, ruleCategory, signal, ruleSubcategory);
      if (!signal.aborted) {
        setRules(next);
        setPending(null);
        setBatch(null);
        setRuleError("");
        if (ruleCategory !== null) setRemember(false);
        else if (merchantKey(ruleMerchant) === merchantKey(merchant)) {
          setRemember(false);
          setAutoRecord(false);
        }
        onRulesChanged?.();
      }
      return ruleCategory === null ? "个人商户规则已删除。" : "个人商户规则已保存。请重新预览历史记录。";
    });
  }

  return <section className="sms-classification" aria-label="分类整理工具">
    <h2>分类与历史整理</h2><p>先预览，再确认。只补全消费的“待分类”，保留已有分类和金额。</p>
    <div className="sms-tool-actions"><button className="button secondary small" disabled={busy || !canWrite} onClick={previewPending}>预览待确认短信</button><button className="button secondary small" disabled={busy || !canWrite} onClick={previewCategories}>预览账本待分类</button>{undo && <button className="button ghost small" disabled={busy || !canWrite} onClick={() => saveCategories(true)}>撤销本次分类</button>}</div>
    {pending && <div className="sms-classification-preview"><h3>待确认预览：可入账 {pending.recordable_count} 笔，保留确认 {pending.pending_count - pending.recordable_count} 笔</h3><p>仅应用本次列出的可入账记录；不改变收到新短信后的记录方式，相同记录不会重复入账。</p><ul>{pending.items.map(item => <li key={item.id}><strong>{item.draft?.merchant || "无法识别"}</strong><span>{item.draft ? `${formatMoney(item.draft.amountCents)} · ${categoryText(item.draft)}` : "需手动核对"} · {item.eligible ? "可入账" : "保留确认"}</span><small>{item.reason}</small>{item.draft && canRememberMerchant(item.draft.merchant) && <button className="button ghost small" disabled={busy} onClick={() => editRule(item.draft!, false)}>为这家设置分类</button>}</li>)}</ul><div className="sms-tool-actions"><button className="button primary small" disabled={busy || !canWrite || !pending.recordable_count} onClick={() => void run(async signal => { guard(); const response = await applyPendingSms(client, userId, pending.items.filter(item => item.eligible && item.draft).map(item => ({ id: item.id, draft: item.draft! })), signal); if (signal.aborted) return; setPending(null); const refreshNotice = await refreshSmsLedger(store); if (!signal.aborted) onServerWrite(); return `已入账 ${response.recorded_count} 笔，仍有 ${response.pending_count} 笔待确认。${refreshNotice}`; })}>确认应用可入账记录</button><button className="button ghost small" disabled={busy} onClick={() => setPending(null)}>关闭预览</button></div></div>}
    {batch && <div className="sms-classification-preview"><h3>账本分类预览：{batch.changes.length} 笔</h3>{!batch.changes.length && <p>没有可补全分类的消费，账本没有变化。</p>}<ul>{batch.changes.map(change => <li key={change.id}><strong>{change.merchant}</strong><span>{categoryText(change.before)} → {categoryText(change.after)}</span><small>{change.reason}</small></li>)}</ul><div className="sms-tool-actions"><button className="button primary small" disabled={busy || !canWrite || !batch.changes.length} onClick={() => saveCategories()}>确认更新分类</button><button className="button ghost small" disabled={busy} onClick={() => setBatch(null)}>关闭预览</button></div></div>}
    <details className="sms-rule-editor">
      <summary>个人商户分类规则</summary>
      {pendingRules.length > 0 && <div className="sms-pending-memory">
        <h3>待同步的商户记忆</h3><p>如果这次记忆有误或规则数量已满，可先取消该学习选择，账目仍会保留。账本同步完成后再编辑或删除云端规则。</p>
        <ul>{pendingRules.map(rule => <li key={rule.transactionId}><span>{merchantKey(rule.merchant)} · {categoryText(rule)}</span><button className="button ghost small" disabled={busy || store.getState().phase === "syncing"} onClick={() => cancelMemory(rule.transactionId)}>取消这次待同步记忆</button></li>)}</ul>
      </div>}
      <p>只记住具体商户。只有平台、通用渠道、群收款或不明转账时，请核对实际用途。</p>
      <button className="button secondary small" disabled={busy} onClick={() => void run(async signal => { await loadRules(signal); })}>读取个人规则</button>
      {ruleError && <p role="alert">{ruleError}</p>}
      <label>具体商户<input maxLength={200} value={merchant} disabled={busy} onChange={event => {
        setMerchant(event.target.value);
        setRemember(false);
        if (merchantKey(merchant) !== merchantKey(event.target.value)) setAutoRecord(false);
      }} /></label>
      <p className="help-text">匹配名称：{merchantKey(merchant) || "请填写具体商户"}。支付渠道前缀会移除，分店名称会保留。</p>
      <label>分类<select disabled={busy} value={category} onChange={event => { setCategory(event.target.value); setSubcategory("未细分"); setAutoRecord(false); }}>
        <option value="" disabled>请选择分类</option>
        {CATEGORIES.filter(value => value !== "待分类").map(value => <option key={value}>{value}</option>)}
      </select></label>
      <DetailField category={category} value={subcategory} onChange={value => { setSubcategory(value); setAutoRecord(false); }} disabled={busy} />
      {platformOnly ? <p>仅显示美团平台，实际用途待确认。填写具体门店后可以保存商户规则。</p> : <label className="sms-remember"><input type="checkbox" checked={remember} disabled={busy || !canRemember} onChange={event => setRemember(event.target.checked)} />以后这家都这样分类</label>}
      {canSetAutoRecord && <label className="sms-remember">
        <input type="checkbox" checked={autoRecord} disabled={busy || !canRemember || !category} onChange={event => setAutoRecord(event.target.checked)} />iPhone 确认时，这家直接入账
      </label>}
      <button className="button secondary small" disabled={busy || !canWrite || !remember || !canRemember || !category} onClick={() => saveRule(merchant, category, subcategory?.trim() || "未细分")}>保存商户规则</button>
      <ul>{rules.map(rule => <li key={rule.merchant}>
        <span>{rule.merchant} · {categoryText(rule)}{canSetAutoRecord && rule.auto_record && <small>iPhone 直接入账</small>}</span>
        <button className="button ghost small" disabled={busy} onClick={() => editRule(rule, true)}>编辑规则</button>
        <button className="button ghost small" disabled={busy || !canWrite} onClick={() => saveRule(rule.merchant, null)}>删除规则</button>
      </li>)}</ul>
    </details>
  </section>;
}
