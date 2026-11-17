import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';

const migrations = import.meta.glob('../../supabase/migrations/*.sql', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const debit = '〖招商银行〗您账户0000于04月09日06:43在〖支付宝-示例商户〗快捷支付114.15元，余额9999.99元';
const credit = '您尾号1234的招行信用卡于12月24日18时4分消费人民币256.05元';
const copied = debit + '\u200c\ufffc\u200c\ufffc';
let db: PGlite;
let establishedDefinitions: unknown[];
let cmbDefinitionsUnchanged: boolean;

async function rpc(name: string, args: unknown[] = []): Promise<any> {
  return (await db.query<{ r: any }>(`select to_jsonb(public.${name}(${args.map((_, i) => `$${i + 1}`).join(',')})) r`, args)).rows[0].r;
}
async function user(id = A) { await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ sub: id })]); }
async function receive(token: string, message: string) { return rpc('moneytrail_receive_sms', [token, message]); }
async function parse(message: string | null, received = '2026-04-09T00:00:00Z') {
  return (await db.query<{ r: any }>('select moneytrail_private.sms_parse_cmb($1,$2::timestamptz) r', [message, received])).rows[0].r;
}
async function source(message: string | null) { return (await db.query<{ r: string | null }>('select moneytrail_private.sms_review_bank_source($1) r', [message])).rows[0].r; }
async function rows(table: string) { return (await db.query(`select row_to_json(t)::text value from ${table} t order by row_to_json(t)::text`)).rows; }
async function definitions() {
  return (await db.query(`select p.proname,pg_get_functiondef(p.oid) definition from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where (n.nspname='public' and p.proname in ('moneytrail_sms_confirm','moneytrail_sms_reprocess_pending','moneytrail_sms_preview_pending'))
      or (n.nspname='moneytrail_private' and p.proname in ('sms_bank_code','sms_parse_bank','sms_parse_for_account','moneytrail_parse_icbc_sms')) order by n.nspname,p.proname`)).rows;
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`create role anon nologin; create role authenticated nologin; create schema auth;
    create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz,deleted_at timestamptz);
    create function auth.uid() returns uuid language sql stable as $$select (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid$$;
    grant usage on schema public,auth to anon,authenticated;`);
  for (const file of Object.keys(migrations).sort()) {
    if (file.endsWith('_cmb_sms_formats.sql')) establishedDefinitions = await definitions();
    await db.exec(migrations[file]);
    if (file.endsWith('_cmb_sms_formats.sql')) cmbDefinitionsUnchanged = JSON.stringify(await definitions()) === JSON.stringify(establishedDefinitions);
  }
  establishedDefinitions = await definitions();
}, 30000);
afterAll(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec(`reset role; truncate auth.users cascade; insert into auth.users values('${A}','a@invalid',now(),null,null),('${B}','b@invalid',now(),null,null);`);
  await user();
});

it('parses the white-bracket debit independently of its balance and preserves the payment descriptor for review', async () => {
  const result = await parse(copied);
  expect(result).toMatchObject({ requires_review: true, error: null,
    draft: { kind: 'expense', amountCents: 11415, date: '2026-04-09T06:43', merchant: '支付宝-示例商户', category: '待分类', source: 'sms' } });
  expect(result.warnings.join('')).toContain('支付渠道或收款方');
  expect(result.draft.smsEvidence.text).toContain('114.15元');
  expect(result.draft.smsEvidence.text).not.toMatch(/0000|9999\.99/);
  expect(result.draft.smsEvidence.receivedAt).toBe('2026-04-09T00:00:00.000000Z');
  expect((await parse(debit)).draft).toMatchObject({ amountCents: 11415, date: '2026-04-09T06:43', merchant: '支付宝-示例商户' });
});

it('parses the exact unsigned credit-card identity with a one-digit minute and a missing-merchant warning', async () => {
  const result = await parse(credit, '2026-12-24T10:05:00Z');
  expect(result).toMatchObject({ requires_review: true, error: null,
    draft: { kind: 'expense', amountCents: 25605, date: '2026-12-24T18:04', merchant: '待补充商户', category: '待分类', source: 'sms' } });
  expect(result.warnings.join('')).toContain('未提供具体商户');
  expect(result.draft.smsEvidence.text).not.toContain('1234');
});

it.each([debit, copied, credit, credit + '。', credit.replace('1234', '××××')])('recognizes only the bounded CMB source %#', async message => {
  expect(await source(message)).toBe('cmb');
});

it.each([
  credit.replace('招行信用卡', '信用卡'), credit.replace('招行', '其他'), '招行通知：' + credit,
  credit + '其他通知', credit + '【招商银行】', credit + '【中国银行】', credit + '（招商银行）', '【中国银行】' + credit,
  debit + '【工商银行】', debit.replace('〖支付宝-示例商户〗', '〖中国银行商户〗'),
  debit.replace('114.15', '114.\u200c15'), credit.replace('256.05', '256.\ufffc05'),
])('does not recognize an unsigned loose mention, conflicting marker or hidden value mutation %#', async message => {
  expect(await source(message)).toBeNull();
  expect((await parse(message)).draft).toBeNull();
});

it.each([
  debit.replace('114.15', '1,114.15'), debit.replace('114.15', '１１４．１５'),
  debit.replace('0000', '××××').replace('9999.99', '××××.××'),
])('supports grouped/fullwidth money and masked account/balance without treating the balance as spending %#', async message => {
  expect((await parse(message)).draft.amountCents).toBe(message.includes('1,114') ? 111415 : 11415);
});

it.each([
  ...['0', '-114.15', '114.151', '1,14.15', '1000000000000'].map(value => debit.replace('114.15', value)),
  ...['0', '-256.05', '256.051', '2,56.05', '1000000000000'].map(value => credit.replace('256.05', value)),
  ...['02月30日', '13月09日'].map(value => debit.replace('04月09日', value)),
  debit.replace('06:43', '24:00'), debit.replace('06:43', '06:60'),
  credit.replace('18时4分', '18时60分'), credit.replace('12月24日', '02月30日'),
  debit.replace('〖支付宝-示例商户〗', '〖示例商户20元〗'),
  debit.replace('〖支付宝-示例商户〗', '〖支付宝-退款〗'),
  debit + '另消费20元', credit + '另消费20元',
  copied + '未结束', debit.replace('快捷支付', '快捷支付验证码'),
  debit.replace('114.15元', '114.15美元'), credit.replace('人民币', '美元'),
])('does not construct a draft from unsafe money, date, merchant or multiple-event content %#', async message => {
  expect(await parse(message)).toMatchObject({ requires_review: true, draft: null, error: expect.any(String) });
});

it('uses receipt-local year, rollover rules and warnings without substituting receipt time', async () => {
  expect((await parse(credit.replace('12月24日18时4分', '12月31日23时59分'), '2027-01-01T00:00:00Z')).draft.date).toBe('2026-12-31T23:59');
  expect((await parse(debit, '2026-04-09T00:00:00Z')).draft.date).toBe('2026-04-09T06:43');
  expect((await parse(debit, '2026-04-09T00:00:00Z')).warnings.join('')).not.toContain('超过7天');
  expect((await parse(debit, '2026-11-16T00:00:00Z')).warnings.join('')).toContain('超过7天');
  expect((await parse(debit.replace('06:43', '09:00'), '2026-04-09T00:00:00Z')).warnings.join('')).toContain('晚于');
  expect((await parse(debit, 'infinity')).draft).toBeNull();
});

it('rejects every Unicode format-control range inside the body while allowing only the measured copied suffix', async () => {
  const ranges = [[173,173],[1536,1541],[1564,1564],[1757,1757],[1807,1807],[2192,2193],[2274,2274],[6158,6158],
    [8203,8207],[8234,8238],[8288,8292],[8294,8303],[65279,65279],[65529,65531],[69821,69821],[69837,69837],
    [78896,78911],[113824,113827],[119155,119162],[917505,917505],[917536,917631]];
  for (const [start,end] of ranges) {
    for (let value=start;value<=end;value++) {
      const message = debit.replace('示例商户', '示例' + String.fromCodePoint(value) + '商户');
      expect((await db.query<{ r: string | null }>('select moneytrail_private.sms_cmb_text($1) r', [message])).rows[0].r).toBeNull();
      expect(await source(message)).toBeNull();
    }
  }
  expect(await source(copied)).toBe('cmb');
});

it.each(['auto', 'review'])('receives both supported formats as pending and never posts automatically in %s mode', async mode => {
  const { token } = await rpc('moneytrail_sms_rotate', [mode]);
  for (const message of [copied, credit]) {
    expect(await receive(token, message)).toMatchObject({ accepted: true, status: 'pending' });
  }
  const inbox = await rpc('moneytrail_sms_inbox');
  expect(inbox.total).toBe(2);
  expect(inbox.items.map((entry: any) => entry.draft.amountCents).sort()).toEqual([11415, 25605]);
  expect(inbox.items.every((entry: any) => entry.status === 'pending' && entry.transaction_id === null)).toBe(true);
  expect(inbox.items.map((entry: any) => entry.raw_text)).toContain(copied);
  expect((await rpc('moneytrail_sms_preview_pending')).recordable_count).toBe(0);
  if (mode === 'auto') expect(await rpc('moneytrail_sms_reprocess_pending')).toEqual({ recorded_count: 0, pending_count: 2 });
  expect(await rows('public.moneytrail_ledgers')).toEqual([]);
});

it('retains invalid dates and unknown signed layouts as draftless pending receipts rather than guessing', async () => {
  const { token } = await rpc('moneytrail_sms_rotate', ['auto']);
  for (const message of [debit.replace('04月09日', '02月30日'), credit.replace('12月24日', '13月24日'), '【招商银行】您尾号1234卡消费人民币120元。']) {
    expect(await receive(token, message)).toMatchObject({ status: 'pending' });
  }
  expect((await rpc('moneytrail_sms_inbox')).items.every((entry: any) => entry.draft === null)).toBe(true);
  expect(await rows('public.moneytrail_ledgers')).toEqual([]);
});

it.each([
  debit.replace('114.15元', 'USD114.15元'), debit + '验证码123456', credit + 'OTP123456',
  debit.replace('快捷支付114.15元', '快捷支付，余额114.15元'),
  credit.replace('消费人民币256.05元', '本期账单消费人民币256.05元'),
  '您尾号1234的信用卡于12月24日18时4分消费人民币256.05元',
  '【中国银行】您账户1234快捷支付114.15元。', debit + '【中国银行】',
  ...['\u200b','\u2060','\u202e','\u{E007F}'].map(value => debit.replace('示例商户', '验' + value + '证码商户')),
])('rejects unsafe or widened scope before any receipt count or raw retention %#', async message => {
  const { token } = await rpc('moneytrail_sms_rotate', ['auto']);
  const before = await rows('moneytrail_private.sms_settings');
  await expect(receive(token, message)).rejects.toMatchObject({ code: '22023' });
  expect(await rows('moneytrail_private.sms_settings')).toEqual(before);
  expect((await rpc('moneytrail_sms_inbox')).total).toBe(0);
});

it('preserves raw-message deduplication, owner isolation and confirmation evidence', async () => {
  const a = await rpc('moneytrail_sms_rotate', ['auto']);
  const receipt = await receive(a.token, copied);
  expect(await receive(a.token, copied)).toEqual({ accepted: true, status: 'duplicate', id: receipt.id });
  const draft = (await rpc('moneytrail_sms_inbox')).items[0].draft;
  await user(B); const b = await rpc('moneytrail_sms_rotate', ['auto']);
  const other = await receive(b.token, copied); expect(other.id).not.toBe(receipt.id);
  await expect(rpc('moneytrail_sms_confirm', [receipt.id, draft])).rejects.toMatchObject({ code: '42501' });
  await user();
  await expect(rpc('moneytrail_sms_confirm_with_rule', [receipt.id, draft, true])).rejects.toMatchObject({ code: '22023' });
  expect(await rpc('moneytrail_sms_confirm', [receipt.id, { ...draft, merchant: '本人核对的示例商户', smsEvidence: { text: 'forged' } }])).toMatchObject({ status: 'recorded' });
  const data = (await db.query<{ data: any }>('select data from public.moneytrail_ledgers where user_id=$1', [A])).rows[0].data;
  expect(data.transactions[0].smsEvidence.text).toContain('招商银行');
  expect(data.transactions[0].smsEvidence.text).not.toMatch(/0000|9999\.99|forged/);
  expect((await rpc('moneytrail_sms_inbox')).items[0].raw_text).toBeNull();
  expect((await db.query('select * from public.moneytrail_ledgers where user_id=$1', [B])).rows).toEqual([]);
});

it('keeps helpers private, immutable and pinned while preserving established parser definitions and business rows', async () => {
  for (const signature of ['sms_cmb_text(text)', 'sms_cmb_credit_identity(text)', 'sms_parse_cmb(text,timestamptz)', 'sms_review_bank_source(text)']) {
    for (const role of ['anon', 'authenticated']) expect((await db.query<{ allowed: boolean }>("select has_function_privilege($1,$2,'EXECUTE') allowed", [role, 'moneytrail_private.' + signature])).rows[0].allowed).toBe(false);
    expect((await db.query('select provolatile,prosecdef,proconfig from pg_proc where oid=$1::regprocedure', ['moneytrail_private.' + signature])).rows[0]).toMatchObject({ provolatile: 'i', prosecdef: false, proconfig: ['search_path=""'] });
  }
  expect(cmbDefinitionsUnchanged).toBe(true);
  expect(await definitions()).toEqual(establishedDefinitions);
  await rpc('save_moneytrail_ledger', [{ version: 1, budgetCents: 12345, transactions: [], billCheckedMonths: [] }, 0]);
  const { token } = await rpc('moneytrail_sms_rotate', ['review']); await receive(token, copied);
  const tables = ['public.moneytrail_ledgers', 'moneytrail_private.sms_inbox', 'moneytrail_private.sms_settings', 'moneytrail_private.sms_category_rules'];
  const before = await Promise.all(tables.map(rows));
  await db.exec(migrations[Object.keys(migrations).find(file => file.endsWith('_cmb_sms_formats.sql'))!]);
  expect(await Promise.all(tables.map(rows))).toEqual(before);
  expect(await definitions()).toEqual(establishedDefinitions);
});
