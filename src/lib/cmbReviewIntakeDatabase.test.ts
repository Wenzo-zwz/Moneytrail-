import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';

const migrations = import.meta.glob('../../supabase/migrations/*.sql', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
// Synthetic transaction fixtures, not a claim to support a verified CMB layout.
const body = '您尾号1234的一卡通于11月16日12:32消费人民币28.70元，余额1234.56元。';
const raw = '【招商银行】' + body;
let db: PGlite;
let definitionsBeforeMigration: unknown[];
let basicDefinitionsUnchanged: boolean;

async function rpc(name: string, args: unknown[] = []): Promise<any> {
  return (await db.query<{ r: any }>(`select to_jsonb(public.${name}(${args.map((_, i) => `$${i + 1}`).join(',')})) r`, args)).rows[0].r;
}
async function user(id = A) { await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ sub: id })]); }
async function receive(token: string, message = raw) { return rpc('moneytrail_receive_sms', [token, message]); }
async function source(message: string | null) { return (await db.query<{ r: string | null }>('select moneytrail_private.sms_review_bank_source($1) r', [message])).rows[0].r; }
async function rows(table: string) { return (await db.query(`select row_to_json(t)::text value from ${table} t order by row_to_json(t)::text`)).rows; }
async function definitions() {
  return (await db.query(`select p.proname,pg_get_functiondef(p.oid) definition from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where (n.nspname='public' and p.proname in ('moneytrail_receive_sms','moneytrail_sms_confirm','moneytrail_sms_reprocess_pending','moneytrail_sms_preview_pending'))
      or (n.nspname='moneytrail_private' and p.proname in ('sms_bank_code','sms_parse_bank','sms_parse_for_account','moneytrail_parse_icbc_sms')) order by n.nspname,p.proname`)).rows;
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`create role anon nologin; create role authenticated nologin; create schema auth;
    create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz,deleted_at timestamptz);
    create function auth.uid() returns uuid language sql stable as $$select (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid$$;
    grant usage on schema public,auth to anon,authenticated;`);
  for (const file of Object.keys(migrations).sort()) {
    if (file.endsWith('_cmb_review_intake.sql')) definitionsBeforeMigration = await definitions();
    await db.exec(migrations[file]);
    if (file.endsWith('_cmb_review_intake.sql')) basicDefinitionsUnchanged = JSON.stringify(await definitions()) === JSON.stringify(definitionsBeforeMigration);
  }
  definitionsBeforeMigration = await definitions();
}, 30000);
afterAll(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec(`reset role; truncate auth.users cascade; insert into auth.users values('${A}','a@invalid',now(),null,null),('${B}','b@invalid',now(),null,null);`);
  await user();
});

it.each(['auto', 'review'])('accepts CMB for review in %s mode without inventing a draft or writing the ledger', async mode => {
  const { token } = await rpc('moneytrail_sms_rotate', [mode]);
  expect(await receive(token)).toMatchObject({ accepted: true, status: 'pending' });
  expect((await rpc('moneytrail_sms_inbox')).items[0]).toMatchObject({ raw_text: raw, status: 'pending', draft: null, transaction_id: null,
    reason: '该银行短信已接收，当前格式需手动核对金额、时间和商户。' });
  expect((await rpc('moneytrail_sms_preview_pending')).recordable_count).toBe(0);
  if (mode === 'auto') expect(await rpc('moneytrail_sms_reprocess_pending')).toEqual({ recorded_count: 0, pending_count: 1 });
  else await expect(rpc('moneytrail_sms_reprocess_pending')).rejects.toMatchObject({ code: '22023' });
  expect(await rows('public.moneytrail_ledgers')).toEqual([]);
});

it.each([['【', '】'], ['(', ')'], ['（', '）']])('recognizes only one explicit boundary CMB marker with %s%s', async (open, close) => {
  const { token } = await rpc('moneytrail_sms_rotate', ['auto']);
  for (const message of [` \t${open}招商银行${close}${body}\r\n`, `${body}${open}招商银行${close}。`]) {
    expect(await source(message)).toBe('cmb');
    expect(await receive(token, message)).toMatchObject({ status: 'pending' });
  }
});

it.each([
  null, '', '招商银行' + body, '您尾号1234卡【招商银行】消费人民币28.70元。',
  '【招商银行信用卡】' + body, '【招商银行】' + body + '【中国银行】',
  '【未知银行】' + body + '（招商银行）', '【招商银行】' + body + '（招商银行）',
  '【招商银行】' + body + '工商银行', '【招商银行】' + 'x'.repeat(2000),
])('does not guess CMB from unsigned, ambiguous or out-of-scope markers %#', async message => {
  expect(await source(message)).toBeNull();
});

it.each([
  '【招商银行】您尾号1234卡消费，余额人民币1234.56元。',
  '【招商银行】您尾号1234卡消费交易，金额为12,34.00，余额100元。',
  '【招商银行】您尾号1234卡消费人民币28.701元。',
  '【招商银行】您尾号1234卡消费USD28.70元。',
  '【招商银行】您尾号1234卡收到余额通知，余额28.70元，已开通消费提醒。',
  '【招商银行】本期账单消费人民币28.70元，应还28.70元。',
  '【招商银行】每消费人民币100元可获1积分。',
  '【招商银行】消费满100元赠优惠券。',
  '【招商银行】您尾号1234卡退回人民币28.70元。',
  ...['验证码123456', '动态码123456', 'OTP123456', 'ｏｔｐ１２３', 'verification123456', 'one-time123456'].map(value => raw + value),
])('rejects non-transaction or sensitive messages before retaining or counting them %#', async message => {
  const { token } = await rpc('moneytrail_sms_rotate', ['auto']);
  const before = await rows('moneytrail_private.sms_settings');
  await expect(receive(token, message)).rejects.toMatchObject({ code: '22023' });
  expect(await rows('moneytrail_private.sms_settings')).toEqual(before);
  expect((await rpc('moneytrail_sms_inbox')).total).toBe(0);
  expect(await rows('public.moneytrail_ledgers')).toEqual([]);
});

it('preserves per-account deduplication and prevents another user confirming a CMB receipt', async () => {
  const a = await rpc('moneytrail_sms_rotate', ['auto']);
  const receipt = await receive(a.token);
  expect(await receive(a.token)).toEqual({ accepted: true, status: 'duplicate', id: receipt.id });
  await user(B);
  const b = await rpc('moneytrail_sms_rotate', ['auto']);
  const other = await receive(b.token);
  expect(other.status).toBe('pending'); expect(other.id).not.toBe(receipt.id);
  expect((await rpc('moneytrail_sms_inbox')).items.map((entry: any) => entry.id)).toEqual([other.id]);
  const draft = { kind: 'expense', source: 'sms', merchant: '示例商户', amountCents: 2870, date: '2026-11-16T12:32', category: '本地生活', subcategory: '餐饮', note: '' };
  await expect(rpc('moneytrail_sms_confirm', [receipt.id, draft])).rejects.toMatchObject({ code: '42501' });
  await user();
  expect((await rpc('moneytrail_sms_inbox')).total).toBe(1);
  expect(await rpc('moneytrail_sms_confirm', [receipt.id, { ...draft, smsEvidence: { text: 'client-supplied evidence' } }])).toMatchObject({ status: 'recorded' });
  const ledger = (await db.query<{ data: any }>('select data from public.moneytrail_ledgers where user_id=$1', [A])).rows[0].data;
  expect(ledger.transactions[0]).toMatchObject({ amountCents: 2870, merchant: '示例商户', source: 'sms' });
  expect(ledger.transactions[0].smsEvidence.text).toContain('招商银行');
  expect(ledger.transactions[0].smsEvidence.text).not.toMatch(/1234|1234\.56|client-supplied/);
  expect((await db.query('select * from public.moneytrail_ledgers where user_id=$1', [B])).rows).toEqual([]);
});

it('preserves token validity and the existing daily and pending limits', async () => {
  const { token } = await rpc('moneytrail_sms_rotate', ['auto']);
  await expect(receive('mt_sms_' + '0'.repeat(64))).rejects.toMatchObject({ code: '42501' });
  await db.query("update moneytrail_private.sms_settings set receipt_count=100,receipt_day=(now() at time zone 'Asia/Shanghai')::date where user_id=$1", [A]);
  await expect(receive(token)).rejects.toMatchObject({ code: '54000' });
  await db.query('update moneytrail_private.sms_settings set receipt_count=0 where user_id=$1', [A]);
  await db.query(`insert into moneytrail_private.sms_inbox(id,user_id,received_at,fingerprint,status,raw_text,warnings)
    select gen_random_uuid(),$1,now(),encode(sha256(convert_to('cmb-pending-'||n,'UTF8')),'hex'),'pending','fixture','[]'::jsonb from generate_series(1,200) n`, [A]);
  await expect(receive(token)).rejects.toMatchObject({ code: '54000' });
  expect((await rpc('moneytrail_sms_inbox')).total).toBe(200);
});

it('keeps the new helper private and preserves all parser, receiver and business state', async () => {
  expect(basicDefinitionsUnchanged).toBe(true);
  for (const role of ['anon', 'authenticated']) expect((await db.query<{ allowed: boolean }>("select has_function_privilege($1,'moneytrail_private.sms_review_bank_source(text)','EXECUTE') allowed", [role])).rows[0].allowed).toBe(false);
  expect((await db.query("select provolatile,prosecdef,proconfig from pg_proc where oid='moneytrail_private.sms_review_bank_source(text)'::regprocedure")).rows[0]).toMatchObject({ provolatile: 'i', prosecdef: false, proconfig: ['search_path=""'] });
  await rpc('save_moneytrail_ledger', [{ version: 1, budgetCents: 50000, transactions: [], billCheckedMonths: [] }, 0]);
  const { token } = await rpc('moneytrail_sms_rotate', ['review']); await receive(token);
  const tables = ['public.moneytrail_ledgers', 'moneytrail_private.sms_inbox', 'moneytrail_private.sms_settings', 'moneytrail_private.sms_category_rules'];
  const before = await Promise.all(tables.map(rows));
  expect(await definitions()).toEqual(definitionsBeforeMigration);
  await db.exec(migrations[Object.keys(migrations).find(file => file.endsWith('_cmb_review_intake.sql'))!]);
  expect(await Promise.all(tables.map(rows))).toEqual(before);
  expect(await definitions()).toEqual(definitionsBeforeMigration);
  expect((await db.query<{ r: string | null }>('select moneytrail_private.sms_bank_code($1) r', [raw])).rows[0].r).toBeNull();
});
