-- Apply in the Supabase SQL editor or with `supabase db push`.
-- Auth users are provided by Supabase; no credential belongs in this migration.
begin;

create table if not exists public.moneytrail_ledgers (
  user_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null,
  revision bigint not null check (revision between 1 and 9007199254740991),
  updated_at timestamp with time zone not null default pg_catalog.now(),
  constraint moneytrail_ledger_object check (pg_catalog.jsonb_typeof(data) = 'object')
);

alter table public.moneytrail_ledgers enable row level security;

-- Client writes must use the revision-checked RPC below, including empty ledgers.
revoke all on table public.moneytrail_ledgers from public, anon, authenticated;
grant select on table public.moneytrail_ledgers to authenticated;

drop policy if exists moneytrail_select_own_ledger on public.moneytrail_ledgers;
create policy moneytrail_select_own_ledger on public.moneytrail_ledgers
  for select to authenticated
  using ((select auth.uid()) = user_id);

create or replace function public.moneytrail_valid_local_datetime(p_value text)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  parsed timestamp without time zone;
begin
  if p_value is null
    or pg_catalog.char_length(p_value) <> 16
    or p_value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}$'
  then
    return false;
  end if;
  begin
    parsed := p_value::timestamp without time zone;
  exception when others then
    return false;
  end;
  return pg_catalog.to_char(parsed, 'YYYY-MM-DD"T"HH24:MI') = p_value;
end;
$$;

create or replace function public.moneytrail_valid_payload(p_data jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  entry jsonb;
  amount numeric;
  month_value jsonb;
begin
  -- The limit covers the complete snapshot, not only the transactions array.
  if p_data is null
    or pg_catalog.octet_length(p_data::text) > 5242880
    or pg_catalog.jsonb_typeof(p_data) is distinct from 'object'
    or p_data - array['version', 'transactions', 'budgetCents', 'billCheckedMonths'] <> '{}'::jsonb
    or (p_data -> 'version') is distinct from '1'::jsonb
    or pg_catalog.jsonb_typeof(p_data -> 'budgetCents') is distinct from 'number'
    or pg_catalog.jsonb_typeof(p_data -> 'transactions') is distinct from 'array'
    or pg_catalog.jsonb_typeof(p_data -> 'billCheckedMonths') is distinct from 'array'
  then
    return false;
  end if;

  amount := (p_data ->> 'budgetCents')::numeric;
  if amount < 0 or amount > 1000000000000 or pg_catalog.floor(amount) <> amount
    or pg_catalog.jsonb_array_length(p_data -> 'transactions') > 100000
    or pg_catalog.jsonb_array_length(p_data -> 'billCheckedMonths') > 12000
  then
    return false;
  end if;

  for month_value in select value from pg_catalog.jsonb_array_elements(p_data -> 'billCheckedMonths') loop
    if pg_catalog.jsonb_typeof(month_value) is distinct from 'string'
      or (month_value #>> '{}') !~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
      or pg_catalog.left(month_value #>> '{}', 4) = '0000'
    then
      return false;
    end if;
  end loop;
  if (select pg_catalog.count(*) from pg_catalog.jsonb_array_elements(p_data -> 'billCheckedMonths'))
    <> (select pg_catalog.count(distinct value) from pg_catalog.jsonb_array_elements(p_data -> 'billCheckedMonths'))
  then
    return false;
  end if;

  for entry in select value from pg_catalog.jsonb_array_elements(p_data -> 'transactions') loop
    if pg_catalog.jsonb_typeof(entry) is distinct from 'object'
      or entry - array['id', 'kind', 'amountCents', 'date', 'merchant', 'category', 'source', 'note', 'sourceRef', 'linkedTransactionId'] <> '{}'::jsonb
      or pg_catalog.jsonb_typeof(entry -> 'id') is distinct from 'string'
      or pg_catalog.char_length(entry ->> 'id') > 128
      or (entry ->> 'id') !~ '[^[:space:]]'
      or pg_catalog.jsonb_typeof(entry -> 'kind') is distinct from 'string'
      or (entry ->> 'kind') not in ('expense', 'refund', 'transfer', 'income')
      or pg_catalog.jsonb_typeof(entry -> 'amountCents') is distinct from 'number'
      or pg_catalog.jsonb_typeof(entry -> 'date') is distinct from 'string'
      or not public.moneytrail_valid_local_datetime(entry ->> 'date')
      or pg_catalog.jsonb_typeof(entry -> 'merchant') is distinct from 'string'
      or pg_catalog.char_length(entry ->> 'merchant') > 200
      or (entry ->> 'merchant') !~ '[^[:space:]]'
      or pg_catalog.jsonb_typeof(entry -> 'category') is distinct from 'string'
      or (entry ->> 'category') not in ('餐饮', '购物', '交通', '居住', '娱乐', '医疗', '学习', '其他', '待分类')
      or pg_catalog.jsonb_typeof(entry -> 'source') is distinct from 'string'
      or (entry ->> 'source') not in ('manual', 'sms', 'wechat', 'alipay', 'csv')
      or pg_catalog.jsonb_typeof(entry -> 'note') is distinct from 'string'
      or pg_catalog.char_length(entry ->> 'note') > 2000
    then
      return false;
    end if;
    amount := (entry ->> 'amountCents')::numeric;
    if amount <= 0 or amount > 1000000000000 or pg_catalog.floor(amount) <> amount then
      return false;
    end if;
    if entry ? 'sourceRef' and (
      pg_catalog.jsonb_typeof(entry -> 'sourceRef') is distinct from 'string'
      or pg_catalog.char_length(entry ->> 'sourceRef') > 200
      or (entry ->> 'sourceRef') !~ '[^[:space:]]'
    ) then
      return false;
    end if;
    if entry ? 'linkedTransactionId' and (
      (entry ->> 'kind') <> 'refund'
      or pg_catalog.jsonb_typeof(entry -> 'linkedTransactionId') is distinct from 'string'
      or pg_catalog.char_length(entry ->> 'linkedTransactionId') > 128
      or (entry ->> 'linkedTransactionId') !~ '[^[:space:]]'
    ) then
      return false;
    end if;
  end loop;

  if (select pg_catalog.count(*) from pg_catalog.jsonb_array_elements(p_data -> 'transactions'))
    <> (select pg_catalog.count(distinct value ->> 'id') from pg_catalog.jsonb_array_elements(p_data -> 'transactions'))
  then
    return false;
  end if;
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_data -> 'transactions') as refunds(value)
    where refunds.value ? 'linkedTransactionId'
      and not exists (
        select 1
        from pg_catalog.jsonb_array_elements(p_data -> 'transactions') as expenses(value)
        where expenses.value ->> 'id' = refunds.value ->> 'linkedTransactionId'
          and expenses.value ->> 'kind' = 'expense'
      )
  ) then
    return false;
  end if;
  return true;
exception when others then
  -- Malformed values are never a reason to accept a snapshot.
  return false;
end;
$$;

revoke all on function public.moneytrail_valid_local_datetime(text) from public, anon, authenticated;
revoke all on function public.moneytrail_valid_payload(jsonb) from public, anon, authenticated;

create or replace function public.save_moneytrail_ledger(p_data jsonb, p_expected_revision bigint)
returns setof public.moneytrail_ledgers
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := auth.uid();
  saved public.moneytrail_ledgers%rowtype;
begin
  if caller is null then
    raise exception using errcode = '28000', message = 'Authentication is required.';
  end if;
  if p_expected_revision is null or p_expected_revision < 0 or p_expected_revision >= 9007199254740991
    or not public.moneytrail_valid_payload(p_data)
  then
    raise exception using errcode = '22023', message = 'Invalid ledger snapshot or revision.';
  end if;

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
    raise exception using errcode = '40001', message = 'Ledger changed on another device. Reload before saving.';
  end if;
  return next saved;
end;
$$;

revoke all on function public.save_moneytrail_ledger(jsonb, bigint) from public, anon, authenticated;
grant execute on function public.save_moneytrail_ledger(jsonb, bigint) to authenticated;

comment on table public.moneytrail_ledgers is 'One revisioned ledger per Supabase Auth user. Client writes only through save_moneytrail_ledger.';
comment on function public.save_moneytrail_ledger(jsonb, bigint) is 'Account ID comes exclusively from the verified auth context; stale revisions fail with SQLSTATE 40001.';

commit;
