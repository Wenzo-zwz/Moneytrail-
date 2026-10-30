import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { canRememberMerchant, classifyMerchant, merchantKey } from './merchantClassification';

const migrations = import.meta.glob('../../supabase/migrations/*.sql', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
let db: PGlite;
type Tx = Record<string, unknown>;
const tx = (overrides: Tx = {}): Tx => ({ id: 'manual-1', kind: 'expense', amountCents: 2000, date: '2026-10-24T12:00', merchant: '青禾馆(东店)', category: '本地生活', subcategory: '自选细分', source: 'manual', note: '', ...overrides });
const ledger = (...transactions: Tx[]) => ({ version: 1, transactions, budgetCents: 123456, billCheckedMonths: ['2026-09'] });
const intent = (overrides: Tx = {}): Tx => ({ transactionId: 'manual-1', merchant: '青禾馆(东店)', category: '本地生活', subcategory: '自选细分', ...overrides });
const sms = (merchant: string) => `尾号xxxx卡10月24日12:00支出(${merchant})20元，余额12,345.94元。【工商银行】`;

async function rpc(name: string, args: unknown[] = []): Promise<any> {
  return (await db.query<{ r: any }>(`select to_jsonb(public.${name}(${args.map((_, index) => `$${index + 1}`).join(',')})) r`, args)).rows[0]?.r;
}
async function user(id = A) { await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ sub: id })]); }
async function rules() { return rpc('moneytrail_sms_category_rules'); }
async function parse(merchant: string) {
  return (await db.query<{ r: any }>("select moneytrail_private.sms_parse_for_account($1,$2,'2026-10-24T04:01:00Z') r", [A, sms(merchant)])).rows[0].r;
}
async function pending(merchant: string, owner = A) {
  const parsed = await parse(merchant);
  const id = (await db.query<{ id: string }>(`insert into moneytrail_private.sms_inbox(user_id,received_at,fingerprint,status,raw_text,draft) values($1,'2026-10-24T04:01:00Z',repeat('a',64),'pending',$2,$3) returning id`, [owner, sms(merchant), parsed.draft])).rows[0].id;
  return { id, draft: parsed.draft };
}
async function saved() { return (await db.query<{ data: any; revision: number }>('select data,revision from public.moneytrail_ledgers where user_id=$1', [A])).rows[0]; }
async function save(data = ledger(tx()), revision = 0, intents: unknown = [intent()]) { return rpc('save_moneytrail_ledger_with_rules', [data, revision, intents]); }

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

it('round trips explicit details and clears them through the new setter', async () => {
  expect(await rpc('moneytrail_sms_set_merchant_rule', ['消费抖音支付-青禾馆（东店）', '本地生活', '未细分']))
    .toEqual({ rules: [{ merchant: '青禾馆(东店)', category: '本地生活', subcategory: '未细分' }] });
  expect((await parse('微信支付-青禾馆(东店)')).draft).toMatchObject({ category: '本地生活', subcategory: '未细分' });
  expect(await rpc('moneytrail_sms_set_category_rule', ['青禾馆(东店)', '本地生活']))
    .toEqual({ rules: [{ merchant: '青禾馆(东店)', category: '本地生活', subcategory: '未细分' }] });
  expect(await rpc('moneytrail_sms_set_merchant_rule', ['青禾馆(东店)', '本地生活', null]))
    .toEqual({ rules: [{ merchant: '青禾馆(东店)', category: '本地生活' }] });
  expect((await parse('青禾馆(东店)')).draft).not.toHaveProperty('subcategory');
  await rpc('moneytrail_sms_set_merchant_rule', ['青禾馆(东店)', '本地生活', '聚会']);
  expect(await rpc('moneytrail_sms_set_category_rule', ['青禾馆(东店)', '学习']))
    .toEqual({ rules: [{ merchant: '青禾馆(东店)', category: '学习' }] });
  expect(await rpc('moneytrail_sms_set_merchant_rule', ['青禾馆(东店)', null, null])).toEqual({ rules: [] });
});

it('normalizes legacy categories and explicit legacy details', async () => {
  await db.query(`insert into moneytrail_private.sms_category_rules(user_id,merchant,category,subcategory) values($1,'青禾馆(东店)','餐饮',null),($1,'青禾馆(西店)','娱乐','未细分')`, [A]);
  expect(await rules()).toEqual({ rules: [
    { merchant: '青禾馆(东店)', category: '本地生活', subcategory: '餐饮' },
    { merchant: '青禾馆(西店)', category: '本地生活', subcategory: '未细分' },
  ] });
  expect((await parse('青禾馆(东店)')).draft).toMatchObject({ category: '本地生活', subcategory: '餐饮' });
  expect((await parse('青禾馆(西店)')).draft).toMatchObject({ category: '本地生活', subcategory: '未细分' });
});

it.each(['抖音支付-青禾馆（东店）', '消费：快捷支付-抖音支付-微信支付-青禾馆(东店)', ' 支付－ＡＢＣ（东店） ', '青禾馆(西店)'])('normalizes exactly like TS: %s', async merchant => {
  const result = await db.query<{ key: string }>('select moneytrail_private.sms_merchant_key($1) key', [merchant]);
  expect(result.rows[0].key).toBe(merchantKey(merchant));
  if (merchant.includes('抖音支付')) expect(result.rows[0].key).toBe('青禾馆(东店)');
});

it('normalizes 抖音支付 in the preserved Meituan platform path too', async () => {
  expect((await parse('抖音支付-美团支付')).draft).toMatchObject({ category: '本地生活', platform: '美团' });
  expect((await db.query<{ v: boolean }>("select moneytrail_private.sms_is_platform_only_merchant('抖音支付-美团支付') v")).rows[0].v).toBe(true);
});

it.each(['未细分', '特别用途'])('prefers explicit %s to inferred store detail with TS parity', async subcategory => {
  await rpc('moneytrail_sms_set_merchant_rule', ['松林咖啡(东店)', '本地生活', subcategory]);
  const sql = (await parse('抖音支付-松林咖啡(东店)')).draft;
  const ts = classifyMerchant('抖音支付-松林咖啡(东店)', (await rules()).rules);
  expect({ category: sql.category, subcategory: sql.subcategory }).toEqual({ category: ts.category, subcategory: ts.subcategory });
  expect(sql.subcategory).toBe(subcategory);
  expect((await parse('松林咖啡(西店)')).draft.subcategory).toBe('咖啡奶茶');
});

it('looks up old normalized aliases without globally rewriting conflicting rows', async () => {
  await db.query(`insert into moneytrail_private.sms_category_rules(user_id,merchant,category,subcategory) values($1,'抖音支付-青禾馆(东店)','学习','课程'),($1,'青禾馆(西店)','购物','纪念品')`, [A]);
  expect((await parse('微信支付-青禾馆(东店)')).draft).toMatchObject({ category: '学习', subcategory: '课程' });
  expect((await rules()).rules).toHaveLength(2);
  await db.query(`insert into moneytrail_private.sms_category_rules(user_id,merchant,category,subcategory) values($1,'青禾馆(东店)','医疗','检查')`, [A]);
  expect((await parse('青禾馆(东店)')).draft).toMatchObject({ category: '医疗', subcategory: '检查' });
  expect((await rules()).rules).toHaveLength(3);
  await rpc('moneytrail_sms_set_merchant_rule', ['微信支付-青禾馆(东店)', '本地生活', '餐饮']);
  expect(await rules()).toEqual({ rules: [
    { merchant: '青禾馆(东店)', category: '本地生活', subcategory: '餐饮' },
    { merchant: '青禾馆(西店)', category: '购物', subcategory: '纪念品' },
  ] });
});

it.each(['财付通', '抖音支付', '群收款', '给张三转账', '待补充商户', '未知商户', '---', '京东', '淘宝网', '天猫商城', '拼多多', '滴滴出行', '抖音平台', '抖音支付-美团支付'])('rejects unsafe rule %s', async merchant => {
  expect((await db.query<{ allowed: boolean }>('select moneytrail_private.sms_can_remember_merchant($1) allowed', [merchant])).rows[0].allowed).toBe(canRememberMerchant(merchant));
  await expect(rpc('moneytrail_sms_set_merchant_rule', [merchant, '购物', '自选'])).rejects.toMatchObject({ code: '22023' });
  expect(await rules()).toEqual({ rules: [] });
});

it.each(['', ' ', 'x'.repeat(41)])('rejects invalid detail %s', async detail => {
  await expect(rpc('moneytrail_sms_set_merchant_rule', ['青禾馆', '购物', detail])).rejects.toMatchObject({ code: '22023' });
});

it('saves matching transaction and rule in one revisioned write', async () => {
  const result = await save();
  expect(result).toMatchObject({ user_id: A, revision: 1, data: ledger(tx()) });
  expect(await rules()).toEqual({ rules: [{ merchant: '青禾馆(东店)', category: '本地生活', subcategory: '自选细分' }] });
  expect((await parse('消费抖音支付-青禾馆(东店)')).draft).toMatchObject({ category: '本地生活', subcategory: '自选细分' });
  expect((await parse('青禾馆(西店)')).draft.category).toBe('待分类');
});

it('fails stale revision without publishing the accompanying intent', async () => {
  await rpc('save_moneytrail_ledger', [ledger(tx({ category: '待分类', subcategory: undefined })), 0]);
  const before = await saved();
  await expect(save(ledger(tx()), 0)).rejects.toMatchObject({ code: '40001' });
  expect(await saved()).toEqual(before);
  expect(await rules()).toEqual({ rules: [] });
});

it.each([
  { transactionId: 'missing' }, { merchant: '青禾馆(西店)' }, { category: '学习' }, { subcategory: '另外细分' },
  { extra: true }, { transactionId: null }, { category: '待分类' }, { subcategory: null },
])('rejects mismatching or malformed intent %j atomically', async patch => {
  await expect(save(ledger(tx()), 0, [intent(patch)])).rejects.toMatchObject({ code: '22023' });
  expect(await saved()).toBeUndefined();
  expect(await rules()).toEqual({ rules: [] });
});

it('validates rule array bounds, duplicate transactions and conflicting merchant intents', async () => {
  for (const intents of [null, {}, [intent(), intent()], Array.from({ length: 201 }, () => intent())]) {
    await expect(save(ledger(tx()), 0, intents)).rejects.toMatchObject({ code: '22023' });
  }
  const second = tx({ id: 'manual-2', category: '学习' });
  await expect(save(ledger(tx(), second), 0, [intent(), intent({ transactionId: 'manual-2', category: '学习' })])).rejects.toMatchObject({ code: '22023' });
  expect(await saved()).toBeUndefined();
});

it.each([
  tx({ kind: 'transfer', category: '待分类', merchant: '本人账户互转', subcategory: undefined }),
  tx({ merchant: '群收款', category: '待分类', subcategory: undefined }),
  tx({ merchant: '转账张三', category: '待分类', subcategory: undefined }),
  tx({ merchant: '青禾馆(西店)', category: '待分类', subcategory: undefined }),
])('does not learn by renaming an unsafe or different prior transaction: $merchant', async original => {
  await rpc('save_moneytrail_ledger', [ledger(original), 0]);
  const before = await saved();
  await expect(save(ledger(tx()), 1)).rejects.toMatchObject({ code: '22023' });
  expect(await saved()).toEqual(before);
  expect(await rules()).toEqual({ rules: [] });
});

it('allows exact channel variants of safe prior merchants', async () => {
  await rpc('save_moneytrail_ledger', [ledger(tx({ merchant: '抖音支付-青禾馆（东店）', category: '待分类', subcategory: undefined })), 0]);
  expect(await save(ledger(tx()), 1)).toMatchObject({ revision: 2 });
  expect((await rules()).rules).toHaveLength(1);
});

it('rolls back all ledger and rule changes when rule capacity is exceeded', async () => {
  await db.query(`insert into moneytrail_private.sms_category_rules(user_id,merchant,category) select $1,'已有商店'||n,'购物' from generate_series(1,199)n`, [A]);
  const second = tx({ id: 'manual-2', merchant: '青禾馆(西店)' });
  await expect(save(ledger(tx(), second), 0, [intent(), intent({ transactionId: 'manual-2', merchant: '青禾馆(西店)' })])).rejects.toMatchObject({ code: '54000' });
  expect(await saved()).toBeUndefined();
  expect((await rules()).rules).toHaveLength(199);
});

it('lets an explicit matching alias update at capacity without learning another branch', async () => {
  await db.query(`insert into moneytrail_private.sms_category_rules(user_id,merchant,category) select $1,'已有商店'||n,'购物' from generate_series(1,199)n`, [A]);
  await db.query(`insert into moneytrail_private.sms_category_rules(user_id,merchant,category) values($1,'抖音支付-青禾馆(东店)','购物')`, [A]);
  await save();
  expect((await rules()).rules).toHaveLength(200);
  expect((await parse('青禾馆(东店)')).draft).toMatchObject({ category: '本地生活', subcategory: '自选细分' });
});

it('supports category-only intents and keeps the old save API unchanged', async () => {
  const categoryOnly = tx(); delete categoryOnly.subcategory;
  const rule = intent(); delete rule.subcategory;
  await save(ledger(categoryOnly), 0, [rule]);
  expect(await rules()).toEqual({ rules: [{ merchant: '青禾馆(东店)', category: '本地生活' }] });
  expect(await rpc('save_moneytrail_ledger', [ledger(tx({ note: 'ordinary save' })), 1])).toMatchObject({ revision: 2 });
});

it('clears a previously stored detail only when an explicit matching intent omits it', async () => {
  await save();
  const categoryOnly = tx(); delete categoryOnly.subcategory;
  const rule = intent(); delete rule.subcategory;
  await rpc('save_moneytrail_ledger', [ledger(categoryOnly), 1]);
  expect((await saved()).data.transactions[0].subcategory).toBe('自选细分');
  await save(ledger(categoryOnly), 2, [rule]);
  expect((await saved()).revision).toBe(3);
  expect((await saved()).data.transactions[0]).not.toHaveProperty('subcategory');
  expect((await rules()).rules[0]).not.toHaveProperty('subcategory');
});

it.each([
  { refundFirst: false, changedLink: false }, { refundFirst: true, changedLink: false },
  { refundFirst: false, changedLink: true }, { refundFirst: true, changedLink: true },
])('new or changed refunds inherit the final explicit detail clear: %j', async ({ refundFirst, changedLink }) => {
  const original = tx({ category: '购物', subcategory: '旧细类', platform: '京东' });
  const previous = tx({ id: 'previous', merchant: '另一馆', category: '学习', subcategory: '教材' });
  const refund = tx({ id: 'refund', kind: 'refund', category: '购物', subcategory: '旧细类', linkedTransactionId: changedLink ? 'previous' : 'manual-1', smsEvidence: { text: '退款自己的凭据' } });
  await rpc('save_moneytrail_ledger', [ledger(original, previous, ...(changedLink ? [refund] : [])), 0]);
  const cleared = { ...original }; delete cleared.subcategory;
  const finalRefund = { ...refund, linkedTransactionId: 'manual-1' };
  const rule = intent({ category: '购物' }); delete rule.subcategory;
  await save(ledger(...(refundFirst ? [finalRefund, cleared] : [cleared, finalRefund])), 1, [rule]);
  const entries = (await saved()).data.transactions;
  expect(entries.find((entry: Tx) => entry.id === 'manual-1')).not.toHaveProperty('subcategory');
  expect(entries.find((entry: Tx) => entry.id === 'refund')).toEqual({ ...finalRefund, subcategory: undefined, platform: '京东' });
  expect(entries.find((entry: Tx) => entry.id === 'refund')).not.toHaveProperty('subcategory');
  // A later save with the same link preserves a deliberate refund detail edit.
  const manualRefund = { ...finalRefund, category: '学习', subcategory: '手工细类', platform: '京东' };
  await save(ledger(cleared, manualRefund), 2, [rule]);
  expect((await saved()).data.transactions[1]).toEqual(manualRefund);
});

it('normalizes a legacy ledger intent and its detail to the same stored transaction and rule', async () => {
  const legacy = tx({ category: '娱乐' }); delete legacy.subcategory;
  const legacyIntent = intent({ category: '娱乐' }); delete legacyIntent.subcategory;
  await save(ledger(legacy), 0, [legacyIntent]);
  expect((await saved()).data.transactions[0]).toMatchObject({ category: '本地生活', subcategory: '休闲娱乐' });
  expect((await rules()).rules[0]).toMatchObject({ category: '本地生活', subcategory: '休闲娱乐' });
});

it('uses all matching safe intents when multiple transactions share a merchant', async () => {
  await save(ledger(tx(), tx({ id: 'manual-2' })), 0, [intent(), intent({ transactionId: 'manual-2' })]);
  expect((await saved()).data.transactions).toHaveLength(2);
  expect((await rules()).rules).toHaveLength(1);
});

it('ignores preexisting unsafe platform and placeholder rules during account classification', async () => {
  await db.query(`insert into moneytrail_private.sms_category_rules(user_id,merchant,category,subcategory) values($1,'京东','学习','伪造'),($1,'待补充商户','医疗','伪造')`, [A]);
  expect((await parse('京东')).draft).toMatchObject({ category: '购物' });
  expect((await parse('京东')).draft).not.toHaveProperty('subcategory');
  expect((await parse('待补充商户')).draft.category).toBe('待分类');
  expect(await rpc('moneytrail_sms_set_merchant_rule', ['京东', null, null])).toEqual({ rules: [{ merchant: '待补充商户', category: '医疗', subcategory: '伪造' }] });
});

it('confirms with an explicit detail, rebuilds evidence, and remains idempotent', async () => {
  const entry = await pending('消费抖音支付-青禾馆(东店)');
  const draft = { ...entry.draft, category: '本地生活', subcategory: '未细分', smsEvidence: { text: '伪造凭证' } };
  const result = await rpc('moneytrail_sms_confirm_with_rule', [entry.id, draft, true]);
  expect(result).toEqual({ status: 'recorded', transaction_id: `sms-${entry.id}` });
  expect((await saved()).data.transactions[0]).toMatchObject({ merchant: entry.draft.merchant, subcategory: '未细分', smsEvidence: { classificationReason: '人工确认：本地生活' } });
  expect((await saved()).data.transactions[0].smsEvidence.text).toContain('[已隐藏]');
  expect((await saved()).data.transactions[0].smsEvidence.text).not.toContain('伪造凭证');
  await rpc('moneytrail_sms_set_merchant_rule', ['青禾馆(东店)', '学习', '后来修改']);
  const before = await saved();
  expect(await rpc('moneytrail_sms_confirm_with_rule', [entry.id, {}, true])).toEqual(result);
  expect(await saved()).toEqual(before);
  expect((await rules()).rules[0]).toMatchObject({ category: '学习', subcategory: '后来修改' });
});

it('can confirm without remembering and can learn only an unchanged normalized identity', async () => {
  const entry = await pending('青禾馆(东店)');
  await rpc('moneytrail_sms_confirm_with_rule', [entry.id, { ...entry.draft, category: '本地生活', subcategory: '聚会' }, false]);
  expect(await rules()).toEqual({ rules: [] });
  const next = await pending('微信支付-青禾馆(西店)');
  await rpc('moneytrail_sms_confirm_with_rule', [next.id, { ...next.draft, merchant: '抖音支付-青禾馆（西店）', category: '本地生活', subcategory: '聚会' }, true]);
  expect((await rules()).rules).toEqual([{ merchant: '青禾馆(西店)', category: '本地生活', subcategory: '聚会' }]);
});

it.each(['群收款', '转账张三', '本人账户互转', '财付通', '待补充商户', '美团', '京东', '青禾馆(西店)'])('does not learn by renaming original SMS %s', async original => {
  const entry = await pending(original);
  const draft = { ...entry.draft, merchant: '青禾馆(东店)', kind: 'expense', category: '本地生活', subcategory: '聚会' };
  await expect(rpc('moneytrail_sms_confirm_with_rule', [entry.id, draft, true])).rejects.toMatchObject({ code: '22023' });
  expect(await saved()).toBeUndefined();
  expect(await rules()).toEqual({ rules: [] });
  expect((await db.query<{ status: string }>('select status from moneytrail_private.sms_inbox where id=$1', [entry.id])).rows[0].status).toBe('pending');
});

it('rolls back confirmation and evidence removal when learning hits the account rule limit', async () => {
  await db.query(`insert into moneytrail_private.sms_category_rules(user_id,merchant,category) select $1,'已有商店'||n,'购物' from generate_series(1,200)n`, [A]);
  const entry = await pending('青禾馆(东店)');
  await expect(rpc('moneytrail_sms_confirm_with_rule', [entry.id, { ...entry.draft, category: '本地生活', subcategory: '聚会' }, true])).rejects.toMatchObject({ code: '54000' });
  expect(await saved()).toBeUndefined();
  expect((await db.query<{ status: string; raw_text: string }>('select status,raw_text from moneytrail_private.sms_inbox where id=$1', [entry.id])).rows[0]).toEqual({ status: 'pending', raw_text: sms('青禾馆(东店)') });
});

it('isolates owners for rules, ledger writes and SMS confirmation', async () => {
  await save();
  const foreign = await pending('青禾馆(西店)');
  await user(B);
  expect(await rules()).toEqual({ rules: [] });
  await expect(rpc('moneytrail_sms_confirm_with_rule', [foreign.id, { ...foreign.draft, category: '本地生活' }, true])).rejects.toMatchObject({ code: '42501' });
  await expect(save(ledger(tx()), 1)).rejects.toMatchObject({ code: '40001' });
  expect(await rules()).toEqual({ rules: [] });
  expect((await saved()).revision).toBe(1);
});

it('permits the authenticated role to write only its own account through the wrappers', async () => {
  await db.exec('set role authenticated');
  await save();
  expect((await rules()).rules).toHaveLength(1);
  await expect(db.query('select * from moneytrail_private.sms_category_rules')).rejects.toMatchObject({ code: '42501' });
  await user(B);
  expect(await rules()).toEqual({ rules: [] });
  expect((await db.query('select * from public.moneytrail_ledgers')).rows).toHaveLength(0);
  await db.exec('reset role');
});

it('restricts public RPCs to authenticated accounts and keeps helpers private with fixed search paths', async () => {
  for (const role of ['anon', 'authenticated']) {
    const privileges = (await db.query<{ name: string; allowed: boolean }>(`select p.proname name,has_function_privilege($1,p.oid,'EXECUTE') allowed from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='moneytrail_private' and p.proname in ('sms_can_remember_merchant','sms_upsert_merchant_rule')`, [role])).rows;
    expect(privileges).toHaveLength(2);
    expect(privileges.every(row => !row.allowed)).toBe(true);
  }
  const paths = (await db.query<{ config: string[] }>(`select p.proconfig config from pg_proc p join pg_namespace n on n.oid=p.pronamespace where p.proname in ('sms_can_remember_merchant','sms_upsert_merchant_rule','moneytrail_sms_set_merchant_rule','save_moneytrail_ledger_with_rules','moneytrail_sms_confirm_with_rule')`)).rows;
  expect(paths).toHaveLength(5);
  expect(paths.every(row => row.config.includes('search_path=""'))).toBe(true);
  await db.exec('set role anon');
  await expect(rpc('moneytrail_sms_set_merchant_rule', ['青禾馆', '购物', null])).rejects.toMatchObject({ code: '42501' });
  await expect(save()).rejects.toMatchObject({ code: '42501' });
  await expect(rpc('moneytrail_sms_confirm_with_rule', [A, {}, false])).rejects.toMatchObject({ code: '42501' });
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claims','{}',false)");
  await expect(save()).rejects.toMatchObject({ code: '42501' });
  await user();
  await db.query('update auth.users set email_confirmed_at=null where id=$1', [A]);
  await expect(rpc('moneytrail_sms_set_merchant_rule', ['青禾馆', '购物', null])).rejects.toMatchObject({ code: '42501' });
});
