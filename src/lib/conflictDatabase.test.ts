import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';

const migrations = import.meta.glob('../../supabase/migrations/*.sql', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
let db: PGlite;
type Transaction = Record<string, unknown>;
type Selection = { id: string; draft: Transaction };
const transaction = (patch: Transaction = {}): Transaction => ({ id: 'manual-1', kind: 'expense', amountCents: 9000, date: '2026-10-31T12:00', merchant: '青禾馆(东店)', category: '购物', source: 'manual', note: '', ...patch });
const ledger = (transactions = [transaction()], budgetCents = 123456) => ({ version: 1, transactions, budgetCents, billCheckedMonths: ['2026-09'] });
const intent = { transactionId: 'manual-1', merchant: '青禾馆(东店)', category: '学习' };

async function user(id: string | null = A) {
  await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify(id ? { sub: id } : {})]);
}
async function rpc<T = unknown>(name: string, args: unknown[] = []): Promise<T> {
  return (await db.query<{ result: T }>(`select to_jsonb(public.${name}(${args.map((_, i) => `$${i + 1}`).join(',')})) result`, args)).rows[0].result;
}
async function rows(table: string) { return (await db.query(`select * from ${table} order by 1`)).rows; }
async function snapshot() {
  return {
    ledgers: await rows('public.moneytrail_ledgers'),
    inbox: await rows('moneytrail_private.sms_inbox'),
    rules: await rows('moneytrail_private.sms_category_rules'),
  };
}
async function pending(merchant: string, amount = '20', owner = A) {
  const raw = `尾号xxxx卡10月31日12:00支出(${merchant})${amount}元，余额12,345.94元。【工商银行】`;
  return (await db.query<{ id: string }>(`insert into moneytrail_private.sms_inbox(user_id,received_at,fingerprint,status,raw_text)
    values($1,'2026-10-31T04:01:00Z',repeat('a',64),'pending',$2) returning id`, [owner, raw])).rows[0].id;
}
async function preview(): Promise<Selection[]> {
  return (await rpc<{ items: Selection[] }>('moneytrail_sms_preview_pending')).items.map(({ id, draft }) => ({ id, draft }));
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`create role anon nologin; create role authenticated nologin; create schema auth;
    create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz,deleted_at timestamptz);
    create function auth.uid() returns uuid language sql stable as $$select (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid$$;
    grant usage on schema public,auth to anon,authenticated;`);
  for (const path of Object.keys(migrations).sort()) await db.exec(migrations[path]);
}, 30000);

afterAll(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec(`reset role; truncate auth.users cascade; insert into auth.users values('${A}','a@invalid',now(),null,null),('${B}','b@invalid',now(),null,null);`);
  await user();
});

it.each(['save_moneytrail_ledger', 'save_moneytrail_ledger_with_rules'])('%s rejects missing and stale revisions with PT409 while retaining the last ledger', async name => {
  const args = (data: ReturnType<typeof ledger>, revision: number) => name.endsWith('_with_rules') ? [data, revision, []] : [data, revision];
  await expect(rpc(name, args(ledger(), 1))).rejects.toMatchObject({ code: 'PT409' });
  expect(await rows('public.moneytrail_ledgers')).toEqual([]);
  await rpc(name, args(ledger(), 0));
  await rpc(name, args(ledger([transaction({ note: 'current' })], 222222), 1));
  const before = await snapshot();
  for (const revision of [0, 1]) {
    await expect(rpc(name, args(ledger([], 0), revision))).rejects.toMatchObject({ code: 'PT409' });
    expect(await snapshot()).toEqual(before);
  }
});

it('rejects a stale rule save without publishing either the ledger or merchant intent', async () => {
  await rpc('save_moneytrail_ledger', [ledger(), 0]);
  const before = await snapshot();
  await expect(rpc('save_moneytrail_ledger_with_rules', [ledger([transaction({ category: '学习' })]), 0, [intent]]))
    .rejects.toMatchObject({ code: 'PT409' });
  expect(await snapshot()).toEqual(before);
});

it('rejects a conflicting SMS transaction ID with PT409 and retains the saved content', async () => {
  const original = transaction({ id: 'sms-same-id', source: 'sms', sourceRef: 'sms-same-id' });
  await rpc('save_moneytrail_ledger', [ledger([original]), 0]);
  const before = await snapshot();
  await expect(db.query('select moneytrail_private.sms_append($1::uuid,$2::jsonb,false)', [A, { ...original, amountCents: 1 }]))
    .rejects.toMatchObject({ code: 'PT409' });
  expect(await snapshot()).toEqual(before);
});

it.each(['altered draft', 'changed classification', 'dismissed entry'])('rolls back the whole SMS selection when its final item has a %s', async reason => {
  await rpc('save_moneytrail_ledger', [ledger(), 0]);
  const validId = await pending('烟酒副食');
  const staleId = await pending('松林咖啡', '21');
  const selected = await preview();
  const valid = selected.find(item => item.id === validId)!;
  const stale = selected.find(item => item.id === staleId)!;
  if (reason === 'altered draft') stale.draft = { ...stale.draft, amountCents: 1 };
  if (reason === 'changed classification') await rpc('moneytrail_sms_set_category_rule', ['松林咖啡', '学习']);
  if (reason === 'dismissed entry') await rpc('moneytrail_sms_dismiss', [staleId]);
  const before = await snapshot();
  await expect(rpc('moneytrail_sms_apply_pending', [[valid, stale]])).rejects.toMatchObject({ code: 'PT409' });
  expect(await snapshot()).toEqual(before);
});

it('keeps a recorded SMS retry idempotent and rejects a changed recorded preview with PT409', async () => {
  await pending('烟酒副食');
  const selected = await preview();
  expect(await rpc('moneytrail_sms_apply_pending', [selected])).toEqual({ recorded_count: 1, pending_count: 0 });
  const before = await snapshot();
  expect(await rpc('moneytrail_sms_apply_pending', [selected])).toEqual({ recorded_count: 0, pending_count: 0 });
  await expect(rpc('moneytrail_sms_apply_pending', [[{ ...selected[0], draft: { ...selected[0].draft, amountCents: 1 } }]]))
    .rejects.toMatchObject({ code: 'PT409' });
  expect(await snapshot()).toEqual(before);
});

it('preserves valid old-client saves, matching rule saves and account isolation for authenticated users', async () => {
  const original = transaction({ subcategory: '原细类', platform: '京东' });
  await db.exec('set role authenticated');
  expect(await rpc('save_moneytrail_ledger', [ledger([original]), 0])).toMatchObject({ user_id: A, revision: 1 });
  const legacyEdit = ledger([transaction({ note: 'old-client edit' })]);
  const saved = await rpc<{ revision: number; data: ReturnType<typeof ledger> }>('save_moneytrail_ledger', [legacyEdit, 1]);
  expect(saved.revision).toBe(2);
  expect(saved.data.transactions).toEqual([{ ...original, note: 'old-client edit' }]);
  expect(await rpc('save_moneytrail_ledger_with_rules', [ledger([transaction({ category: '学习' })]), 2, [intent]]))
    .toMatchObject({ user_id: A, revision: 3 });
  const aliceRows = await rows('public.moneytrail_ledgers');
  await user(B);
  expect(await rows('public.moneytrail_ledgers')).toEqual([]);
  expect(await rpc('moneytrail_sms_category_rules')).toEqual({ rules: [] });
  expect(await rpc('save_moneytrail_ledger', [ledger([], 777), 0])).toMatchObject({ user_id: B, revision: 1 });
  await user();
  expect(await rows('public.moneytrail_ledgers')).toEqual(aliceRows);
  expect(await rpc('moneytrail_sms_category_rules')).toEqual({ rules: [{ merchant: intent.merchant, category: intent.category }] });
});

it('keeps foreign SMS entries and private append helpers inaccessible', async () => {
  await pending('烟酒副食');
  const selected = await preview();
  await user(B);
  await db.exec('set role authenticated');
  await expect(rpc('moneytrail_sms_apply_pending', [selected])).rejects.toMatchObject({ code: '42501' });
  await expect(db.query('select moneytrail_private.sms_append($1::uuid,$2::jsonb,false)', [A, transaction()]))
    .rejects.toMatchObject({ code: '42501' });
  expect(await rows('public.moneytrail_ledgers')).toEqual([]);
  await db.exec('reset role');
  expect((await rows('moneytrail_private.sms_inbox'))[0]).toMatchObject({ user_id: A, status: 'pending' });
});

it('retains anonymous and missing-identity restrictions on every public write RPC', async () => {
  const writes: [string, unknown[]][] = [
    ['save_moneytrail_ledger', [ledger(), 0]],
    ['save_moneytrail_ledger_with_rules', [ledger(), 0, []]],
    ['moneytrail_sms_apply_pending', [[]]],
  ];
  await db.exec('set role anon');
  for (const [name, args] of writes) await expect(rpc(name, args)).rejects.toMatchObject({ code: '42501' });
  await db.exec('set role authenticated');
  await user(null);
  for (const [name, args] of writes) {
    await expect(rpc(name, args)).rejects.toMatchObject({ code: name === 'save_moneytrail_ledger' ? '28000' : '42501' });
  }
  expect(await rows('public.moneytrail_ledgers')).toEqual([]);
});

it('keeps business conflicts out of the serialization-failure retry code in every final RPC', async () => {
  const functions = [
    'public.save_moneytrail_ledger(jsonb,bigint)',
    'public.save_moneytrail_ledger_with_rules(jsonb,bigint,jsonb)',
    'moneytrail_private.sms_append(uuid,jsonb,boolean)',
    'public.moneytrail_sms_apply_pending(jsonb)',
  ];
  for (const signature of functions) {
    const definition = (await db.query<{ definition: string }>('select pg_get_functiondef($1::regprocedure) definition', [signature])).rows[0].definition;
    expect(definition, signature).not.toContain('40001');
    expect(definition, signature).toContain('PT409');
  }
});
