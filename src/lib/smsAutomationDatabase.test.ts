/** Real PostgreSQL capability/ACL tests; fixture claims do not verify hosted JWT signatures. */
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import ledgerMigration from "../../supabase/migrations/202610220001_ledger_accounts.sql?raw";
import parserMigration from "../../supabase/migrations/202610220003_sms_parser.sql?raw";
import smsMigration from "../../supabase/migrations/202610220004_sms_automation.sql?raw";
import { emptyData } from "./storage";

const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const UNVERIFIED = "33333333-3333-4333-8333-333333333333";
let db: PGlite;
let date: string;
let currentMonth: string;
type Config = { enabled: boolean; mode: "review" | "auto"; created_at: string | null; last_received_at: string | null; pending_count: number };
type Item = { id: string; status: "pending" | "recorded" | "dismissed"; raw_text: string | null; draft: Record<string, unknown> | null; warnings: string[]; reason: string | null; transaction_id: string | null };
type Inbox = { items: Item[]; total: number; page: number; page_size: number };
type Receipt = { accepted: boolean; status: string; id: string };
const draft = { kind: "expense", amountCents: 3090, date: "2026-10-22T19:27", merchant: "财付通-群收款", category: "餐饮", source: "sms", note: "AA 晚餐" };

async function rpc<T>(name: string, args: unknown[] = []): Promise<T> {
  const values = args.map((_, i) => `$${i + 1}`).join(",");
  return (await db.query<{ result: T }>(`select public.${name}(${values}) as result`, args)).rows[0].result;
}
async function asUser<T>(id: string | null, run: () => Promise<T>, role: "anon" | "authenticated" = "authenticated"): Promise<T> {
  await db.exec(`set role ${role}`);
  await db.query("select pg_catalog.set_config('request.jwt.claims', $1, false)", [JSON.stringify({ role, ...(id ? { sub: id } : {}) })]);
  try { return await run(); }
  finally { await db.exec("reset role"); await db.query("select pg_catalog.set_config('request.jwt.claims', '', false)"); }
}
async function rotate(id = ALICE, mode = "auto") {
  return asUser(id, () => rpc<{ token: string; config: Config }>("moneytrail_sms_rotate", [mode]));
}
function message(detail = "消费-超市", amount = "30.90", extra = "") {
  return `尾号xxxx卡${date}支出(${detail})${amount}元，余额8xxxx元。${extra}【工商银行】`;
}
async function receive(token: string, text = message()) {
  return asUser(null, () => rpc<Receipt>("moneytrail_receive_sms", [token, text]), "anon");
}
async function inbox(id = ALICE, page = 1, pageSize = 20) {
  return asUser(id, () => rpc<Inbox>("moneytrail_sms_inbox", [page, pageSize]));
}
async function ledger(id = ALICE) {
  return (await db.query<{ data: ReturnType<typeof emptyData>; revision: number }>("select data, revision::integer as revision from public.moneytrail_ledgers where user_id=$1::uuid", [id])).rows[0];
}
async function tableCount() { return (await db.query<{ count: number }>("select count(*)::integer as count from moneytrail_private.sms_inbox")).rows[0].count; }

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create schema auth;
    create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz,deleted_at timestamptz);
    create function auth.uid() returns uuid language sql stable set search_path = '' as $$
      select (nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid
    $$;
    grant usage on schema public,auth to anon,authenticated;
  `);
  await db.exec(ledgerMigration);
  await db.exec(parserMigration);
  await db.exec(smsMigration);
  const local = (await db.query<{ date: string; month: string }>(`select to_char(now() at time zone 'Asia/Shanghai','FMMM月FMDD日HH24:MI') as date,to_char(now() at time zone 'Asia/Shanghai','YYYY-MM') as month`)).rows[0];
  date = local.date; currentMonth = local.month;
}, 30_000);
beforeEach(async () => {
  await db.exec(`reset role; truncate auth.users cascade;
    insert into auth.users(id,email,email_confirmed_at) values
      ('${ALICE}','alice@example.invalid',now()),('${BOB}','bob@example.invalid',now()),('${UNVERIFIED}','unverified@example.invalid',null);
  `);
});
afterAll(async () => { await db?.close(); });

describe("PostgreSQL scoped SMS automation", () => {
  it("is disabled until an active verified account explicitly creates a capability", async () => {
    expect(await asUser(ALICE, () => rpc<Config>("moneytrail_sms_config"))).toEqual({ enabled: false, mode: "auto", created_at: null, last_received_at: null, pending_count: 0 });
    const created = await rotate();
    expect(created.token).toMatch(/^mt_sms_[a-f0-9]{64}$/);
    expect(created.config).toMatchObject({ enabled: true, mode: "auto", pending_count: 0 });
    expect(created.config.created_at).toBeTruthy();
    const stored = (await db.query<Record<string, unknown>>("select * from moneytrail_private.sms_settings")).rows[0];
    expect(stored.token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(created.token);
    expect(JSON.stringify(await asUser(ALICE, () => rpc("moneytrail_sms_config")))).not.toContain(String(stored.token_hash));
  });

  it("rotates and revokes immediately without deleting the user's pending messages", async () => {
    const first = await rotate();
    await receive(first.token, message("转账财付通-群收款"));
    const next = await rotate(ALICE, "review");
    expect(next.token).not.toBe(first.token);
    expect(next.config).toMatchObject({ enabled: true, mode: "review", pending_count: 1 });
    await expect(receive(first.token)).rejects.toMatchObject({ code: "42501" });
    expect((await receive(next.token)).status).toBe("pending");
    const revoked = await asUser(ALICE, () => rpc<Config>("moneytrail_sms_revoke"));
    expect(revoked).toMatchObject({ enabled: false, pending_count: 2 });
    await expect(receive(next.token)).rejects.toMatchObject({ code: "42501" });
    expect((await inbox()).total).toBe(2);
  });

  it("rejects unverified, deleted and banned accounts for both setup and ingestion", async () => {
    await expect(rotate(UNVERIFIED)).rejects.toMatchObject({ code: "42501" });
    const { token } = await rotate();
    for (const patch of ["email_confirmed_at=null", "deleted_at=now()", "banned_until=now()+interval '1 hour'", "email=''"]) {
      await db.exec(`update auth.users set email='alice@example.invalid',email_confirmed_at=now(),deleted_at=null,banned_until=null where id='${ALICE}'`);
      await db.exec(`update auth.users set ${patch} where id='${ALICE}'`);
      await expect(receive(token)).rejects.toMatchObject({ code: "42501" });
      await expect(asUser(ALICE, () => rpc("moneytrail_sms_config"))).rejects.toMatchObject({ code: "42501" });
      await expect(asUser(ALICE, () => rpc("moneytrail_sms_revoke"))).rejects.toMatchObject({ code: "42501" });
    }
    expect(await tableCount()).toBe(0);
  });

  it("keeps the sample's group collection pending even in automatic mode", async () => {
    const { token } = await rotate();
    const text = message("转账财付通-群收款");
    const receipt = await receive(token, text);
    expect(receipt.status).toBe("pending");
    expect(await ledger()).toBeUndefined();
    const item = (await inbox()).items[0];
    expect(item).toMatchObject({ id: receipt.id, raw_text: text, status: "pending", transaction_id: null, draft: { kind: "expense", amountCents: 3090 } });
    expect(item.warnings.length).toBeGreaterThan(0);
    expect(await asUser(ALICE, () => rpc<Config>("moneytrail_sms_config"))).toMatchObject({ pending_count: 1 });
  });

  it("automatically records only a safely parsed expense and purges its original SMS", async () => {
    const { token } = await rotate();
    const receipt = await receive(token);
    expect(receipt).toMatchObject({ accepted: true, status: "recorded" });
    const saved = await ledger();
    expect(saved.revision).toBe(1);
    expect(saved.data.transactions).toMatchObject([{ id: `sms-${receipt.id}`, sourceRef: `sms-${receipt.id}`, kind: "expense", amountCents: 3090, source: "sms" }]);
    expect((await inbox()).items[0]).toMatchObject({ raw_text: null, transaction_id: `sms-${receipt.id}`, status: "recorded" });
    expect((await asUser(ALICE, () => rpc<Config>("moneytrail_sms_config"))).last_received_at).toBeTruthy();
  });

  it("review mode and unsupported expense formats cannot auto-record", async () => {
    const { token } = await rotate(ALICE, "review");
    expect((await receive(token)).status).toBe("pending");
    expect(await ledger()).toBeUndefined();
    await asUser(ALICE, () => rpc("moneytrail_sms_set_mode", ["auto"]));
    expect((await receive(token, "您今日支出30.90元【工商银行】")).status).toBe("pending");
    const unknown = (await inbox()).items.find(item => item.draft === null);
    expect(unknown?.reason).toBeTruthy();
    expect(await ledger()).toBeUndefined();
  });

  it("rejects OTPs and non-bank/unbounded input before retaining any text", async () => {
    const { token } = await rotate();
    for (const text of [message("消费", "30.90", "验证码123456"), message("消费", "30.90", "动态口令123456"), ...["OTP123", "ｏｔｐ１２３", "动态码123", "短信口令123", "verification123", "one-time123"].map(value => `工商银行支出${value}`), "支付宝支出30元", "工商银行验证码123456", "支出".repeat(1001), ""]) {
      await expect(receive(token, text)).rejects.toMatchObject({ code: "22023" });
    }
    expect(await tableCount()).toBe(0);
    expect(await ledger()).toBeUndefined();
    expect((await db.query<{ count: number }>("select receipt_count as count from moneytrail_private.sms_settings")).rows[0].count).toBe(0);
  });

  it("deduplicates the complete exact SMS for 24 hours without comparing only amounts", async () => {
    const { token } = await rotate();
    const first = await receive(token);
    expect(await receive(token)).toEqual({ accepted: true, status: "duplicate", id: first.id });
    expect((await ledger()).data.transactions).toHaveLength(1);
    const other = await receive(token, message().replace("余额8xxxx", "余额9xxxx"));
    expect(other.status).toBe("pending");
    expect(other.id).not.toBe(first.id);
    expect((await ledger()).data.transactions).toHaveLength(1);
    await db.query("update moneytrail_private.sms_inbox set received_at=now()-interval '25 hours' where id=$1::uuid", [first.id]);
    expect((await receive(token)).status).toBe("pending");
    expect((await ledger()).data.transactions).toHaveLength(1);
  });

  it("caps daily submissions including duplicate attempts and resets on a new Shanghai day", async () => {
    const { token } = await rotate();
    await db.exec(`update moneytrail_private.sms_settings set receipt_day=(now() at time zone 'Asia/Shanghai')::date, receipt_count=99`);
    await receive(token);
    await expect(receive(token)).rejects.toMatchObject({ code: "54000" });
    expect(await tableCount()).toBe(1);
    await db.exec("update moneytrail_private.sms_settings set receipt_day=receipt_day-1");
    expect((await receive(token)).status).toBe("duplicate");
    expect((await db.query<{ count: number }>("select receipt_count as count from moneytrail_private.sms_settings")).rows[0].count).toBe(1);
  });

  it("never silently drops pending entries when the inbox reaches its limit", async () => {
    const { token } = await rotate();
    await db.query(`insert into moneytrail_private.sms_inbox(user_id,fingerprint,status,raw_text)
      select $1::uuid,encode(sha256(convert_to(index::text,'UTF8')),'hex'),'pending','PRIVATE RAW' from generate_series(1,200) as index`, [ALICE]);
    await expect(receive(token)).rejects.toMatchObject({ code: "54000" });
    expect(await tableCount()).toBe(200);
    expect((await asUser(ALICE, () => rpc<Config>("moneytrail_sms_config"))).pending_count).toBe(200);
  });

  it("appends confirmation to the latest ledger, preserving budget, records and unrelated checked months", async () => {
    const { token } = await rotate();
    const receipt = await receive(token, message("转账财付通-群收款"));
    const initial = { ...emptyData(), budgetCents: 123456, billCheckedMonths: [currentMonth, "2020-01"], transactions: [{ ...draft, id: "existing", source: "manual" }] };
    await asUser(ALICE, () => rpc("save_moneytrail_ledger", [initial, 0]));
    const fixed = { ...draft, date: `${currentMonth}-01T19:27`, kind: "transfer" };
    expect(await asUser(ALICE, () => rpc("moneytrail_sms_confirm", [receipt.id, fixed]))).toEqual({ status: "recorded", transaction_id: `sms-${receipt.id}` });
    const saved = await ledger();
    expect(saved.revision).toBe(2);
    expect(saved.data.budgetCents).toBe(123456);
    expect(saved.data.billCheckedMonths).toEqual(["2020-01"]);
    expect(saved.data.transactions).toHaveLength(2);
    expect(saved.data.transactions[0]).toEqual(initial.transactions[0]);
    expect(saved.data.transactions[1]).toMatchObject({ kind: "transfer", id: `sms-${receipt.id}`, source: "sms", sourceRef: `sms-${receipt.id}` });
    expect((await inbox()).items[0]).toMatchObject({ status: "recorded", raw_text: null, transaction_id: `sms-${receipt.id}` });
    await expect(asUser(ALICE, () => rpc("save_moneytrail_ledger", [initial, 1]))).rejects.toMatchObject({ code: "40001" });
    expect((await ledger()).data.transactions).toHaveLength(2);
  });

  it("confirmation is idempotent and cannot mutate an already recorded transaction", async () => {
    const { token } = await rotate();
    const { id } = await receive(token, message("转账财付通-群收款"));
    await asUser(ALICE, () => rpc("moneytrail_sms_confirm", [id, draft]));
    await asUser(ALICE, () => rpc("moneytrail_sms_confirm", [id, { ...draft, amountCents: 999999 }]));
    expect((await ledger()).revision).toBe(1);
    expect((await ledger()).data.transactions[0].amountCents).toBe(3090);
    await expect(asUser(ALICE, () => rpc("moneytrail_sms_dismiss", [id]))).rejects.toMatchObject({ code: "22023" });
  });

  it("validates confirmation completely and rolls back invalid amounts, IDs, sources, dates and fields", async () => {
    const { token } = await rotate();
    const { id } = await receive(token, message("转账财付通-群收款"));
    for (const invalid of [null, [], { ...draft, amountCents: -1 }, { ...draft, amountCents: 0.1 }, { ...draft, id: "overwrite" }, { ...draft, sourceRef: "overwrite" }, { ...draft, linkedTransactionId: "overwrite" }, { ...draft, source: "manual" }, { ...draft, date: "2026-02-30T12:00" }, { ...draft, note: "x".repeat(2001) }, { ...draft, merchant: "" }, { ...draft, unexpected: true }]) {
      await expect(asUser(ALICE, () => rpc("moneytrail_sms_confirm", [id, invalid]))).rejects.toMatchObject({ code: "22023" });
    }
    expect(await ledger()).toBeUndefined();
    expect((await inbox()).items[0].status).toBe("pending");
    expect((await inbox()).items[0].raw_text).toBeTruthy();
  });

  it("dismisses pending SMS, purges text and prevents accidentally recording it later", async () => {
    const { token } = await rotate();
    const { id } = await receive(token, message("转账财付通-群收款"));
    expect(await asUser(ALICE, () => rpc("moneytrail_sms_dismiss", [id]))).toEqual({ status: "dismissed" });
    expect(await asUser(ALICE, () => rpc("moneytrail_sms_dismiss", [id]))).toEqual({ status: "dismissed" });
    expect((await inbox()).items[0]).toMatchObject({ status: "dismissed", raw_text: null, draft: null, warnings: [], reason: null });
    await expect(asUser(ALICE, () => rpc("moneytrail_sms_confirm", [id, draft]))).rejects.toMatchObject({ code: "22023" });
    expect(await ledger()).toBeUndefined();
  });

  it("isolates two users' tokens, settings, inbox entries and confirm/dismiss operations", async () => {
    const alice = await rotate(); const bob = await rotate(BOB, "review");
    const aliceReceipt = await receive(alice.token, message("转账财付通-群收款"));
    const bobReceipt = await receive(bob.token);
    expect((await inbox()).items.map(item => item.id)).toEqual([aliceReceipt.id]);
    expect((await inbox(BOB)).items.map(item => item.id)).toEqual([bobReceipt.id]);
    expect((await asUser(BOB, () => rpc<Config>("moneytrail_sms_config"))).mode).toBe("review");
    await expect(asUser(BOB, () => rpc("moneytrail_sms_confirm", [aliceReceipt.id, draft]))).rejects.toMatchObject({ code: "42501" });
    await expect(asUser(BOB, () => rpc("moneytrail_sms_dismiss", [aliceReceipt.id]))).rejects.toMatchObject({ code: "42501" });
    await asUser(BOB, () => rpc("moneytrail_sms_revoke"));
    expect((await receive(alice.token, message("消费-公交", "2.00"))).status).toBe("recorded");
    await expect(receive(bob.token, message("消费-公交", "2.00"))).rejects.toMatchObject({ code: "42501" });
  });

  it("enforces pagination and retains pending originals while pruning old processed history", async () => {
    const { token } = await rotate();
    const old = await receive(token);
    const pending = await receive(token, message("转账财付通-群收款"));
    await db.exec("update moneytrail_private.sms_inbox set received_at=now()-interval '31 days'");
    await receive(token, message("消费-公交", "2.00"));
    const first = await inbox(ALICE, 1, 1); const second = await inbox(ALICE, 2, 1);
    expect(first).toMatchObject({ total: 2, page: 1, page_size: 1 });
    expect(second.items[0].id).toBe(pending.id);
    expect(second.items[0].raw_text).toBeTruthy();
    expect([...first.items, ...second.items].map(item => item.id)).not.toContain(old.id);
    await expect(inbox(ALICE, 0, 20)).rejects.toMatchObject({ code: "22023" });
    await expect(inbox(ALICE, 1, 51)).rejects.toMatchObject({ code: "22023" });
  });

  it("routes plausible existing manual/CSV matches to review and allows an explicit confirmed repeat", async () => {
    const { token } = await rotate();
    const first = await receive(token);
    const saved = await ledger();
    await db.query("update public.moneytrail_ledgers set data=jsonb_set(data,'{transactions,0,source}','\"csv\"'::jsonb)");
    const second = await receive(token, message().replace("余额8xxxx", "余额9xxxx"));
    expect(second.status).toBe("pending");
    expect((await ledger()).data.transactions).toHaveLength(1);
    expect((await ledger()).revision).toBe(saved.revision);
    const candidate = (await inbox()).items.find(item => item.id === second.id)!;
    expect(candidate.warnings.join(" ")).toContain("可能重复");
    expect(candidate.raw_text).toBeTruthy();
    await asUser(ALICE, () => rpc("moneytrail_sms_confirm", [second.id, candidate.draft]));
    expect((await ledger()).data.transactions).toHaveLength(2);
    expect((await ledger()).data.transactions[0].id).toBe(`sms-${first.id}`);
  });

  it("does not flag equal amounts outside the 10-minute duplicate window", async () => {
    const { token } = await rotate();
    const earlier = (await db.query<{ date: string }>(`select to_char((now() at time zone 'Asia/Shanghai')-interval '11 minutes','YYYY-MM-DD\"T\"HH24:MI') as date`)).rows[0].date;
    const initial = { ...emptyData(), transactions: [{ ...draft, id: "csv-earlier", source: "csv", date: earlier }] };
    await asUser(ALICE, () => rpc("save_moneytrail_ledger", [initial, 0]));
    expect((await receive(token)).status).toBe("recorded");
    expect((await ledger()).data.transactions).toHaveLength(2);
  });

  it("can replay the migration without rotating tokens or losing pending inbox data", async () => {
    const { token } = await rotate(ALICE, "review");
    const receipt = await receive(token);
    await db.exec(smsMigration);
    expect((await inbox()).items[0].id).toBe(receipt.id);
    expect((await asUser(ALICE, () => rpc<Config>("moneytrail_sms_config")))).toMatchObject({ enabled: true, mode: "review", pending_count: 1 });
    expect(await receive(token)).toMatchObject({ status: "duplicate", id: receipt.id });
  });

  it("never treats a conflicting manually supplied SMS ID as an already saved transaction", async () => {
    const { token } = await rotate(ALICE, "review");
    const receipt = await receive(token);
    const initial = { ...emptyData(), transactions: [{ ...draft, id: `sms-${receipt.id}`, source: "manual" }] };
    await asUser(ALICE, () => rpc("save_moneytrail_ledger", [initial, 0]));
    await expect(asUser(ALICE, () => rpc("moneytrail_sms_confirm", [receipt.id, draft]))).rejects.toMatchObject({ code: "40001" });
    expect((await inbox()).items[0].status).toBe("pending");
    expect((await ledger()).data).toEqual(initial);
  });

  it.each(["anon", "authenticated"] as const)("gives %s no direct private table or helper access", async role => {
    await rotate();
    for (const sql of ["select * from moneytrail_private.sms_settings", "select * from moneytrail_private.sms_inbox", `delete from moneytrail_private.sms_settings`, `select moneytrail_private.sms_config('${ALICE}')`, `select moneytrail_private.sms_append('${ALICE}', '{}'::jsonb)`]) {
      await expect(asUser(ALICE, () => db.exec(sql), role)).rejects.toMatchObject({ code: "42501" });
    }
    const schema = await db.query<{ allowed: boolean }>("select has_schema_privilege($1,'moneytrail_private','USAGE') as allowed", [role]);
    expect(schema.rows[0].allowed).toBe(false);
  });

  it("grants anonymous execution only to write-only ingress and revokes all PUBLIC execute defaults", async () => {
    for (const [name, args] of [["moneytrail_sms_config", []], ["moneytrail_sms_rotate", ["auto"]], ["moneytrail_sms_set_mode", ["auto"]], ["moneytrail_sms_revoke", []], ["moneytrail_sms_inbox", [1, 20]], ["moneytrail_sms_confirm", [ALICE, draft]], ["moneytrail_sms_dismiss", [ALICE]]] as const) {
      await expect(asUser(ALICE, () => rpc(name, [...args]), "anon")).rejects.toMatchObject({ code: "42501" });
    }
    const grants = await db.query<{ count: number }>(`select count(*)::integer as count from pg_proc as procedure, lateral aclexplode(coalesce(procedure.proacl,acldefault('f',procedure.proowner))) as permission
      where (procedure.proname like 'moneytrail_sms_%' or procedure.proname='moneytrail_receive_sms' or procedure.proname like 'sms_%') and permission.grantee=0 and permission.privilege_type='EXECUTE'`);
    expect(grants.rows[0].count).toBe(0);
    const policies = await db.query<{ enabled: boolean }>("select relrowsecurity as enabled from pg_class where oid in ('moneytrail_private.sms_settings'::regclass,'moneytrail_private.sms_inbox'::regclass)");
    expect(policies.rows).toEqual([{ enabled: true }, { enabled: true }]);
    await expect(receive("mt_sms_" + "0".repeat(64))).rejects.toMatchObject({ code: "42501" });
  });

  it("fails safely on invalid modes and never provisions someone else's user ID", async () => {
    await expect(rotate(ALICE, "expense")).rejects.toMatchObject({ code: "22023" });
    await expect(asUser(ALICE, () => rpc("moneytrail_sms_set_mode", [null]))).rejects.toMatchObject({ code: "22023" });
    await expect(asUser(null, () => rpc("moneytrail_sms_rotate", ["auto"])) ).rejects.toMatchObject({ code: "42501" });
    expect((await db.query("select * from moneytrail_private.sms_settings")).rows).toEqual([]);
  });
});
