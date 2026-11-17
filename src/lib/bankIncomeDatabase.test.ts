import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';

const migrations = import.meta.glob('../../supabase/migrations/*.sql', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const income = '尾号0000卡11月10日14:50工商银行收入(2026年10月工资)18,123.45元，余额1xxx元。【工商银行】';
const otherBanks = ['农业银行', '中国银行', '建设银行', '招商银行'];
let db: PGlite;
let existingDefinitions: unknown[];

async function rpc(name: string, args: unknown[] = []): Promise<any> {
  return (await db.query<{ r: any }>(`select to_jsonb(public.${name}(${args.map((_, i) => `$${i + 1}`).join(',')})) r`, args)).rows[0].r;
}
async function user(id = A) { await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ sub: id })]); }
async function parse(message: string | null, received: string | null = '2026-11-10T07:00:00Z') {
  return (await db.query<{ r: any }>('select moneytrail_private.sms_parse_bank($1,$2::timestamptz) r', [message, received])).rows[0].r;
}
async function candidate(message: string | null) {
  return (await db.query<{ r: boolean }>('select moneytrail_private.sms_income_candidate($1) r', [message])).rows[0].r;
}
async function receive(token: string, message: string) { return rpc('moneytrail_receive_sms', [token, message]); }
async function rows(table: string) { return (await db.query(`select row_to_json(t)::text value from ${table} t order by row_to_json(t)::text`)).rows; }
async function definitions() {
  return (await db.query(`select n.nspname,p.proname,pg_get_functiondef(p.oid) definition from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('public','moneytrail_private') and p.proname not in ('sms_parse_bank','moneytrail_receive_sms','sms_income_bank','sms_income_candidate','sms_parse_income') order by n.nspname,p.proname,p.oid`)).rows;
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`create role anon nologin; create role authenticated nologin; create schema auth;
    create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz,deleted_at timestamptz);
    create function auth.uid() returns uuid language sql stable as $$select (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid$$;
    grant usage on schema public,auth to anon,authenticated;`);
  for (const file of Object.keys(migrations).sort()) {
    if (file.endsWith('_bank_income_review_intake.sql')) existingDefinitions = await definitions();
    await db.exec(migrations[file]);
  }
}, 30000);
afterAll(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec(`reset role; truncate auth.users cascade; insert into auth.users values('${A}','a@invalid',now(),null,null),('${B}','b@invalid',now(),null,null);`);
  await user();
});

it('extracts the independent salary amount and transaction date, preserving the purpose and masked evidence', async () => {
  const result = await parse(income);
  expect(result).toMatchObject({ requires_review: true, error: null, draft: {
    kind: 'income', amountCents: 1812345, date: '2026-11-10T14:50', merchant: '2026年10月工资', category: '其他', subcategory: '工资', source: 'sms', note: '',
  } });
  expect(result.warnings.join('')).toContain('本人确认');
  expect(result.draft.smsEvidence.text).toContain('2026年10月工资');
  expect(result.draft.smsEvidence.text).not.toMatch(/0000|1xxx/);
  expect(result.draft.smsEvidence.receivedAt).toBe('2026-11-10T07:00:00.000000Z');
});

it.each(['18123.45', '18,123.45', '１８，１２３．４５', '18123.4', '18123'])('parses real numeric income without using the balance: %s', async amount => {
  const result = await parse(income.replace('18,123.45', amount));
  expect(result.draft.amountCents).toBe(amount.endsWith('.4') ? 1812340 : amount === '18123' ? 1812300 : 1812345);
  expect(result.requires_review).toBe(true);
});

it.each(['18，xxx', '18,xxx', '18xxx', '****', '××××', '18.**', '18,123.xx'])('keeps masked transaction money unresolved, never substituting its prefix or balance: %s', async amount => {
  const raw = income.replace('18,123.45', amount).replace('1xxx', '99999.99');
  expect(await candidate(raw)).toBe(true);
  const result = await parse(raw);
  expect(result).toMatchObject({ requires_review: true, draft: null });
  expect(result.error).toContain('金额已打码');
  const { token } = await rpc('moneytrail_sms_rotate', ['auto']);
  const receipt = await receive(token, raw);
  expect(receipt.status).toBe('pending');
  expect((await rpc('moneytrail_sms_inbox')).items[0]).toMatchObject({ raw_text: raw, draft: null, reason: result.error });
  expect(await rows('public.moneytrail_ledgers')).toEqual([]);
});

it.each(['0', '-18123.45', '18123.456', '18,12.45', '1,81,234.50', '1000000000000', '18e3', '+18123.45'])('does not guess invalid, signed or out-of-range amounts: %s', async amount => {
  expect((await parse(income.replace('18,123.45', amount))).draft).toBeNull();
});

it.each([
  ['工资退款', 'refund'], ['工资冲正', 'refund'], ['工资退回', 'refund'],
  ['本人账户互转', 'transfer'], ['本人账户转入', 'transfer'], ['同名账户转账', 'transfer'],
  ['理财赎回', 'transfer'], ['贷款到账', 'transfer'], ['借款', 'transfer'],
])('keeps %s distinct from earned income', async (purpose, kind) => {
  const result = await parse(income.replace('2026年10月工资', purpose));
  expect(result).toMatchObject({ requires_review: true, error: null, draft: { kind, amountCents: 1812345, merchant: purpose, category: '待分类' } });
  expect(result.draft).not.toHaveProperty('subcategory');
  expect(result.warnings.join('')).toMatch(/退款|资金周转/);
});

it.each(['转账', '汇款', '工资转账', '不明转入工资', '工资存入', '工资汇入', '资金往来', '未知用途'])('requires manual type selection for ambiguous inflows: %s', async purpose => {
  expect(await parse(income.replace('2026年10月工资', purpose))).toMatchObject({ draft: null, requires_review: true, error: expect.stringMatching(/用途|周转/) });
});

it.each([['年终奖金', '奖金'], ['交通补贴', '补贴'], ['劳务报酬', '劳务报酬']])('recognizes explicit earned-income purpose %s', async (purpose, subcategory) => {
  expect(await parse(income.replace('2026年10月工资', purpose))).toMatchObject({ requires_review: true, draft: { kind: 'income', category: '其他', subcategory } });
});

it.each([
  income.replace('11月10日', '02月30日'), income.replace('11月10日', '13月10日'), income.replace('14:50', '24:00'), income.replace('14:50', '14:60'),
  income.replace('2026年10月工资', '工资100元'), income.replace('2026年10月工资', '中国银行工资'), income.replace('2026年10月工资', '工资)18123.45元收入(工资'),
  income + '另收入20元', income.replace('工商银行收入', '工商银行到账'), income.replace('工商银行收入', '收入'),
])('retains strict layout, event and date boundaries %#', async raw => {
  expect((await parse(raw)).draft).toBeNull();
});

it('uses receipt-local year and strict rollover, keeping the payroll month out of the transaction date', async () => {
  expect((await parse(income, '2026-11-10T07:00:00Z')).draft.date).toBe('2026-11-10T14:50');
  expect((await parse(income.replace('11月10日14:50', '12月31日23:59'), '2027-01-01T00:00:00Z')).draft.date).toBe('2026-12-31T23:59');
  expect((await parse(income.replace('卡11月', '卡2025年11月'))).draft.date).toBe('2025-11-10T14:50');
  expect((await parse(income.replace('14:50', '16:00'))).warnings.join('')).toContain('晚于');
  expect((await parse(income, '2026-11-17T07:00:00Z')).warnings.join('')).toContain('超过7天');
  expect((await parse(income, 'infinity')).draft).toBeNull();
  expect((await parse(income, null)).draft).toBeNull();
});

it.each(otherBanks.flatMap(bank => ['收入', '入账', '到账', '转入', '存入'].map(action => [`【${bank}】您的账户${action}人民币1000元。`, bank, action])))('retains other-bank income as unverified draftless pending: %s', async raw => {
  const { token } = await rpc('moneytrail_sms_rotate', ['auto']);
  expect(await candidate(raw)).toBe(true);
  expect(await parse(raw)).toMatchObject({ draft: null, requires_review: true, error: expect.stringContaining('尚未完成验证') });
  expect(await receive(token, raw)).toMatchObject({ accepted: true, status: 'pending' });
  expect((await rpc('moneytrail_sms_inbox')).items[0]).toMatchObject({ raw_text: raw, draft: null, reason: expect.stringContaining('尚未完成验证') });
  expect((await rpc('moneytrail_sms_preview_pending')).recordable_count).toBe(0);
  expect(await rpc('moneytrail_sms_reprocess_pending')).toEqual({ recorded_count: 0, pending_count: 1 });
  expect(await rows('public.moneytrail_ledgers')).toEqual([]);
});

it.each([
  '【农业银行】账户收入(工资)18,xxx元，余额99999元。', '〖招商银行〗账户到账18,xxx元，余额99999元。',
])('preserves an explicit masked-money reason for review banks: %s', async raw => {
  const { token } = await rpc('moneytrail_sms_rotate', ['auto']);
  expect(await receive(token, raw)).toMatchObject({ status: 'pending' });
  expect((await rpc('moneytrail_sms_inbox')).items[0]).toMatchObject({ draft: null, reason: expect.stringContaining('金额已打码') });
});

it.each([
  ...['验证码123456', '驗證碼123456', '校驗碼123456', '動態碼123456', '密碼123456', 'OTP123456', 'verification123456', '优惠券', '抽奖', '最低还款', '预计', '未到账', '待入账', '处理中'].map(value => income.replace('2026年10月工资', value)),
  income.replace('18,123.45元', '18,123.45美元'), income.replace('18,123.45元', 'USD18123.45元'),
  income.replace('【工商银行】', ''), income.replace('【工商银行】', '【未知银行】'), income + '【中国银行】', income + '（招商银行）',
  income.replace('工商银行收入', '工商银行收\u200b入'), income.replace('收入(', '收入(验\u200c证码'), income.replace('收入(', '收入(工\u2060资'),
  '【中国银行】余额1000元，收入已到账。', '【招商银行】可用余额1000元。', '您尾号1234的招行信用卡于12月24日18时4分收入人民币256.05元',
])('rejects insecure, prospective, marketing or unsigned income before counting or retaining it %#', async raw => {
  const { token } = await rpc('moneytrail_sms_rotate', ['auto']);
  const before = await rows('moneytrail_private.sms_settings');
  expect(await candidate(raw)).toBe(false);
  await expect(receive(token, raw)).rejects.toMatchObject({ code: '22023' });
  expect((await rpc('moneytrail_sms_inbox')).total).toBe(0);
  expect(await rows('moneytrail_private.sms_settings')).toEqual(before);
  expect(await rows('public.moneytrail_ledgers')).toEqual([]);
});

it.each(['auto', 'review'])('keeps salary pending through receive, preview, apply and reprocess in %s mode', async mode => {
  const { token } = await rpc('moneytrail_sms_rotate', [mode]);
  const receipt = await receive(token, income);
  expect(receipt.status).toBe('pending');
  expect(await receive(token, income)).toEqual({ accepted: true, status: 'duplicate', id: receipt.id });
  const preview = await rpc('moneytrail_sms_preview_pending');
  expect(preview).toMatchObject({ pending_count: 1, recordable_count: 0, items: [{ id: receipt.id, eligible: false, draft: { kind: 'income' } }] });
  await expect(rpc('moneytrail_sms_apply_pending', [[{ id: receipt.id, draft: preview.items[0].draft }]])).rejects.toMatchObject({ code: 'PT409' });
  if (mode === 'auto') expect(await rpc('moneytrail_sms_reprocess_pending')).toEqual({ recorded_count: 0, pending_count: 1 });
  expect((await rpc('moneytrail_sms_inbox')).items[0]).toMatchObject({ raw_text: income, status: 'pending', transaction_id: null });
  expect(await rows('public.moneytrail_ledgers')).toEqual([]);
});

it('requires the owner to confirm income, never learns an expense rule, and preserves locked raw evidence', async () => {
  const { token } = await rpc('moneytrail_sms_rotate', ['auto']);
  const receipt = await receive(token, income);
  const draft = (await rpc('moneytrail_sms_inbox')).items[0].draft;
  await user(B);
  expect((await rpc('moneytrail_sms_inbox')).total).toBe(0);
  await expect(rpc('moneytrail_sms_confirm', [receipt.id, draft])).rejects.toMatchObject({ code: '42501' });
  await user();
  await expect(rpc('moneytrail_sms_confirm_with_rule', [receipt.id, draft, true])).rejects.toMatchObject({ code: '22023' });
  expect(await rpc('moneytrail_sms_category_rules')).toEqual({ rules: [] });
  const tampered = { ...draft, smsEvidence: { ...draft.smsEvidence, text: 'changed evidence' } };
  await rpc('moneytrail_sms_confirm', [receipt.id, tampered]);
  const saved = (await db.query<{ data: any }>('select data from public.moneytrail_ledgers where user_id=$1', [A])).rows[0].data;
  expect(saved.transactions).toHaveLength(1);
  expect(saved.transactions[0]).toMatchObject({ kind: 'income', amountCents: 1812345, category: '其他', subcategory: '工资', merchant: '2026年10月工资' });
  expect(saved.transactions[0].smsEvidence.text).not.toBe('changed evidence');
  expect((await rpc('moneytrail_sms_inbox')).items[0]).toMatchObject({ status: 'recorded', raw_text: null });
  expect(await rpc('moneytrail_sms_category_rules')).toEqual({ rules: [] });
});

it('lets the owner complete a masked amount manually without deriving it from the balance', async () => {
  const raw = income.replace('18,123.45', '18，xxx').replace('1xxx', '99999.99');
  const { token } = await rpc('moneytrail_sms_rotate', ['auto']);
  const receipt = await receive(token, raw);
  expect((await rpc('moneytrail_sms_inbox')).items[0].draft).toBeNull();
  const fingerprint = (await db.query<{ valid: boolean }>("select fingerprint=encode(sha256(convert_to($1,'UTF8')),'hex') valid from moneytrail_private.sms_inbox where id=$2", [raw, receipt.id])).rows[0].valid;
  expect(fingerprint).toBe(true);
  await rpc('moneytrail_sms_confirm', [receipt.id, { kind: 'income', amountCents: 1812345, date: '2026-11-10T14:50', merchant: '2026年10月工资', category: '其他', subcategory: '工资', source: 'sms', note: '已核对真实金额' }]);
  const saved = (await db.query<{ data: any }>('select data from public.moneytrail_ledgers where user_id=$1', [A])).rows[0].data;
  expect(saved.transactions[0]).toMatchObject({ kind: 'income', amountCents: 1812345, note: '已核对真实金额' });
  expect((await rpc('moneytrail_sms_inbox')).items[0]).toMatchObject({ raw_text: null, status: 'recorded' });
});

it.each(['工资退款', '本人账户互转'])('also holds reclassified %s for manual confirmation in automatic mode', async purpose => {
  const { token } = await rpc('moneytrail_sms_rotate', ['auto']);
  expect(await receive(token, income.replace('2026年10月工资', purpose))).toMatchObject({ status: 'pending' });
  expect((await rpc('moneytrail_sms_preview_pending')).recordable_count).toBe(0);
  expect(await rpc('moneytrail_sms_reprocess_pending')).toEqual({ recorded_count: 0, pending_count: 1 });
  expect(await rows('public.moneytrail_ledgers')).toEqual([]);
});

it('keeps token, account, daily and pending limits on the income route', async () => {
  const { token } = await rpc('moneytrail_sms_rotate', ['auto']);
  await expect(receive('mt_sms_' + '0'.repeat(64), income)).rejects.toMatchObject({ code: '42501' });
  await db.query('update auth.users set email_confirmed_at=null where id=$1', [A]);
  await expect(receive(token, income)).rejects.toMatchObject({ code: '42501' });
  await db.query('update auth.users set email_confirmed_at=now() where id=$1', [A]);
  await db.query("update moneytrail_private.sms_settings set receipt_day=(clock_timestamp() at time zone 'Asia/Shanghai')::date,receipt_count=100 where user_id=$1", [A]);
  await expect(receive(token, income)).rejects.toMatchObject({ code: '54000' });
  await db.query('update moneytrail_private.sms_settings set receipt_count=0 where user_id=$1', [A]);
  await db.query("insert into moneytrail_private.sms_inbox(user_id,fingerprint,status,raw_text) select $1,encode(sha256(convert_to('fixture-'||i,'UTF8')),'hex'),'pending','fixture' from generate_series(1,200) i", [A]);
  await expect(receive(token, income)).rejects.toMatchObject({ code: '54000' });
  expect(await rows('public.moneytrail_ledgers')).toEqual([]);
});

it('preserves debit auto-posting and the CMB review formats', async () => {
  const { token } = await rpc('moneytrail_sms_rotate', ['auto']);
  const stamp = (await db.query<{ stamp: string }>("select to_char(now() at time zone 'Asia/Shanghai','FMMM月FMDD日HH24:MI') stamp")).rows[0].stamp;
  expect(await receive(token, `尾号1234卡${stamp}支出(消费财付通-松林咖啡)28元，余额12345.67元。【工商银行】`)).toMatchObject({ status: 'recorded' });
  expect(await receive(token, '〖招商银行〗您账户0000于04月09日06:43在〖支付宝-示例商户〗快捷支付114.15元，余额9999.99元')).toMatchObject({ status: 'pending' });
  expect(await receive(token, '您尾号1234的招行信用卡于12月24日18时4分消费人民币256.05元')).toMatchObject({ status: 'pending' });
  expect((await rpc('moneytrail_sms_inbox')).items.map((entry: any) => entry.draft.kind)).toEqual(['expense', 'expense', 'expense']);
});

it.each([
  '尾号1234卡11月10日14:50支出(消费入账xxx元咖啡)28元，余额12345.67元。【工商银行】',
  '〖招商银行〗您账户0000于11月10日14:50在〖支付宝-入账xxx元咖啡〗快捷支付114.15元，余额9999.99元',
])('does not divert established debit heads because a merchant happens to mention an inflow: %s', async raw => {
  expect(await candidate(raw)).toBe(false);
  const bank = raw.startsWith('〖') ? 'cmb' : 'icbc';
  const direct = (await db.query<{ r: any }>(bank === 'icbc'
    ? "select moneytrail_private.moneytrail_parse_icbc_sms($1,$2::timestamptz,'review') r"
    : 'select moneytrail_private.sms_parse_cmb($1,$2::timestamptz) r', [raw, '2026-11-10T07:00:00Z'])).rows[0].r;
  expect(direct.draft).toMatchObject({ kind: 'expense' });
  if (bank === 'icbc') expect(await parse(raw)).toEqual(direct);
  const { token } = await rpc('moneytrail_sms_rotate', ['review']);
  expect(await receive(token, raw)).toMatchObject({ status: 'pending' });
  const entry = (await rpc('moneytrail_sms_inbox')).items[0];
  const expected = (await db.query<{ r: any }>(bank === 'icbc'
    ? "select moneytrail_private.moneytrail_parse_icbc_sms($1,$2::timestamptz,'review') r"
    : 'select moneytrail_private.sms_parse_cmb($1,$2::timestamptz) r', [raw, entry.received_at])).rows[0].r;
  expect(entry.draft).toEqual(expected.draft);
  expect(entry.warnings).toEqual(expected.warnings);
});

it('adds only private immutable helpers and preserves all other established function definitions', async () => {
  expect(await definitions()).toEqual(existingDefinitions);
  const helpers = (await db.query<{ proname: string; provolatile: string; proconfig: string[]; exposed: boolean }>(`select p.proname,p.provolatile,p.proconfig,
    has_function_privilege('anon',p.oid,'EXECUTE') or has_function_privilege('authenticated',p.oid,'EXECUTE') exposed
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='moneytrail_private' and p.proname in ('sms_income_bank','sms_income_candidate','sms_parse_income') order by p.proname`)).rows;
  expect(helpers).toHaveLength(3);
  for (const helper of helpers) expect(helper).toMatchObject({ provolatile: 'i', proconfig: ['search_path=""'], exposed: false });
});

it('can be reapplied without rewriting existing ledgers, receipts, settings or merchant rules', async () => {
  await rpc('save_moneytrail_ledger', [{ version: 1, budgetCents: 123456, transactions: [], billCheckedMonths: ['2026-11'] }, 0]);
  await rpc('moneytrail_sms_set_merchant_rule', ['松林咖啡', '学习', '课程']);
  const { token } = await rpc('moneytrail_sms_rotate', ['auto']);
  await receive(token, income);
  const tables = ['public.moneytrail_ledgers', 'moneytrail_private.sms_inbox', 'moneytrail_private.sms_settings', 'moneytrail_private.sms_category_rules'];
  const before = await Promise.all(tables.map(rows));
  const functions = await definitions();
  await db.exec(migrations[Object.keys(migrations).find(file => file.endsWith('_bank_income_review_intake.sql'))!]);
  expect(await Promise.all(tables.map(rows))).toEqual(before);
  expect(await definitions()).toEqual(functions);
});
