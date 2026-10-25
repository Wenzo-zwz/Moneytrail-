import { PGlite } from '@electric-sql/pglite';
import { beforeAll, afterAll, beforeEach, it, expect } from 'vitest';
import cases from './merchantClassification.cases.json';
import { isPlatformOnlyMerchant } from './merchantClassification';
const migrations=import.meta.glob('../../supabase/migrations/*.sql',{query:'?raw',import:'default',eager:true}) as Record<string,string>;
const A='11111111-1111-4111-8111-111111111111', B='22222222-2222-4222-8222-222222222222';
let db:PGlite;
async function rpc(name:string,args:unknown[]=[]):Promise<any>{ return (await db.query<{r:any}>(`select public.${name}(${args.map((_,i)=>`$${i+1}`).join(',')}) r`,args)).rows[0].r; }
async function user(id=A){await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:id})]);}
const sms=(m:string,a='20')=>`尾号xxxx卡10月24日12:00支出(${m})${a}元，余额12,345.94元。【工商银行】`;
async function parse(m:string){return (await db.query<{r:any}>("select moneytrail_private.moneytrail_parse_icbc_sms($1,'2026-10-24T04:01:00Z','review') r",[sms(m)])).rows[0].r;}
async function pending(m:string,a='20',owner=A){return (await db.query<{id:string}>(`insert into moneytrail_private.sms_inbox(user_id,received_at,fingerprint,status,raw_text) values($1,'2026-10-24T04:01:00Z',repeat('a',64),'pending',$2) returning id`,[owner,sms(m,a)])).rows[0].id;}
beforeAll(async()=>{db=new PGlite();await db.exec(`create role anon nologin;create role authenticated nologin;create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz,deleted_at timestamptz);create function auth.uid() returns uuid language sql stable as $$select (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid$$;grant usage on schema public,auth to anon,authenticated;`);for(const path of Object.keys(migrations).sort())await db.exec(migrations[path]);},30000);
afterAll(async()=>{await db?.close();});
beforeEach(async()=>{await db.exec(`reset role;truncate auth.users cascade;insert into auth.users values('${A}','a@invalid',now(),null,null),('${B}','b@invalid',now(),null,null);`);await user();});
it('parses original nested tobacco amount independently of balance',async()=>{expect(await parse('消费财付通-烟酒副食(万达店)')).toMatchObject({draft:{amountCents:2000,category:'购物'},requires_review:false});});
it.each([['滴滴出行','交通'],['美团','待分类'],['美团大药房','医疗'],['美团酒店','居住'],['话费充值','居住'],['书店','学习'],['电影院','娱乐']])('classifies %s',async(m,c)=>{expect(await parse(m)).toMatchObject({draft:{category:c,kind:'expense'},requires_review:false});});
it.each(['财付通','快捷支付-财付通','群收款','转账-张三','商店(缺口','商店)缺口','商店20元','商店)30元支出(其他'])('keeps unsafe %s in review',async(m)=>{expect((await parse(m)).requires_review).toBe(true);});
it('normalizes fullwidth brackets and rejects extra event',async()=>{expect(await parse('消费财付通-烟酒副食（分店）')).toMatchObject({draft:{category:'购物'},requires_review:false});});
it('owns exact merchant rules and rejects generic descriptions',async()=>{expect(await rpc('moneytrail_sms_set_category_rule',['消费财付通-阿明店','餐饮'])).toEqual({rules:[{merchant:'阿明店',category:'餐饮'}]});await user(B);expect(await rpc('moneytrail_sms_category_rules')).toEqual({rules:[]});await user();for(const m of ['财付通','群收款','转账张三'])await expect(rpc('moneytrail_sms_set_category_rule',[m,'餐饮'])).rejects.toMatchObject({code:'22023'});await expect(rpc('moneytrail_sms_set_category_rule',['阿明店','非法'])).rejects.toMatchObject({code:'22023'});expect(await rpc('moneytrail_sms_set_category_rule',['阿明店',null])).toEqual({rules:[]});});
it('preview is read only; apply selected excludes new arrivals and retries safely',async()=>{const id=await pending('烟酒副食');await pending('滴滴出行','21');await pending('群收款','22');const before=(await db.query('select * from moneytrail_private.sms_inbox')).rows;const p=await rpc('moneytrail_sms_preview_pending');expect(p.recordable_count).toBe(2);expect((await db.query('select * from moneytrail_private.sms_inbox')).rows).toEqual(before);const selected=p.items.filter((i:any)=>i.id===id).map(({id,draft}:any)=>({id,draft}));await pending('新便利店','23');expect(await rpc('moneytrail_sms_apply_pending',[selected])).toEqual({recorded_count:1,pending_count:3});expect(await rpc('moneytrail_sms_apply_pending',[selected])).toEqual({recorded_count:0,pending_count:3});expect((await db.query<any>('select data from public.moneytrail_ledgers')).rows[0].data.transactions).toHaveLength(1);});
it('rejects stale altered and foreign selections atomically',async()=>{await pending('烟酒副食');const p=await rpc('moneytrail_sms_preview_pending');const s=p.items.map(({id,draft}:any)=>({id,draft}));await expect(rpc('moneytrail_sms_apply_pending',[[{...s[0],draft:{...s[0].draft,amountCents:1}}]])).rejects.toMatchObject({code:'40001'});await rpc('moneytrail_sms_set_category_rule',['烟酒副食','餐饮']);await expect(rpc('moneytrail_sms_apply_pending',[s])).rejects.toMatchObject({code:'40001'});await user(B);await expect(rpc('moneytrail_sms_apply_pending',[s])).rejects.toMatchObject({code:'42501'});expect((await db.query('select * from public.moneytrail_ledgers')).rows).toHaveLength(0);});
it('denies anonymous execution and private access',async()=>{await db.exec('set role anon');await expect(rpc('moneytrail_sms_category_rules')).rejects.toMatchObject({code:'42501'});await db.exec('reset role');expect((await db.query<{v:boolean}>("select has_schema_privilege('authenticated','moneytrail_private','USAGE') v")).rows[0].v).toBe(false);});

it.each(['微信零钱充值','支付宝余额充值','本人账户互转','信用卡还款'])('recognizes explicit funds flow %s',async m=>{expect(await parse(m)).toMatchObject({draft:{kind:'transfer',category:'待分类'},requires_review:false});});
it.each(['充值','支付宝充值','给张三转账','信用卡还款转账张三','微信零钱充值群收款'])('does not broaden funds whitelist %s',async m=>{expect((await parse(m)).requires_review).toBe(true);});
it('preserves review mode while explicit selected apply preserves budget and manual categories',async()=>{await rpc('moneytrail_sms_set_mode',['review']);const id=await pending('便利店');const initial={version:1,budgetCents:123456,billCheckedMonths:['2026-10','2026-09'],transactions:[{id:'manual',kind:'expense',amountCents:9000,date:'2026-10-24T12:00',merchant:'既有商店',category:'娱乐',source:'manual',note:'保留'}]};await rpc('save_moneytrail_ledger',[initial,0]);const p=await rpc('moneytrail_sms_preview_pending');expect((await db.query<any>('select data from public.moneytrail_ledgers')).rows[0].data).toEqual(initial);await rpc('moneytrail_sms_apply_pending',[p.items.filter((i:any)=>i.id===id).map(({id,draft}:any)=>({id,draft}))]);const d=(await db.query<any>('select data from public.moneytrail_ledgers')).rows[0].data;expect(d.budgetCents).toBe(initial.budgetCents);expect(d.transactions[0]).toEqual(initial.transactions[0]);expect(d.billCheckedMonths).toEqual(['2026-09']);expect((await rpc('moneytrail_sms_config')).mode).toBe('review');await expect(rpc('moneytrail_sms_reprocess_pending')).rejects.toMatchObject({code:'22023'});});
it('keeps late ledger duplicate pending and rejects duplicate selection',async()=>{await pending('便利店');const p=await rpc('moneytrail_sms_preview_pending');const s=p.items.map(({id,draft}:any)=>({id,draft}));await expect(rpc('moneytrail_sms_apply_pending',[[...s,...s]])).rejects.toMatchObject({code:'22023'});await rpc('save_moneytrail_ledger',[{version:1,budgetCents:1,billCheckedMonths:[],transactions:[{...s[0].draft,id:'manual',source:'manual'}]},0]);expect(await rpc('moneytrail_sms_apply_pending',[s])).toEqual({recorded_count:0,pending_count:1});expect((await db.query<any>('select data from public.moneytrail_ledgers')).rows[0].data.transactions).toHaveLength(1);});
it('uses personal rules during automatic intake and compatible reprocessing',async()=>{await rpc('moneytrail_sms_set_category_rule',['阿明店','学习']);const {token}=await rpc('moneytrail_sms_rotate',['auto']);const date=(await db.query<{d:string}>(`select to_char(now() at time zone 'Asia/Shanghai','FMMM月FMDD日HH24:MI') d`)).rows[0].d;expect((await rpc('moneytrail_receive_sms',[token,`尾号xxxx卡${date}支出(消费财付通-阿明店)33元。【工商银行】`])).status).toBe('recorded');await pending('阿明店','34');expect(await rpc('moneytrail_sms_reprocess_pending')).toEqual({recorded_count:1,pending_count:0});const tx=(await db.query<any>('select data from public.moneytrail_ledgers')).rows[0].data.transactions;expect(tx.map((t:any)=>t.category)).toEqual(['学习','学习']);});
it('enforces rules and selection caps, missing identity and inactive account',async()=>{await db.query(`insert into moneytrail_private.sms_category_rules(user_id,merchant,category) select $1,'商店'||n,'购物' from generate_series(1,200)n`,[A]);await expect(rpc('moneytrail_sms_set_category_rule',['新商店','购物'])).rejects.toMatchObject({code:'54000'});await expect(rpc('moneytrail_sms_apply_pending',[Array.from({length:201},()=>({id:A,draft:{}}))])).rejects.toMatchObject({code:'22023'});await db.query("select set_config('request.jwt.claims','{}',false)");await expect(rpc('moneytrail_sms_preview_pending')).rejects.toMatchObject({code:'42501'});await user();await db.query('update auth.users set email_confirmed_at=null where id=$1',[A]);await expect(rpc('moneytrail_sms_apply_pending',[[]])).rejects.toMatchObject({code:'42501'});});

it.each(cases)('SQL/TS shared category parity: $merchant',async ({merchant,category,review})=>{expect(await parse(merchant)).toMatchObject({draft:{category},requires_review:review});});

const platformOnlyMerchants = ['美团','美团平台','美团平台商户','美团网','美团支付','美团北京三快在线科技有限公司','美团北京三快在线科技有限公','北京三快在线科技有限公司','北京三快科技有限公司','消费财付通-美团支付','快捷支付-微信支付-美团平台','支付：美团网'];
it.each(platformOnlyMerchants)('records ordinary platform %s as uncategorized without review',async merchant=>{
  expect(await parse(merchant)).toMatchObject({draft:{category:'待分类',kind:'expense'},requires_review:false});
});
it.each(['按摩店','足浴店','足疗店','推拿店','SPA馆','剧本杀馆','密室逃脱','桌游馆','棋牌室'])('classifies clear recreation %s',async merchant=>{
  expect(await parse(merchant)).toMatchObject({draft:{category:'娱乐',kind:'expense'},requires_review:false});
});
it.each(['医院推拿','诊所按摩'])('preserves medical priority for %s',async merchant=>{
  expect(await parse(merchant)).toMatchObject({draft:{category:'医疗'},requires_review:false});
});
it.each([['Space咖啡','餐饮'],['Space商贸','待分类'],['SPA养生馆','娱乐'],['某某SPA','娱乐'],['ＳＰＡ','娱乐']])('uses ASCII word boundaries for SPA in %s',async(merchant,category)=>{
  expect(await parse(merchant)).toMatchObject({draft:{category},requires_review:false});
});
it('ignores legacy platform overrides but permits deleting them',async()=>{
  await db.query(`insert into moneytrail_private.sms_category_rules(user_id,merchant,category) values($1,'美团','餐饮'),($1,'北京三快在线科技有限公司','购物')`,[A]);
  for(const merchant of ['美团','美团支付-美团','北京三快在线科技有限公司']) {
    const result=(await db.query<{r:any}>(`select moneytrail_private.sms_parse_for_account($1,$2,'2026-10-24T04:01:00Z') r`,[A,sms(merchant)])).rows[0].r;
    expect(result).toMatchObject({draft:{category:'待分类'},requires_review:false});
  }
  await user(B);
  expect(await rpc('moneytrail_sms_category_rules')).toEqual({rules:[]});
  await rpc('moneytrail_sms_set_category_rule',['美团',null]);
  await user();
  expect((await rpc('moneytrail_sms_category_rules')).rules).toHaveLength(2);
  await rpc('moneytrail_sms_set_category_rule',['消费财付通-美团',null]);
  expect(await rpc('moneytrail_sms_set_category_rule',['北京三快在线科技有限公司',null])).toEqual({rules:[]});
  expect(await rpc('moneytrail_sms_set_category_rule',['美团支付',null])).toEqual({rules:[]});
});
it.each(platformOnlyMerchants)('rejects new permanent category for platform %s',async merchant=>{
  await expect(rpc('moneytrail_sms_set_category_rule',[merchant,'餐饮'])).rejects.toMatchObject({code:'22023'});
});
it('keeps exact purpose and store overrides available and isolated',async()=>{
  for(const merchant of ['美团外卖','美团酒店','美团买药','美团打车','美团便利店','三快棋牌室']) {
    await rpc('moneytrail_sms_set_category_rule',[merchant,'学习']);
    const result=(await db.query<{r:any}>(`select moneytrail_private.sms_parse_for_account($1,$2,'2026-10-24T04:01:00Z') r`,[A,sms(merchant)])).rows[0].r;
    expect(result).toMatchObject({draft:{category:'学习'},requires_review:false});
    const other=(await db.query<{r:any}>(`select moneytrail_private.sms_parse_for_account($1,$2,'2026-10-24T04:01:00Z') r`,[B,sms(merchant)])).rows[0].r;
    expect(other.draft.category).not.toBe('学习');
  }
});
it('automatic intake records platforms and recreation but preserves ambiguity and duplicate guards',async()=>{
  await db.query(`insert into moneytrail_private.sms_category_rules(user_id,merchant,category) values($1,'美团','餐饮')`,[A]);
  const {token}=await rpc('moneytrail_sms_rotate',['auto']);
  const date=(await db.query<{d:string}>(`select to_char(now() at time zone 'Asia/Shanghai','FMMM月FMDD日HH24:MI') d`)).rows[0].d;
  const message=(merchant:string,amount:number)=>`尾号xxxx卡${date}支出(${merchant})${amount}元。【工商银行】`;
  const recordable=[['美团','待分类'],['美团支付','待分类'],['消费财付通-北京三快在线科技有限公司','待分类'],['美团外卖','餐饮'],['美团酒店','居住'],['美团买药','医疗'],['美团打车','交通'],['足浴店','娱乐'],['SPA馆','娱乐'],['烟酒','购物']];
  for(const [index,[merchant]] of recordable.entries()) expect((await rpc('moneytrail_receive_sms',[token,message(merchant,40+index)])).status).toBe('recorded');
  const tx=(await db.query<any>('select data from public.moneytrail_ledgers where user_id=$1',[A])).rows[0].data.transactions;
  expect(tx.map((t:any)=>[t.merchant,t.category])).toEqual(recordable);
  for(const [index,merchant] of ['美团群收款','美团转账张三','美团退款','美团取消','美团未成功'].entries()) expect((await rpc('moneytrail_receive_sms',[token,message(merchant,100+index)])).status).toBe('pending');
  expect((await rpc('moneytrail_receive_sms',[token,message('美团',40)])).status).toBe('duplicate');
  expect((await db.query<any>('select data from public.moneytrail_ledgers where user_id=$1',[A])).rows[0].data.transactions).toHaveLength(recordable.length);
  expect((await db.query(`select id from moneytrail_private.sms_inbox where user_id=$1 and status='pending'`,[A])).rows).toHaveLength(5);
});
it.each([...platformOnlyMerchants,...cases.map(({merchant})=>merchant),'消费支付美团支付','消费美团支付-美团北京三快在线科技有限公','美团支付-美团外卖','三快','北京三快便利店','美团平台商户(店)','美团群收款','美团退款','美团转账','美团\n','美团\u007f',' '.repeat(201)+'美团'])('matches SQL/TS platform identity helper for %s',async merchant=>{
  const result=(await db.query<{r:boolean}>(`select moneytrail_private.sms_is_platform_only_merchant($1) r`,[merchant])).rows[0].r;
  expect(result).toBe(isPlatformOnlyMerchant(merchant));
});
it('keeps the new platform helper private and the rule RPC owner checked',async()=>{
  for(const role of ['anon','authenticated']) expect((await db.query<{r:boolean}>(`select has_function_privilege($1,'moneytrail_private.sms_is_platform_only_merchant(text)','EXECUTE') r`,[role])).rows[0].r).toBe(false);
  const functions=(await db.query<{proname:string;prosecdef:boolean;proconfig:string[]}>(`select proname,prosecdef,proconfig from pg_proc where oid in ('moneytrail_private.sms_is_platform_only_merchant(text)'::regprocedure,'moneytrail_private.sms_classify(text)'::regprocedure,'moneytrail_private.sms_parse_for_account(uuid,text,timestamptz)'::regprocedure,'public.moneytrail_sms_set_category_rule(text,text)'::regprocedure)`)).rows;
  for(const fn of functions) {
    expect(fn.proconfig).toContain('search_path=""');
    expect(fn.prosecdef).toBe(fn.proname==='moneytrail_sms_set_category_rule');
  }
  await db.exec('set role authenticated');
  expect(await rpc('moneytrail_sms_set_category_rule',['美团',null])).toEqual({rules:[]});
  await expect(rpc('moneytrail_sms_set_category_rule',['美团','餐饮'])).rejects.toMatchObject({code:'22023'});
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claims','{}',false)");
  await expect(rpc('moneytrail_sms_set_category_rule',['美团',null])).rejects.toMatchObject({code:'42501'});
});
