import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

const migrations = import.meta.glob("../../supabase/migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const owner = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const original = {
  id: "original-expense", kind: "expense", amountCents: 4000, date: "2026-11-25T14:00",
  merchant: "原消费商户", category: "食品酒水", subcategory: "外卖", platform: "美团", source: "sms", note: "",
  smsEvidence: { text: "原消费凭据" },
};
const refund = {
  kind: "refund", amountCents: 1500, date: "2026-11-26T16:00", merchant: "银行卡退款", category: "其他",
  subcategory: "宠物", platform: "京东", source: "sms", note: "本次退款", linkedTransactionId: original.id,
  smsEvidence: { text: "不可覆盖服务端凭据" },
};
const raw = "尾号1234卡11月26日16:00收入(退款说明)15.00元，余额100.00元。【工商银行】";
let db: PGlite;
type Fields = Record<string, unknown>;
type Snapshot = { data: { transactions: Fields[]; billCheckedMonths: string[] }; revision: number };

async function rpc<T>(name: string, args: unknown[] = [], account: string | null = owner) {
  const role = account ? "authenticated" : "anon";
  await db.exec(`set role ${role}`);
  await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ role, sub: account })]);
  const parameters = args.map((_, index) => `$${index + 1}`).join(",");
  try {
    return (await db.query<{ result: T }>(`select public.${name}(${parameters}) as result`, args)).rows[0].result;
  } finally {
    await db.exec("reset role");
  }
}

async function saveLedger(transactions: Fields[], account = owner, revision = 0) {
  return rpc("save_moneytrail_ledger", [{ version: 1, transactions, budgetCents: 0, billCheckedMonths: ["2026-11"] }, revision], account);
}

async function seedReceipt(account = owner) {
  return (await db.query<{ id: string }>(
    "insert into moneytrail_private.sms_inbox(user_id,fingerprint,status,raw_text) values($1,repeat('a',64),'pending',$2) returning id",
    [account, raw],
  )).rows[0].id;
}

function confirm(id: string, draft: Fields, account: string | null = owner) {
  return rpc<{ status: string; transaction_id: string }>("moneytrail_sms_confirm", [id, draft], account);
}

async function ledger(account = owner) {
  return (await db.query<Snapshot>("select data, revision::integer as revision from public.moneytrail_ledgers where user_id=$1", [account])).rows[0];
}

async function inbox(account = owner) {
  return (await rpc<{ items: Fields[] }>("moneytrail_sms_inbox", [], account)).items;
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create schema auth;
    create table auth.users(id uuid primary key, email text, email_confirmed_at timestamptz, banned_until timestamptz, deleted_at timestamptz);
    create function auth.uid() returns uuid language sql stable set search_path = '' as
      $$select (nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb->>'sub')::uuid$$;
    grant usage on schema public, auth to anon, authenticated;
  `);
  for (const path of Object.keys(migrations).sort()) await db.exec(migrations[path]);
}, 30_000);

beforeEach(async () => {
  await db.exec("reset role; truncate auth.users cascade;");
  await db.query("insert into auth.users values ($1,'owner@example.invalid',now(),null,null),($2,'other@example.invalid',now(),null,null)", [owner, other]);
});

afterAll(async () => { await db?.close(); });

it("saves one explicitly linked partial refund with original categories and the refund's own masked evidence", async () => {
  await saveLedger([original]);
  const id = await seedReceipt();
  const result = { status: "recorded", transaction_id: `sms-${id}` };
  expect(await confirm(id, refund)).toEqual(result);
  expect(await confirm(id, { ...refund, amountCents: 999999, linkedTransactionId: "stale-target" })).toEqual(result);
  const saved = await ledger();
  expect(saved.revision).toBe(2);
  expect(saved.data.billCheckedMonths).toEqual([]);
  expect(saved.data.transactions).toHaveLength(2);
  const recorded = saved.data.transactions[1];
  expect(recorded).toMatchObject({
    id: result.transaction_id, sourceRef: result.transaction_id, kind: "refund", amountCents: refund.amountCents,
    date: refund.date, merchant: refund.merchant, note: refund.note, linkedTransactionId: original.id,
    category: original.category, subcategory: original.subcategory, platform: original.platform,
    smsEvidence: { text: expect.stringContaining("退款说明"), classificationReason: "人工确认：食品酒水" },
  });
  expect((recorded.smsEvidence as { text: string }).text).not.toMatch(/1234|100\.00|原消费凭据|不可覆盖服务端凭据/);
  const receipts = await inbox();
  expect(receipts).toMatchObject([{
    id, status: "recorded", raw_text: null, transaction_id: result.transaction_id,
    draft: { category: original.category, subcategory: original.subcategory, platform: original.platform },
  }]);
  expect(receipts[0].draft).not.toHaveProperty("linkedTransactionId");
});

it("uses the current ledger to allow several partial refunds up to the original amount", async () => {
  // This existing manually entered refund counts toward the limit too.
  const priorRefund = {
    ...original, id: "prior-refund", kind: "refund", amountCents: 1000, date: refund.date,
    source: "manual", smsEvidence: undefined, linkedTransactionId: original.id,
  };
  await saveLedger([original, priorRefund]);
  const first = await seedReceipt();
  const rejected = await seedReceipt();
  expect(await confirm(first, refund)).toMatchObject({ status: "recorded" });
  await expect(confirm(rejected, { ...refund, amountCents: 1501 })).rejects.toMatchObject({ code: "22023" });
  expect(await inbox()).toEqual(expect.arrayContaining([expect.objectContaining({ id: rejected, status: "pending", raw_text: raw })]));
  expect(await ledger()).toMatchObject({ revision: 2, data: { transactions: [expect.any(Object), expect.any(Object), expect.any(Object)] } });
  expect(await confirm(rejected, refund)).toMatchObject({ status: "recorded" });
  expect((await ledger()).data.transactions.filter(row => row.linkedTransactionId === original.id)
    .map(row => row.amountCents)).toEqual([1000, 1500, 1500]);
});

it("rejects foreign, missing, non-expense, later and malformed targets without changing either ledger or receipt", async () => {
  await saveLedger([
    original,
    { ...original, id: "future-original", date: "2026-11-27T10:00" },
    { ...original, id: "income-row", kind: "income" },
  ]);
  await saveLedger([{ ...original, id: "foreign-expense" }], other);
  const id = await seedReceipt();
  const start = await ledger();
  const otherStart = await ledger(other);
  for (const linkedTransactionId of ["foreign-expense", "deleted-expense", "income-row", "future-original", " ", null, 12]) {
    await expect(confirm(id, { ...refund, linkedTransactionId })).rejects.toMatchObject({ code: "22023" });
  }
  await expect(confirm(id, { ...refund, kind: "expense" })).rejects.toMatchObject({ code: "22023" });
  await expect(confirm(id, { ...refund, date: "2026-02-30T12:00" })).rejects.toMatchObject({ code: "22023" });
  await expect(confirm(id, refund, other)).rejects.toMatchObject({ code: "42501" });
  await expect(confirm(id, refund, null)).rejects.toMatchObject({ code: "42501" });
  expect(await ledger()).toEqual(start);
  expect(await ledger(other)).toEqual(otherStart);
  expect(await inbox()).toMatchObject([{ id, status: "pending", raw_text: raw }]);
});

it("checks deleted targets and inherits the latest category without adding absent metadata", async () => {
  const linked = { ...original, id: "changed-expense", category: "交通出行", subcategory: undefined, platform: undefined };
  await saveLedger([original, { ...linked, category: "其他" }]);
  const id = await seedReceipt();
  await saveLedger([linked], owner, 1);
  await expect(confirm(id, refund)).rejects.toMatchObject({ code: "22023" });
  expect(await confirm(id, { ...refund, linkedTransactionId: linked.id })).toMatchObject({ status: "recorded" });
  const saved = await ledger();
  expect(saved.revision).toBe(3);
  expect(saved.data.transactions[1]).toMatchObject({ category: linked.category, linkedTransactionId: linked.id });
  expect(saved.data.transactions[1]).not.toHaveProperty("subcategory");
  expect(saved.data.transactions[1]).not.toHaveProperty("platform");
});

it("still allows an unlinked refund and rejects using one to teach a merchant rule", async () => {
  const { linkedTransactionId, ...unlinked } = refund;
  const id = await seedReceipt();
  await expect(confirm(id, { ...unlinked, linkedTransactionId })).rejects.toMatchObject({ code: "22023" });
  await expect(rpc("moneytrail_sms_confirm_with_rule", [id, unlinked, true])).rejects.toMatchObject({ code: "22023" });
  expect(await rpc("moneytrail_sms_confirm_with_rule", [id, unlinked, false])).toMatchObject({ status: "recorded" });
  expect((await ledger()).data.transactions[0]).toMatchObject({ kind: "refund", category: unlinked.category });
  expect((await ledger()).data.transactions[0]).not.toHaveProperty("linkedTransactionId");
  expect(await rpc("moneytrail_sms_category_rules")).toEqual({ rules: [] });
});
