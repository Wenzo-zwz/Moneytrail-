import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';

const migrations = import.meta.glob('../../supabase/migrations/*.sql', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const RECEIVED = '2026-10-31T04:01:00Z';
let db: PGlite;
const abc = (amount = '1000.00', stamp = '10月31日12:00') => `您1234的信用卡${stamp}消费${amount}元，可用余额10000.00元。【农业银行】`;
const ccb = (amount = '18', stamp = '10月31日12时00分') => `您尾号1234的储蓄卡活期账户${stamp}，歌华批扣人民币${amount}元，活期余额6900.12元。【建设银行】`;
const icbc = (stamp = '10月31日12:00', merchant = '消费财付通-松林咖啡') => `尾号1234卡${stamp}支出(${merchant})28元，余额12345.67元。【工商银行】`;
const boc = '您的借记卡1234于10月31日12:00消费人民币20.00元，余额10000.00元。【中国银行】';

async function rpc(name: string, args: unknown[] = []): Promise<any> {
  return (await db.query<{ r: any }>(`select to_jsonb(public.${name}(${args.map((_, i) => `$${i + 1}`).join(',')})) r`, args)).rows[0].r;
}
async function user(id = A) { await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ sub: id })]); }
async function code(text: string | null) { return (await db.query<{ r: string | null }>('select moneytrail_private.sms_bank_code($1) r', [text])).rows[0].r; }
async function parse(text: string | null, received = RECEIVED) { return (await db.query<{ r: any }>('select moneytrail_private.sms_parse_bank($1,$2::timestamptz) r', [text, received])).rows[0].r; }
async function receive(token: string, text: string) { return rpc('moneytrail_receive_sms', [token, text]); }
async function ledger(id = A) { return (await db.query<{ data: any; revision: number }>('select data,revision from public.moneytrail_ledgers where user_id=$1', [id])).rows[0]; }

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
  await db.exec(`reset role; truncate auth.users cascade; insert into auth.users values('${A}','a@invalid',now(),null,null),('${B}','b@invalid',now(),null,null);`);
  await user();
});

it.each([
  ['工商银行', 'icbc'], ['中国工商银行', 'icbc'], ['农业银行', 'abc'], ['中国农业银行', 'abc'],
  ['中国银行', 'boc'], ['建设银行', 'ccb'], ['中国建设银行', 'ccb'],
])('selects only a supported terminal bank signature: %s', async (bank, expected) => {
  expect(await code(`消费20元。【${bank}】`)).toBe(expected);
});

it.each([
  null, '', '消费20元【招商银行】', '工商银行消费20元', '消费20元【工商银行】后续说明',
  '【农业银行】消费20元【建设银行】', '【招商银行】消费20元【工商银行】',
  '【工商银行】消费20元【工商银行】',
])('does not guess a bank from missing, unsupported or multiple claims: %s', async text => {
  expect(await code(text)).toBeNull();
});

it('delegates ICBC to the unchanged parser including original evidence and every warning', async () => {
  for (const merchant of ['消费财付通-松林咖啡', '转账财付通-群收款', '转账张三', '消费财付通-新商店', '消费失败']) {
    const raw = icbc(undefined, merchant);
    const previous = (await db.query<{ r: any }>("select moneytrail_private.moneytrail_parse_icbc_sms($1,$2::timestamptz,'review') r", [raw, RECEIVED])).rows[0].r;
    expect(await parse(raw)).toEqual(previous);
  }
  const spaced = ` \t${icbc()}\r\n`;
  const previous = (await db.query<{ r: any }>("select moneytrail_private.moneytrail_parse_icbc_sms($1,$2::timestamptz,'review') r", [spaced, RECEIVED])).rows[0].r;
  expect(await parse(spaced)).toEqual(previous);
});

it('extracts only the bounded historical ABC layout and never substitutes the available balance', async () => {
  const parsed = await parse(abc());
  expect(parsed).toMatchObject({ requires_review: true, error: null, draft: { kind: 'expense', amountCents: 100000, date: '2026-10-31T12:00', merchant: '待补充商户', category: '待分类', source: 'sms' } });
  expect(parsed.warnings.length).toBeGreaterThan(0);
  expect(parsed.draft.smsEvidence.text).toContain('【农业银行】');
  expect(parsed.draft.smsEvidence.text).toContain('消费1000.00元');
  expect(parsed.draft.smsEvidence.text).not.toMatch(/1234|10000\.00/);
  expect((await parse(abc('1,234.56'))).draft.amountCents).toBe(123456);
  const masked = await parse(abc().replace('1234', '××××').replace('10000.00', '××××.××'));
  expect(masked.draft.amountCents).toBe(100000);
  expect(masked.draft.smsEvidence.text).not.toContain('×');
});

it('extracts only the bounded historical CCB layout and retains its business description', async () => {
  const parsed = await parse(ccb());
  expect(parsed).toMatchObject({ requires_review: true, error: null, draft: { kind: 'expense', amountCents: 1800, date: '2026-10-31T12:00', merchant: '歌华批扣', source: 'sms' } });
  expect(parsed.draft.smsEvidence.text).toContain('【建设银行】');
  expect(parsed.draft.smsEvidence.text).not.toMatch(/1234|6900\.12/);
  const folded = ccb('１８．５０').replace('尾号1234', '尾号１２３４').replace('建设银行', '中国建设银行');
  expect((await parse(folded)).draft.amountCents).toBe(1850);
});

it.each([
  boc,
  '您尾号1234的账户10月31日支出20元。【中国农业银行】',
  '您尾号1234的储蓄卡消费20元，余额100元。【中国建设银行】',
])('keeps unknown layouts without inventing a date, amount or merchant: %s', async raw => {
  const parsed = await parse(raw);
  expect(parsed).toMatchObject({ draft: null, requires_review: true });
  expect(parsed.error).toBeTruthy();
});

it.each([
  abc('0'), abc('-1.00'), abc('1.001'), abc('12,34.00'), abc('1000000000000'),
  abc('20', '2月30日12:00'), abc('20', '13月1日12:00'), abc('20', '10月31日24:00'),
  abc('20', '10月31日12:60'), ccb('0'), ccb('18.001'), ccb('18', '2月30日12时00分'),
  abc().replace('元，可用', '美元，可用'), abc().replace('消费', '消费验证码'),
  ccb().replace('人民币18', '美元18'), `${ccb()}${ccb()}`,
])('does not construct an unsafe historical draft: %s', async raw => {
  expect((await parse(raw)).draft).toBeNull();
});

it('keeps new-bank future, old and rollover dates for review', async () => {
  const future = await parse(abc('20', '10月31日12:30'));
  expect(future.requires_review).toBe(true);
  expect(future.warnings.join('')).toContain('晚于');
  const old = await parse(abc('20', '10月1日12:00'));
  expect(old.requires_review).toBe(true);
  expect(old.warnings.join('')).toContain('7天');
  const rollover = await parse(abc('20', '12月31日23:59'), '2027-01-01T00:00:00Z');
  expect(rollover.draft.date).toBe('2026-12-31T23:59');
});

it.each(['auto', 'review'])('admits each new bank but never automatically posts in %s mode', async mode => {
  const { token } = await rpc('moneytrail_sms_rotate', [mode]);
  for (const raw of [abc(), ccb(), boc]) expect(await receive(token, raw)).toMatchObject({ accepted: true, status: 'pending' });
  expect(await ledger()).toBeUndefined();
  const inbox = await rpc('moneytrail_sms_inbox');
  expect(inbox.total).toBe(3);
  expect(inbox.items.every((item: any) => item.raw_text && item.status === 'pending')).toBe(true);
  expect((await rpc('moneytrail_sms_preview_pending')).items.every((item: any) => !item.eligible)).toBe(true);
  if (mode === 'auto') expect(await rpc('moneytrail_sms_reprocess_pending')).toEqual({ recorded_count: 0, pending_count: 3 });
});

it('retains existing ICBC auto posting and account merchant memory', async () => {
  await rpc('moneytrail_sms_set_merchant_rule', ['松林咖啡', '学习', '课程']);
  const { token } = await rpc('moneytrail_sms_rotate', ['auto']);
  const stamp = (await db.query<{ d: string }>(`select to_char(now() at time zone 'Asia/Shanghai','FMMM月FMDD日HH24:MI') d`)).rows[0].d;
  expect((await receive(token, icbc(stamp))).status).toBe('recorded');
  expect((await ledger()).data.transactions[0]).toMatchObject({ category: '学习', subcategory: '课程' });
});

it.each([
  '您尾号1234消费20元。【招商银行】', '消费20元【中国银行】【农业银行】',
  '您尾号1234收到工资收入1000元。【农业银行】', '信用卡消费满100元赠20元优惠券。【中国银行】',
  '中国银行信用卡限时促销，消费享优惠。【中国银行】',
  ...['验证码123456', '动态码123456', 'OTP123456', 'ｏｔｐ１２３', 'verification123456', 'one-time123456'].map(code => `您消费20元${code}。【建设银行】`),
])('rejects non-scope or security input without retaining or counting it: %s', async raw => {
  const { token } = await rpc('moneytrail_sms_rotate', ['auto']);
  await expect(receive(token, raw)).rejects.toMatchObject({ code: '22023' });
  expect((await rpc('moneytrail_sms_inbox')).total).toBe(0);
  expect((await db.query<{ n: number }>('select receipt_count n from moneytrail_private.sms_settings')).rows[0].n).toBe(0);
});

it.each([
  '您的借记卡1234于10月31日12:00消费USD20.00元，余额10000.00元。【中国银行】',
  '您尾号1234于10月31日12:00支出美元20元。【建设银行】',
  '您的账户收到工资收入1000元，已开通消费通知。【中国银行】',
  '每消费100元可获1积分，敬请使用我行信用卡。【中国银行】',
])('rejects new-bank foreign amounts or a mere mention of spending before any receipt write: %s', async raw => {
  const { token } = await rpc('moneytrail_sms_rotate', ['auto']);
  await db.query('update moneytrail_private.sms_settings set receipt_count=99,receipt_day=(now() at time zone \'Asia/Shanghai\')::date where user_id=$1', [A]);
  const before = (await db.query('select row_to_json(s) value from moneytrail_private.sms_settings s where user_id=$1', [A])).rows;
  await expect(receive(token, raw)).rejects.toMatchObject({ code: '22023' });
  expect((await db.query('select row_to_json(s) value from moneytrail_private.sms_settings s where user_id=$1', [A])).rows).toEqual(before);
  expect((await rpc('moneytrail_sms_inbox')).total).toBe(0);
  expect(await ledger()).toBeUndefined();
  expect((await receive(token, boc)).status).toBe('pending');
  expect((await db.query<{ n: number }>('select receipt_count n from moneytrail_private.sms_settings where user_id=$1', [A])).rows[0].n).toBe(100);
});

it.each([
  '您尾号1234的账户10月31日支出20元。【中国农业银行】',
  '您尾号1234的储蓄卡消费20元，余额100元。【中国建设银行】',
  ...['支出', '消费', '扣款', '扣费', '批扣', '代扣', '转出', '支取'].map(action => `您的账户10月31日12:00${action}人民币18.50元，余额1000元。【中国银行】`),
  '您的账户10月31日12:00扣费：人民币 18.50元，余额1000元。【中国银行】',
  '您的账户10月31日12:00消费金额为人民币18.50元，余额1000元。【中国银行】',
])('continues admitting a signed actual debit with an associated amount for review: %s', async raw => {
  const { token } = await rpc('moneytrail_sms_rotate', ['auto']);
  expect(await receive(token, raw)).toMatchObject({ accepted: true, status: 'pending' });
  expect((await rpc('moneytrail_sms_inbox')).items[0].raw_text).toBe(raw);
  expect(await ledger()).toBeUndefined();
});

it('leaves established ICBC intake behavior for foreign/ambiguous currency unchanged', async () => {
  const { token } = await rpc('moneytrail_sms_rotate', ['auto']);
  const raw = icbc().replace('28元', '28美元');
  expect(await receive(token, raw)).toMatchObject({ accepted: true, status: 'pending' });
  expect((await rpc('moneytrail_sms_inbox')).items[0]).toMatchObject({ raw_text: raw, draft: null });
  expect(await ledger()).toBeUndefined();
});

it('keeps raw-message deduplication and isolates account ownership for new banks', async () => {
  const a = await rpc('moneytrail_sms_rotate', ['auto']);
  const first = await receive(a.token, abc());
  expect(await receive(a.token, abc())).toEqual({ accepted: true, status: 'duplicate', id: first.id });
  await user(B);
  const b = await rpc('moneytrail_sms_rotate', ['review']);
  const other = await receive(b.token, abc());
  expect(other.status).toBe('pending');
  expect(other.id).not.toBe(first.id);
  const draft = (await rpc('moneytrail_sms_inbox')).items[0].draft;
  await expect(rpc('moneytrail_sms_confirm', [first.id, draft])).rejects.toMatchObject({ code: '42501' });
  expect((await rpc('moneytrail_sms_inbox')).total).toBe(1);
  await user(A);
  expect((await rpc('moneytrail_sms_inbox')).items[0].id).toBe(first.id);
  await rpc('moneytrail_sms_revoke');
  await expect(receive(a.token, ccb())).rejects.toMatchObject({ code: '42501' });
});

it('allows explicit new-bank confirmation while rebuilding evidence and refusing unverified rule learning', async () => {
  const { token } = await rpc('moneytrail_sms_rotate', ['auto']);
  const receipt = await receive(token, ccb());
  const item = (await rpc('moneytrail_sms_inbox')).items[0];
  const fixed = { ...item.draft, category: '居住', smsEvidence: { text: 'forged' } };
  await expect(rpc('moneytrail_sms_confirm_with_rule', [receipt.id, fixed, true])).rejects.toMatchObject({ code: '22023' });
  expect(await ledger()).toBeUndefined();
  const result = await rpc('moneytrail_sms_confirm_with_rule', [receipt.id, fixed, false]);
  expect(result.status).toBe('recorded');
  const saved = (await ledger()).data.transactions[0];
  expect(saved.category).toBe('居住');
  expect(saved.smsEvidence.text).toContain('建设银行');
  expect(saved.smsEvidence.text).not.toMatch(/forged|工商银行|1234|6900\.12/);
  expect((await rpc('moneytrail_sms_inbox')).items[0].raw_text).toBeNull();
  expect(await rpc('moneytrail_sms_category_rules')).toEqual({ rules: [] });
  expect(await rpc('moneytrail_sms_confirm_with_rule', [receipt.id, {}, false])).toEqual(result);
});

it('keeps newly introduced private helpers uncallable and search paths pinned', async () => {
  for (const role of ['anon', 'authenticated']) {
    for (const signature of ['moneytrail_private.sms_bank_code(text)', 'moneytrail_private.sms_parse_bank(text,timestamptz)']) {
      expect((await db.query<{ allowed: boolean }>('select has_function_privilege($1,$2,\'EXECUTE\') allowed', [role, signature])).rows[0].allowed).toBe(false);
    }
  }
  const rows = (await db.query<{ config: string[] }>("select proconfig config from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='moneytrail_private' and proname in ('sms_bank_code','sms_parse_bank')")).rows;
  expect(rows).toHaveLength(2);
  expect(rows.every(row => row.config?.includes('search_path=""'))).toBe(true);
});

it('reapplying the DDL leaves ledger, inbox, rules, settings and original ICBC parser unchanged', async () => {
  await rpc('save_moneytrail_ledger', [{ version: 1, budgetCents: 123456, billCheckedMonths: ['2026-09'], transactions: [] }, 0]);
  await rpc('moneytrail_sms_set_merchant_rule', ['松林咖啡', '本地生活', '咖啡奶茶']);
  const { token } = await rpc('moneytrail_sms_rotate', ['review']);
  await receive(token, abc());
  const tables = ['public.moneytrail_ledgers', 'moneytrail_private.sms_inbox', 'moneytrail_private.sms_category_rules', 'moneytrail_private.sms_settings'];
  const read = () => Promise.all(tables.map(async table => (await db.query(`select row_to_json(t)::text value from ${table} t order by row_to_json(t)::text`)).rows));
  const before = await read();
  const original = (await db.query<{ text: string }>("select pg_get_functiondef('moneytrail_private.moneytrail_parse_icbc_sms(text,timestamptz,text)'::regprocedure) text")).rows[0].text;
  await db.exec(migrations[Object.keys(migrations).find(file => file.endsWith('_four_bank_sms.sql'))!]);
  expect(await read()).toEqual(before);
  expect((await db.query<{ text: string }>("select pg_get_functiondef('moneytrail_private.moneytrail_parse_icbc_sms(text,timestamptz,text)'::regprocedure) text")).rows[0].text).toBe(original);
});
