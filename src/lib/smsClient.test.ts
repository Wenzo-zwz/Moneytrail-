import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";
import {
  SmsSetupError, SmsUpgradeError, confirmSms, dismissSms, fetchSmsConfig, fetchSmsInbox, reprocessPendingSms, revokeSmsToken, rotateSmsToken, setSmsMode,
  type SmsConfig, type SmsDraft, type SmsInbox,
} from "./smsClient";

const project = "https://sms-test.supabase.co";
const alice = "11111111-1111-4111-8111-111111111111";
const bob = "22222222-2222-4222-8222-222222222222";
const inboxId = "33333333-3333-4333-8333-333333333333";
const at = "2026-10-22T11:27:00.123456+00:00";
const capability = `mt_sms_${"a".repeat(64)}`;
const session = (id = alice, token = "token-A") => ({ user: { id }, access_token: token, refresh_token: "refresh", token_type: "bearer", expires_in: 3600 }) as Session;
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
const config = (): SmsConfig => ({ enabled: true, mode: "auto", created_at: at, last_received_at: at, pending_count: 1 });
const draft = (): SmsDraft => ({ kind: "expense", amountCents: 3090, date: "2026-10-22T19:27", merchant: "财付通-群收款", category: "待分类", source: "sms", note: "" });
const inbox = (): SmsInbox => ({ items: [{ id: inboxId, received_at: at, status: "pending", raw_text: "尾号xxxx卡支出30.90元。【工商银行】", draft: draft(), warnings: ["群收款需要确认用途。"], reason: null, transaction_id: null }], total: 1, page: 1, page_size: 20 });
let client: SupabaseClient;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>();
  client = createClient(project, "sb_publishable_sms_test", {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: fetchMock },
  });
  vi.spyOn(client.auth, "getSession").mockResolvedValue({ data: { session: session() }, error: null });
});
afterEach(() => vi.restoreAllMocks());

describe("account-bound SMS automation transport", () => {
  it("preserves validated detail, platform and masked evidence through inbox and confirmation", async () => {
    const metadata = { subcategory: "咖啡奶茶", platform: "美团", smsEvidence: { text: "尾号****卡消费30.90元，余额****。【工商银行】", receivedAt: at, classificationReason: "明确咖啡商户", ruleVersion: "local-life-v1" } };
    const value = inbox(); Object.assign(value.items[0].draft!, metadata, { category: "本地生活" });
    fetchMock.mockResolvedValueOnce(response(value)).mockResolvedValueOnce(response({ status: "recorded", transaction_id: `sms-${inboxId}` }));
    const received = (await fetchSmsInbox(client, alice, { page: 1, pageSize: 20 })).items[0].draft!;
    expect(received).toEqual(value.items[0].draft);
    await confirmSms(client, alice, inboxId, { ...received, subcategory: "堂食" });
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).p_draft).toEqual({ ...received, subcategory: "堂食" });
  });

  it("normalizes legacy response categories while retaining explicit details", async () => {
    const value = inbox(); Object.assign(value.items[0].draft!, { category: "餐饮" });
    fetchMock.mockResolvedValueOnce(response(value));
    expect((await fetchSmsInbox(client, alice, { page: 1, pageSize: 20 })).items[0].draft).toMatchObject({ category: "本地生活", subcategory: "餐饮" });
  });

  it.each([
    { subcategory: "" }, { subcategory: "x".repeat(41) }, { platform: "未知平台" },
    { smsEvidence: { text: "" } }, { smsEvidence: { text: "x".repeat(3001) } },
    { smsEvidence: { text: "脱敏", receivedAt: "2026-02-30T12:00:00Z" } },
    { smsEvidence: { text: "脱敏", classificationReason: "x".repeat(201) } },
    { smsEvidence: { text: "脱敏", ruleVersion: "x".repeat(65) } },
    { smsEvidence: { text: "脱敏", rawText: "不接受额外字段" } },
  ])("rejects malformed optional draft metadata before IO: %j", async metadata => {
    await expect(confirmSms(client, alice, inboxId, Object.assign(draft(), metadata))).rejects.toThrow("有效的短信金额");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("reprocesses only the captured account's pending inbox without accepting an owner or ledger payload", async () => {
    fetchMock.mockResolvedValue(response({ recorded_count: 4, pending_count: 2 }));
    expect(await reprocessPendingSms(client, alice)).toEqual({ recorded_count: 4, pending_count: 2 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(new URL(String(url)).pathname).toBe("/rest/v1/rpc/moneytrail_sms_reprocess_pending");
    expect(JSON.parse(String(init?.body))).toEqual({});
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer token-A");
  });

  it("explains a missing rule upgrade and rejects invalid reprocessing acknowledgements", async () => {
    fetchMock.mockResolvedValueOnce(response({ code: "PGRST202", message: "PRIVATE" }, 404));
    await expect(reprocessPendingSms(client, alice)).rejects.toBeInstanceOf(SmsUpgradeError);
    for (const data of [{ recorded_count: -1, pending_count: 1 }, { recorded_count: 201, pending_count: 0 }, { recorded_count: 1, pending_count: 0.5 }, { recorded_count: 1, pending_count: 0, ledger: {} }]) {
      fetchMock.mockResolvedValueOnce(response(data));
      await expect(reprocessPendingSms(client, alice)).rejects.toThrow("格式不正确");
    }
  });
  it("sends only capability settings to their named RPCs, without an owner or stored SMS token", async () => {
    fetchMock.mockResolvedValueOnce(response(config()))
      .mockResolvedValueOnce(response({ token: capability, config: config() }))
      .mockResolvedValueOnce(response({ ...config(), mode: "review" }))
      .mockResolvedValueOnce(response({ ...config(), enabled: false }));
    expect(await fetchSmsConfig(client, alice)).toEqual(config());
    expect(await rotateSmsToken(client, alice, "auto")).toEqual({ token: capability, config: config() });
    expect((await setSmsMode(client, alice, "review")).mode).toBe("review");
    expect((await revokeSmsToken(client, alice)).enabled).toBe(false);
    expect(fetchMock.mock.calls.map(([url, init]) => ({ path: new URL(String(url)).pathname, body: JSON.parse(String(init?.body)), method: init?.method }))).toEqual([
      { path: "/rest/v1/rpc/moneytrail_sms_config", body: {}, method: "POST" },
      { path: "/rest/v1/rpc/moneytrail_sms_rotate", body: { p_mode: "auto" }, method: "POST" },
      { path: "/rest/v1/rpc/moneytrail_sms_set_mode", body: { p_mode: "review" }, method: "POST" },
      { path: "/rest/v1/rpc/moneytrail_sms_revoke", body: {}, method: "POST" },
    ]);
    for (const [url, init] of fetchMock.mock.calls) {
      expect(String(url)).not.toContain(capability);
      expect(String(init?.body)).not.toContain(capability);
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer token-A");
    }
  });

  it("captures the original account bearer before a later SDK session switch", async () => {
    vi.mocked(client.auth.getSession).mockResolvedValueOnce({ data: { session: session() }, error: null })
      .mockResolvedValue({ data: { session: session(bob, "token-B") }, error: null });
    fetchMock.mockImplementation(async (_url, init) => {
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer token-A");
      return response({ token: capability, config: config() });
    });
    expect((await rotateSmsToken(client, alice, "auto")).token).toBe(capability);
  });

  it.each([null, session(bob)])("rejects missing or changed accounts before a write", async (current) => {
    vi.mocked(client.auth.getSession).mockResolvedValue(current
      ? { data: { session: current }, error: null }
      : { data: { session: null }, error: null });
    await expect(rotateSmsToken(client, alice, "auto")).rejects.toThrow("账号已发生变化");
    await expect(confirmSms(client, alice, inboxId, draft())).rejects.toThrow("账号已发生变化");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches a bounded inbox and confirms only the edited draft and message ID", async () => {
    fetchMock.mockResolvedValueOnce(response(inbox()))
      .mockResolvedValueOnce(response({ status: "recorded", transaction_id: `sms-${inboxId}` }))
      .mockResolvedValueOnce(response({ status: "dismissed" }));
    expect(await fetchSmsInbox(client, alice, { page: 1, pageSize: 20 })).toEqual(inbox());
    const edited = { ...draft(), kind: "transfer" as const, note: "纯转账" };
    expect(await confirmSms(client, alice, inboxId, edited)).toEqual({ status: "recorded", transaction_id: `sms-${inboxId}` });
    expect(await dismissSms(client, alice, inboxId)).toEqual({ status: "dismissed" });
    expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
      { p_page: 1, p_page_size: 20 }, { p_id: inboxId, p_draft: edited }, { p_id: inboxId },
    ]);
  });

  it("keeps processed entries free of original text and validates their fixed transaction identity", async () => {
    const data = inbox();
    Object.assign(data.items[0], { status: "recorded", raw_text: null, transaction_id: `sms-${inboxId}` });
    fetchMock.mockResolvedValue(response(data));
    expect((await fetchSmsInbox(client, alice, { page: 1, pageSize: 20 })).items[0].raw_text).toBe(null);
    data.items[0].raw_text = "account balance must not survive processing";
    fetchMock.mockResolvedValue(response(data));
    await expect(fetchSmsInbox(client, alice, { page: 1, pageSize: 20 })).rejects.toThrow("格式不正确");
  });

  it.each(["PGRST202", "42883", "42P01", "PGRST205"])("explains missing setup %s without exposing backend diagnostics", async (code) => {
    fetchMock.mockResolvedValue(response({ code, message: "PRIVATE DIAGNOSTIC" }, 404));
    const task = fetchSmsConfig(client, alice);
    await expect(task).rejects.toBeInstanceOf(SmsSetupError);
    await expect(task).rejects.not.toThrow("PRIVATE DIAGNOSTIC");
  });

  it("maps account and network errors without leaking original exceptions", async () => {
    fetchMock.mockResolvedValueOnce(response({ code: "42501", message: "PRIVATE" }, 403));
    await expect(fetchSmsInbox(client, alice, { page: 1, pageSize: 20 })).rejects.toThrow("邮箱已验证");
    fetchMock.mockResolvedValueOnce(response({ code: "28000", message: "PRIVATE" }, 400));
    await expect(revokeSmsToken(client, alice)).rejects.toThrow("登录状态已过期");
    fetchMock.mockRejectedValueOnce(new Error("private network credentials"));
    const task = fetchSmsConfig(client, alice);
    await expect(task).rejects.toThrow("检查网络");
    await expect(task).rejects.not.toThrow("credentials");
  });

  it("explains merchant rule capacity without exposing backend diagnostics", async () => {
    const { setSmsCategoryRule } = await import("./smsClient");
    fetchMock.mockResolvedValue(response({ code: "54000", message: "PRIVATE" }, 400));
    await expect(setSmsCategoryRule(client, alice, "星辰小馆", "本地生活")).rejects.toThrow("商户规则已达上限");
  });

  it("rejects invalid inputs before session access or network calls", async () => {
    await expect(fetchSmsInbox(client, alice, { page: 0, pageSize: 20 })).rejects.toThrow("页码无效");
    await expect(fetchSmsInbox(client, alice, { page: 1, pageSize: 51 })).rejects.toThrow("页码无效");
    await expect(setSmsMode(client, alice, "unexpected" as "auto")).rejects.toThrow("有效的短信记账方式");
    await expect(dismissSms(client, alice, "forged")).rejects.toThrow("编号无效");
    await expect(confirmSms(client, alice, inboxId, { ...draft(), amountCents: 1.1 })).rejects.toThrow("有效的短信金额");
    await expect(confirmSms(client, alice, inboxId, { ...draft(), date: "2026-02-30T12:00" })).rejects.toThrow("有效的短信金额");
    await expect(confirmSms(client, alice, inboxId, Object.assign(draft(), { sourceRef: "target another transaction" }))).rejects.toThrow("有效的短信金额");
    expect(client.auth.getSession).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    (value: SmsConfig) => { value.pending_count = 201; },
    (value: SmsConfig) => { value.enabled = "true" as unknown as boolean; },
    (value: SmsConfig) => { value.created_at = null; },
    (value: SmsConfig) => { value.last_received_at = "2026-02-30T12:00:00Z"; },
    (value: SmsConfig) => { Object.assign(value, { token: capability }); },
  ])("rejects malformed or secret-expanded configuration", async (alter) => {
    const value = config(); alter(value); fetchMock.mockResolvedValue(response(value));
    await expect(fetchSmsConfig(client, alice)).rejects.toThrow("格式不正确");
  });

  it.each([
    (value: SmsInbox) => { value.items[0].draft!.amountCents = -1; },
    (value: SmsInbox) => { value.items[0].draft!.source = "manual" as "sms"; },
    (value: SmsInbox) => { value.items[0].draft!.category = "other"; },
    (value: SmsInbox) => { value.items[0].warnings = ["x".repeat(501)]; },
    (value: SmsInbox) => { value.items[0].raw_text = "x".repeat(2001); },
    (value: SmsInbox) => { value.items[0].transaction_id = `sms-${bob}`; },
    (value: SmsInbox) => { value.page = 2; },
    (value: SmsInbox) => { value.page_size = 50; },
    (value: SmsInbox) => { value.total = 0; },
    (value: SmsInbox) => { value.items.push(value.items[0]); value.total = 2; },
    (value: SmsInbox) => { Object.assign(value.items[0], { user_id: bob }); },
  ])("rejects invalid, overbroad, or inconsistent inbox responses", async (alter) => {
    const value = inbox(); alter(value); fetchMock.mockResolvedValue(response(value));
    await expect(fetchSmsInbox(client, alice, { page: 1, pageSize: 20 })).rejects.toThrow("格式不正确");
  });

  it("refuses an invalid capability and acknowledgements for a different record", async () => {
    fetchMock.mockResolvedValueOnce(response({ token: "mt_sms_short", config: config() }))
      .mockResolvedValueOnce(response({ status: "recorded", transaction_id: `sms-${bob}` }))
      .mockResolvedValueOnce(response({ status: "recorded" }));
    await expect(rotateSmsToken(client, alice, "auto")).rejects.toThrow("格式不正确");
    await expect(confirmSms(client, alice, inboxId, draft())).rejects.toThrow("格式不正确");
    await expect(dismissSms(client, alice, inboxId)).rejects.toThrow("格式不正确");
  });

  it("stops requests before capture and discards responses arriving after cancellation", async () => {
    const before = new AbortController(); before.abort();
    await expect(fetchSmsConfig(client, alice, before.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(client.auth.getSession).not.toHaveBeenCalled();
    const capture = new AbortController();
    vi.mocked(client.auth.getSession).mockImplementationOnce(async () => { capture.abort(); return { data: { session: session() }, error: null }; });
    await expect(rotateSmsToken(client, alice, "auto", capture.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).not.toHaveBeenCalled();
    const late = new AbortController();
    fetchMock.mockImplementation(async () => { late.abort(); return response(inbox()); });
    await expect(fetchSmsInbox(client, alice, { page: 1, pageSize: 20 }, late.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});

// Classification transport stays account-bound and rejects unsafe selections before IO.
describe("classification RPCs", () => {
  it("reads remembered detail and normalizes legacy categories with their detail", async () => {
    const { fetchSmsCategoryRules } = await import("./smsClient");
    const rules = [{ merchant: "北京轨道交通", category: "交通", subcategory: "公共交通" }, { merchant: "巷口咖啡", category: "本地生活", subcategory: "未细分" }, { merchant: "示例饭馆", category: "餐饮" }, { merchant: "示例俱乐部", category: "娱乐" }];
    fetchMock.mockResolvedValueOnce(response({ rules }));
    expect(await fetchSmsCategoryRules(client, alice)).toEqual([rules[0], rules[1], { merchant: "示例饭馆", category: "本地生活", subcategory: "餐饮" }, { merchant: "示例俱乐部", category: "本地生活", subcategory: "休闲娱乐" }]);
  });
  it("saves detail through the new RPC and keeps category-only calls compatible", async () => {
    const { setSmsCategoryRule } = await import("./smsClient");
    fetchMock.mockResolvedValueOnce(response({ rules: [{ merchant: "北京轨道交通", category: "交通", subcategory: "公共交通" }] })).mockResolvedValueOnce(response({ rules: [] }));
    expect(await setSmsCategoryRule(client, alice, "消费抖音支付-北京轨道交通", "交通", undefined, "公共交通")).toEqual([{ merchant: "北京轨道交通", category: "交通", subcategory: "公共交通" }]);
    await setSmsCategoryRule(client, alice, "北京轨道交通", "交通");
    expect(fetchMock.mock.calls.map(([url, init]) => ({ path: new URL(String(url)).pathname, body: JSON.parse(String(init?.body)) }))).toEqual([
      { path: "/rest/v1/rpc/moneytrail_sms_set_merchant_rule", body: { p_merchant: "消费抖音支付-北京轨道交通", p_category: "交通", p_subcategory: "公共交通" } },
      { path: "/rest/v1/rpc/moneytrail_sms_set_category_rule", body: { p_merchant: "北京轨道交通", p_category: "交通" } },
    ]);
  });
  it("confirms and remembers a concrete merchant atomically only when requested", async () => {
    const saved = { ...draft(), merchant: "消费抖音支付-北京轨道交通", category: "交通", subcategory: "未细分" };
    fetchMock.mockImplementation(async () => response({ status: "recorded", transaction_id: `sms-${inboxId}` }));
    await confirmSms(client, alice, inboxId, saved, undefined, true);
    await confirmSms(client, alice, inboxId, saved, undefined, false);
    expect(fetchMock.mock.calls.map(([url, init]) => ({ path: new URL(String(url)).pathname, body: JSON.parse(String(init?.body)) }))).toEqual([
      { path: "/rest/v1/rpc/moneytrail_sms_confirm_with_rule", body: { p_id: inboxId, p_draft: saved, p_remember: true } },
      { path: "/rest/v1/rpc/moneytrail_sms_confirm", body: { p_id: inboxId, p_draft: saved } },
    ]);
  });
  it("rejects unsafe remembering and invalid detail before session access", async () => {
    const { setSmsCategoryRule } = await import("./smsClient");
    for (const merchant of ["待补充商户", "京东", "滴滴", "抖音支付", "财付通-群收款"]) {
      await expect(setSmsCategoryRule(client, alice, merchant, "购物")).rejects.toThrow();
      await expect(confirmSms(client, alice, inboxId, { ...draft(), merchant, category: "购物" }, undefined, true)).rejects.toThrow();
    }
    for (const kind of ["refund", "transfer", "income"] as const) {
      await expect(confirmSms(client, alice, inboxId, { ...draft(), merchant: "示例商店", category: "购物", kind }, undefined, true)).rejects.toThrow();
    }
    await expect(confirmSms(client, alice, inboxId, { ...draft(), merchant: "示例商店" }, undefined, true)).rejects.toThrow();
    for (const subcategory of ["", " ", "x".repeat(41), "x\u0000"]) {
      await expect(setSmsCategoryRule(client, alice, "示例商店", "购物", undefined, subcategory)).rejects.toThrow();
    }
    expect(client.auth.getSession).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("explains missing upgraded RPCs when remembering a merchant", async () => {
    const { setSmsCategoryRule } = await import("./smsClient");
    fetchMock.mockImplementation(async () => response({ code: "PGRST202" }, 404));
    await expect(setSmsCategoryRule(client, alice, "北京轨道交通", "交通", undefined, "公共交通")).rejects.toBeInstanceOf(SmsUpgradeError);
    await expect(confirmSms(client, alice, inboxId, { ...draft(), merchant: "北京轨道交通", category: "交通" }, undefined, true)).rejects.toBeInstanceOf(SmsUpgradeError);
  });
  it("retains optional metadata in pending previews and batch apply", async () => {
    const api = await import("./smsClient");
    const metadataDraft = { ...draft(), category: "本地生活", subcategory: "外卖", platform: "美团" as const, smsEvidence: { text: "卡尾号****，消费30.90元，余额****。", classificationReason: "平台及外卖用途", ruleVersion: "local-life-v1" } };
    const item = { id: inboxId, draft: metadataDraft, eligible: true, reason: "明确用途" };
    fetchMock.mockResolvedValueOnce(response({ items: [item], recordable_count: 1, pending_count: 1 })).mockResolvedValueOnce(response({ recorded_count: 1, pending_count: 0 }));
    const preview = await api.previewPendingSms(client, alice);
    expect(preview.items).toEqual([item]);
    await api.applyPendingSms(client, alice, [{ id: inboxId, draft: preview.items[0].draft! }]);
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({ p_items: [{ id: inboxId, draft: metadataDraft }] });
  });
  it.each(["美团", "消费美团支付-美团北京三快在线科技有限公司", "北京三快科技有限公司", "美团支付"])("rejects a platform-wide category rule for %s before IO", async merchant => {
    const api = await import("./smsClient");
    fetchMock.mockResolvedValue(response({ rules: [] }));
    await expect(api.setSmsCategoryRule(client, alice, merchant, "本地生活")).rejects.toThrow("平台默认归入本地生活，细类未细分");
    expect(client.auth.getSession).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each(["美团", "美团支付", "北京三快在线科技有限公司"])("allows deletion of an old platform rule for %s", async merchant => {
    const api = await import("./smsClient");
    fetchMock.mockResolvedValue(response({ rules: [] }));
    expect(await api.setSmsCategoryRule(client, alice, merchant, null)).toEqual([]);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ p_merchant: merchant, p_category: null });
  });
  it("saves concrete Meituan-purpose merchants without blocking other exact merchant rules", async () => {
    const api = await import("./smsClient");
    for (const merchant of ["美团酒店", "美团-巷口咖啡", "示例科技有限公司"]) {
      fetchMock.mockResolvedValueOnce(response({ rules: [{ merchant, category: "娱乐" }] }));
      expect(await api.setSmsCategoryRule(client, alice, merchant, "本地生活")).toEqual([{ merchant, category: "本地生活", subcategory: "休闲娱乐" }]);
    }
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
  it("reads rules, previews without writes and applies exactly the selected drafts", async () => {
    const api = await import("./smsClient");
    const item = { id: inboxId, draft: { ...draft(), merchant: "滴滴", category: "交通" }, eligible: true, reason: "交通商户" };
    fetchMock.mockResolvedValueOnce(response({ rules: [{ merchant: "滴滴", category: "交通" }] }))
      .mockResolvedValueOnce(response({ items: [item], recordable_count: 1, pending_count: 1 }))
      .mockResolvedValueOnce(response({ recorded_count: 1, pending_count: 0 }));
    expect(await api.fetchSmsCategoryRules(client, alice)).toEqual([{ merchant: "滴滴", category: "交通" }]);
    expect((await api.previewPendingSms(client, alice)).items).toEqual([item]);
    expect(await api.applyPendingSms(client, alice, [{ id: item.id, draft: item.draft }])).toEqual({ recorded_count: 1, pending_count: 0 });
    expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body))).toEqual({ p_items: [{ id: item.id, draft: item.draft }] });
    expect(new Headers(fetchMock.mock.calls[2][1]?.headers).get("Authorization")).toBe("Bearer token-A");
  });
  it("rejects invalid selections/rules, malformed preview and missing migration", async () => {
    const api = await import("./smsClient");
    await expect(api.applyPendingSms(client, alice, [])).rejects.toThrow();
    await expect(api.applyPendingSms(client, alice, [{ id: inboxId, draft: draft() }, { id: inboxId, draft: draft() }])).rejects.toThrow();
    await expect(api.setSmsCategoryRule(client, alice, "财付通-群收款", "购物")).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(response({ items: [{ id: inboxId, draft: null, eligible: true, reason: "x" }], recordable_count: 1, pending_count: 1 }));
    await expect(api.previewPendingSms(client, alice)).rejects.toThrow("格式不正确");
    fetchMock.mockResolvedValueOnce(response({ code: "PGRST202" }, 404));
    await expect(api.fetchSmsCategoryRules(client, alice)).rejects.toBeInstanceOf(SmsUpgradeError);
  });
  it("cancels late preview and refuses a different account", async () => {
    const api = await import("./smsClient");
    vi.mocked(client.auth.getSession).mockResolvedValueOnce({ data: { session: session(bob) }, error: null });
    await expect(api.previewPendingSms(client, alice)).rejects.toThrow();
    const controller = new AbortController();
    fetchMock.mockImplementationOnce(async () => { controller.abort(); return response({ rules: [] }); });
    await expect(api.fetchSmsCategoryRules(client, alice, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});

it.each([
  { rules: [{ merchant: "", category: "购物" }] },
  { rules: [{ merchant: "店铺", category: "待分类" }] },
  { rules: [{ merchant: "店铺", category: "未知" }] },
  { rules: [{ merchant: "店铺", category: "购物", owner: alice }] },
  { rules: [{ merchant: "店铺", category: "购物", subcategory: "" }] },
  { rules: [{ merchant: "店铺", category: "购物", subcategory: " " }] },
  { rules: [{ merchant: "店铺", category: "购物", subcategory: "x".repeat(41) }] },
  { rules: [{ merchant: "店铺", category: "购物", subcategory: null }] },
  { rules: [{ merchant: "店铺", category: "购物", subcategory: 1 }] },
  { rules: [{ merchant: "店铺", category: "购物", subcategory: "x\u0000" }] },
  { rules: [{ merchant: "店铺", category: "购物" }, { merchant: "店铺", category: "购物" }] },
])("rejects malformed personal rule responses", async value => {
  const { fetchSmsCategoryRules } = await import("./smsClient");
  fetchMock.mockResolvedValueOnce(response(value));
  await expect(fetchSmsCategoryRules(client, alice)).rejects.toThrow("格式不正确");
});
it("deletes an exact personal rule with null category and validates its response", async () => {
  const { setSmsCategoryRule } = await import("./smsClient");
  fetchMock.mockResolvedValueOnce(response({ rules: [] }));
  expect(await setSmsCategoryRule(client, alice, "巷口咖啡", null)).toEqual([]);
  expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ p_merchant: "巷口咖啡", p_category: null });
});
