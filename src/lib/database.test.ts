/** Actual PostgreSQL permission/RLS tests. Auth fixtures do not emulate JWT verification. */
import { PGlite } from "@electric-sql/pglite";
import migration from "../../supabase/migrations/202610220001_ledger_accounts.sql?raw";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { emptyData, type AppData } from "./storage";
import type { Transaction } from "./ledger";

const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
let db: PGlite;
type LedgerRow = { user_id: string; data: AppData; revision: number | string; updated_at: Date | string };

function expense(overrides: Partial<Transaction> = {}): Transaction {
  return { id: "expense-1", kind: "expense", amountCents: 3850, date: "2026-10-22T12:30", merchant: "测试餐厅", category: "餐饮", source: "sms", note: "", ...overrides };
}
function ledger(overrides: Partial<AppData> = {}): AppData {
  return { ...emptyData(), transactions: [expense()], budgetCents: 100_000, ...overrides };
}
async function asUser<T>(userId: string | null, run: () => Promise<T>, role = "authenticated"): Promise<T> {
  await db.exec(`set role ${role}`);
  await db.query("select pg_catalog.set_config('request.jwt.claims', $1, false)", [JSON.stringify(userId ? { sub: userId, role } : { role })]);
  try { return await run(); }
  finally {
    await db.exec("reset role");
    await db.query("select pg_catalog.set_config('request.jwt.claims', '', false)");
  }
}
async function save(data: unknown, revision: number | null) {
  return (await db.query<LedgerRow>("select * from public.save_moneytrail_ledger($1::jsonb, $2::bigint)", [JSON.stringify(data), revision])).rows;
}
async function rows() { return (await db.query<LedgerRow>("select * from public.moneytrail_ledgers order by user_id")).rows; }

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create schema auth;
    create table auth.users (id uuid primary key, email text);
    create function auth.uid() returns uuid language sql stable set search_path = '' as $$
      select (nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid
    $$;
    grant usage on schema public, auth to anon, authenticated;
    insert into auth.users(id,email) values ('${ALICE}','alice@example.invalid'),('${BOB}','bob@example.invalid');
  `);
  await db.exec(migration);
}, 30_000);

beforeEach(async () => { await db.exec("reset role; truncate public.moneytrail_ledgers;"); });
afterAll(async () => { await db?.close(); });

describe("PostgreSQL account isolation and compare-and-swap", () => {
  it("allows initial creation and revision-checked update for the authenticated owner", async () => {
    const initial = await asUser(ALICE, () => save(ledger(), 0));
    expect(initial).toHaveLength(1);
    expect(initial[0].user_id).toBe(ALICE);
    expect(Number(initial[0].revision)).toBe(1);
    const next = ledger({ budgetCents: 200_000 });
    const updated = await asUser(ALICE, () => save(next, 1));
    expect(Number(updated[0].revision)).toBe(2);
    expect(updated[0].data).toEqual(next);
  });

  it("keeps Alice and Bob separate even when their transaction IDs are identical", async () => {
    await asUser(ALICE, () => save(ledger(), 0));
    await asUser(BOB, () => save(ledger({ budgetCents: 900_000 }), 0));
    const alice = await asUser(ALICE, rows);
    const bob = await asUser(BOB, rows);
    expect(alice.map(row => row.user_id)).toEqual([ALICE]);
    expect(bob.map(row => row.user_id)).toEqual([BOB]);
    expect(alice[0].data.budgetCents).toBe(100_000);
    expect(bob[0].data.budgetCents).toBe(900_000);
  });

  it("returns no other-account rows even when a client supplies the other user ID", async () => {
    await asUser(BOB, () => save(ledger(), 0));
    const selected = await asUser(ALICE, () => db.query("select * from public.moneytrail_ledgers where user_id = $1::uuid", [BOB]));
    expect(selected.rows).toEqual([]);
  });

  it("denies anonymous reads and RPC execution", async () => {
    await asUser(ALICE, () => save(ledger(), 0));
    await expect(asUser(null, rows, "anon")).rejects.toMatchObject({ code: "42501" });
    await expect(asUser(null, () => save(ledger(), 0), "anon")).rejects.toMatchObject({ code: "42501" });
  });

  it("refuses a missing verified subject even if the role is authenticated", async () => {
    await asUser(ALICE, () => save(ledger(), 0));
    expect(await asUser(null, rows)).toEqual([]);
    await expect(asUser(null, () => save(ledger(), 0))).rejects.toMatchObject({ code: "28000" });
    expect((await rows()).map(row => row.user_id)).toEqual([ALICE]);
  });

  it.each([ALICE, BOB])("does not allow direct client inserts for user %s", async (target) => {
    await expect(asUser(ALICE, () => db.query("insert into public.moneytrail_ledgers(user_id,data,revision) values ($1::uuid,$2::jsonb,1)", [target, JSON.stringify(ledger())]))).rejects.toMatchObject({ code: "42501" });
    expect(await rows()).toEqual([]);
  });

  it("does not allow direct updates or deletes to bypass the revision RPC", async () => {
    await asUser(ALICE, () => save(ledger(), 0));
    await asUser(BOB, () => save(ledger(), 0));
    await expect(asUser(ALICE, () => db.query("update public.moneytrail_ledgers set data = $1::jsonb where user_id = $2::uuid", [JSON.stringify(emptyData()), ALICE]))).rejects.toMatchObject({ code: "42501" });
    await expect(asUser(ALICE, () => db.query("update public.moneytrail_ledgers set data = $1::jsonb where user_id = $2::uuid", [JSON.stringify(emptyData()), BOB]))).rejects.toMatchObject({ code: "42501" });
    await expect(asUser(ALICE, () => db.exec("delete from public.moneytrail_ledgers"))).rejects.toMatchObject({ code: "42501" });
    expect(await rows()).toHaveLength(2);
  });

  it("rejects an extra forged account ID in a snapshot instead of trusting it", async () => {
    await asUser(BOB, () => save(ledger(), 0));
    await expect(asUser(ALICE, () => save({ ...ledger(), user_id: BOB }, 0))).rejects.toMatchObject({ code: "22023" });
    expect((await rows()).map(row => row.user_id)).toEqual([BOB]);
  });

  it("does not accept a user ID parameter on the save RPC", async () => {
    await expect(asUser(ALICE, () => db.query("select * from public.save_moneytrail_ledger($1::jsonb,$2::bigint,$3::uuid)", [JSON.stringify(ledger()), 0, BOB]))).rejects.toMatchObject({ code: "42883" });
  });

  it("does not expose internal validation helpers to client roles", async () => {
    for (const role of ["anon", "authenticated"]) {
      await expect(asUser(ALICE, () => db.query("select public.moneytrail_valid_payload($1::jsonb)", [JSON.stringify(ledger())]), role)).rejects.toMatchObject({ code: "42501" });
      await expect(asUser(ALICE, () => db.query("select public.moneytrail_valid_local_datetime($1)", ["2026-10-22T12:30"]), role)).rejects.toMatchObject({ code: "42501" });
    }
  });

  it("rejects two devices creating the same account snapshot at revision zero", async () => {
    await asUser(ALICE, () => save(ledger(), 0));
    await expect(asUser(ALICE, () => save(ledger({ budgetCents: 99 }), 0))).rejects.toMatchObject({ code: "40001" });
    expect((await rows())[0].data.budgetCents).toBe(100_000);
  });

  it("rejects stale updates and missing nonzero revisions without erasing data", async () => {
    await expect(asUser(ALICE, () => save(ledger(), 1))).rejects.toMatchObject({ code: "40001" });
    await asUser(ALICE, () => save(ledger(), 0));
    await asUser(ALICE, () => save(ledger({ budgetCents: 200_000 }), 1));
    await expect(asUser(ALICE, () => save(ledger({ budgetCents: 99 }), 1))).rejects.toMatchObject({ code: "40001" });
    expect((await rows())[0].data.budgetCents).toBe(200_000);
  });

  it("clears an account with a valid empty snapshot while preserving another account", async () => {
    await asUser(ALICE, () => save(ledger(), 0));
    await asUser(BOB, () => save(ledger(), 0));
    await asUser(ALICE, () => save(emptyData(), 1));
    const all = await rows();
    expect(all.find(row => row.user_id === ALICE)?.data).toEqual(emptyData());
    expect(all.find(row => row.user_id === BOB)?.data).toEqual(ledger());
  });

  it("removes only the deleted auth user's ledger through the foreign-key cascade", async () => {
    await asUser(ALICE, () => save(ledger(), 0));
    await asUser(BOB, () => save(ledger(), 0));
    // Roll back the auth fixture deletion so later cases keep both auth users.
    await db.exec("begin");
    try {
      await db.query("delete from auth.users where id = $1::uuid", [ALICE]);
      expect((await rows()).map(row => row.user_id)).toEqual([BOB]);
    } finally {
      await db.exec("rollback");
    }
  });

  it("stops safely at the maximum JavaScript-safe revision", async () => {
    await asUser(ALICE, () => save(ledger(), 0));
    await db.query("update public.moneytrail_ledgers set revision = $1::bigint where user_id = $2::uuid", ["9007199254740990", ALICE]);
    const updated = await asUser(ALICE, () => save(ledger(), 9_007_199_254_740_990));
    expect(String(updated[0].revision)).toBe("9007199254740991");
    await expect(asUser(ALICE, () => save(emptyData(), 9_007_199_254_740_991))).rejects.toMatchObject({ code: "22023" });
    expect((await rows())[0].data).toEqual(ledger());
  });

  it("can reapply the migration without losing existing ledgers or opening write grants", async () => {
    await asUser(ALICE, () => save(ledger(), 0));
    await db.exec(migration);
    expect((await rows())[0].data).toEqual(ledger());
    const permissions = await db.query<{ privilege_type: string }>("select privilege_type from information_schema.role_table_grants where table_schema='public' and table_name='moneytrail_ledgers' and grantee='authenticated'");
    expect(permissions.rows.map(row => row.privilege_type)).toEqual(["SELECT"]);
    await expect(asUser(BOB, () => db.exec("delete from public.moneytrail_ledgers"))).rejects.toMatchObject({ code: "42501" });
  });
});

describe("server-side payload validation", () => {
  const badSnapshots: [string, () => unknown][] = [
    ["missing payload", () => null],
    ["wrong version", () => ledger({ version: 2 as 1 })],
    ["missing field", () => ({ version: 1, transactions: [], budgetCents: 0 })],
    ["negative budget", () => ledger({ budgetCents: -1 })],
    ["fractional budget", () => ledger({ budgetCents: 1.5 })],
    ["oversized budget", () => ledger({ budgetCents: 1_000_000_000_001 })],
    ["invalid month", () => ledger({ billCheckedMonths: ["2026-13"] })],
    ["year zero", () => ledger({ billCheckedMonths: ["0000-01"] })],
    ["duplicate months", () => ledger({ billCheckedMonths: ["2026-10", "2026-10"] })],
    ["wrong array type", () => ({ ...ledger(), transactions: {} })],
    ["duplicate transaction IDs", () => ledger({ transactions: [expense(), expense()] })],
    ["zero amount", () => ledger({ transactions: [expense({ amountCents: 0 })] })],
    ["fractional cents", () => ledger({ transactions: [expense({ amountCents: 0.01 })] })],
    ["oversized amount", () => ledger({ transactions: [expense({ amountCents: 1_000_000_000_001 })] })],
    ["invalid date", () => ledger({ transactions: [expense({ date: "2026-02-30T12:30" })] })],
    ["invalid leap date", () => ledger({ transactions: [expense({ date: "2026-02-29T12:30" })] })],
    ["overflow hour", () => ledger({ transactions: [expense({ date: "2026-10-22T24:00" })] })],
    ["missing merchant", () => ledger({ transactions: [expense({ merchant: "   " })] })],
    ["unknown category", () => ledger({ transactions: [expense({ category: "秘密分类" })] })],
    ["unknown kind", () => ledger({ transactions: [expense({ kind: "delete" as "expense" })] })],
    ["unknown source", () => ledger({ transactions: [expense({ source: "server" as "manual" })] })],
    ["extra transaction user ID", () => ledger({ transactions: [{ ...expense(), user_id: BOB } as Transaction] })],
    ["null optional value", () => ledger({ transactions: [{ ...expense(), sourceRef: null } as unknown as Transaction] })],
    ["missing refund target", () => ledger({ transactions: [expense({ kind: "refund", linkedTransactionId: "missing" })] })],
    ["expense with refund link", () => ledger({ transactions: [expense({ linkedTransactionId: "expense-1" })] })],
    ["overlong note", () => ledger({ transactions: [expense({ note: "x".repeat(2001) })] })],
    ["oversized snapshot", () => ledger({ transactions: Array.from({ length: 3000 }, (_, n) => expense({ id: `tx-${n}`, note: "x".repeat(2000) })) })],
  ];
  it.each(badSnapshots)("rejects %s without creating an account row", async (_label, make) => {
    await expect(asUser(ALICE, () => save(make(), 0))).rejects.toMatchObject({ code: "22023" });
    expect(await rows()).toEqual([]);
  });

  it.each([-1, null, 9_007_199_254_740_991])("rejects invalid revision %s", async revision => {
    await expect(asUser(ALICE, () => save(ledger(), revision))).rejects.toMatchObject({ code: "22023" });
  });

  it("accepts leap days, independent transfers/income and correctly linked refunds", async () => {
    const body = ledger({ transactions: [
      expense({ date: "2024-02-29T23:59", sourceRef: "original-1" }),
      expense({ id: "refund-1", kind: "refund", linkedTransactionId: "expense-1", amountCents: 500 }),
      expense({ id: "transfer-1", kind: "transfer" }),
      expense({ id: "income-1", kind: "income" }),
    ], billCheckedMonths: ["2024-02", "2026-10"] });
    const result = await asUser(ALICE, () => save(body, 0));
    expect(result[0].data).toEqual(body);
  });
});
