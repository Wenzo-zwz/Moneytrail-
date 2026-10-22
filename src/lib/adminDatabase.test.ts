/** Real PostgreSQL ACL/RLS tests; fixture claims do not verify hosted JWT signatures. */
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import ledgerMigration from "../../supabase/migrations/202610220001_ledger_accounts.sql?raw";
import adminMigration from "../../supabase/migrations/202610220002_single_admin.sql?raw";
import ownerBinding from "../../supabase/admin-owner.sql?raw";
import { emptyData } from "./storage";

const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const CHARLIE = "33333333-3333-4333-8333-333333333333";
const PHONE = "44444444-4444-4444-8444-444444444444";
let db: PGlite;

type AdminUser = {
  id: string;
  email: string | null;
  created_at: string | null;
  email_confirmed_at: string | null;
  last_sign_in_at: string | null;
  ledger_updated_at: string | null;
  transaction_count: number;
};
type Overview = {
  totals: { users: number; confirmed_users: number; new_users_7d: number; ledgers: number; synced_24h: number };
  users: AdminUser[];
  total: number;
  page: number;
  page_size: number;
};

async function asUser<T>(id: string | null, run: () => Promise<T>, role: "anon" | "authenticated" = "authenticated", claims: Record<string, unknown> = {}): Promise<T> {
  await db.exec(`set role ${role}`);
  await db.query("select pg_catalog.set_config('request.jwt.claims', $1, false)", [JSON.stringify({ role, ...(id ? { sub: id } : {}), ...claims })]);
  try { return await run(); }
  finally {
    await db.exec("reset role");
    await db.query("select pg_catalog.set_config('request.jwt.claims', '', false)");
  }
}
async function isAdmin() {
  return (await db.query<{ allowed: boolean }>("select public.moneytrail_is_admin() as allowed")).rows[0].allowed;
}
async function overview(query: string | null = "", page: number | null = 1, pageSize: number | null = 20): Promise<Overview> {
  return (await db.query<{ result: Overview }>("select public.moneytrail_admin_overview($1::text,$2::integer,$3::integer) as result", [query, page, pageSize])).rows[0].result;
}
async function bindOwner(email: string) {
  try {
    return await db.exec(ownerBinding.replace("ADMIN_EMAIL_HERE", email.replaceAll("'", "''")));
  } catch (error) {
    await db.exec("rollback");
    throw error;
  }
}
function ledger(prefix: string, count = 1) {
  return {
    ...emptyData(), budgetCents: 900000,
    transactions: Array.from({ length: count }, (_, index) => ({
      id: `${prefix}-${index}`, kind: "expense", amountCents: 123456,
      date: "2026-10-22T12:30", merchant: "PRIVATE MERCHANT", category: "餐饮",
      source: "manual", note: "PRIVATE FINANCIAL NOTE", sourceRef: "PRIVATE REF",
    })),
  };
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create schema auth;
    create table auth.users (
      id uuid primary key, email text, email_confirmed_at timestamptz,
      created_at timestamptz, last_sign_in_at timestamptz,
      banned_until timestamptz, deleted_at timestamptz,
      raw_app_meta_data jsonb, raw_user_meta_data jsonb,
      encrypted_password text, confirmation_token text
    );
    create function auth.uid() returns uuid language sql stable set search_path = '' as $$
      select (nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid
    $$;
    grant usage on schema public, auth to anon, authenticated;
  `);
  await db.exec(ledgerMigration);
  await db.exec(adminMigration);
}, 30_000);

beforeEach(async () => {
  await db.exec(`
    reset role;
    truncate auth.users cascade;
    insert into auth.users(id,email,email_confirmed_at,created_at,last_sign_in_at,encrypted_password,confirmation_token) values
      ('${ALICE}','alice@example.invalid',now()-interval '14 days',now()-interval '14 days',now()-interval '1 hour','SECRET HASH','SECRET TOKEN'),
      ('${BOB}','bob@example.invalid',now()-interval '2 days',now()-interval '2 days',now()-interval '2 hours','OTHER HASH','OTHER TOKEN'),
      ('${CHARLIE}','charlie+100%@example.invalid',null,now()-interval '1 day',null,null,null),
      ('${PHONE}',null,null,null,null,null,null);
    insert into moneytrail_private.admin_owner(user_id) values ('${ALICE}');
  `);
  await db.query("insert into public.moneytrail_ledgers(user_id,data,revision,updated_at) values ($1::uuid,$2::jsonb,1,now()-interval '1 hour'),($3::uuid,$4::jsonb,2,now()-interval '2 days')", [ALICE, JSON.stringify(ledger("alice")), BOB, JSON.stringify(ledger("bob", 2))]);
});
afterAll(async () => { await db?.close(); });

describe("PostgreSQL single-owner administrator", () => {
  it("has no administrator until an operator binds one verified user UUID", async () => {
    await db.exec("delete from moneytrail_private.admin_owner");
    expect(await asUser(ALICE, isAdmin)).toBe(false);
    expect(await asUser(BOB, isAdmin)).toBe(false);
    await expect(asUser(ALICE, overview)).rejects.toMatchObject({ code: "42501" });
    await db.query("insert into moneytrail_private.admin_owner(user_id) values ($1::uuid)", [ALICE]);
    expect(await asUser(ALICE, isAdmin)).toBe(true);
  });

  it("authorizes exactly the bound verified active account", async () => {
    expect(await asUser(ALICE, isAdmin)).toBe(true);
    expect(await asUser(BOB, isAdmin)).toBe(false);
    expect(await asUser(CHARLIE, isAdmin)).toBe(false);
    expect(await asUser(PHONE, isAdmin)).toBe(false);
    expect(await asUser(null, isAdmin)).toBe(false);
    await expect(asUser(BOB, overview)).rejects.toMatchObject({ code: "42501" });
    await expect(asUser(null, overview)).rejects.toMatchObject({ code: "42501" });
  });

  it("denies anonymous execution even with the owner's UUID in fixture claims", async () => {
    await expect(asUser(null, isAdmin, "anon")).rejects.toMatchObject({ code: "42501" });
    await expect(asUser(ALICE, isAdmin, "anon")).rejects.toMatchObject({ code: "42501" });
    await expect(asUser(ALICE, overview, "anon")).rejects.toMatchObject({ code: "42501" });
  });

  it("ignores caller role/email claims and user-editable administrator metadata", async () => {
    await db.query("update auth.users set raw_user_meta_data = $1::jsonb, raw_app_meta_data = $1::jsonb where id = $2::uuid", [JSON.stringify({ role: "admin", is_admin: true }), BOB]);
    const claims = { email: "alice@example.invalid", role: "service_role", app_metadata: { role: "admin" }, user_metadata: { is_admin: true }, email_verified: true };
    expect(await asUser(BOB, isAdmin, "authenticated", claims)).toBe(false);
    await expect(asUser(BOB, overview, "authenticated", claims)).rejects.toMatchObject({ code: "42501" });
  });

  it.each(["anon", "authenticated"] as const)("does not grant %s any direct binding-table privileges", async (role) => {
    for (const sql of [
      "select * from moneytrail_private.admin_owner",
      `insert into moneytrail_private.admin_owner(user_id) values ('${BOB}')`,
      `update moneytrail_private.admin_owner set user_id = '${BOB}'`,
      "delete from moneytrail_private.admin_owner",
    ]) await expect(asUser(ALICE, () => db.exec(sql), role)).rejects.toMatchObject({ code: "42501" });
    expect((await db.query("select user_id from moneytrail_private.admin_owner")).rows).toEqual([{ user_id: ALICE }]);
  });

  it("revokes default PUBLIC function execution and private schema access", async () => {
    const grants = await db.query<{ count: number }>(`
      select pg_catalog.count(*)::integer as count
      from pg_catalog.pg_proc as procedure,
        lateral pg_catalog.aclexplode(coalesce(procedure.proacl, pg_catalog.acldefault('f', procedure.proowner))) as permission
      where procedure.oid in ('public.moneytrail_is_admin()'::regprocedure, 'public.moneytrail_admin_overview(text,integer,integer)'::regprocedure)
        and permission.grantee = 0 and permission.privilege_type = 'EXECUTE'
    `);
    expect(grants.rows[0].count).toBe(0);
    for (const role of ["anon", "authenticated"]) {
      const result = await db.query<{ allowed: boolean }>("select pg_catalog.has_schema_privilege($1, 'moneytrail_private', 'USAGE') as allowed", [role]);
      expect(result.rows[0].allowed).toBe(false);
    }
    const policy = await db.query<{ enabled: boolean }>("select relrowsecurity as enabled from pg_catalog.pg_class where oid = 'moneytrail_private.admin_owner'::regclass");
    expect(policy.rows[0].enabled).toBe(true);
  });

  it("allows only a single true singleton row", async () => {
    await expect(db.query("insert into moneytrail_private.admin_owner(id,user_id) values (true,$1::uuid)", [BOB])).rejects.toMatchObject({ code: "23505" });
    await expect(db.query("insert into moneytrail_private.admin_owner(id,user_id) values (false,$1::uuid)", [BOB])).rejects.toMatchObject({ code: "23514" });
    await expect(db.query("insert into moneytrail_private.admin_owner(id,user_id) values (null,$1::uuid)", [BOB])).rejects.toMatchObject({ code: "23502" });
    await db.exec("delete from moneytrail_private.admin_owner");
    await expect(db.query("insert into moneytrail_private.admin_owner(user_id) values ('99999999-9999-4999-8999-999999999999')")).rejects.toMatchObject({ code: "23503" });
  });

  it("immediately loses access when the operator removes or replaces the binding", async () => {
    await db.query("update moneytrail_private.admin_owner set user_id = $1::uuid", [BOB]);
    expect(await asUser(ALICE, isAdmin)).toBe(false);
    expect(await asUser(BOB, isAdmin)).toBe(true);
    await expect(asUser(ALICE, overview)).rejects.toMatchObject({ code: "42501" });
    await db.exec("delete from moneytrail_private.admin_owner");
    expect(await asUser(BOB, isAdmin)).toBe(false);
    await expect(asUser(BOB, overview)).rejects.toMatchObject({ code: "42501" });
  });

  it.each([null, "", "   "])("requires the owner's current nonblank email: %j", async (email) => {
    await db.query("update auth.users set email = $1 where id = $2::uuid", [email, ALICE]);
    expect(await asUser(ALICE, isAdmin)).toBe(false);
    await expect(asUser(ALICE, overview)).rejects.toMatchObject({ code: "42501" });
  });

  it("uses current database verification even when an old JWT says the email was verified", async () => {
    await db.query("update auth.users set email_confirmed_at = null where id = $1::uuid", [ALICE]);
    expect(await asUser(ALICE, isAdmin, "authenticated", { email_verified: true, email: "alice@example.invalid" })).toBe(false);
    await expect(asUser(ALICE, overview)).rejects.toMatchObject({ code: "42501" });
  });

  it("keeps the binding on the same UUID after a verified email change", async () => {
    await db.query("update auth.users set email = 'changed@example.invalid' where id = $1::uuid", [ALICE]);
    await db.query("update auth.users set email = 'alice@example.invalid' where id = $1::uuid", [BOB]);
    expect(await asUser(ALICE, isAdmin)).toBe(true);
    expect(await asUser(BOB, isAdmin)).toBe(false);
  });

  it("invalidates the owner's still-unexpired session after a ban or soft deletion", async () => {
    await db.query("update auth.users set banned_until = now() + interval '1 day' where id = $1::uuid", [ALICE]);
    expect(await asUser(ALICE, isAdmin)).toBe(false);
    await expect(asUser(ALICE, overview)).rejects.toMatchObject({ code: "42501" });
    await db.query("update auth.users set banned_until = now() - interval '1 day' where id = $1::uuid", [ALICE]);
    expect(await asUser(ALICE, isAdmin)).toBe(true);
    await db.query("update auth.users set deleted_at = now() where id = $1::uuid", [ALICE]);
    expect(await asUser(ALICE, isAdmin)).toBe(false);
    await expect(asUser(ALICE, overview)).rejects.toMatchObject({ code: "42501" });
  });

  it("cascades a hard-deleted owner's binding and never assigns its replacement by email", async () => {
    await db.query("delete from auth.users where id = $1::uuid", [ALICE]);
    expect((await db.query("select * from moneytrail_private.admin_owner")).rows).toEqual([]);
    expect(await asUser(ALICE, isAdmin)).toBe(false);
    await db.query("update auth.users set email = 'alice@example.invalid' where id = $1::uuid", [BOB]);
    expect(await asUser(BOB, isAdmin)).toBe(false);
    await expect(asUser(BOB, overview)).rejects.toMatchObject({ code: "42501" });
  });

  it("does not grant the administrator raw access to other users' ledgers or auth secrets", async () => {
    const rows = await asUser(ALICE, () => db.query("select user_id from public.moneytrail_ledgers"));
    expect(rows.rows).toEqual([{ user_id: ALICE }]);
    await expect(asUser(ALICE, () => db.exec("select encrypted_password,confirmation_token from auth.users"))).rejects.toMatchObject({ code: "42501" });
    await expect(asUser(ALICE, () => db.exec("delete from public.moneytrail_ledgers"))).rejects.toMatchObject({ code: "42501" });
  });

  it("returns only account metadata and aggregate sync statistics", async () => {
    const result = await asUser(ALICE, overview);
    expect(result.totals).toEqual({ users: 4, confirmed_users: 2, new_users_7d: 2, ledgers: 2, synced_24h: 1 });
    expect(result).toMatchObject({ total: 4, page: 1, page_size: 20 });
    expect(result.users.map(user => user.id)).toEqual([CHARLIE, BOB, ALICE, PHONE]);
    expect(result.users.find(user => user.id === ALICE)?.transaction_count).toBe(1);
    expect(result.users.find(user => user.id === BOB)?.transaction_count).toBe(2);
    expect(result.users.find(user => user.id === PHONE)).toMatchObject({ email: null, created_at: null, email_confirmed_at: null, last_sign_in_at: null, ledger_updated_at: null, transaction_count: 0 });
    for (const user of result.users) expect(Object.keys(user).sort()).toEqual(["id", "email", "created_at", "email_confirmed_at", "last_sign_in_at", "ledger_updated_at", "transaction_count"].sort());
    const raw = JSON.stringify(result);
    for (const secret of ["amountCents", "budgetCents", "PRIVATE MERCHANT", "PRIVATE FINANCIAL NOTE", "PRIVATE REF", "SECRET HASH", "SECRET TOKEN", "encrypted_password", "confirmation_token"]) expect(raw).not.toContain(secret);
  });

  it("searches emails case-insensitively and UUIDs literally without changing global totals", async () => {
    const byEmail = await asUser(ALICE, () => overview("  BOB@  "));
    expect(byEmail.users.map(user => user.id)).toEqual([BOB]);
    expect(byEmail.total).toBe(1);
    expect(byEmail.totals.users).toBe(4);
    expect((await asUser(ALICE, () => overview(BOB.slice(0, 8)))).users.map(user => user.id)).toEqual([BOB]);
    expect((await asUser(ALICE, () => overview("%"))).users.map(user => user.id)).toEqual([CHARLIE]);
    expect((await asUser(ALICE, () => overview("' or true --"))).users).toEqual([]);
    expect((await db.query<{ count: number }>("select count(*)::integer as count from auth.users")).rows[0].count).toBe(4);
  });

  it("paginates deterministically, including an empty out-of-range page", async () => {
    const first = await asUser(ALICE, () => overview("", 1, 1));
    const second = await asUser(ALICE, () => overview("", 2, 1));
    expect(first.users.map(user => user.id)).toEqual([CHARLIE]);
    expect(second.users.map(user => user.id)).toEqual([BOB]);
    expect(second).toMatchObject({ total: 4, page: 2, page_size: 1 });
    expect((await asUser(ALICE, () => overview("", 1000000, 50))).users).toEqual([]);
  });

  it.each([
    [null, 1, 20], ["", null, 20], ["", 0, 20], ["", -1, 20], ["", 1000001, 20],
    ["", 2147483647, 20], ["", 1, null], ["", 1, 0], ["", 1, 51], ["a".repeat(201), 1, 20],
  ] as [string | null, number | null, number | null][])("rejects invalid administrator query %j / %j / %j", async (query, page, pageSize) => {
    await expect(asUser(ALICE, () => overview(query, page, pageSize))).rejects.toMatchObject({ code: "22023" });
  });

  it("checks authorization before validating query parameters", async () => {
    await expect(asUser(BOB, () => overview(null, -1, null))).rejects.toMatchObject({ code: "42501" });
  });

  it("has no target user parameter or browser function for enrolling an administrator", async () => {
    await expect(asUser(BOB, () => db.query("select public.moneytrail_is_admin($1::uuid)", [ALICE]))).rejects.toMatchObject({ code: "42883" });
    const functions = await db.query<{ name: string }>("select proname as name from pg_catalog.pg_proc where pronamespace = 'public'::regnamespace and proname like 'moneytrail%admin%' order by proname");
    expect(functions.rows.map(row => row.name)).toEqual(["moneytrail_admin_overview", "moneytrail_is_admin"]);
  });

  it("can reapply the migration without changing the sole owner or opening privileges", async () => {
    await db.exec(adminMigration);
    expect((await db.query("select user_id from moneytrail_private.admin_owner")).rows).toEqual([{ user_id: ALICE }]);
    expect(await asUser(ALICE, isAdmin)).toBe(true);
    expect(await asUser(BOB, isAdmin)).toBe(false);
    await expect(asUser(BOB, overview)).rejects.toMatchObject({ code: "42501" });
    await expect(asUser(ALICE, overview, "anon")).rejects.toMatchObject({ code: "42501" });
  });
});

describe("operator-only administrator binding script", () => {
  it("requires replacing the placeholder rather than assigning the first account", async () => {
    await db.exec("delete from moneytrail_private.admin_owner");
    await expect(bindOwner("ADMIN_EMAIL_HERE")).rejects.toMatchObject({ code: "22023" });
    expect((await db.query("select * from moneytrail_private.admin_owner")).rows).toEqual([]);
  });

  it("binds the exact verified address and safely repeats for the same owner", async () => {
    await db.exec("delete from moneytrail_private.admin_owner");
    await bindOwner("  ALICE@example.invalid  ");
    const first = (await db.query<{ user_id: string; id: boolean; bound_at: Date }>("select * from moneytrail_private.admin_owner")).rows;
    expect(first).toHaveLength(1);
    expect(first[0].user_id).toBe(ALICE);
    expect(await asUser(ALICE, isAdmin)).toBe(true);
    await bindOwner("alice@example.invalid");
    expect((await db.query("select * from moneytrail_private.admin_owner")).rows).toEqual(first);
  });

  it.each(["missing@example.invalid", "ali@example.invalid", "%@example.invalid", "charlie+100%@example.invalid"])("refuses missing, partial, wildcard or unconfirmed address %s", async (email) => {
    await db.exec("delete from moneytrail_private.admin_owner");
    await expect(bindOwner(email)).rejects.toMatchObject({ code: "22023" });
    expect((await db.query("select * from moneytrail_private.admin_owner")).rows).toEqual([]);
  });

  it("refuses duplicate eligible accounts instead of choosing one arbitrarily", async () => {
    await db.exec("delete from moneytrail_private.admin_owner");
    await db.query("update auth.users set email = 'alice@example.invalid', email_confirmed_at = now() where id = $1::uuid", [BOB]);
    await expect(bindOwner("alice@example.invalid")).rejects.toMatchObject({ code: "21000" });
    expect((await db.query("select * from moneytrail_private.admin_owner")).rows).toEqual([]);
  });

  it("cannot silently replace a previously configured owner", async () => {
    const existing = (await db.query("select * from moneytrail_private.admin_owner")).rows;
    await expect(bindOwner("bob@example.invalid")).rejects.toMatchObject({ code: "42501" });
    expect((await db.query("select * from moneytrail_private.admin_owner")).rows).toEqual(existing);
    expect(await asUser(ALICE, isAdmin)).toBe(true);
    expect(await asUser(BOB, isAdmin)).toBe(false);
  });

  it.each(["deleted_at = now()", "banned_until = now() + interval '1 day'"])("refuses a disabled account with %s", async (change) => {
    await db.exec("delete from moneytrail_private.admin_owner");
    await db.exec(`update auth.users set ${change} where id = '${ALICE}'`);
    await expect(bindOwner("alice@example.invalid")).rejects.toMatchObject({ code: "22023" });
    expect((await db.query("select * from moneytrail_private.admin_owner")).rows).toEqual([]);
  });

  it("does not accept extra SQL through the email literal", async () => {
    await expect(bindOwner("alice@example.invalid'; delete from auth.users; --")).rejects.toMatchObject({ code: "22023" });
    expect((await db.query<{ count: number }>("select count(*)::integer as count from auth.users")).rows[0].count).toBe(4);
    expect((await db.query("select user_id from moneytrail_private.admin_owner")).rows).toEqual([{ user_id: ALICE }]);
  });

  it("is not executable by an ordinary browser session, including the current owner", async () => {
    await expect(asUser(ALICE, () => bindOwner("alice@example.invalid"))).rejects.toMatchObject({ code: "42501" });
    await expect(asUser(BOB, () => bindOwner("bob@example.invalid"))).rejects.toMatchObject({ code: "42501" });
    expect((await db.query("select user_id from moneytrail_private.admin_owner")).rows).toEqual([{ user_id: ALICE }]);
  });
});
