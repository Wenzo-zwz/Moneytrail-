import { validateSmsEvidence } from './ledger';
import { redactSmsEvidence } from './smsEvidence';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, afterAll, beforeEach, it, expect } from 'vitest';
const migrations=import.meta.glob('../../supabase/migrations/*.sql',{query:'?raw',import:'default',eager:true}) as Record<string,string>;
const A='11111111-1111-4111-8111-111111111111', B='22222222-2222-4222-8222-222222222222';
let db:PGlite; let date:string;
async function rpc(name:string,args:unknown[]=[]):Promise<any>{return (await db.query<{r:any}>(`select public.${name}(${args.map((_,i)=>`$${i+1}`).join(',')}) r`,args)).rows[0].r;}
async function user(id=A){await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:id})]);}
const sms=(merchant='美团',amount='20')=>`尾号１２３４卡${date}支出(${merchant})${amount}元，余额１２，３４５．９４元。【工商银行】`;
async function ledger(){return (await db.query<any>('select data,revision::integer from public.moneytrail_ledgers where user_id=$1',[A])).rows[0];}
const payload=(transactions:any[])=>({version:1,budgetCents:0,billCheckedMonths:[],transactions});
async function save(transactions: any[], revision: number) {
  return (await db.query<{ saved: any }>('select row_to_json(saved) saved from public.save_moneytrail_ledger($1::jsonb,$2::bigint) saved', [payload(transactions), revision])).rows[0].saved;
}
const tx={id:'manual',kind:'expense',amountCents:1000,date:'2026-10-25T12:00',merchant:'美团',category:'本地生活',source:'manual',note:''};
beforeAll(async()=>{db=new PGlite();await db.exec(`create role anon nologin;create role authenticated nologin;create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz,deleted_at timestamptz);create function auth.uid() returns uuid language sql stable as $$select (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid$$;grant usage on schema public,auth to anon,authenticated;`);for(const path of Object.keys(migrations).sort())await db.exec(migrations[path]);date=(await db.query<{d:string}>(`select to_char(now() at time zone 'Asia/Shanghai','FMMM月FMDD日HH24:MI') d`)).rows[0].d;},30000);
afterAll(async()=>{await db?.close();});
beforeEach(async()=>{await db.exec(`reset role;truncate auth.users cascade;insert into auth.users values('${A}','a@invalid',now(),null,null),('${B}','b@invalid',now(),null,null);`);await user();});
function evidence(t:any,merchant='美团') {expect(t.smsEvidence.text).toContain(merchant);expect(t.smsEvidence.text).toContain('工商银行');expect(t.smsEvidence.text).not.toMatch(/1234|１２３４|12,345|１２，３４５/);expect(t.smsEvidence.classificationReason).toBeTruthy();expect(t.smsEvidence.ruleVersion).toBeTruthy();expect(new Date(t.smsEvidence.receivedAt).getTime()).not.toBeNaN();}
it('records auto receipts before purging raw, preserves after cleanup, and isolates owners',async()=>{const {token}=await rpc('moneytrail_sms_rotate',['auto']);const result=await rpc('moneytrail_receive_sms',[token,sms()]);expect(result.status).toBe('recorded');const saved=await ledger();expect(saved.data.transactions[0]).toMatchObject({category:'本地生活',platform:'美团'});evidence(saved.data.transactions[0]);expect(saved.data.transactions[0].subcategory).toBeUndefined();expect((await db.query<any>('select raw_text from moneytrail_private.sms_inbox')).rows[0].raw_text).toBeNull();expect((await rpc('moneytrail_receive_sms',[token,sms()])).status).toBe('duplicate');await db.exec("update moneytrail_private.sms_inbox set received_at=now()-interval '31 days'");await rpc('moneytrail_receive_sms',[token,sms('京东','21')]);expect((await db.query<any>('select count(*)::integer n from moneytrail_private.sms_inbox')).rows[0].n).toBe(1);expect((await ledger()).data.transactions[0]).toEqual(saved.data.transactions[0]);await user(B);await db.exec('set role authenticated');expect((await db.query('select * from public.moneytrail_ledgers')).rows).toEqual([]);await expect(rpc('moneytrail_sms_confirm',[result.id,tx])).rejects.toMatchObject({code:'42501'});});
it.each(['confirm','selected','reprocess'])('retains server receipt via %s and leaves unclear transfers pending',async path=>{const {token}=await rpc('moneytrail_sms_rotate',['review']);const result=await rpc('moneytrail_receive_sms',[token,sms('美团按摩','25')]);const unclear=await rpc('moneytrail_receive_sms',[token,sms('转账张三','26')]);const inbox=(await rpc('moneytrail_sms_inbox')).items;const entry=inbox.find((x:any)=>x.id===result.id);if(path==='confirm'){await rpc('moneytrail_sms_confirm',[result.id,{...entry.draft,smsEvidence:{text:'forged'},category:'学习'}]);}else if(path==='selected'){const p=await rpc('moneytrail_sms_preview_pending');const items=p.items.filter((x:any)=>x.id===result.id).map(({id,draft}:any)=>({id,draft}));await rpc('moneytrail_sms_apply_pending',[items]);await rpc('moneytrail_sms_apply_pending',[items]);}else{await rpc('moneytrail_sms_set_mode',['auto']);await rpc('moneytrail_sms_reprocess_pending');await rpc('moneytrail_sms_reprocess_pending');}const saved=await ledger();expect(saved.data.transactions).toHaveLength(1);evidence(saved.data.transactions[0],'美团按摩');if(path==='confirm'){expect(saved.data.transactions[0].category).toBe('学习');expect(saved.data.transactions[0].smsEvidence.classificationReason).toContain('学习');}const remaining=(await rpc('moneytrail_sms_inbox')).items.find((x:any)=>x.id===unclear.id);expect(remaining.status).toBe('pending');expect(remaining.raw_text).toBeTruthy();await rpc('moneytrail_sms_dismiss',[unclear.id]);expect((await ledger()).data.transactions).toHaveLength(1);});
it('preserves optional metadata for same IDs from legacy saves without resurrecting deleted entries or bypassing CAS',async()=>{const meta={subcategory:'按摩足疗',platform:'美团',smsEvidence:{text:'尾号****卡支出20元，余额[已隐藏]元。【工商银行】',receivedAt:'2026-10-25T04:00:00Z',classificationReason:'人工确认',ruleVersion:'local-life-v1'}};await rpc('save_moneytrail_ledger',[payload([{...tx,...meta},{...tx,id:'delete-me'}]),0]);await rpc('save_moneytrail_ledger',[payload([{...tx,note:'edited'}]),1]);expect((await ledger()).data.transactions).toEqual([{...tx,...meta,note:'edited'}]);await expect(rpc('save_moneytrail_ledger',[payload([]),1])).rejects.toMatchObject({code:'PT409'});await rpc('save_moneytrail_ledger',[payload([{...tx,subcategory:'未细分'}]),2]);expect((await ledger()).data.transactions[0]).toMatchObject({...meta,subcategory:'未细分'});await rpc('save_moneytrail_ledger',[payload([]),3]);expect((await ledger()).data.transactions).toEqual([]);});
it.each([
  { refundFirst: false, previouslyLinked: false }, { refundFirst: true, previouslyLinked: false },
  { refundFirst: false, previouslyLinked: true }, { refundFirst: true, previouslyLinked: true },
])('clears stale refund detail/platform when linking to an unknown original: %j', async ({ refundFirst, previouslyLinked }) => {
  const original = { ...tx, id: 'original', category: '购物', smsEvidence: { text: '原消费凭据' } };
  const previous = { ...tx, id: 'previous', subcategory: '按摩足疗', platform: '美团' };
  const ownEvidence = { text: '退款凭据' };
  const refund = { ...tx, id: 'refund', kind: 'refund', subcategory: '按摩足疗', platform: '美团', smsEvidence: ownEvidence, ...(previouslyLinked ? { linkedTransactionId: previous.id } : {}) };
  await rpc('save_moneytrail_ledger', [payload([original, previous, refund, { ...tx, id: 'delete-me' }]), 0]);
  // The editor copies the original's missing fields; JSON drops those undefined properties.
  const editedRefund = { ...refund, category: original.category, linkedTransactionId: original.id, subcategory: undefined, platform: undefined };
  const incoming = JSON.parse(JSON.stringify(refundFirst ? [editedRefund, original] : [original, editedRefund]));
  const result = await save(incoming, 1);
  const savedRefund = result.data.transactions.find((entry: any) => entry.id === refund.id);
  expect(savedRefund).toEqual({ ...tx, id: 'refund', kind: 'refund', category: '购物', linkedTransactionId: original.id, smsEvidence: ownEvidence });
  expect(result.data.transactions).toHaveLength(2);
  expect(await ledger()).toEqual({ data: result.data, revision: 2 });
  await expect(rpc('save_moneytrail_ledger', [payload([original, previous, refund]), 1])).rejects.toMatchObject({ code: 'PT409' });
  expect(await ledger()).toEqual({ data: result.data, revision: 2 });
});
it('derives changed refund links from the canonical incoming original without copying its receipt', async () => {
  const first = { ...tx, id: 'first', subcategory: '按摩足疗', platform: '美团', smsEvidence: { text: '第一笔消费凭据' } };
  const second = { ...tx, id: 'second', category: '购物', smsEvidence: { text: '第二笔消费凭据' } };
  const refund = { ...tx, id: 'refund', kind: 'refund', linkedTransactionId: first.id, smsEvidence: { text: '退款自己的凭据' } };
  const receiptlessRefund = { ...tx, id: 'receiptless-refund', kind: 'refund', linkedTransactionId: first.id };
  const created = await save([first, second, refund, receiptlessRefund], 0);
  expect(created.data.transactions[3]).toEqual({ ...receiptlessRefund, subcategory: '按摩足疗', platform: '美团' });
  const changedOriginal = { ...second, category: '餐饮', platform: '京东' };
  const relinked = { ...refund, linkedTransactionId: second.id };
  let result = await save([relinked, first, changedOriginal], 1);
  expect(result.data.transactions[0]).toEqual({ ...relinked, category: '本地生活', subcategory: '餐饮', platform: '京东' });
  // An unchanged association permits a deliberate manual category/detail edit and legacy metadata omission.
  const manualEdit = { ...relinked, category: '学习', subcategory: '课程培训' };
  result = await save([manualEdit, first, changedOriginal], 2);
  expect(result.data.transactions[0]).toEqual({ ...manualEdit, platform: '京东' });
  result = await save([{ ...relinked, category: '学习' }, first, changedOriginal], 3);
  expect(result.data.transactions[0]).toEqual({ ...manualEdit, platform: '京东' });
});
it('normalizes legacy categories during save and validates optional nested fields strictly',async()=>{await rpc('save_moneytrail_ledger',[payload([{...tx,category:'餐饮'}]),0]);expect((await ledger()).data.transactions[0]).toMatchObject({category:'本地生活',subcategory:'餐饮'});for(const extra of [{subcategory:''},{subcategory:'x'.repeat(41)},{platform:'抖音'},{smsEvidence:null},{smsEvidence:{text:''}},{smsEvidence:{text:'x',unexpected:1}},{smsEvidence:{text:'x',receivedAt:'yesterday'}},{smsEvidence:{text:'x',ruleVersion:'x'.repeat(65)}}])await expect(rpc('save_moneytrail_ledger',[payload([{...tx,...extra}]),1])).rejects.toMatchObject({code:'22023'});});

it.each([
 '银行卡（１２３４）支出20元，余额12,345.94元',
 '尾号1234卡10月25日12:00支出(美团外卖)20元，余额12,345.94元。【工商银行】',
 '尾号１２３４卡支出20元，余额１２，３４５．９４元。【工商银行】',
 '尾号8x**卡支出20元，余额8x,***.x*元。【工商银行】',
 '卡号为6222 1234 5678 9999支出20元，账户余额人民币12,345.94元',
 '1234的储蓄卡支出20元，可用额度RMB-1,234.56元',
 '末四位：１２３４卡支出20元，可用余额为1 234.56元',
 '账号****1234支出20元，剩余金额：CNY1,234.56元'
])('redacts card/balance identically to TS while retaining debit: %s',async text=>{const r=(await db.query<{r:string}>('select moneytrail_private.sms_mask_evidence($1) r',[text])).rows[0].r;expect(r).toBe(redactSmsEvidence(text));expect(r).toContain('20元');expect(r).not.toMatch(/1234|12,345|1,234|１２３４/);expect((await db.query<{r:string}>('select moneytrail_private.sms_mask_evidence($1) r',[r])).rows[0].r).toBe(r);});
it.each(['于', '在', '支出', '消费', '支付', '付款', '扣款', '退款', '转账', '，'])('masks bare card numbers before %s with TS/SQL parity and preserves kart merchant digits', async event => {
  const raw = `您卡１２３４${event}2026-10-25 12:00在1234卡丁车乐园支出20元，余额100元。【工商银行】`;
  const masked = (await db.query<{ r: string }>('select moneytrail_private.sms_mask_evidence($1) r', [raw])).rows[0].r;
  expect(masked).toBe(redactSmsEvidence(raw));
  expect(masked).toContain(`您卡[已隐藏]${event.normalize('NFKC')}`);
  expect(masked).toContain('2026-10-25 12:00在1234卡丁车乐园支出20元');
  expect(masked).toContain('余额[已隐藏]元');
  expect((await db.query<{ r: string }>('select moneytrail_private.sms_mask_evidence($1) r', [masked])).rows[0].r).toBe(masked);
});
it('uses original receipt time and personal rule reason, clearing incompatible detail',async()=>{await rpc('moneytrail_sms_set_category_rule',['美团按摩','学习']);const {token}=await rpc('moneytrail_sms_rotate',['review']);const received=await rpc('moneytrail_receive_sms',[token,sms('美团按摩')]);const original=(await db.query<any>('select received_at from moneytrail_private.sms_inbox where id=$1',[received.id])).rows[0].received_at;const preview=await rpc('moneytrail_sms_preview_pending');expect(preview.items[0].draft.subcategory).toBeUndefined();expect(preview.items[0].draft.category).toBe('学习');await rpc('moneytrail_sms_apply_pending',[preview.items.map(({id,draft}:any)=>({id,draft}))]);const t=(await ledger()).data.transactions[0];expect(new Date(t.smsEvidence.receivedAt).getTime()).toBe(new Date(original).getTime());expect(t.smsEvidence.classificationReason).toContain('学习');await rpc('moneytrail_sms_set_category_rule',['美团按摩','本地生活']);expect((await rpc('moneytrail_sms_category_rules')).rules[0].category).toBe('本地生活');});
it('allows optional-field maximum sizes and rejects draft unknown keys',async()=>{const maximum={...tx,subcategory:'x'.repeat(40),platform:'美团',smsEvidence:{text:'x'.repeat(3000),classificationReason:'x'.repeat(200),ruleVersion:'x'.repeat(64),receivedAt:'2026-10-25T12:00:00+08:00'}};await rpc('save_moneytrail_ledger',[payload([maximum]),0]);expect((await ledger()).data.transactions).toEqual([maximum]);const {token}=await rpc('moneytrail_sms_rotate',['review']);const result=await rpc('moneytrail_receive_sms',[token,sms()]);const draft=(await rpc('moneytrail_sms_inbox')).items[0].draft;await expect(rpc('moneytrail_sms_confirm',[result.id,{...draft,unexpected:true}])).rejects.toMatchObject({code:'22023'});await expect(rpc('moneytrail_sms_confirm',[result.id,{...draft,smsEvidence:{text:'x',extra:1}}])).rejects.toMatchObject({code:'22023'});});
it('preserves the old ledger when merged receipt size exceeds the snapshot cap',async()=>{const entries=Array.from({length:1450},(_,i)=>({...tx,id:String(i),smsEvidence:{text:'x'.repeat(3000)}}));await rpc('save_moneytrail_ledger',[payload(entries),0]);const old=await ledger();const incoming=entries.map(({smsEvidence:_,...entry})=>({...entry,note:'x'.repeat(1000)}));await expect(rpc('save_moneytrail_ledger',[payload(incoming),1])).rejects.toMatchObject({code:'22023'});expect(await ledger()).toEqual(old);});
it('does not invent evidence for historical entries with no surviving raw SMS',async()=>{await rpc('save_moneytrail_ledger',[payload([{...tx,category:'娱乐'}]),0]);expect((await ledger()).data.transactions[0]).toEqual({...tx,category:'本地生活',subcategory:'休闲娱乐'});});
it('keeps new helpers private and fixes their search paths',async()=>{for(const signature of ['sms_mask_evidence(text)','sms_evidence(text,timestamptz,text)','sms_normalize_transaction(jsonb)','sms_valid_metadata(jsonb)']){for(const role of ['anon','authenticated'])expect((await db.query<{r:boolean}>("select has_function_privilege($1,$2,'EXECUTE') r",[role,`moneytrail_private.${signature}`])).rows[0].r).toBe(false);expect((await db.query<{r:string[]}>('select proconfig r from pg_proc where oid=$1::regprocedure',[`moneytrail_private.${signature}`])).rows[0].r).toContain('search_path=""');}});

it('migration DDL leaves existing ledger, inbox and category-rule rows byte-for-byte unchanged',async()=>{await rpc('save_moneytrail_ledger',[payload([tx]),0]);await rpc('moneytrail_sms_set_category_rule',['示例店','餐饮']);const {token}=await rpc('moneytrail_sms_rotate',['review']);await rpc('moneytrail_receive_sms',[token,sms('转账张三')]);const read=async()=>Promise.all(['public.moneytrail_ledgers','moneytrail_private.sms_inbox','moneytrail_private.sms_category_rules'].map(async table=>(await db.query(`select row_to_json(t)::text value from ${table} t`)).rows));const before=await read();const path=Object.keys(migrations).find(p=>p.endsWith('_local_life_receipts.sql'))!;await db.exec(migrations[path]);expect(await read()).toEqual(before);});
it.each([
  '2026-10-25T12:00:60Z',
  '2026-10-25T24:00:00Z',
  '2026-10-25T12:00:00.1234567Z',
  '2026-02-30T12:00:00Z',
])('rejects frontend-invalid evidence timestamp %s in metadata and snapshot saves', async receivedAt => {
  const smsEvidence = { text: '脱敏凭据', receivedAt };
  expect(validateSmsEvidence(smsEvidence)).toBe(false);
  const result = (await db.query<{ valid: boolean }>('select moneytrail_private.sms_valid_metadata($1::jsonb) valid', [{ ...tx, smsEvidence }])).rows[0];
  expect(result.valid).toBe(false);
  await rpc('save_moneytrail_ledger', [payload([tx]), 0]);
  const before = await ledger();
  await expect(rpc('save_moneytrail_ledger', [payload([{ ...tx, smsEvidence }]), 1])).rejects.toMatchObject({ code: '22023' });
  expect(await ledger()).toEqual(before);
});
it.each(['2026-10-25T23:59:59.123456Z', '2026-10-25T00:00:00+08:00'])('accepts shared valid evidence timestamp %s', async receivedAt => {
  const smsEvidence = { text: '脱敏凭据', receivedAt };
  expect(validateSmsEvidence(smsEvidence)).toBe(true);
  expect((await db.query<{ valid: boolean }>('select moneytrail_private.sms_valid_metadata($1::jsonb) valid', [{ ...tx, smsEvidence }])).rows[0].valid).toBe(true);
  await rpc('save_moneytrail_ledger', [payload([{ ...tx, smsEvidence }]), 0]);
  expect((await ledger()).data.transactions[0].smsEvidence).toEqual(smsEvidence);
});
it.each(['信用卡', '储蓄卡', '借记卡', '银行卡', '账户', '卡'])('masks bare %s identifiers through unknown-format intake and manual confirmation', async label => {
  const { token } = await rpc('moneytrail_sms_rotate', ['review']);
  const raw = `您${label}1234于2026-10-25 12:00在1234卡丁车乐园支出20元，余额12,345.94元。【工商银行】`;
  const received = await rpc('moneytrail_receive_sms', [token, raw]);
  expect(received.status).toBe('pending');
  expect((await rpc('moneytrail_sms_inbox')).items[0].draft).toBeNull();
  await rpc('moneytrail_sms_confirm', [received.id, {kind:'expense', amountCents:2000, date:'2026-10-25T12:00', merchant:'1234卡丁车乐园', category:'本地生活', source:'sms', note:''}]);
  const receipt = (await ledger()).data.transactions[0].smsEvidence.text;
  expect(receipt).toContain(`您${label}[已隐藏]于2026-10-25 12:00`);
  expect(receipt).toContain('1234卡丁车乐园支出20元');
  expect(receipt).toContain('余额[已隐藏]元');
  expect(receipt).toContain('【工商银行】');
  expect(receipt).toBe(redactSmsEvidence(raw));
  expect((await db.query<any>('select raw_text from moneytrail_private.sms_inbox where id=$1',[received.id])).rows[0].raw_text).toBeNull();
});
