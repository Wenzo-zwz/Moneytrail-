/** Actual PostgreSQL tests for ICBC grouping and narrow medical classification. */
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import ledgerMigration from "../../supabase/migrations/202610220001_ledger_accounts.sql?raw";
import parserMigration from "../../supabase/migrations/202610220003_sms_parser.sql?raw";
import intakeMigration from "../../supabase/migrations/202610220004_sms_automation.sql?raw";
import autoMigration from "../../supabase/migrations/202610230001_sms_auto_debits.sql?raw";
import formatsMigration from "../../supabase/migrations/202610230002_icbc_sms_formats.sql?raw";
import { emptyData } from "./storage";

const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const RECEIVED = "2026-10-23T01:47:24Z";
const PHARMACY = "消费支付宝-阿里健康大药房医药连锁有限公";
let db: PGlite;
let today: string;
type Parsed = { draft: Record<string, unknown> | null; error: string | null; warnings: string[]; requires_review: boolean };
type Receipt = { accepted: boolean; status: string; id: string };
function message(balance = "12,345.94", amount = "375", detail = PHARMACY, date = "10月23日09:47") {
  return `尾号xxxx卡${date}支出(${detail})${amount}元，余额${balance}元。【工商银行】`;
}
async function rpc<T>(name: string, args: unknown[] = []): Promise<T> {
  return (await db.query<{ result: T }>(`select public.${name}(${args.map((_, i) => `$${i + 1}`).join(",")}) as result`, args)).rows[0].result;
}
async function asUser<T>(id: string | null, run: () => Promise<T>, role = "authenticated") {
  await db.exec(`set role ${role}`);
  await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ role, ...(id ? { sub: id } : {}) })]);
  try { return await run(); }
  finally { await db.exec("reset role"); await db.query("select set_config('request.jwt.claims','',false)"); }
}
async function parse(text: string): Promise<Parsed> {
  return (await db.query<{ result: Parsed }>("select moneytrail_private.moneytrail_parse_icbc_sms($1,$2::timestamptz,'review') as result", [text, RECEIVED])).rows[0].result;
}
async function rotate(owner = ALICE, mode = "auto") {
  return asUser(owner, () => rpc<{ token: string }>("moneytrail_sms_rotate", [mode]));
}
async function receive(token: string, text: string) {
  return asUser(null, () => rpc<Receipt>("moneytrail_receive_sms", [token, text]), "anon");
}
async function ledger(owner = ALICE) {
  return (await db.query<{ data: ReturnType<typeof emptyData>; revision: number }>("select data,revision::integer as revision from public.moneytrail_ledgers where user_id=$1::uuid", [owner])).rows[0];
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`create role anon nologin; create role authenticated nologin; create schema auth;
    create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz,deleted_at timestamptz);
    create function auth.uid() returns uuid language sql stable set search_path='' as $$
      select (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid
    $$; grant usage on schema public,auth to anon,authenticated;`);
  for (const sql of [ledgerMigration, parserMigration, intakeMigration, autoMigration, formatsMigration]) await db.exec(sql);
  today = (await db.query<{ date: string }>("select to_char(now() at time zone 'Asia/Shanghai','FMMM月FMDD日HH24:MI') as date")).rows[0].date;
}, 30_000);
beforeEach(async () => {
  await db.exec(`reset role; truncate auth.users cascade; insert into auth.users(id,email,email_confirmed_at) values
    ('${ALICE}','alice@example.invalid',now()),('${BOB}','bob@example.invalid',now());`);
  await db.exec(formatsMigration);
});
afterAll(async () => { await db?.close(); });

describe("ICBC balance display and medical expense upgrade", () => {
  it.each(["12345.94", "12,345.94", "xxxx.94", "xx,xxx.94", "X,XXX.94", "*,***.**", "1,234,567.89", "１２，３４５．９４"])("recognizes the 375-yuan pharmacy debit with balance %s without using the balance", async balance => {
    const result = await parse(message(balance));
    expect(result).toEqual({ draft: { kind: "expense", amountCents: 37500, date: "2026-10-23T09:47", merchant: PHARMACY, category: "医疗", source: "sms", note: "" }, warnings: [], error: null, requires_review: false });
    expect(JSON.stringify(result)).not.toContain(balance);
  });

  it.each([["1,375", 137500], ["1,375.9", 137590], ["1,375.94", 137594], ["10,000,000,000.00", 1_000_000_000_000]] as const)("converts grouped debit %s to exactly %i cents", async (amount, cents) => {
    expect((await parse(message("9,999.99", amount))).draft?.amountCents).toBe(cents);
  });

  it("normalizes fullwidth punctuation and trims only boundary CRLF, preserving the whole-message check", async () => {
    const raw = message().replaceAll("(", "（").replaceAll(")", "）").replace("375元", "３７５元").replace("09:47", "０９：４７");
    expect(await parse(`\r\n ${raw}\r\n\t`)).toEqual(await parse(message()));
    expect((await parse(message().replace("大药房", "大\n药房"))).draft).toBeNull();
    expect((await parse(message() + "\n" + message())).draft).toBeNull();
  });

  it.each(["12,34.94", "1234,567.94", ",123.94", "123,.94", "12,,345.94", "1,234.567", "1,234元,支出375", "1,234元另支出375"])("rejects malformed or additional-event balance %s", async balance => {
    expect(await parse(message(balance))).toMatchObject({ draft: null, requires_review: true, error: expect.any(String) });
  });

  it.each(["12,34", "1234,567", "1,,375", "1,375.001", "-1,375", "10,000,000,000.01", "123,456,789,123,456,789.12"])("rejects malformed, negative or out-of-range debit %s", async amount => {
    expect((await parse(message("12,345.94", amount))).draft).toBeNull();
  });

  it.each(["消费药店", "支付医院", "社区诊所"])("uses narrow medical categorization for %s", async detail => {
    expect(await parse(message("12,345.94", "375", detail))).toMatchObject({ draft: { category: "医疗" }, requires_review: false });
  });
  it("leaves unknown merchants uncategorized without requiring approval", async () => {
    expect(await parse(message("12,345.94", "375", "支付宝"))).toMatchObject({ draft: { category: "待分类" }, requires_review: false });
  });

  it.each(["财付通-群收款", "消费药店群收款", "转账-医院", "药店充值", "医院还款", "药房退款", "药店支付失败", "零钱通", "余额宝"])("retains review protection and pending category for %s", async detail => {
    expect(await parse(message("12,345.94", "375", detail))).toMatchObject({ draft: { category: "待分类" }, requires_review: true });
    const { token } = await rotate();
    expect((await receive(token, message("12,345.94", "375", detail, today))).status).toBe("pending");
    expect(await ledger()).toBeUndefined();
  });

  it("retains strict bank, currency, OTP, impossible date and stale/future-time guards", async () => {
    for (const text of [message().replace("工商银行", "建设银行"), message("12,345.94", "375", "药店美元"), message("12,345.94", "375", "药店验证码123456"), message("12,345.94", "375", PHARMACY, "2月30日09:47")]) {
      expect((await parse(text)).draft).toBeNull();
    }
    expect((await parse(message("12,345.94", "375", PHARMACY, "10月23日10:00"))).requires_review).toBe(true);
    expect((await parse(message("12,345.94", "375", PHARMACY, "10月01日09:47"))).requires_review).toBe(true);
  });

  it("automatically receives a grouped-balance pharmacy debit with a clean amount and medical category", async () => {
    const { token } = await rotate();
    const receipt = await receive(token, message("12,345.94", "375", PHARMACY, today));
    expect(receipt.status).toBe("recorded");
    expect((await ledger()).data.transactions).toMatchObject([{ id: `sms-${receipt.id}`, amountCents: 37500, category: "医疗", merchant: PHARMACY }]);
    const inbox = (await asUser(ALICE, () => rpc<{ items: { raw_text: string | null }[] }>("moneytrail_sms_inbox", [1, 50]))).items;
    expect(inbox[0].raw_text).toBeNull();
    const duplicate = await receive(token, message("12,000.94", "375", PHARMACY, today));
    expect(duplicate.status).toBe("pending");
    expect((await ledger()).data.transactions).toHaveLength(1);
  });

  it("only reparses the requesting account old failures explicitly, using original receipts and preserving budget and other ledger data", async () => {
    await db.exec(autoMigration);
    const { token } = await rotate();
    await rotate(BOB);
    const raw = message();
    expect((await parse(raw)).draft).toBeNull();
    const own = "44444444-4444-4444-8444-444444444444";
    const other = "55555555-5555-4555-8555-555555555555";
    for (const [id, user, hash] of [[own, ALICE, "a"], [other, BOB, "b"]]) {
      await db.query(`insert into moneytrail_private.sms_inbox(id,user_id,received_at,fingerprint,status,raw_text,draft,reason)
        values($1::uuid,$2::uuid,$3::timestamptz,repeat($4,64),'pending',$5,'null'::jsonb,'暂不支持这条短信的格式，请手动核对后记账。')`, [id, user, RECEIVED, hash, raw]);
    }
    const original = { ...emptyData(), budgetCents: 900000, billCheckedMonths: ["2026-10", "2020-01"], transactions: [{ id: "existing", kind: "expense" as const, amountCents: 1234, date: "2020-01-01T12:00", merchant: "原账目", category: "其他", source: "manual" as const, note: "保留" }] };
    await asUser(ALICE, () => rpc("save_moneytrail_ledger", [original, 0]));
    const settings = (await db.query("select * from moneytrail_private.sms_settings order by user_id")).rows;
    await db.exec(formatsMigration);
    expect((await db.query("select * from moneytrail_private.sms_settings order by user_id")).rows).toEqual(settings);
    expect((await db.query<{ draft: Parsed["draft"] }>("select draft from moneytrail_private.sms_inbox where id=$1::uuid", [own])).rows[0].draft).toBeNull();
    expect((await ledger()).data).toEqual(original);
    const result = await asUser(ALICE, () => rpc("moneytrail_sms_reprocess_pending"));
    expect(result).toEqual({ recorded_count: 1, pending_count: 0 });
    const saved = await ledger();
    expect(saved.data.budgetCents).toBe(900000); expect(saved.data.transactions[0]).toEqual(original.transactions[0]);
    expect(saved.data.transactions[1]).toMatchObject({ id: `sms-${own}`, date: "2026-10-23T09:47", amountCents: 37500, category: "医疗" });
    expect(saved.data.billCheckedMonths).toEqual(["2020-01"]);
    expect((await db.query("select status,raw_text from moneytrail_private.sms_inbox where id=$1::uuid", [other])).rows[0]).toMatchObject({ status: "pending", raw_text: raw });
    expect(await ledger(BOB)).toBeUndefined();
    expect(await asUser(ALICE, () => rpc("moneytrail_sms_reprocess_pending"))).toEqual({ recorded_count: 0, pending_count: 0 });
    expect((await ledger()).revision).toBe(saved.revision);
    expect((await receive(token, message("12,345.94", "1.23", "普通商店", today))).status).toBe("recorded");
  });

  it("preserves review mode and private parser ACL on replay", async () => {
    const { token } = await rotate(ALICE, "review");
    await db.exec(formatsMigration);
    expect((await receive(token, message("12,345.94", "375", PHARMACY, today))).status).toBe("pending");
    await expect(asUser(ALICE, () => rpc("moneytrail_sms_reprocess_pending"))).rejects.toMatchObject({ code: "22023" });
    for (const role of ["anon", "authenticated"]) {
      expect((await db.query<{ allowed: boolean }>("select has_schema_privilege($1,'moneytrail_private','USAGE') as allowed", [role])).rows[0].allowed).toBe(false);
      expect((await db.query<{ allowed: boolean }>("select has_function_privilege($1,'moneytrail_private.moneytrail_parse_icbc_sms(text,timestamptz,text)','EXECUTE') as allowed", [role])).rows[0].allowed).toBe(false);
    }
    const publicGrants = await db.query<{ count: number }>(`select count(*)::integer as count from pg_proc p,
      lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where
      p.oid='moneytrail_private.moneytrail_parse_icbc_sms(text,timestamptz,text)'::regprocedure
      and a.grantee=0 and a.privilege_type='EXECUTE'`);
    expect(publicGrants.rows[0].count).toBe(0);
  });
});
