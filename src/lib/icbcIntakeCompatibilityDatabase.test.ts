import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';

const migrations = import.meta.glob('../../supabase/migrations/*.sql', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const A = '11111111-1111-4111-8111-111111111111';
const body = '尾号1234卡10月31日12:00支出(消费财付通-松林咖啡)28元，余额12345.67元。';
const legacy = [
  `【工商银行】${body}`,
  `${body}（工商银行）`,
  `${body}(工商银行)`,
  `工商银行${body}`,
  `${body}工商银行`,
  `【工商银行】${body}【工商银行】`,
  `${body}【工商银行】\u200b`,
  `${body}【工商银行】短信通知`,
];
let db: PGlite;

async function rpc(name: string, args: unknown[] = []): Promise<any> {
  return (await db.query<{ r: any }>(`select to_jsonb(public.${name}(${args.map((_, i) => `$${i + 1}`).join(',')})) r`, args)).rows[0].r;
}
async function ledger() { return (await db.query('select data,revision,updated_at from public.moneytrail_ledgers where user_id=$1', [A])).rows; }
async function settings() { return (await db.query('select row_to_json(s) value from moneytrail_private.sms_settings s where user_id=$1', [A])).rows; }

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`create role anon nologin; create role authenticated nologin; create schema auth;
    create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz,deleted_at timestamptz);
    create function auth.uid() returns uuid language sql stable as $$select (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid$$;
    grant usage on schema public,auth to anon,authenticated;`);
  for (const file of Object.keys(migrations).sort()) await db.exec(migrations[file]);
}, 30000);
afterAll(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec(`reset role; truncate auth.users cascade; insert into auth.users values('${A}','a@invalid',now(),null,null);`);
  await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ sub: A })]);
});

it.each(legacy)('retains a legacy ICBC receipt for review without posting it: %s', async raw => {
  await rpc('save_moneytrail_ledger', [{ version: 1, budgetCents: 123456, transactions: [], billCheckedMonths: ['2026-10'] }, 0]);
  await rpc('moneytrail_sms_set_merchant_rule', ['松林咖啡', '学习', '课程']);
  const beforeLedger = await ledger();
  const beforeRules = await rpc('moneytrail_sms_category_rules');
  const { token } = await rpc('moneytrail_sms_rotate', ['auto']);
  expect((await db.query<{ code: string | null }>('select moneytrail_private.sms_bank_code($1) code', [raw])).rows[0].code).toBeNull();
  const receipt = await rpc('moneytrail_receive_sms', [token, raw]);
  expect(receipt).toMatchObject({ accepted: true, status: 'pending' });
  expect(await rpc('moneytrail_receive_sms', [token, raw])).toEqual({ accepted: true, status: 'duplicate', id: receipt.id });
  expect((await rpc('moneytrail_sms_inbox')).items[0]).toMatchObject({ id: receipt.id, raw_text: raw, draft: null, transaction_id: null, status: 'pending' });
  expect(await rpc('moneytrail_sms_reprocess_pending')).toEqual({ recorded_count: 0, pending_count: 1 });
  expect((await rpc('moneytrail_sms_preview_pending')).recordable_count).toBe(0);
  expect(await ledger()).toEqual(beforeLedger);
  expect(await rpc('moneytrail_sms_category_rules')).toEqual(beforeRules);
});

it.each([
  ...['验证码123456', '动态码123456', 'OTP123456', 'ｏｔｐ１２３', 'verification123456', 'one-time123456'].map(value => `【工商银行】${body}${value}`),
  `【农业银行】${body}工商银行`,
  `【招商银行】${body}【工商银行】`,
  `${body}（中国银行）（工商银行）`,
  `${body}【未知银行】【工商银行】`,
  '工商银行欢迎使用信用卡。',
  '您的账户支出20元。',
])('rejects unsafe or mixed-bank fallback text before retaining or counting it: %s', async raw => {
  const { token } = await rpc('moneytrail_sms_rotate', ['auto']);
  const before = await settings();
  await expect(rpc('moneytrail_receive_sms', [token, raw])).rejects.toMatchObject({ code: '22023' });
  expect((await rpc('moneytrail_sms_inbox')).total).toBe(0);
  expect(await settings()).toEqual(before);
  expect(await ledger()).toEqual([]);
});

it('keeps canonical ICBC auto-posting unchanged', async () => {
  const { token } = await rpc('moneytrail_sms_rotate', ['auto']);
  const stamp = (await db.query<{ stamp: string }>("select to_char(now() at time zone 'Asia/Shanghai','FMMM月FMDD日HH24:MI') stamp")).rows[0].stamp;
  const raw = `尾号1234卡${stamp}支出(消费财付通-松林咖啡)28元，余额12345.67元。【工商银行】`;
  expect(await rpc('moneytrail_receive_sms', [token, raw])).toMatchObject({ accepted: true, status: 'recorded' });
  expect((await rpc('moneytrail_sms_inbox')).items[0]).toMatchObject({ status: 'recorded', raw_text: null });
  expect((await ledger())[0]).toMatchObject({ revision: 1, data: { transactions: [{ amountCents: 2800, merchant: '消费财付通-松林咖啡' }] } });
});
