import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';

const migrations = import.meta.glob('../../supabase/migrations/*.sql', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const A = '11111111-1111-4111-8111-111111111111';
// Public internet examples supplied for compatibility, not verified SMS samples.
const examples = [
  ['abc-account', '（中国农业银行）尊敬的客户：您的农行账户（尾号1234）于10月31日15:30完成消费交易，金额为500.00，余额为10230.50。'],
  ['abc-credit', '【中国农业银行】您尾号5678的信用卡于10月31日15:30消费人民币120.00元，剩余可用额度23500.00元。'],
  ['boc-account', '【中国银行】您的账户尾号1234于10月31日15:30发生消费支出，金额为人民币500.00元，实时活期余额10230.50元。'],
  ['boc-credit', '【中国银行】您尾号5678的信用卡于10月31日15:30成功消费人民币120.00元，当前可用额度23500.00元。'],
  ['ccb-account', '您尾号1234的储蓄卡10月31日15:30消费支出人民币500.00元，活期余额10230.50元。【建设银行】'],
  ['ccb-credit', '您尾号5678的龙卡信用卡10月31日15:30消费人民币120.00元，可用额度23500.00元。【建设银行】'],
] as const;
let db: PGlite;
let unchangedDefinitions: unknown[];

async function rpc(name: string, args: unknown[] = []): Promise<any> {
  return (await db.query<{ r: any }>(`select to_jsonb(public.${name}(${args.map((_, i) => `$${i + 1}`).join(',')})) r`, args)).rows[0].r;
}
async function rows(table: string) { return (await db.query(`select row_to_json(t)::text value from ${table} t order by row_to_json(t)::text`)).rows; }
async function receive(token: string, raw: string) { return rpc('moneytrail_receive_sms', [token, raw]); }
async function definitions() {
  return (await db.query(`select p.proname,pg_get_functiondef(p.oid) definition from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='moneytrail_private' and p.proname in ('sms_bank_code','sms_parse_bank','moneytrail_parse_icbc_sms','sms_parse_for_account') order by p.proname`)).rows;
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`create role anon nologin; create role authenticated nologin; create schema auth;
    create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz,deleted_at timestamptz);
    create function auth.uid() returns uuid language sql stable as $$select (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid$$;
    grant usage on schema public,auth to anon,authenticated;`);
  for (const file of Object.keys(migrations).sort()) {
    if (file.endsWith('_three_bank_review_intake.sql')) unchangedDefinitions = await definitions();
    await db.exec(migrations[file]);
  }
}, 30000);
afterAll(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec(`reset role; truncate auth.users cascade; insert into auth.users values('${A}','a@invalid',now(),null,null);`);
  await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ sub: A })]);
});

it.each(examples.flatMap(([name, raw]) => ['auto', 'review'].map(mode => [name, mode, raw])))('retains the unverified %s example for review in %s mode', async (_name, mode, raw) => {
  const { token } = await rpc('moneytrail_sms_rotate', [mode]);
  expect(await receive(token, raw)).toMatchObject({ accepted: true, status: 'pending' });
  expect((await rpc('moneytrail_sms_inbox')).items[0]).toMatchObject({
    raw_text: raw, status: 'pending', transaction_id: null, draft: null,
    reason: '该银行短信已接收，当前格式需手动核对金额、时间和商户。',
  });
  expect((await rpc('moneytrail_sms_preview_pending')).recordable_count).toBe(0);
  const parsed = (await db.query<{ r: any }>("select moneytrail_private.sms_parse_for_account($1,$2,now()) r", [A, raw])).rows[0].r;
  expect(parsed).toMatchObject({ draft: null, requires_review: true });
  expect(await rows('public.moneytrail_ledgers')).toEqual([]);
  await rpc('moneytrail_sms_rotate', ['auto']);
  expect(await rpc('moneytrail_sms_reprocess_pending')).toEqual({ recorded_count: 0, pending_count: 1 });
});

it.each([
  '您1234的信用卡10月31日12:00消费1000.00元，可用余额10000.00元。【农业银行】',
  '您尾号1234的储蓄卡活期账户10月31日12时00分，歌华批扣人民币18元，活期余额6900.12元。【建设银行】',
])('preserves the historical draft and every warning when a draft exists: %s', async raw => {
  const { token } = await rpc('moneytrail_sms_rotate', ['auto']);
  expect(await receive(token, raw)).toMatchObject({ accepted: true, status: 'pending' });
  const entry = (await db.query<{ draft: any; warnings: any; reason: string | null; received: string }>('select draft,warnings,reason,received_at::text received from moneytrail_private.sms_inbox where user_id=$1', [A])).rows[0];
  const parsed = (await db.query<{ r: any }>('select moneytrail_private.sms_parse_for_account($1,$2,$3::timestamptz) r', [A, raw, entry.received])).rows[0].r;
  expect(parsed.draft).not.toBeNull();
  expect(entry).toMatchObject({ draft: parsed.draft, warnings: parsed.warnings, reason: parsed.error });
});

it.each(['农业银行', '中国农业银行', '中国银行', '建设银行', '中国建设银行'])('accepts only explicit boundary markers for %s', async bank => {
  const { token } = await rpc('moneytrail_sms_rotate', ['auto']);
  for (const [open, close] of [['【', '】'], ['(', ')'], ['（', '）']]) {
    for (const suffix of [false, true]) {
      const body = `您尾号1234卡10月31日15:30消费人民币${suffix ? 121 : 120}元，余额23500元。`;
      const marker = `${open}${bank}${close}`;
      const raw = ` \t${suffix ? `${body}${marker}` : `${marker}${body}`}\r\n`;
      expect(await receive(token, raw)).toMatchObject({ accepted: true, status: 'pending' });
    }
  }
  expect(await rows('public.moneytrail_ledgers')).toEqual([]);
});

it.each([
  '【中国银行】您尾号1234卡发生消费支出，金额为CNY1,234.56，余额23500元。',
  '（农业银行）您尾号1234卡完成消费交易，金额为５００．００，余额10230.50。',
  '您尾号1234卡成功消费RMB120.00，当前可用额度23500元。(建设银行)',
  '【中国银行】您尾号1234卡消费金额：120.00元，余额23500元。',
])('admits an explicit transaction amount independently from its balance: %s', async raw => {
  const { token } = await rpc('moneytrail_sms_rotate', ['auto']);
  expect(await receive(token, raw)).toMatchObject({ accepted: true, status: 'pending' });
  expect((await rpc('moneytrail_sms_inbox')).items[0].draft).toBeNull();
  expect(await rows('public.moneytrail_ledgers')).toEqual([]);
});

it.each([
  '您尾号1234账户10月31日15:30完成一笔消费交易人民币-500.00，余额10230.50。',
  '中国银行您尾号1234卡消费人民币120元。',
  '商户中国银行大厦咖啡消费人民币120元。',
  '【招商银行】您尾号1234卡消费人民币120元。',
  '您尾号1234卡【中国银行】消费人民币120元。',
  '【中国银行】您尾号1234卡消费人民币120元。【中国银行】',
  '【中国银行】您尾号1234卡消费人民币120元。（建设银行）',
  '【未知银行】您尾号1234卡消费人民币120元。【中国银行】',
  '【农业银行】您尾号1234卡消费人民币120元。工商银行',
  '【中国银行】您尾号1234卡消费人民币120元。（中国银行信用卡中心）',
  '【中国银行】您尾号1234卡发生消费支出，当前余额人民币23500元。',
  '【中国银行】您尾号1234卡消费，金额待查询，余额23500元。',
  '【中国银行】您尾号1234卡消费120.00，余额23500元。',
  '【中国银行】您尾号1234卡消费交易，金额为12,34.00，余额23500元。',
  '【中国银行】您尾号1234卡消费交易，金额为120.001，余额23500元。',
  '【中国银行】您尾号1234卡消费USD120元，余额23500元。',
  '【中国银行】您尾号1234卡消费人民币120元，余额20美元。',
  '【农业银行】您尾号1234卡收到工资收入120元，已开通消费通知。',
  '【中国银行】信用卡消费满100元赠20元优惠券。',
  '【建设银行】每消费人民币100元可获1积分，敬请使用我行信用卡。',
  '【中国银行】本期账单消费人民币120元，应还金额120元，请按时还款。',
  '【中国银行】您的信用卡本期累计消费人民币120元，本期应还120元，请及时还款。',
  '【建设银行】您的信用卡消费金额为120元还款提醒，距到期还款日还有3天。',
  ...['验证码123456', '动态码123456', 'OTP123456', 'ｏｔｐ１２３', 'verification123456', 'one-time123456'].map(value => `【中国银行】您尾号1234卡消费人民币120元，${value}。`),
])('rejects unsafe, unsigned, conflicting or non-transaction input before retaining or counting it: %s', async raw => {
  const { token } = await rpc('moneytrail_sms_rotate', ['auto']);
  const settings = await rows('moneytrail_private.sms_settings');
  for (const text of new Set([raw, raw.replace(/^(【[^】]+】)(.*)$/s, '$2$1')])) {
    await expect(receive(token, text)).rejects.toMatchObject({ code: '22023' });
  }
  expect((await rpc('moneytrail_sms_inbox')).total).toBe(0);
  expect(await rows('moneytrail_private.sms_settings')).toEqual(settings);
  expect(await rows('public.moneytrail_ledgers')).toEqual([]);
});

it('preserves raw-message deduplication, daily and pending limits', async () => {
  const { token } = await rpc('moneytrail_sms_rotate', ['auto']);
  const raw = examples[0][1];
  const receipt = await receive(token, raw);
  expect(await receive(token, raw)).toEqual({ accepted: true, status: 'duplicate', id: receipt.id });
  expect((await rpc('moneytrail_sms_inbox')).total).toBe(1);
  await db.query("update moneytrail_private.sms_settings set receipt_count=100,receipt_day=(now() at time zone 'Asia/Shanghai')::date where user_id=$1", [A]);
  const atDailyLimit = await rows('moneytrail_private.sms_settings');
  await expect(receive(token, examples[1][1])).rejects.toMatchObject({ code: '54000' });
  expect(await rows('moneytrail_private.sms_settings')).toEqual(atDailyLimit);
  await db.query('update moneytrail_private.sms_settings set receipt_count=0 where user_id=$1', [A]);
  await db.query(`insert into moneytrail_private.sms_inbox(id,user_id,received_at,fingerprint,status,raw_text,warnings)
    select gen_random_uuid(),$1,now(),encode(sha256(convert_to('pending-fixture-'||n,'UTF8')),'hex'),'pending','fixture','[]'::jsonb from generate_series(1,199) n`, [A]);
  const atPendingLimit = await rows('moneytrail_private.sms_settings');
  await expect(receive(token, examples[1][1])).rejects.toMatchObject({ code: '54000' });
  expect(await rows('moneytrail_private.sms_settings')).toEqual(atPendingLimit);
  expect((await rpc('moneytrail_sms_inbox')).total).toBe(200);
});

it('keeps the review source helper private, immutable and search-path pinned', async () => {
  for (const role of ['anon', 'authenticated']) {
    expect((await db.query<{ allowed: boolean }>("select has_function_privilege($1,'moneytrail_private.sms_review_bank_source(text)','EXECUTE') allowed", [role])).rows[0].allowed).toBe(false);
  }
  expect((await db.query("select provolatile,prosecdef,proconfig from pg_proc where oid='moneytrail_private.sms_review_bank_source(text)'::regprocedure")).rows[0]).toMatchObject({
    provolatile: 'i', prosecdef: false, proconfig: ['search_path=""'],
  });
});

it('reapplying the migration preserves business data and every established bank/parser helper', async () => {
  await rpc('save_moneytrail_ledger', [{ version: 1, budgetCents: 123456, transactions: [], billCheckedMonths: ['2026-10'] }, 0]);
  await rpc('moneytrail_sms_set_merchant_rule', ['松林咖啡', '学习', '课程']);
  const { token } = await rpc('moneytrail_sms_rotate', ['auto']);
  await receive(token, examples[0][1]);
  const tables = ['public.moneytrail_ledgers', 'moneytrail_private.sms_inbox', 'moneytrail_private.sms_category_rules', 'moneytrail_private.sms_settings'];
  const before = await Promise.all(tables.map(rows));
  expect(await definitions()).toEqual(unchangedDefinitions);
  await db.exec(migrations[Object.keys(migrations).find(file => file.endsWith('_three_bank_review_intake.sql'))!]);
  expect(await Promise.all(tables.map(rows))).toEqual(before);
  expect(await definitions()).toEqual(unchangedDefinitions);
});
