/** Database-only activity counts; fixture claims do not verify hosted JWT signatures. */
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';

const migrations = import.meta.glob('../../supabase/migrations/*.sql', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const summaryFunction = 'moneytrail_sms_activity_summary';
type Status = 'pending' | 'recorded' | 'dismissed';
type Summary = { period_start: string; period_end: string; time_zone: string; received_count: number; recorded_count: number; pending_count: number; dismissed_count: number };
let db: PGlite;
let previousDefinitions: unknown[];
let summaryKeptDefinitions = false;
let summaryKeptRelations = false;
let previousRelations: unknown[];

async function rpc<T = any>(name: string, args: unknown[] = []): Promise<T> {
  return (await db.query<{ result: T }>(`select public.${name}(${args.map((_, i) => `$${i + 1}`).join(',')}) result`, args)).rows[0].result;
}
async function asUser<T>(id: string | null, run: () => Promise<T>, role: 'anon' | 'authenticated' = 'authenticated'): Promise<T> {
  await db.exec(`set role ${role}`);
  await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ role, ...(id ? { sub: id } : {}) })]);
  try { return await run(); }
  finally { await db.exec('reset role'); await db.query("select set_config('request.jwt.claims','',false)"); }
}
async function summary(id = A) { return asUser(id, () => rpc<Summary>(summaryFunction)); }
async function seed(status: Status, offset = '-1 hour', owner = A) {
  return (await db.query<{ id: string }>(`with fixture as (select gen_random_uuid() id)
    insert into moneytrail_private.sms_inbox(id,user_id,received_at,fingerprint,status,raw_text,transaction_id)
    select id,$1::uuid,statement_timestamp()+$2::interval,encode(sha256(convert_to(id::text,'UTF8')),'hex'),$3,
      case when $3='pending' then 'private fixture text' end,case when $3='recorded' then 'sms-'||id::text end
    from fixture returning id`, [owner, offset, status])).rows[0].id;
}
async function rows(table: string) {
  return (await db.query(`select row_to_json(t)::text value from ${table} t order by row_to_json(t)::text`)).rows;
}
async function definitions() {
  return (await db.query(`select n.nspname,p.proname,pg_get_function_identity_arguments(p.oid) arguments,pg_get_functiondef(p.oid) definition,p.proacl
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('public','moneytrail_private') and p.proname<>'${summaryFunction}' order by n.nspname,p.proname,p.oid`)).rows;
}
async function relations() {
  return (await db.query(`select n.nspname,c.relname,c.relkind,c.relacl,c.relrowsecurity,a.attnum,a.attname,format_type(a.atttypid,a.atttypmod) type,a.attnotnull
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    left join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped
    where n.nspname in ('public','moneytrail_private') and c.relkind in ('r','p','v','m') order by n.nspname,c.relname,a.attnum`)).rows;
}
function counts(result: Summary) {
  return { received_count: result.received_count, recorded_count: result.recorded_count, pending_count: result.pending_count, dismissed_count: result.dismissed_count };
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`create role anon nologin; create role authenticated nologin; create schema auth;
    create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz,deleted_at timestamptz);
    create function auth.uid() returns uuid language sql stable set search_path='' as $$select (nullif(pg_catalog.current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid$$;
    grant usage on schema public,auth to anon,authenticated;`);
  for (const file of Object.keys(migrations).sort()) {
    if (file.endsWith('_sms_activity_summary.sql')) {
      previousDefinitions = await definitions();
      previousRelations = await relations();
      await db.exec(migrations[file]);
      summaryKeptDefinitions = JSON.stringify(await definitions()) === JSON.stringify(previousDefinitions);
      summaryKeptRelations = JSON.stringify(await relations()) === JSON.stringify(previousRelations);
    } else {
      await db.exec(migrations[file]);
    }
  }
}, 30000);
afterAll(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec(`reset role; truncate auth.users cascade; insert into auth.users values
    ('${A}','alice@example.invalid',now(),null,null),('${B}','bob@example.invalid',now(),null,null),('${C}','unverified@example.invalid',null,null,null);`);
});

it('returns an explicit zero summary for a verified account with no SMS setup or receipts', async () => {
  const result = await summary();
  expect(Object.keys(result).sort()).toEqual(['period_start', 'period_end', 'time_zone', 'received_count', 'recorded_count', 'pending_count', 'dismissed_count'].sort());
  expect(result.time_zone).toBe('Asia/Shanghai');
  expect(counts(result)).toEqual({ received_count: 0, recorded_count: 0, pending_count: 0, dismissed_count: 0 });
  expect(Date.parse(result.period_end) - Date.parse(result.period_start)).toBe(168 * 60 * 60 * 1000);
  expect(await rows('moneytrail_private.sms_settings')).toEqual([]);
});

it('counts all current statuses from the caller\'s received cohort, independently of inbox pagination', async () => {
  for (let i = 0; i < 12; i++) await seed('recorded');
  await seed('pending'); await seed('pending'); await seed('dismissed');
  await seed('pending', '-8 days'); await seed('recorded', '-8 days');
  const result = await summary();
  expect(counts(result)).toEqual({ received_count: 15, recorded_count: 12, pending_count: 2, dismissed_count: 1 });
  const inbox = await asUser(A, () => rpc<{ items: unknown[]; total: number }>('moneytrail_sms_inbox', [1, 10]));
  expect(inbox.items).toHaveLength(10); expect(inbox.total).toBe(17);
  expect((await asUser(A, () => rpc<{ pending_count: number }>('moneytrail_sms_config'))).pending_count).toBe(3);
});

it('keeps another account\'s receipts and statuses isolated', async () => {
  await seed('pending'); await seed('recorded', '-1 hour', B); await seed('dismissed', '-1 hour', B);
  expect(counts(await summary(A))).toEqual({ received_count: 1, recorded_count: 0, pending_count: 1, dismissed_count: 0 });
  expect(counts(await summary(B))).toEqual({ received_count: 2, recorded_count: 1, pending_count: 0, dismissed_count: 1 });
  expect(counts(await summary(A))).toEqual({ received_count: 1, recorded_count: 0, pending_count: 1, dismissed_count: 0 });
});

it('includes the exact lower bound and excludes the exact upper bound, older and future receipts', async () => {
  await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ sub: A })]);
  await db.exec(`do $$ declare anchor timestamptz:=statement_timestamp(); result jsonb; begin
    insert into moneytrail_private.sms_inbox(id,user_id,received_at,fingerprint,status,raw_text,transaction_id)
    select id,'${A}'::uuid,anchor+offset_value,encode(sha256(convert_to(id::text,'UTF8')),'hex'),status,
      case when status='pending' then 'boundary fixture' end,case when status='recorded' then 'sms-'||id::text end
    from (select gen_random_uuid() id,offset_value,status from (values
      (-interval '168 hours','pending'),(-interval '168 hours'-interval '1 microsecond','dismissed'),
      (-interval '1 microsecond','recorded'),(interval '0','pending'),(interval '1 microsecond','dismissed'),
      (-interval '3 days','dismissed')) bounds(offset_value,status)) fixture;
    result:=public.${summaryFunction}();
    if (result->>'period_end')::timestamptz<>anchor or (result->>'period_start')::timestamptz<>anchor-interval '168 hours' then raise exception 'Incorrect activity bounds'; end if;
    perform set_config('test.sms_activity_summary',result::text,false);
  end $$;`);
  const result = (await db.query<{ result: Summary }>("select current_setting('test.sms_activity_summary')::jsonb result")).rows[0].result;
  expect(counts(result)).toEqual({ received_count: 3, recorded_count: 1, pending_count: 1, dismissed_count: 1 });
});

it('uses one statement endpoint for repeated calls and the fixed 168-hour window in any session timezone', async () => {
  for (const zone of ['UTC', 'Asia/Shanghai', 'America/New_York']) {
    await db.query("select set_config('TimeZone',$1,false)", [zone]);
    const result = await asUser(A, async () => (await db.query<{ same_end: boolean; duration: number; first_result: Summary; second_result: Summary }>(`select
      (one->>'period_end')::timestamptz=statement_timestamp() same_end,
      extract(epoch from (one->>'period_end')::timestamptz-(one->>'period_start')::timestamptz)::integer duration,
      one first_result,two second_result from (select public.${summaryFunction}() one,public.${summaryFunction}() two) calls`)).rows[0]);
    expect(result.same_end).toBe(true); expect(result.duration).toBe(168 * 60 * 60);
    expect(result.first_result.period_end).toBe(result.second_result.period_end); expect(result.first_result.time_zone).toBe('Asia/Shanghai');
  }
  await db.exec("set TimeZone='UTC'");
});

it('keeps old receipts outside the period even when confirmed now, while recent status changes move between buckets', async () => {
  const oldId = await seed('pending', '-8 days');
  const recordedId = await seed('pending', '-2 days');
  const dismissedId = await seed('pending', '-1 day');
  expect(counts(await summary())).toEqual({ received_count: 2, recorded_count: 0, pending_count: 2, dismissed_count: 0 });
  await db.query("update moneytrail_private.sms_inbox set status='recorded',raw_text=null,transaction_id='sms-'||id::text where id=any($1::uuid[])", [[oldId, recordedId]]);
  await db.query("update moneytrail_private.sms_inbox set status='dismissed',raw_text=null where id=$1", [dismissedId]);
  expect(counts(await summary())).toEqual({ received_count: 2, recorded_count: 1, pending_count: 0, dismissed_count: 1 });
});

it('does not count repeated capability deliveries of the same receipt as new activity', async () => {
  const { token } = await asUser(A, () => rpc<{ token: string }>('moneytrail_sms_rotate', ['review']));
  const text = '【中国银行】您的账户收入人民币1000元。';
  const first = await asUser(null, () => rpc<{ status: string; id: string }>('moneytrail_receive_sms', [token, text]), 'anon');
  expect(first.status).toBe('pending');
  expect(await asUser(null, () => rpc('moneytrail_receive_sms', [token, text]), 'anon')).toEqual({ accepted: true, status: 'duplicate', id: first.id });
  expect(counts(await summary())).toEqual({ received_count: 1, recorded_count: 0, pending_count: 1, dismissed_count: 0 });
  expect((await db.query<{ n: number }>('select receipt_count n from moneytrail_private.sms_settings where user_id=$1', [A])).rows[0].n).toBe(2);
});

it('keeps seven-day counts accurate after the existing thirty-day processed-receipt cleanup', async () => {
  const { token } = await asUser(A, () => rpc<{ token: string }>('moneytrail_sms_rotate', ['review']));
  const oldRecorded = await seed('recorded', '-31 days');
  const oldDismissed = await seed('dismissed', '-31 days');
  const oldPending = await seed('pending', '-31 days');
  await seed('recorded', '-6 days'); await seed('dismissed', '-2 days'); await seed('pending', '-1 day');
  expect(counts(await summary())).toEqual({ received_count: 3, recorded_count: 1, pending_count: 1, dismissed_count: 1 });
  await asUser(null, () => rpc('moneytrail_receive_sms', [token, '【中国银行】您的账户收入人民币1200元。']), 'anon');
  expect((await db.query<{ id: string }>('select id from moneytrail_private.sms_inbox where id=any($1::uuid[])', [[oldRecorded, oldDismissed, oldPending]])).rows).toEqual([{ id: oldPending }]);
  expect(counts(await summary())).toEqual({ received_count: 4, recorded_count: 1, pending_count: 2, dismissed_count: 1 });
});

it.each([
  ['unverified email', "email_confirmed_at=null"], ['empty email', "email=''"], ['null email', 'email=null'],
  ['deleted account', 'deleted_at=now()'], ['banned account', "banned_until=now()+interval '1 hour'"],
])('requires a verified active account: %s', async (_, patch) => {
  await seed('pending'); await db.exec(`update auth.users set ${patch} where id='${A}'`);
  await expect(summary()).rejects.toMatchObject({ code: '42501' });
});

it('rejects anonymous, missing and non-existent identities without granting capability-token read access', async () => {
  await expect(asUser(A, () => rpc(summaryFunction), 'anon')).rejects.toMatchObject({ code: '42501' });
  await expect(asUser(null, () => rpc(summaryFunction))).rejects.toMatchObject({ code: '42501' });
  await expect(asUser('99999999-9999-4999-8999-999999999999', () => rpc(summaryFunction))).rejects.toMatchObject({ code: '42501' });
  await expect(summary(C)).rejects.toMatchObject({ code: '42501' });
});

it('does not expose raw text, drafts, identifiers or receipt tokens', async () => {
  const { token } = await asUser(A, () => rpc<{ token: string }>('moneytrail_sms_rotate', ['review']));
  const id = await seed('pending');
  const serialized = JSON.stringify(await summary());
  expect(serialized).not.toContain(token); expect(serialized).not.toContain(id); expect(serialized).not.toContain(A);
  expect(serialized).not.toContain('private fixture text'); expect(serialized).not.toContain('raw_text'); expect(serialized).not.toContain('draft');
  await expect(asUser(A, () => db.query('select * from moneytrail_private.sms_inbox'))).rejects.toMatchObject({ code: '42501' });
});

it('is read-only even in a read-only transaction and leaves every existing business row unchanged', async () => {
  await asUser(A, () => rpc('moneytrail_sms_rotate', ['review']));
  await seed('pending'); await seed('recorded'); await seed('dismissed');
  await db.query("insert into public.moneytrail_ledgers(user_id,data,revision,updated_at) values($1,$2::jsonb,1,now())", [A, JSON.stringify({ version: 1, transactions: [], budgetCents: 42, billCheckedMonths: [] })]);
  const tables = ['auth.users', 'moneytrail_private.sms_settings', 'moneytrail_private.sms_inbox', 'moneytrail_private.sms_category_rules', 'public.moneytrail_ledgers'];
  const before = await Promise.all(tables.map(rows));
  await db.exec('begin read only');
  try { expect(counts(await summary())).toEqual({ received_count: 3, recorded_count: 1, pending_count: 1, dismissed_count: 1 }); }
  finally { await db.exec('rollback'); }
  expect(await Promise.all(tables.map(rows))).toEqual(before);
});

it('adds only one stable, authenticated-only, argument-free definer function with pinned search_path', async () => {
  const metadata = (await db.query<{ stable: boolean; definer: boolean; no_args: boolean; pinned: boolean; auth: boolean; anon: boolean; public_grant: boolean }>(`select
    p.provolatile='s' stable,p.prosecdef definer,p.pronargs=0 no_args,p.proconfig=array['search_path=""']::text[] pinned,
    has_function_privilege('authenticated',p.oid,'EXECUTE') auth,has_function_privilege('anon',p.oid,'EXECUTE') anon,
    exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl where acl.grantee=0 and acl.privilege_type='EXECUTE') public_grant
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='${summaryFunction}'`)).rows;
  expect(metadata).toEqual([{ stable: true, definer: true, no_args: true, pinned: true, auth: true, anon: false, public_grant: false }]);
  expect(previousDefinitions).toBeDefined(); expect(previousRelations).toBeDefined();
  expect(summaryKeptDefinitions).toBe(true);
  expect(summaryKeptRelations).toBe(true);
});
