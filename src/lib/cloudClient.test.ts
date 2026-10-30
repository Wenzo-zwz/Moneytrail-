import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";
import {
  CloudConflictError, fetchCloudLedger, getCloudConfigError,
  pushCloudLedger, readCloudConfig,
} from "./cloudClient";
import { emptyData } from "./storage";

const project = "https://one.supabase.co";
const key = "sb_publishable_unit_test";
const userA = "11111111-1111-4111-8111-111111111111";
const userB = "22222222-2222-4222-8222-222222222222";
const timestamp = "2026-10-22T12:00:00.123456+00:00";
const jwt = (role: string) => `eyJhbGciOiJIUzI1NiJ9.${btoa(JSON.stringify({ role })).replaceAll("=", "").replaceAll("+", "-").replaceAll("/", "_")}.signature`;

describe("public cloud configuration", () => {
  it("normalizes public build values, including a legacy key behind an empty new-key field", () => {
    expect(readCloudConfig({ VITE_SUPABASE_URL: ` ${project}/ `, VITE_SUPABASE_PUBLISHABLE_KEY: ` ${key} ` }))
      .toEqual({ url: project, publishableKey: key });
    const legacy = jwt("anon");
    for (const blank of [undefined, null, "", "  "]) {
      const env = { VITE_SUPABASE_URL: project, VITE_SUPABASE_PUBLISHABLE_KEY: blank, VITE_SUPABASE_ANON_KEY: legacy };
      expect(readCloudConfig(env)).toEqual({ url: project, publishableKey: legacy });
      expect(getCloudConfigError(env)).toBeNull();
    }
    expect(readCloudConfig({ VITE_SUPABASE_URL: "http://localhost:54321", VITE_SUPABASE_PUBLISHABLE_KEY: key })?.url).toBe("http://localhost:54321");
  });

  it.each([
    "http://one.supabase.co", `${project}/rest/v1`, `${project}/?apikey=x`, `${project}/#secret`,
    "https://person:password@one.supabase.co", "javascript:alert(1)", "not a URL",
  ])("rejects unsafe project address %s", (url) => {
    expect(readCloudConfig({ VITE_SUPABASE_URL: url, VITE_SUPABASE_PUBLISHABLE_KEY: key })).toBeNull();
  });

  it.each(["sb_secret_admin", jwt("service_role"), jwt("authenticated"), "unknown", "sb_publishable_", 42])("rejects non-public key %s even if a legacy key also exists", (invalidKey) => {
    const env = { VITE_SUPABASE_URL: project, VITE_SUPABASE_PUBLISHABLE_KEY: invalidKey, VITE_SUPABASE_ANON_KEY: jwt("anon") };
    expect(readCloudConfig(env)).toBeNull();
    expect(getCloudConfigError(env)).toContain("公开密钥");
  });

  it("explains missing versus partial configuration without echoing values", () => {
    expect(getCloudConfigError({})).toBe("账号服务尚未配置。");
    expect(getCloudConfigError({ VITE_SUPABASE_PUBLISHABLE_KEY: key })).toContain("地址");
    expect(getCloudConfigError({ VITE_SUPABASE_URL: project })).toContain("公开密钥");
  });
});

function session(id = userA, token = "access-token-A"): Session {
  return { access_token: token, user: { id }, refresh_token: "refresh", token_type: "bearer", expires_in: 3600 } as Session;
}

function response(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

let client: SupabaseClient;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>();
  // Use the real PostgREST builder/fetchWithAuth implementation, with network calls intercepted.
  client = createClient(project, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: fetchMock },
  });
  vi.spyOn(client.auth, "getSession").mockResolvedValue({ data: { session: session() }, error: null });
});
afterEach(() => vi.restoreAllMocks());

describe("authenticated ledger transport", () => {
  it("submits matching explicit merchant memory in the same CAS RPC as the ledger", async () => {
    const transaction = { id: "one", kind: "expense" as const, amountCents: 2000, date: "2026-10-31T12:00", merchant: "星辰小馆", category: "本地生活", subcategory: "堂食", source: "manual" as const, note: "" };
    const data = { ...emptyData(), transactions: [transaction] };
    const rule = { transactionId: "one", merchant: "星辰小馆", category: "本地生活", subcategory: "堂食" };
    fetchMock.mockResolvedValue(response([{ data, revision: 2, updated_at: timestamp }]));
    await pushCloudLedger(client, data, 1, userA, undefined, [rule]);
    expect(String(fetchMock.mock.calls[0][0])).toBe(`${project}/rest/v1/rpc/save_moneytrail_ledger_with_rules`);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ p_data: data, p_expected_revision: 1, p_rules: [rule] });
  });
  it("binds a read to the captured account bearer and its own row filter", async () => {
    vi.mocked(client.auth.getSession)
      .mockResolvedValueOnce({ data: { session: session() }, error: null })
      .mockResolvedValue({ data: { session: session(userB, "access-token-B") }, error: null });
    fetchMock.mockImplementation(async (_url, init) => {
      // Even if the SDK's session changes after capture, it must not replace this header.
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer access-token-A");
      return response({ data: emptyData(), revision: 3, updated_at: timestamp });
    });
    expect(await fetchCloudLedger(client, userA)).toEqual({ data: emptyData(), revision: 3, updatedAt: timestamp });
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.pathname).toBe("/rest/v1/moneytrail_ledgers");
    expect(url.searchParams.get("user_id")).toBe(`eq.${userA}`);
    expect(client.auth.getSession).toHaveBeenCalledTimes(2);
  });

  it("captures a write's bearer before a later session change and sends no caller-selected owner", async () => {
    vi.mocked(client.auth.getSession).mockImplementation(async () => {
      vi.mocked(client.auth.getSession).mockResolvedValue({ data: { session: session(userB, "access-token-B") }, error: null });
      return { data: { session: session() }, error: null };
    });
    const source = { ...emptyData(), budgetCents: 500, user_id: userB, access_token: "never-upload" };
    fetchMock.mockImplementation(async (_url, init) => {
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer access-token-A");
      expect(JSON.parse(String(init?.body))).toEqual({ p_data: { ...emptyData(), budgetCents: 500 }, p_expected_revision: 7 });
      return response([{ data: { ...emptyData(), budgetCents: 500 }, revision: 8, updated_at: timestamp }]);
    });
    expect((await pushCloudLedger(client, source, 7, userA)).revision).toBe(8);
    expect(client.auth.getSession).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toBe(`${project}/rest/v1/rpc/save_moneytrail_ledger`);
  });

  it("refuses requests if the current session belongs to a different user or has disappeared", async () => {
    vi.mocked(client.auth.getSession).mockResolvedValue({ data: { session: session(userB) }, error: null });
    await expect(fetchCloudLedger(client, userA)).rejects.toThrow("账号已发生变化");
    await expect(pushCloudLedger(client, emptyData(), 0, userA)).rejects.toThrow("账号已发生变化");
    vi.mocked(client.auth.getSession).mockResolvedValue({ data: { session: null }, error: null });
    await expect(fetchCloudLedger(client, userA)).rejects.toThrow("账号已发生变化");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not initialize a remote ledger on read when no own row exists", async () => {
    fetchMock.mockResolvedValue(response(null));
    expect(await fetchCloudLedger(client, userA)).toEqual({ data: emptyData(), revision: 0, updatedAt: null });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]?.method).toBe("GET");
  });

  it("maps a stale revision to a conflict that preserves the caller's data", async () => {
    fetchMock.mockResolvedValue(response({ code: "40001", message: "private internal detail" }, 409));
    const data = { ...emptyData(), budgetCents: 1234 };
    const before = structuredClone(data);
    await expect(pushCloudLedger(client, data, 5, userA)).rejects.toBeInstanceOf(CloudConflictError);
    expect(data).toEqual(before);
  });

  it.each([
    ["42501", 403, "访问权限"], ["PGRST301", 401, "过期"],
    ["PGRST202", 404, "尚未开通"], ["22023", 400, "无效或过大"],
    ["54000", 400, "商户规则已达上限"], ["other", 500, "检查网络"],
  ])("maps %s failures without exposing backend diagnostics", async (code, status, expected) => {
    fetchMock.mockResolvedValue(response({ code, message: "secret diagnostic" }, status));
    const result = fetchCloudLedger(client, userA);
    await expect(result).rejects.toThrow(expected);
    await expect(result).rejects.not.toThrow("secret diagnostic");
  });

  it.each([
    [{ data: emptyData(), revision: 0, updated_at: timestamp }],
    [{ data: emptyData(), revision: 3.1, updated_at: timestamp }],
    [{ data: emptyData(), revision: 3, updated_at: "2026-02-30T12:00:00Z" }],
    [{ data: { ...emptyData(), budgetCents: -1 }, revision: 3, updated_at: timestamp }],
  ])("rejects malformed server snapshots before any cache write", async (row) => {
    fetchMock.mockResolvedValue(response(row));
    await expect(fetchCloudLedger(client, userA)).rejects.toThrow(/云端账目/);
  });

  it("requires an explicit one-row RPC confirmation with exactly the next revision", async () => {
    for (const data of [[], null, [{ data: emptyData(), revision: 8, updated_at: timestamp }]]) {
      fetchMock.mockResolvedValue(response(data));
      await expect(pushCloudLedger(client, emptyData(), 5, userA)).rejects.toThrow(/确认保存|意外/);
    }
  });

  it("rejects invalid payloads and revisions before authentication or network requests", async () => {
    await expect(pushCloudLedger(client, emptyData(), -1, userA)).rejects.toThrow("同步版本无效");
    await expect(pushCloudLedger(client, { ...emptyData(), budgetCents: 1.1 }, 0, userA)).rejects.toThrow("预算金额无效");
    expect(client.auth.getSession).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("cancels before capture and after capture without starting the ledger request", async () => {
    const first = new AbortController();
    first.abort();
    await expect(fetchCloudLedger(client, userA, first.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(client.auth.getSession).not.toHaveBeenCalled();
    const second = new AbortController();
    vi.mocked(client.auth.getSession).mockImplementation(async () => {
      second.abort();
      return { data: { session: session() }, error: null };
    });
    await expect(pushCloudLedger(client, emptyData(), 0, userA, second.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
