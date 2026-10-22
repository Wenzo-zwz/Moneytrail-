import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";
import { AdminAccessError, AdminSetupError, fetchAdminAccess, fetchAdminOverview, type AdminOverview, type AdminOverviewOptions } from "./adminClient";

const project = "https://admin-test.supabase.co";
const userA = "11111111-1111-4111-8111-111111111111";
const userB = "22222222-2222-4222-8222-222222222222";
const at = "2026-10-22T12:00:00.123456+00:00";
const options: AdminOverviewOptions = { query: "", page: 1, pageSize: 20 };
const session = (id = userA, token = "token-A") => ({ user: { id }, access_token: token, refresh_token: "refresh", token_type: "bearer", expires_in: 3600 }) as Session;
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
const fixture = (): AdminOverview => ({
  totals: { users: 2, confirmed_users: 1, new_users_7d: 2, ledgers: 1, synced_24h: 1 },
  users: [{ id: userA, email: "owner@example.test", created_at: at, email_confirmed_at: at, last_sign_in_at: at, ledger_updated_at: at, transaction_count: 3 },
    { id: userB, email: null, created_at: null, email_confirmed_at: null, last_sign_in_at: null, ledger_updated_at: null, transaction_count: 0 }],
  total: 2, page: 1, page_size: 20,
});
let client: SupabaseClient;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>();
  client = createClient(project, "sb_publishable_admin_test", {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: fetchMock },
  });
  vi.spyOn(client.auth, "getSession").mockResolvedValue({ data: { session: session() }, error: null });
});
afterEach(() => vi.restoreAllMocks());

describe("single owner admin transport", () => {
  it("uses only the server boolean for the access decision, never an account email or metadata", async () => {
    fetchMock.mockResolvedValueOnce(response(false)).mockResolvedValueOnce(response(true));
    expect(await fetchAdminAccess(client, userA)).toBe(false);
    expect(await fetchAdminAccess(client, userA)).toBe(true);
    for (const [url, init] of fetchMock.mock.calls) {
      expect(String(url)).toBe(`${project}/rest/v1/rpc/moneytrail_is_admin`);
      expect(JSON.parse(String(init?.body))).toEqual({});
      expect(init?.method).toBe("POST");
    }
  });

  it("binds access checks to the captured token even if the SDK session changes afterward", async () => {
    vi.mocked(client.auth.getSession).mockResolvedValueOnce({ data: { session: session() }, error: null })
      .mockResolvedValue({ data: { session: session(userB, "token-B") }, error: null });
    fetchMock.mockImplementation(async (_url, init) => {
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer token-A");
      return response(true);
    });
    expect(await fetchAdminAccess(client, userA)).toBe(true);
    expect(client.auth.getSession).toHaveBeenCalledTimes(2);
  });

  it("requests a bounded metadata overview and never sends a target owner or ledger payload", async () => {
    fetchMock.mockResolvedValue(response(fixture()));
    expect(await fetchAdminOverview(client, userA, { ...options, query: "  example.test  " })).toEqual(fixture());
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(`${project}/rest/v1/rpc/moneytrail_admin_overview`);
    expect(JSON.parse(String(init?.body))).toEqual({ p_query: "example.test", p_page: 1, p_page_size: 20 });
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer token-A");
  });

  it("also captures the overview bearer before a later SDK account switch", async () => {
    vi.mocked(client.auth.getSession).mockResolvedValueOnce({ data: { session: session() }, error: null })
      .mockResolvedValue({ data: { session: session(userB, "token-B") }, error: null });
    fetchMock.mockImplementation(async (_url, init) => {
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer token-A");
      return response(fixture());
    });
    expect((await fetchAdminOverview(client, userA, options)).users[0].id).toBe(userA);
  });

  it.each([null, session(userB)])("refuses a missing or different current account before requesting metadata", async (current) => {
    vi.mocked(client.auth.getSession).mockResolvedValue(current
      ? { data: { session: current }, error: null }
      : { data: { session: null }, error: null });
    await expect(fetchAdminAccess(client, userA)).rejects.toThrow("账号已发生变化");
    await expect(fetchAdminOverview(client, userA, options)).rejects.toThrow("账号已发生变化");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("authorizes every overview call at the server even after an earlier positive access check", async () => {
    fetchMock.mockResolvedValueOnce(response(true)).mockResolvedValueOnce(response({ code: "42501", message: "internal diagnostic" }, 403));
    expect(await fetchAdminAccess(client, userA)).toBe(true);
    await expect(fetchAdminOverview(client, userA, options)).rejects.toBeInstanceOf(AdminAccessError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(["PGRST202", "42883", "42P01", "PGRST205"])("explains absent backend setup for %s without printing server diagnostics", async (code) => {
    fetchMock.mockResolvedValue(response({ code, message: "internal diagnostic" }, 404));
    const request = fetchAdminAccess(client, userA);
    await expect(request).rejects.toBeInstanceOf(AdminSetupError);
    await expect(request).rejects.not.toThrow("internal diagnostic");
  });

  it.each([["PGRST301", 401], ["PGRST302", 400], ["28000", 400]])("explains an expired login for %s", async (code, status) => {
    fetchMock.mockResolvedValue(response({ code, message: "internal diagnostic" }, status));
    const request = fetchAdminOverview(client, userA, options);
    await expect(request).rejects.toBeInstanceOf(AdminAccessError);
    await expect(request).rejects.toThrow("登录状态已过期");
  });

  it("reports a generic network error and never returns stale fixture data", async () => {
    fetchMock.mockRejectedValue(new Error("private fetch diagnostic"));
    const request = fetchAdminOverview(client, userA, options);
    await expect(request).rejects.toThrow("检查网络");
    await expect(request).rejects.not.toThrow("private fetch diagnostic");
  });

  it.each(["true", { is_admin: true }, null, 1, []])("rejects non-boolean access response %j", async (value) => {
    fetchMock.mockResolvedValue(response(value));
    await expect(fetchAdminAccess(client, userA)).rejects.toThrow("管理数据格式不正确");
  });

  it.each([
    { query: "x".repeat(201), page: 1, pageSize: 20 },
    { query: "", page: 0, pageSize: 20 },
    { query: "", page: 1.5, pageSize: 20 },
    { query: "", page: 1_000_001, pageSize: 20 },
    { query: "", page: 1, pageSize: 0 },
    { query: "", page: 1, pageSize: 51 },
  ])("rejects invalid filters before session access or a request", async (invalid) => {
    await expect(fetchAdminOverview(client, userA, invalid)).rejects.toThrow("查询条件无效");
    expect(client.auth.getSession).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows an empty valid page beyond the last result and copies only known metadata fields", async () => {
    const payload = { ...fixture(), page: 2, users: [] };
    fetchMock.mockResolvedValue(response(payload));
    const result = await fetchAdminOverview(client, userA, { ...options, page: 2 });
    expect(result).toEqual(payload);
    expect(result).not.toBe(payload);
  });

  it("rejects an oversized user page even when its counts and identifiers are otherwise valid", async () => {
    const payload = fixture();
    payload.totals.users = 21; payload.total = 21;
    payload.users = Array.from({ length: 21 }, (_, index) => ({
      ...payload.users[0], id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    }));
    fetchMock.mockResolvedValue(response(payload));
    await expect(fetchAdminOverview(client, userA, options)).rejects.toThrow("管理数据格式不正确");
  });

  it.each([
    (data: AdminOverview) => { data.totals.users = -1; },
    (data: AdminOverview) => { data.totals.ledgers = Number.MAX_SAFE_INTEGER + 1; },
    (data: AdminOverview) => { data.totals.synced_24h = 2; },
    (data: AdminOverview) => { data.totals.confirmed_users = 3; },
    (data: AdminOverview) => { data.total = 3; },
    (data: AdminOverview) => { data.page = 2; },
    (data: AdminOverview) => { data.page_size = 50; },
    (data: AdminOverview) => { data.users[0].id = "forged"; },
    (data: AdminOverview) => { data.users[1].id = userA; },
    (data: AdminOverview) => { data.users[0].created_at = "2026-02-30T12:00:00Z"; },
    (data: AdminOverview) => { data.users[0].email = "x".repeat(321); },
    (data: AdminOverview) => { data.users[0].email = "x\ny@example.test"; },
    (data: AdminOverview) => { data.users[0].transaction_count = 1.5; },
    (data: AdminOverview) => { Object.assign(data.users[0], { transactions: [{ amountCents: 100 }] }); },
    (data: AdminOverview) => { Object.assign(data, { access_token: "do-not-display" }); },
  ])("rejects malformed or expanded metadata payloads", async (alter) => {
    const payload = fixture(); alter(payload); fetchMock.mockResolvedValue(response(payload));
    await expect(fetchAdminOverview(client, userA, options)).rejects.toThrow("管理数据格式不正确");
  });

  it("aborts before capture, after capture, or before a late response is displayed", async () => {
    const first = new AbortController(); first.abort();
    await expect(fetchAdminAccess(client, userA, first.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(client.auth.getSession).not.toHaveBeenCalled();
    const second = new AbortController();
    vi.mocked(client.auth.getSession).mockImplementationOnce(async () => { second.abort(); return { data: { session: session() }, error: null }; });
    await expect(fetchAdminOverview(client, userA, options, second.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).not.toHaveBeenCalled();
    const third = new AbortController();
    fetchMock.mockImplementation(async () => { third.abort(); return response(fixture()); });
    await expect(fetchAdminOverview(client, userA, options, third.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});
