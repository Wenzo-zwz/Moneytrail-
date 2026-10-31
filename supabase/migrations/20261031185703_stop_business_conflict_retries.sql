-- Business conflicts must return immediately. SQLSTATE 40001 makes PostgREST 14
-- retry a stale request indefinitely; PT409 returns HTTP 409 without that retry.
-- Preserve compare-and-swap, permissions, lock order and all existing data.
begin;

CREATE OR REPLACE FUNCTION moneytrail_private.sms_append(p_user uuid, p_transaction jsonb, p_check_duplicates boolean DEFAULT false)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  snapshot public.moneytrail_ledgers%rowtype;
  next_data jsonb;
  checked jsonb;
  existing jsonb;
begin
  next_data := pg_catalog.jsonb_build_object('version', 1, 'transactions', pg_catalog.jsonb_build_array(p_transaction), 'budgetCents', 0, 'billCheckedMonths', '[]'::jsonb);
  if not public.moneytrail_valid_payload(next_data) then
    raise exception using errcode = '22023', message = 'Invalid SMS transaction.';
  end if;
  insert into public.moneytrail_ledgers(user_id, data, revision, updated_at)
    values(p_user, next_data, 1, pg_catalog.clock_timestamp()) on conflict (user_id) do nothing
    returning * into snapshot;
  if snapshot.user_id is not null then return true; end if;
  select ledger.* into snapshot from public.moneytrail_ledgers as ledger where ledger.user_id = p_user for update;
  select entry.value into existing from pg_catalog.jsonb_array_elements(snapshot.data -> 'transactions') as entry(value)
    where entry.value ->> 'id' = p_transaction ->> 'id';
  if existing is not null then
    if existing = p_transaction then return true; end if;
    raise exception using errcode = 'PT409', message = 'SMS transaction ID already exists with different content.';
  end if;
  if p_check_duplicates and exists (
    select 1 from pg_catalog.jsonb_array_elements(snapshot.data -> 'transactions') as candidate(value)
    where candidate.value ->> 'kind' = p_transaction ->> 'kind'
      and candidate.value -> 'amountCents' = p_transaction -> 'amountCents'
      and pg_catalog.abs(pg_catalog.date_part('epoch', (candidate.value ->> 'date')::timestamp - (p_transaction ->> 'date')::timestamp)) <= 600
  ) then
    return false;
  end if;
  select coalesce(pg_catalog.jsonb_agg(month.value), '[]'::jsonb) into checked
    from pg_catalog.jsonb_array_elements(snapshot.data -> 'billCheckedMonths') as month(value)
    where month.value #>> '{}' <> pg_catalog.left(p_transaction ->> 'date', 7);
  next_data := pg_catalog.jsonb_set(pg_catalog.jsonb_set(snapshot.data, '{transactions}', (snapshot.data -> 'transactions') || pg_catalog.jsonb_build_array(p_transaction)), '{billCheckedMonths}', checked);
  if snapshot.revision >= 9007199254740991 or not public.moneytrail_valid_payload(next_data) then
    raise exception using errcode = '22023', message = 'Ledger is too large or invalid for another SMS transaction.';
  end if;
  update public.moneytrail_ledgers set data = next_data, revision = snapshot.revision + 1, updated_at = pg_catalog.clock_timestamp() where user_id = p_user;
  return true;
end;
$function$;

CREATE OR REPLACE FUNCTION public.moneytrail_sms_apply_pending(p_items jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare caller uuid:=moneytrail_private.sms_require_account(); item jsonb; entry moneytrail_private.sms_inbox%rowtype; p jsonb; txid text; n integer:=0; total integer;
begin
 if p_items is null or pg_catalog.jsonb_typeof(p_items)<>'array' then raise exception using errcode='22023',message='Invalid SMS selection.'; end if;
 if pg_catalog.jsonb_array_length(p_items)>200 then raise exception using errcode='22023',message='At most 200 SMS entries may be selected.'; end if;
 if exists(select 1 from pg_catalog.jsonb_array_elements(p_items) i where pg_catalog.jsonb_typeof(i)<>'object' or not(i ? 'id' and i ? 'draft') or i-array['id','draft']<>'{}'::jsonb or pg_catalog.jsonb_typeof(i->'id')<>'string' or (i->>'id')!~'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') then raise exception using errcode='22023',message='Invalid SMS selection.'; end if;
 if (select count(distinct (i->>'id')::uuid) from pg_catalog.jsonb_array_elements(p_items) i)<>pg_catalog.jsonb_array_length(p_items) then raise exception using errcode='22023',message='Duplicate SMS selection.'; end if;
 insert into moneytrail_private.sms_settings(user_id) values(caller) on conflict do nothing;
 perform 1 from moneytrail_private.sms_settings where user_id=caller for update;
 -- Lock every selected inbox before touching the ledger, in a consistent order.
 perform 1 from moneytrail_private.sms_inbox where user_id=caller and id in(select (i->>'id')::uuid from pg_catalog.jsonb_array_elements(p_items)i) order by received_at,id for update;
 for item in select i from pg_catalog.jsonb_array_elements(p_items)i loop
 select * into entry from moneytrail_private.sms_inbox where user_id=caller and id=(item->>'id')::uuid;
 if entry.id is null then raise exception using errcode='42501',message='SMS entry is unavailable.'; end if;
 if entry.status='recorded' then
 if entry.draft is distinct from item->'draft' then raise exception using errcode='PT409',message='SMS preview has changed.'; end if;
 continue;
 end if;
 if entry.status<>'pending' then raise exception using errcode='PT409',message='SMS entry is no longer pending.'; end if;
 p:=moneytrail_private.sms_parse_for_account(caller,entry.raw_text,entry.received_at);
 if p->'draft' is distinct from item->'draft' or p->'requires_review'<>'false'::jsonb or p->'error'<>'null'::jsonb or p->'draft'='null'::jsonb then raise exception using errcode='PT409',message='SMS preview has changed; preview again.'; end if;
 txid:='sms-'||entry.id::text;
 if moneytrail_private.sms_append(caller,(p->'draft')||pg_catalog.jsonb_build_object('id',txid,'source','sms','sourceRef',txid),true) then
 update moneytrail_private.sms_inbox set status='recorded',raw_text=null,draft=p->'draft',warnings='[]',reason=null,transaction_id=txid where id=entry.id and user_id=caller;
 n:=n+1;
 end if;
 end loop;
 select count(*)::integer into total from moneytrail_private.sms_inbox where user_id=caller and status='pending';
 return pg_catalog.jsonb_build_object('recorded_count',n,'pending_count',total);
end; $function$;

CREATE OR REPLACE FUNCTION public.save_moneytrail_ledger(p_data jsonb, p_expected_revision bigint)
 RETURNS SETOF moneytrail_ledgers
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller uuid := auth.uid();
  saved public.moneytrail_ledgers%rowtype;
  prior public.moneytrail_ledgers%rowtype;
  merged jsonb;
begin
  if caller is null then
    raise exception using errcode = '28000', message = 'Authentication is required.';
  end if;
  if p_expected_revision is null or p_expected_revision < 0 or p_expected_revision >= 9007199254740991
    or not public.moneytrail_valid_payload(p_data)
  then
    raise exception using errcode = '22023', message = 'Invalid ledger snapshot or revision.';
  end if;

  -- Lock and compare before preserving metadata; only incoming IDs survive.
  if p_expected_revision > 0 then
    select * into prior from public.moneytrail_ledgers where user_id=caller for update;
    if prior.user_id is null or prior.revision<>p_expected_revision then
      raise exception using errcode='PT409',message='Ledger changed on another device. Reload before saving.';
    end if;
  end if;
  select coalesce(pg_catalog.jsonb_agg(moneytrail_private.sms_normalize_transaction(
    (coalesce(old.value,'{}'::jsonb)-array['id','kind','amountCents','date','merchant','category','source','note','sourceRef','linkedTransactionId']) || incoming.value
  ) order by incoming.ordinality),'[]'::jsonb) into merged
  from pg_catalog.jsonb_array_elements(p_data->'transactions') with ordinality incoming(value,ordinality)
  left join lateral (select value from pg_catalog.jsonb_array_elements(prior.data->'transactions') where value->>'id'=incoming.value->>'id') old on true;
  -- A new/changed refund association deliberately inherits even missing metadata.
  -- Resolve against the complete canonical incoming snapshot, independent of order,
  -- after legacy normalization and old-client preservation. Keep the refund's receipt.
  select coalesce(pg_catalog.jsonb_agg(
    case when incoming.value->>'kind'='refund'
      and incoming.value ? 'linkedTransactionId'
      and (old.value->>'kind' is distinct from 'refund'
        or old.value->>'linkedTransactionId' is distinct from incoming.value->>'linkedTransactionId')
    then (incoming.value-array['category','subcategory','platform'])
      || pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
        'category',original.value->'category','subcategory',original.value->'subcategory','platform',original.value->'platform'))
    else incoming.value end order by incoming.ordinality),'[]'::jsonb) into merged
  from pg_catalog.jsonb_array_elements(merged) with ordinality incoming(value,ordinality)
  left join lateral (select value from pg_catalog.jsonb_array_elements(prior.data->'transactions') where value->>'id'=incoming.value->>'id') old on true
  left join lateral (select value from pg_catalog.jsonb_array_elements(merged) where value->>'id'=incoming.value->>'linkedTransactionId' and value->>'kind'='expense') original on true;
  p_data:=pg_catalog.jsonb_set(p_data,'{transactions}',merged);
  if not public.moneytrail_valid_payload(p_data) then raise exception using errcode='22023',message='Preserved ledger snapshot is too large or invalid.'; end if;

  if p_expected_revision = 0 then
    insert into public.moneytrail_ledgers as target (user_id, data, revision, updated_at)
      values (caller, p_data, 1, pg_catalog.clock_timestamp())
      on conflict (user_id) do nothing
      returning target.* into saved;
  else
    update public.moneytrail_ledgers as target
      set data = p_data,
          revision = target.revision + 1,
          updated_at = pg_catalog.clock_timestamp()
      where target.user_id = caller and target.revision = p_expected_revision
      returning target.* into saved;
  end if;

  if saved.user_id is null then
    raise exception using errcode = 'PT409', message = 'Ledger changed on another device. Reload before saving.';
  end if;
  return next saved;
end;
$function$;

CREATE OR REPLACE FUNCTION public.save_moneytrail_ledger_with_rules(p_data jsonb, p_expected_revision bigint, p_rules jsonb)
 RETURNS SETOF moneytrail_ledgers
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  raise exception using errcode='PT409',message='Ledger changed on another device. Reload before saving.';
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
end; $function$;

comment on function public.save_moneytrail_ledger(jsonb,bigint) is 'Account ID comes exclusively from verified auth context; stale revisions return PT409 without transaction retries.';

commit;
