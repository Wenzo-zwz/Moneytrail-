import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';

const migrations = import.meta.glob('../../supabase/migrations/*.sql', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const owner = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
let db: PGlite;

async function rpc<T>(name: string, args: unknown[] = []): Promise<T> {
  const parameters = args.map((_, index) => '$' + (index + 1)).join(',');
  const result = await db.query<{ value: T }>(
    'select to_jsonb(public.' + name + '(' + parameters + ')) as value',
    args,
  );
  return result.rows[0].value;
}

async function selectAccount(id: string) {
  await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ sub: id })]);
}

async function bankSms(merchant: string, minutesAgo = 0) {
  const result = await db.query<{ value: string }>(
    "select to_char((clock_timestamp() at time zone 'Asia/Shanghai') - $1::int * interval '1 minute', 'MM月DD日HH24:MI') as value",
    [minutesAgo],
  );
  return '尾号xxxx卡' + result.rows[0].value + '支出(' + merchant + ')20元，余额123.94元。【工商银行】';
}

const transaction = {
  id: 'manual-1', kind: 'expense', amountCents: 2_000, date: '2026-10-24T12:00',
  merchant: '松林咖啡', category: '食品酒水', subcategory: '咖啡奶茶', source: 'manual', note: '',
};
const empty = { version: 1, transactions: [], budgetCents: 0, billCheckedMonths: [] };
const annualBudget = {
  category: '食品酒水',
  subcategory: '咖啡奶茶',
  year: 2026,
  capChanges: [
    { month: '2026-01', amountCents: 600_000 },
    { month: '2026-08', amountCents: null },
  ],
  monthlyOverrides: [{ month: '2026-02', amountCents: 0 }],
};

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create schema auth;
    create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz,deleted_at timestamptz);
    create function auth.uid() returns uuid language sql stable as
      $$select (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid$$;
    grant usage on schema public,auth to anon,authenticated;
  `);
  for (const path of Object.keys(migrations).sort()) await db.exec(migrations[path]);
}, 30000);

afterAll(async () => { await db?.close(); });

beforeEach(async () => {
  await db.exec('reset role; truncate auth.users cascade;');
  await db.query("insert into auth.users values($1,'a@invalid',now(),null,null),($2,'b@invalid',now(),null,null)", [owner, other]);
  await selectAccount(owner);
});

it('retains old ledger validity while accepting the new category in an atomic merchant rule save', async () => {
  const existing = { ...transaction, category: '本地生活' };
  const prior = await rpc('save_moneytrail_ledger', [{ ...empty, transactions: [existing] }, 0]);
  expect(prior).toMatchObject({ revision: 1 });

  const saved = await rpc('save_moneytrail_ledger_with_rules', [
    { ...empty, transactions: [transaction] },
    1,
    [{ transactionId: transaction.id, merchant: transaction.merchant, category: transaction.category, subcategory: transaction.subcategory }],
  ]);
  expect(saved).toMatchObject({ revision: 2, data: { transactions: [transaction] } });
  expect(await rpc('moneytrail_sms_category_rules')).toEqual({
    rules: [{ merchant: transaction.merchant, category: transaction.category, subcategory: transaction.subcategory }],
  });
  await selectAccount(other);
  expect(await rpc('moneytrail_sms_category_rules')).toEqual({ rules: [] });
});

it('maps legacy utility details using explicit merchant evidence when saving old snapshots', async () => {
  const utilities = [
    ['城东电费', '居住与家用', '水电燃气'],
    ['松林物业', '居住与家用', '物业'],
    ['家庭宽带账单', '通讯', '家庭宽带'],
    ['快捷支付商户', '待分类', '生活缴费'],
  ] as const;
  const legacy = utilities.map(([merchant], index) => ({
    ...transaction, id: String(index), merchant, category: '居住', subcategory: '生活缴费',
  }));
  expect(await rpc('save_moneytrail_ledger', [{ ...empty, transactions: legacy }, 0])).toMatchObject({
    data: {
      transactions: utilities.map(([merchant, category, subcategory]) => expect.objectContaining({
        merchant, category, subcategory,
      })),
    },
  });
});

it('recognizes explicit food spending and holds platform-only spending for review', async () => {
  const { token } = await rpc<{ token: string }>('moneytrail_sms_rotate', ['auto']);
  expect(await rpc('moneytrail_receive_sms', [token, await bankSms('松林咖啡(东店)')]))
    .toMatchObject({ status: 'recorded' });
  expect(await rpc('moneytrail_receive_sms', [token, await bankSms('美团平台', 15)]))
    .toMatchObject({ status: 'pending' });

  const result = await db.query<{ data: unknown }>('select data from public.moneytrail_ledgers where user_id=$1', [owner]);
  expect(result.rows[0].data).toMatchObject({
    transactions: [{ category: '食品酒水', subcategory: '咖啡奶茶' }],
  });
  expect(await rpc('moneytrail_sms_inbox')).toMatchObject({
    items: expect.arrayContaining([expect.objectContaining({
      status: 'pending', draft: expect.objectContaining({ category: '待分类', platform: '美团' }),
    })]),
  });
});

it('learns a confirmed concrete merchant, then keeps the learned category within that account', async () => {
  const first = await rpc<{ token: string }>('moneytrail_sms_rotate', ['auto']);
  const receipt = await rpc<{ status: string; id: string }>('moneytrail_receive_sms', [first.token, await bankSms('青石小铺(东店)', 30)]);
  expect(receipt.status).toBe('pending');
  const prior = await rpc<{ items: { draft: Record<string, unknown>; warnings: string[]; reason: string }[] }>('moneytrail_sms_inbox');
  expect(prior.items[0]).toMatchObject({ warnings: [], reason: '请核对商户用途与分类。' });
  const draft = { ...prior.items[0].draft, category: '人情往来', subcategory: '礼物' };
  expect(await rpc('moneytrail_sms_confirm_with_rule', [receipt.id, draft, true])).toMatchObject({ status: 'recorded' });
  expect(await rpc('moneytrail_receive_sms', [first.token, await bankSms('财付通-青石小铺（东店）', 15)]))
    .toMatchObject({ status: 'recorded' });

  const ownerLedger = await db.query('select data from public.moneytrail_ledgers where user_id=$1', [owner]);
  expect(ownerLedger.rows[0]).toMatchObject({
    data: { transactions: [expect.objectContaining({ category: '人情往来' }), expect.objectContaining({ category: '人情往来' })] },
  });
  await selectAccount(other);
  const second = await rpc<{ token: string }>('moneytrail_sms_rotate', ['auto']);
  expect(await rpc('moneytrail_receive_sms', [second.token, await bankSms('青石小铺(东店)')]))
    .toMatchObject({ status: 'pending' });
});

it('validates and retains annual settings across an older client save and a recorded SMS', async () => {
  const data = { ...empty, annualBudgets: [annualBudget] };
  expect(await rpc('save_moneytrail_ledger', [data, 0])).toMatchObject({ data, revision: 1 });
  expect(await rpc('save_moneytrail_ledger', [empty, 1])).toMatchObject({ data, revision: 2 });

  const { token } = await rpc<{ token: string }>('moneytrail_sms_rotate', ['auto']);
  expect(await rpc('moneytrail_receive_sms', [token, await bankSms('松林咖啡')])).toMatchObject({ status: 'recorded' });
  const result = await db.query('select data, revision from public.moneytrail_ledgers where user_id=$1', [owner]);
  expect(result.rows[0]).toMatchObject({ data: { annualBudgets: [annualBudget] }, revision: 3 });
  expect(await rpc('save_moneytrail_ledger', [{ ...empty, annualBudgets: [] }, 3]))
    .toMatchObject({ data: { annualBudgets: [] }, revision: 4 });
});

it.each([
  [{ ...annualBudget, category: '待分类' }],
  [{ ...annualBudget, subcategory: '未细分' }],
  [{ ...annualBudget, subcategory: '   ' }],
  [{ ...annualBudget, year: 2025 }],
  [{ ...annualBudget, capChanges: [] }],
  [{ ...annualBudget, capChanges: [...annualBudget.capChanges].reverse() }],
  [{ ...annualBudget, capChanges: [{ month: '2026-01', amountCents: 0.5 }] }],
  [{ ...annualBudget, monthlyOverrides: [{ month: '2026-02', amountCents: null }] }],
  [annualBudget, annualBudget],
].map(value => [value]))('rejects malformed annual settings %#', async annualBudgets => {
  expect(await rpc('moneytrail_valid_payload', [{ ...empty, annualBudgets }])).toBe(false);
});
