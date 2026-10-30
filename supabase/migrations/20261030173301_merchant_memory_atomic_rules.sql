-- Explicit merchant memory. Existing business rows and aliases are not rewritten.
begin;

alter table moneytrail_private.sms_category_rules add column subcategory text;
alter table moneytrail_private.sms_category_rules add constraint sms_category_rules_subcategory_check
  check (subcategory is null or (pg_catalog.char_length(subcategory) between 1 and 40 and subcategory ~ '[^[:space:]]'));

create or replace function moneytrail_private.sms_merchant_key(p_merchant text)
returns text language plpgsql immutable set search_path='' as $$
declare k text := pg_catalog.lower(pg_catalog.btrim(pg_catalog.normalize(p_merchant,'NFKC'))); previous text;
begin
 if k is null or pg_catalog.char_length(k)>200 then return ''; end if;
 loop
  previous:=k;
  k:=pg_catalog.regexp_replace(k,'^(消费|支付(?!宝)|付款)[-—:[:space:]]*','');
  k:=pg_catalog.regexp_replace(k,'^((快捷支付[-[:space:]]*)?(财付通|微信支付|微信|支付宝|美团支付|滴滴支付|抖音支付|银联商务|银联)|快捷支付)[-—:[:space:]]*','');
  k:=pg_catalog.btrim(k);
  exit when previous=k;
 end loop;
 if k ~ '[[:cntrl:]]' or k ~ '(群收款|退款|退回|冲正|撤销|失败|未成功|取消)'
   or pg_catalog.regexp_replace(k,'(手机|话费|流量)充值','','g') ~ '(转账|转出|转入|充值|提现|取现|取款|支取|还款|偿还|缴款|还贷|贷款|余额宝|零钱通|花呗|借呗|白条|网商贷|理财|基金|证券|买入|申购|赎回)' then return ''; end if;
 return k;
end; $$;

create or replace function moneytrail_private.sms_is_platform_only_merchant(p_merchant text)
returns boolean language plpgsql immutable set search_path='' as $$
declare k text; previous text;
begin
 if p_merchant is null or pg_catalog.char_length(p_merchant)>200 or p_merchant ~ '[[:cntrl:]]' then return false; end if;
 k:=pg_catalog.lower(pg_catalog.btrim(pg_catalog.normalize(p_merchant,'NFKC')));
 if pg_catalog.char_length(k)>200 or k ~ '[[:cntrl:]]' or k ~ '(群收款|退款|退回|冲正|撤销|失败|未成功|取消)'
  or pg_catalog.regexp_replace(k,'(手机|话费|流量)充值','','g') ~ '(转账|转出|转入|充值|提现|取现|取款|支取|还款|偿还|缴款|还贷|贷款|余额宝|零钱通|花呗|借呗|白条|网商贷|理财|基金|证券|买入|申购|赎回)' then return false; end if;
 loop
  if k in ('美团','美团平台','美团平台商户','美团网','美团支付','美团北京三快在线科技有限公司','美团北京三快在线科技有限公','北京三快在线科技有限公司','北京三快科技有限公司') then return true; end if;
  previous:=k;
  k:=pg_catalog.btrim(pg_catalog.regexp_replace(k,'^(消费|支付(?!宝)|付款)[-—:[:space:]]*',''));
  if k in ('美团','美团平台','美团平台商户','美团网','美团支付','美团北京三快在线科技有限公司','美团北京三快在线科技有限公','北京三快在线科技有限公司','北京三快科技有限公司') then return true; end if;
  k:=pg_catalog.btrim(pg_catalog.regexp_replace(k,'^((快捷支付[-[:space:]]*)?(财付通|微信支付|微信|支付宝|美团支付|滴滴支付|抖音支付|银联商务|银联)|快捷支付)[-—:[:space:]]*',''));
  exit when previous=k;
 end loop;
 return false;
end; $$;

create or replace function moneytrail_private.sms_can_remember_merchant(p_merchant text)
returns boolean language sql immutable set search_path='' as $$
 select coalesce(moneytrail_private.sms_merchant_key(p_merchant)<>''
  and not moneytrail_private.sms_is_platform_only_merchant(p_merchant)
  and moneytrail_private.sms_merchant_key(p_merchant) !~ '^(京东|京东商城|京东平台|淘宝|淘宝网|淘宝平台|天猫|天猫商城|天猫平台|拼多多|拼多多平台|滴滴|滴滴出行|抖音|抖音平台)$'
  and moneytrail_private.sms_merchant_key(p_merchant) !~ '^(待补充商户|待补充|未知商户|未知|不详|商户不详|未提供商户|未识别商户|无商户|[-—]+)$',false);
$$;

-- Prefer an exact canonical row over historical normalized aliases. Reads do not
-- merge competing aliases; an explicit save may replace aliases of that exact key.
create or replace function moneytrail_private.sms_upsert_merchant_rule(
 p_user uuid,p_merchant text,p_category text,p_subcategory text,p_preserve_detail boolean default false
)
returns void language plpgsql set search_path='' as $$
declare k text:=moneytrail_private.sms_merchant_key(p_merchant); normalized jsonb; prior jsonb;
begin
 if p_merchant is null or pg_catalog.char_length(p_merchant)>200 or p_merchant ~ '[[:cntrl:]]'
  or (p_category is not null and (not moneytrail_private.sms_can_remember_merchant(p_merchant)
    or p_category not in ('本地生活','餐饮','购物','交通','居住','医疗','娱乐','学习','其他')))
  or (p_subcategory is not null and (pg_catalog.char_length(p_subcategory)>40 or p_subcategory !~ '[^[:space:]]'))
 then raise exception using errcode='22023',message='Invalid merchant category rule.'; end if;
 if k='' then k:=pg_catalog.lower(pg_catalog.btrim(pg_catalog.normalize(p_merchant,'NFKC'))); end if;
 if k='' then raise exception using errcode='22023',message='Invalid merchant category rule.'; end if;
 normalized:=moneytrail_private.sms_normalize_transaction(pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object('category',p_category,'subcategory',p_subcategory)));
 if p_category is not null and p_preserve_detail then
  select moneytrail_private.sms_normalize_transaction(pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object('category',r.category,'subcategory',r.subcategory))) into prior
  from moneytrail_private.sms_category_rules r
  where r.user_id=p_user and moneytrail_private.sms_merchant_key(r.merchant)=k
  order by (r.merchant=k) desc,r.merchant limit 1;
  if prior->>'category'=normalized->>'category' and prior ? 'subcategory' then normalized:=normalized||pg_catalog.jsonb_build_object('subcategory',prior->'subcategory'); end if;
 end if;
 delete from moneytrail_private.sms_category_rules r where r.user_id=p_user
  and (r.merchant=k or moneytrail_private.sms_merchant_key(r.merchant)=k);
 if p_category is null then return; end if;
 if (select pg_catalog.count(*) from moneytrail_private.sms_category_rules where user_id=p_user)>=200 then
  raise exception using errcode='54000',message='Merchant rule limit reached.';
 end if;
 insert into moneytrail_private.sms_category_rules(user_id,merchant,category,subcategory)
 values(p_user,k,normalized->>'category',normalized->>'subcategory');
end; $$;

create or replace function public.moneytrail_sms_category_rules()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare caller uuid:=moneytrail_private.sms_require_account(); result jsonb;
begin
 select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('merchant',r.merchant)
  ||moneytrail_private.sms_normalize_transaction(pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object('category',r.category,'subcategory',r.subcategory))) order by r.merchant),'[]'::jsonb)
 into result from moneytrail_private.sms_category_rules r where r.user_id=caller;
 return pg_catalog.jsonb_build_object('rules',result);
end; $$;

create or replace function public.moneytrail_sms_set_merchant_rule(p_merchant text,p_category text,p_subcategory text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare caller uuid:=moneytrail_private.sms_require_account();
begin
 insert into moneytrail_private.sms_settings(user_id) values(caller) on conflict do nothing;
 perform 1 from moneytrail_private.sms_settings where user_id=caller for update;
 perform moneytrail_private.sms_upsert_merchant_rule(caller,p_merchant,p_category,p_subcategory);
 return public.moneytrail_sms_category_rules();
end; $$;

-- Preserve explicit detail for old category-only clients when category is unchanged.
create or replace function public.moneytrail_sms_set_category_rule(p_merchant text,p_category text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare caller uuid:=moneytrail_private.sms_require_account();
begin
 insert into moneytrail_private.sms_settings(user_id) values(caller) on conflict do nothing;
 perform 1 from moneytrail_private.sms_settings where user_id=caller for update;
 perform moneytrail_private.sms_upsert_merchant_rule(caller,p_merchant,p_category,null,true);
 return public.moneytrail_sms_category_rules();
end; $$;

create or replace function moneytrail_private.sms_parse_for_account(p_user uuid,p_text text,p_received timestamptz)
returns jsonb language plpgsql stable set search_path='' as $$
declare p jsonb; rule jsonb; draft jsonb; k text;
begin
 p:=moneytrail_private.moneytrail_parse_icbc_sms(p_text,p_received,'review');
 if p->'requires_review'='false'::jsonb and p#>>'{draft,kind}'='expense'
  and moneytrail_private.sms_can_remember_merchant(p#>>'{draft,merchant}') then
  k:=moneytrail_private.sms_merchant_key(p#>>'{draft,merchant}');
  select moneytrail_private.sms_normalize_transaction(pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object('category',r.category,'subcategory',r.subcategory))) into rule
  from moneytrail_private.sms_category_rules r
  where r.user_id=p_user and moneytrail_private.sms_merchant_key(r.merchant)=k
  order by (r.merchant=k) desc,r.merchant limit 1;
  if rule is not null then
   draft:=p->'draft';
   if rule->>'category'<>draft->>'category' or rule ? 'subcategory' then draft:=draft-'subcategory'; end if;
   draft:=draft||rule;
   draft:=pg_catalog.jsonb_set(draft,'{smsEvidence,classificationReason}',pg_catalog.to_jsonb('个人商户规则：'||(rule->>'category')));
   p:=pg_catalog.jsonb_set(p,'{draft}',draft);
  end if;
 end if;
 return p;
end; $$;

create or replace function public.save_moneytrail_ledger_with_rules(p_data jsonb,p_expected_revision bigint,p_rules jsonb)
returns setof public.moneytrail_ledgers language plpgsql security definer set search_path='' as $$
declare
 caller uuid:=moneytrail_private.sms_require_account(); prior public.moneytrail_ledgers%rowtype;
 saved public.moneytrail_ledgers%rowtype; item jsonb; incoming jsonb; original jsonb; normalized jsonb; matched jsonb; k text;
begin
 if p_rules is null or pg_catalog.jsonb_typeof(p_rules)<>'array' then raise exception using errcode='22023',message='Invalid merchant rule intents.'; end if;
 if pg_catalog.jsonb_array_length(p_rules)>200 or not public.moneytrail_valid_payload(p_data)
  or p_expected_revision is null or p_expected_revision<0 or p_expected_revision>=9007199254740991
 then raise exception using errcode='22023',message='Invalid ledger or merchant rule intents.'; end if;
 -- Same global account lock order as intake: settings before ledger.
 insert into moneytrail_private.sms_settings(user_id) values(caller) on conflict do nothing;
 perform 1 from moneytrail_private.sms_settings where user_id=caller for update;
 select * into prior from public.moneytrail_ledgers where user_id=caller for update;
 if (p_expected_revision=0 and prior.user_id is not null) or (p_expected_revision>0 and (prior.user_id is null or prior.revision<>p_expected_revision)) then
  raise exception using errcode='40001',message='Ledger changed on another device. Reload before saving.';
 end if;
 for item in select value from pg_catalog.jsonb_array_elements(p_rules) loop
  if pg_catalog.jsonb_typeof(item)<>'object' or item-array['transactionId','merchant','category','subcategory']<>'{}'::jsonb
   or pg_catalog.jsonb_typeof(item->'transactionId') is distinct from 'string'
   or pg_catalog.jsonb_typeof(item->'merchant') is distinct from 'string'
   or pg_catalog.jsonb_typeof(item->'category') is distinct from 'string'
   or (item ? 'subcategory' and pg_catalog.jsonb_typeof(item->'subcategory') is distinct from 'string')
   or not moneytrail_private.sms_valid_metadata(item)
   or item->>'category' not in ('本地生活','餐饮','购物','交通','居住','医疗','娱乐','学习','其他')
   or not moneytrail_private.sms_can_remember_merchant(item->>'merchant')
  then raise exception using errcode='22023',message='Invalid merchant rule intent.'; end if;
  if (select pg_catalog.count(*) from pg_catalog.jsonb_array_elements(p_rules) candidate where candidate->>'transactionId'=item->>'transactionId')<>1 then
   raise exception using errcode='22023',message='Duplicate merchant rule transaction.';
  end if;
  select value into incoming from pg_catalog.jsonb_array_elements(p_data->'transactions') where value->>'id'=item->>'transactionId';
  incoming:=moneytrail_private.sms_normalize_transaction(incoming);
  normalized:=moneytrail_private.sms_normalize_transaction(item);
  k:=moneytrail_private.sms_merchant_key(item->>'merchant');
  if incoming is null or incoming->>'kind'<>'expense' or not moneytrail_private.sms_can_remember_merchant(incoming->>'merchant')
   or moneytrail_private.sms_merchant_key(incoming->>'merchant')<>k
   or incoming->>'category' is distinct from normalized->>'category'
   or incoming->>'subcategory' is distinct from normalized->>'subcategory'
  then raise exception using errcode='22023',message='Merchant rule does not match incoming transaction.'; end if;
  select value into original from pg_catalog.jsonb_array_elements(prior.data->'transactions') where value->>'id'=item->>'transactionId';
  if original is not null and (original->>'kind'<>'expense' or not moneytrail_private.sms_can_remember_merchant(original->>'merchant') or moneytrail_private.sms_merchant_key(original->>'merchant')<>k) then
   raise exception using errcode='22023',message='Original transaction cannot establish this merchant rule.';
  end if;
  if exists(select 1 from pg_catalog.jsonb_array_elements(p_rules) other
   where moneytrail_private.sms_merchant_key(other->>'merchant')=k
    and ((moneytrail_private.sms_normalize_transaction(other)->>'category') is distinct from normalized->>'category'
      or (moneytrail_private.sms_normalize_transaction(other)->>'subcategory') is distinct from normalized->>'subcategory')) then
   raise exception using errcode='22023',message='Conflicting merchant rule intents.';
  end if;
 end loop;
 select * into saved from public.save_moneytrail_ledger(p_data,p_expected_revision);
 -- An absent detail on an explicit intent clears that detail. The old save RPC's
 -- metadata-preservation contract remains intact for ordinary/older callers.
 select coalesce(pg_catalog.jsonb_agg(case when rule.value is not null then
  (entry.value-'subcategory') || (moneytrail_private.sms_normalize_transaction(rule.value)-array['transactionId','merchant','category'])
  else entry.value end order by entry.ordinality),'[]'::jsonb) into matched
 from pg_catalog.jsonb_array_elements(saved.data->'transactions') with ordinality entry(value,ordinality)
 left join lateral(select value from pg_catalog.jsonb_array_elements(p_rules) where value->>'transactionId'=entry.value->>'id') rule on true;
 -- Re-resolve only new/changed refund links after explicit detail clears. Older
 -- unchanged links keep deliberate manual edits and each refund keeps its receipt.
 select coalesce(pg_catalog.jsonb_agg(
  case when entry.value->>'kind'='refund' and entry.value ? 'linkedTransactionId'
   and (old_tx.value->>'kind' is distinct from 'refund'
    or old_tx.value->>'linkedTransactionId' is distinct from entry.value->>'linkedTransactionId')
  then (entry.value-array['category','subcategory','platform'])
   ||pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'category',source_tx.value->'category','subcategory',source_tx.value->'subcategory','platform',source_tx.value->'platform'))
  else entry.value end order by entry.ordinality),'[]'::jsonb) into matched
 from pg_catalog.jsonb_array_elements(matched) with ordinality entry(value,ordinality)
 left join lateral(select value from pg_catalog.jsonb_array_elements(prior.data->'transactions') where value->>'id'=entry.value->>'id') old_tx on true
 left join lateral(select value from pg_catalog.jsonb_array_elements(matched) where value->>'id'=entry.value->>'linkedTransactionId' and value->>'kind'='expense') source_tx on true;
 saved.data:=pg_catalog.jsonb_set(saved.data,'{transactions}',matched);
 if not public.moneytrail_valid_payload(saved.data) then raise exception using errcode='22023',message='Invalid saved merchant snapshot.'; end if;
 update public.moneytrail_ledgers set data=saved.data where user_id=caller;
 for item in select value from pg_catalog.jsonb_array_elements(p_rules) loop
  perform moneytrail_private.sms_upsert_merchant_rule(caller,item->>'merchant',item->>'category',item->>'subcategory');
 end loop;
 return next saved;
end; $$;

create or replace function public.moneytrail_sms_confirm_with_rule(p_id uuid,p_draft jsonb,p_remember boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
declare caller uuid:=moneytrail_private.sms_require_account(); entry moneytrail_private.sms_inbox%rowtype; original jsonb; result jsonb;
begin
 if p_remember is null then raise exception using errcode='22023',message='Invalid remember choice.'; end if;
 insert into moneytrail_private.sms_settings(user_id) values(caller) on conflict do nothing;
 perform 1 from moneytrail_private.sms_settings where user_id=caller for update;
 select inbox.* into entry from moneytrail_private.sms_inbox inbox where inbox.user_id=caller and inbox.id=p_id for update;
 if entry.id is null then raise exception using errcode='42501',message='SMS entry is unavailable.'; end if;
 -- A recorded retry must neither replace its rule nor validate the stale draft.
 if entry.status='recorded' then return public.moneytrail_sms_confirm(p_id,p_draft); end if;
 if p_remember then
  original:=moneytrail_private.moneytrail_parse_icbc_sms(entry.raw_text,entry.received_at,'review');
  if entry.status<>'pending' or original->'requires_review' is distinct from 'false'::jsonb
   or original#>>'{draft,kind}' is distinct from 'expense'
   or not moneytrail_private.sms_can_remember_merchant(original#>>'{draft,merchant}')
   or p_draft->>'kind' is distinct from 'expense'
   or not moneytrail_private.sms_can_remember_merchant(p_draft->>'merchant')
   or moneytrail_private.sms_merchant_key(original#>>'{draft,merchant}')<>moneytrail_private.sms_merchant_key(p_draft->>'merchant')
   or p_draft->>'category' is null or p_draft->>'category' not in ('本地生活','餐饮','购物','交通','居住','医疗','娱乐','学习','其他')
  then raise exception using errcode='22023',message='Original SMS cannot establish this merchant rule.'; end if;
 end if;
 -- Reuse the existing owner/metadata validation and receipt evidence rebuild.
 result:=public.moneytrail_sms_confirm(p_id,p_draft);
 if p_remember then perform moneytrail_private.sms_upsert_merchant_rule(caller,p_draft->>'merchant',p_draft->>'category',p_draft->>'subcategory'); end if;
 return result;
end; $$;

revoke all on function moneytrail_private.sms_merchant_key(text) from public,anon,authenticated;
revoke all on function moneytrail_private.sms_is_platform_only_merchant(text) from public,anon,authenticated;
revoke all on function moneytrail_private.sms_can_remember_merchant(text) from public,anon,authenticated;
revoke all on function moneytrail_private.sms_upsert_merchant_rule(uuid,text,text,text,boolean) from public,anon,authenticated;
revoke all on function moneytrail_private.sms_parse_for_account(uuid,text,timestamptz) from public,anon,authenticated;
revoke all on function public.moneytrail_sms_category_rules() from public,anon,authenticated;
revoke all on function public.moneytrail_sms_set_category_rule(text,text) from public,anon,authenticated;
revoke all on function public.moneytrail_sms_set_merchant_rule(text,text,text) from public,anon,authenticated;
revoke all on function public.save_moneytrail_ledger_with_rules(jsonb,bigint,jsonb) from public,anon,authenticated;
revoke all on function public.moneytrail_sms_confirm_with_rule(uuid,jsonb,boolean) from public,anon,authenticated;
grant execute on function public.moneytrail_sms_category_rules() to authenticated;
grant execute on function public.moneytrail_sms_set_category_rule(text,text) to authenticated;
grant execute on function public.moneytrail_sms_set_merchant_rule(text,text,text) to authenticated;
grant execute on function public.save_moneytrail_ledger_with_rules(jsonb,bigint,jsonb) to authenticated;
grant execute on function public.moneytrail_sms_confirm_with_rule(uuid,jsonb,boolean) to authenticated;
notify pgrst,'reload schema';
commit;
