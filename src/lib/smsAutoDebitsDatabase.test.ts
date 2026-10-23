/** Actual PostgreSQL parser upgrade, atomic append and account ACL checks. */
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import ledgerMigration from "../../supabase/migrations/202610220001_ledger_accounts.sql?raw";
import parserMigration from "../../supabase/migrations/202610220003_sms_parser.sql?raw";
import smsMigration from "../../supabase/migrations/202610220004_sms_automation.sql?raw";
import upgrade from "../../supabase/migrations/202610230001_sms_auto_debits.sql?raw";
import { emptyData } from "./storage";

const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const UNVERIFIED = "33333333-3333-4333-8333-333333333333";
const REFERENCE = "2026-10-23T11:30:00Z";
let db: PGlite;
let local: { date: string; iso: string; month: string };
type Receipt = { accepted: boolean; status: string; id: string };
type Processed = { recorded_count: number; pending_count: number };
type Item = { id: string; status: string; raw_text: string | null; draft: Record<string, unknown> | null; warnings: string[]; reason: string | null; transaction_id: string | null };

async function rpc<T>(name: string, args: unknown[] = []): Promise<T> {
  const placeholders = args.map((_, index) => `$${index + 1}`).join(",");
  return (await db.query<{ result: T }>(`select public.${name}(${placeholders}) as result`, args)).rows[0].result;
}
async function asUser<T>(id: string | null, run: () => Promise<T>, role: "anon" | "authenticated" = "authenticated"): Promise<T> {
  await db.exec(`set role ${role}`);
  await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ role, ...(id ? { sub: id } : {}) })]);
  try { return await run(); }
  finally { await db.exec("reset role"); await db.query("select set_config('request.jwt.claims','',false)"); }
}
async function rotate(id = ALICE, mode = "auto") {
  return asUser(id, () => rpc<{ token: string }>("moneytrail_sms_rotate", [mode]));
}
function message(detail: string, amount = "30.90", date = local.date) {
  return `尾号xxxx卡${date}支出(${detail})${amount}元，余额8xxxx元。【工商银行】`;
}
async function receive(token: string, text: string) {
  return asUser(null, () => rpc<Receipt>("moneytrail_receive_sms", [token, text]), "anon");
}
async function reprocess(id = ALICE) {
  return asUser(id, () => rpc<Processed>("moneytrail_sms_reprocess_pending"));
}
async function inbox(id = ALICE) {
  return (await asUser(id, () => rpc<{ items: Item[] }>("moneytrail_sms_inbox", [1, 50]))).items;
}
async function ledger(id = ALICE) {
  return (await db.query<{ data: ReturnType<typeof emptyData>; revision: number }>("select data,revision::integer as revision from public.moneytrail_ledgers where user_id=$1::uuid", [id])).rows[0];
}
async function parse(detail: string, date = "10月23日19:29") {
  return (await db.query<{ result: { draft: Record<string, unknown> | null; warnings: string[]; requires_review: boolean; error: string | null } }>(
    "select moneytrail_private.moneytrail_parse_icbc_sms($1::text,$2::timestamptz,'review') as result", [message(detail, "30.90", date), REFERENCE],
  )).rows[0].result;
}
async function oldPending(details: string[], owner = ALICE) {
  await db.exec(parserMigration);
  const { token } = await rotate(owner);
  const receipts = [];
  for (const [index, detail] of details.entries()) receipts.push(await receive(token, message(detail, `${index + 10}.50`)));
  await db.exec(upgrade);
  return { token, receipts };
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`create role anon nologin; create role authenticated nologin;
    create schema auth;
    create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz,deleted_at timestamptz);
    create function auth.uid() returns uuid language sql stable set search_path = '' as $$
      select (nullif(current_setting('request.jwt.claims',true),'')::jsonb ->> 'sub')::uuid
    $$;
    grant usage on schema public,auth to anon,authenticated;`);
  await db.exec(ledgerMigration); await db.exec(parserMigration); await db.exec(smsMigration); await db.exec(upgrade);
  local = (await db.query<{ date: string; iso: string; month: string }>(`select to_char(now() at time zone 'Asia/Shanghai','FMMM月FMDD日HH24:MI') as date,
    to_char(now() at time zone 'Asia/Shanghai','YYYY-MM-DD"T"HH24:MI') as iso,to_char(now() at time zone 'Asia/Shanghai','YYYY-MM') as month`)).rows[0];
}, 30_000);
beforeEach(async () => {
  await db.exec(`reset role; truncate auth.users cascade;
    insert into auth.users(id,email,email_confirmed_at) values
    ('${ALICE}','alice@example.invalid',now()),('${BOB}','bob@example.invalid',now()),('${UNVERIFIED}','unverified@example.invalid',null);`);
  await db.exec(upgrade);
});
afterAll(async () => { await db?.close(); });

describe("ICBC ordinary debit automatic recording upgrade", () => {
  it.each(["某某商店", "财付通", "快捷支付-财付通", "微信支付", "支付宝", "美团外卖", "银联-便利店"])("records a valid ordinary debit with description %s without knowing its category", async detail => {
    expect(await parse(detail)).toMatchObject({ draft: { kind: "expense", merchant: detail, amountCents: 3090, category: "待分类" }, requires_review: false, warnings: [], error: null });
    const { token } = await rotate();
    const receipt = await receive(token, message(detail));
    expect(receipt.status).toBe("recorded");
    expect((await ledger()).data.transactions).toMatchObject([{ id: `sms-${receipt.id}`, amountCents: 3090, category: "待分类", merchant: detail }]);
    expect((await inbox())[0]).toMatchObject({ status: "recorded", raw_text: null });
  });

  it("automatically appends four ordinary debits and retains exactly four transactions", async () => {
    const { token } = await rotate();
    const receipts = [];
    for (const [index, detail] of ["快捷支付-财付通", "某某便利店", "美团外卖", "支付宝"].entries()) {
      receipts.push(await receive(token, message(detail, `${index + 1}.23`)));
    }
    expect(receipts.every(receipt => receipt.status === "recorded")).toBe(true);
    const saved = await ledger();
    expect(saved.data.transactions).toHaveLength(4);
    expect(saved.data.transactions.map(item => item.amountCents)).toEqual([123, 223, 323, 423]);
    expect(saved.data.transactions.every(item => item.category === "待分类")).toBe(true);
    expect(new Set(saved.data.transactions.map(item => item.id)).size).toBe(4);
  });

  it.each(["转账财付通-群收款", "消费群收款", "支付-财付通-群收款", "转账-张三", "支付宝充值", "微信零钱提现", "取现", "取款", "支取", "信用卡还款", "偿还", "转出", "转入", "基金申购", "理财赎回", "证券买入", "快捷支付-支付宝-余额宝", "微信零钱通", "花呗", "借呗", "京东白条", "网商贷", "还贷", "贷款", "支付退款", "消费冲正", "支付失败", "未成功", "商户撤销"])("still requires review for %s", async detail => {
    const result = await parse(detail);
    expect(result.requires_review).toBe(true); expect(result.warnings.length).toBeGreaterThan(0);
    const { token } = await rotate();
    expect((await receive(token, message(detail))).status).toBe("pending");
    expect(await ledger()).toBeUndefined();
  });

  it("retains time, format, currency, amount and OTP safeguards", async () => {
    expect((await parse("便利店", "10月23日20:00")).requires_review).toBe(true);
    expect((await parse("便利店", "10月01日19:00")).requires_review).toBe(true);
    const { token } = await rotate();
    for (const text of ["您今日支出30.90元【工商银行】", message("便利店", "30.901"), message("便利店", "-30.90"), message("便利店美元"), message("便利店") + message("其他商店")]) {
      const receipt = await receive(token, text);
      expect(receipt.status).toBe("pending");
    }
    await expect(receive(token, message("便利店验证码"))).rejects.toMatchObject({ code: "22023" });
    expect(await ledger()).toBeUndefined();
  });

  it("preserves review mode and refuses to reprocess it implicitly", async () => {
    const { token } = await rotate(ALICE, "review");
    expect((await receive(token, message("某某商店"))).status).toBe("pending");
    await expect(reprocess()).rejects.toMatchObject({ code: "22023" });
    expect(await ledger()).toBeUndefined();
    expect((await inbox())[0].raw_text).toBeTruthy();
  });

  it("does not process existing rows during migration; an explicit request appends ordinary receipts and preserves the rest of the ledger", async () => {
    const { receipts } = await oldPending(["某某商店", "快捷支付-财付通", "转账财付通-群收款"]);
    expect(receipts.every(receipt => receipt.status === "pending")).toBe(true);
    expect(await ledger()).toBeUndefined();
    const initial = { ...emptyData(), budgetCents: 456789, billCheckedMonths: [local.month, "2020-01"], transactions: [{ id: "existing-csv", kind: "expense" as const, amountCents: 9999, date: local.iso, merchant: "原账单", category: "餐饮", source: "csv" as const, note: "不丢失" }] };
    await asUser(ALICE, () => rpc("save_moneytrail_ledger", [initial, 0]));
    expect(await reprocess()).toEqual({ recorded_count: 2, pending_count: 1 });
    const saved = await ledger();
    expect(saved.revision).toBe(3); expect(saved.data.budgetCents).toBe(456789);
    expect(saved.data.billCheckedMonths).toEqual(["2020-01"]);
    expect(saved.data.transactions).toHaveLength(3); expect(saved.data.transactions[0]).toEqual(initial.transactions[0]);
    const items = await inbox();
    expect(items.filter(item => item.status === "recorded").every(item => item.raw_text === null)).toBe(true);
    expect(items.find(item => item.id === receipts[2].id)).toMatchObject({ status: "pending", raw_text: expect.any(String) });
    expect(await reprocess()).toEqual({ recorded_count: 0, pending_count: 1 });
    expect((await ledger()).revision).toBe(3);
  });

  it("uses the original receipt for year and age inference while reprocessing an old queue", async () => {
    await rotate();
    const oldText = message("某某商店", "9.87", "12月31日23:59");
    const id = "44444444-4444-4444-8444-444444444444";
    await db.query(`insert into moneytrail_private.sms_inbox(id,user_id,received_at,fingerprint,status,raw_text)
      values($1::uuid,$2::uuid,'2026-01-01T00:01:00+08:00',repeat('a',64),'pending',$3)`, [id, ALICE, oldText]);
    expect(await reprocess()).toEqual({ recorded_count: 1, pending_count: 0 });
    expect((await ledger()).data.transactions[0]).toMatchObject({ date: "2025-12-31T23:59", amountCents: 987 });
  });

  it("keeps duplicate candidates pending without changing the latest ledger", async () => {
    const { receipts } = await oldPending(["某某商店"]);
    const initial = { ...emptyData(), transactions: [{ id: "manual-first", kind: "expense" as const, amountCents: 1050, date: local.iso, merchant: "手动商店", category: "其他", source: "manual" as const, note: "" }] };
    await asUser(ALICE, () => rpc("save_moneytrail_ledger", [initial, 0]));
    expect(await reprocess()).toEqual({ recorded_count: 0, pending_count: 1 });
    expect((await ledger()).data).toEqual(initial); expect((await ledger()).revision).toBe(1);
    const item = (await inbox()).find(item => item.id === receipts[0].id)!;
    expect(item.warnings.join(" ")).toContain("可能重复"); expect(item.raw_text).toBeTruthy();
    await reprocess();
    expect((await inbox())[0].warnings.filter(warning => warning.includes("可能重复"))).toHaveLength(1);
  });

  it("only processes its authenticated owner, including when intake has been revoked", async () => {
    const alice = await oldPending(["某某商店"]);
    const bob = await oldPending(["另一个商店"], BOB);
    await asUser(ALICE, () => rpc("moneytrail_sms_revoke"));
    expect(await reprocess()).toEqual({ recorded_count: 1, pending_count: 0 });
    expect((await ledger()).data.transactions[0].id).toBe(`sms-${alice.receipts[0].id}`);
    expect(await ledger(BOB)).toBeUndefined();
    expect((await inbox(BOB))[0]).toMatchObject({ id: bob.receipts[0].id, status: "pending", raw_text: expect.any(String) });
    expect(await reprocess(BOB)).toEqual({ recorded_count: 1, pending_count: 0 });
    expect((await ledger(BOB)).data.transactions[0].id).toBe(`sms-${bob.receipts[0].id}`);
  });

  it("does not process recorded or dismissed rows again", async () => {
    const { token } = await rotate();
    await receive(token, message("某某商店"));
    const group = await receive(token, message("转账财付通-群收款", "3.21"));
    await asUser(ALICE, () => rpc("moneytrail_sms_dismiss", [group.id]));
    expect(await reprocess()).toEqual({ recorded_count: 0, pending_count: 0 });
    expect((await ledger()).data.transactions).toHaveLength(1);
    expect((await inbox()).find(item => item.id === group.id)?.status).toBe("dismissed");
  });

  it("rolls back a batch on an existing conflicting ID instead of overwriting any transaction", async () => {
    const { receipts } = await oldPending(["某某商店", "另一个商店"]);
    const initial = { ...emptyData(), transactions: [{ id: `sms-${receipts[1].id}`, kind: "expense" as const, amountCents: 9999, date: local.iso, merchant: "原有记录", category: "其他", source: "manual" as const, note: "保留" }] };
    await asUser(ALICE, () => rpc("save_moneytrail_ledger", [initial, 0]));
    await expect(reprocess()).rejects.toMatchObject({ code: "40001" });
    expect((await ledger()).data).toEqual(initial); expect((await ledger()).revision).toBe(1);
    expect((await inbox()).every(item => item.status === "pending" && item.raw_text)).toBe(true);
  });

  it("keeps tokens, mode, ledgers and pending rows intact on replay", async () => {
    const { token } = await oldPending(["某某商店"]);
    const before = await inbox(); const settings = (await db.query("select * from moneytrail_private.sms_settings")).rows;
    await db.exec(upgrade);
    expect(await inbox()).toEqual(before); expect((await db.query("select * from moneytrail_private.sms_settings")).rows).toEqual(settings);
    expect(await ledger()).toBeUndefined();
    expect((await receive(token, message("某某商店", "10.50"))).status).toBe("duplicate");
  });

  it("denies anonymous, unverified, banned, deleted and missing-account callers", async () => {
    await expect(asUser(ALICE, () => rpc("moneytrail_sms_reprocess_pending"), "anon")).rejects.toMatchObject({ code: "42501" });
    await expect(reprocess(UNVERIFIED)).rejects.toMatchObject({ code: "42501" });
    await expect(asUser(null, () => rpc("moneytrail_sms_reprocess_pending"))).rejects.toMatchObject({ code: "42501" });
    await oldPending(["某某商店"]);
    for (const patch of ["banned_until=now()+interval '1 hour'", "deleted_at=now()", "email_confirmed_at=null"]) {
      await db.exec(`update auth.users set banned_until=null,deleted_at=null,email_confirmed_at=now() where id='${ALICE}'; update auth.users set ${patch} where id='${ALICE}'`);
      await expect(reprocess()).rejects.toMatchObject({ code: "42501" });
    }
    expect(await ledger()).toBeUndefined();
  });

  it("does not reopen private helpers or PUBLIC execution through the upgrade", async () => {
    for (const role of ["anon", "authenticated"]) {
      expect((await db.query<{ allowed: boolean }>("select has_schema_privilege($1,'moneytrail_private','USAGE') as allowed", [role])).rows[0].allowed).toBe(false);
    }
    expect((await db.query<{ count: number }>(`select count(*)::integer as count from pg_proc p,
      lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where p.oid in
      ('public.moneytrail_sms_reprocess_pending()'::regprocedure,'moneytrail_private.moneytrail_parse_icbc_sms(text,timestamptz,text)'::regprocedure)
      and a.grantee=0 and a.privilege_type='EXECUTE'`)).rows[0].count).toBe(0);
  });
});
