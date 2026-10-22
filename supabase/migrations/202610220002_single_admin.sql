-- Apply after 202610220001_ledger_accounts.sql in the Supabase SQL editor.
-- This migration creates no administrator. Bind the owner's verified user UUID
-- separately as the project operator; never put an owner email or password here.
begin;

create schema if not exists moneytrail_private;
revoke all on schema moneytrail_private from public, anon, authenticated;

create table if not exists moneytrail_private.admin_owner (
  id boolean primary key default true,
  user_id uuid not null unique references auth.users(id) on delete cascade,
  bound_at timestamp with time zone not null default pg_catalog.now(),
  constraint moneytrail_admin_owner_singleton check (id)
);

alter table moneytrail_private.admin_owner enable row level security;
revoke all on table moneytrail_private.admin_owner from public, anon, authenticated;

-- The binding is never readable or writable through the browser. Checking the
-- current auth record also invalidates a stale session after revocation/deletion.
create or replace function public.moneytrail_is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from moneytrail_private.admin_owner as owner
    join auth.users as account on account.id = owner.user_id
    where owner.id = true
      and owner.user_id = (select auth.uid())
      and account.email is not null
      and pg_catalog.btrim(account.email) <> ''
      and account.email_confirmed_at is not null
      and account.deleted_at is null
      and (account.banned_until is null or account.banned_until <= pg_catalog.now())
  );
$$;

revoke all on function public.moneytrail_is_admin() from public, anon, authenticated;
grant execute on function public.moneytrail_is_admin() to authenticated;

create or replace function public.moneytrail_admin_overview(
  p_query text default '',
  p_page integer default 1,
  p_page_size integer default 20
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  search_query text;
  result_totals jsonb;
  result_users jsonb;
  filtered_total bigint;
begin
  -- Check identity on every request, before inspecting caller-supplied input.
  -- No JWT role, email or user-editable metadata grants administrator access.
  if not public.moneytrail_is_admin() then
    raise exception using errcode = '42501', message = 'Administrator access is required.';
  end if;

  if p_query is null or p_page is null or p_page_size is null
    or p_page < 1 or p_page > 1000000
    or p_page_size < 1 or p_page_size > 50
  then
    raise exception using errcode = '22023', message = 'Invalid administrator query or pagination.';
  end if;
  search_query := pg_catalog.lower(pg_catalog.btrim(p_query));
  if pg_catalog.char_length(search_query) > 200 then
    raise exception using errcode = '22023', message = 'Administrator search is too long.';
  end if;

  select pg_catalog.jsonb_build_object(
    'users', (select pg_catalog.count(*) from auth.users),
    'confirmed_users', (
      select pg_catalog.count(*) from auth.users
      where email is not null and pg_catalog.btrim(email) <> '' and email_confirmed_at is not null
    ),
    'new_users_7d', (
      select pg_catalog.count(*) from auth.users
      where created_at >= pg_catalog.now() - interval '7 days'
    ),
    'ledgers', (select pg_catalog.count(*) from public.moneytrail_ledgers),
    'synced_24h', (
      select pg_catalog.count(*) from public.moneytrail_ledgers
      where updated_at >= pg_catalog.now() - interval '24 hours'
    )
  ) into result_totals;

  select pg_catalog.count(*) into filtered_total
  from auth.users as account
  where search_query = ''
    or pg_catalog.strpos(pg_catalog.lower(coalesce(account.email, '')), search_query) > 0
    or pg_catalog.strpos(account.id::text, search_query) > 0;

  -- Return account and synchronization metadata only. No expense values,
  -- merchant names, notes, complete ledgers or authentication secrets are read.
  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'id', selected.id,
        'email', selected.email,
        'created_at', selected.created_at,
        'email_confirmed_at', selected.email_confirmed_at,
        'last_sign_in_at', selected.last_sign_in_at,
        'ledger_updated_at', selected.ledger_updated_at,
        'transaction_count', selected.transaction_count
      ) order by selected.created_at desc nulls last, selected.id asc
    ),
    '[]'::jsonb
  ) into result_users
  from (
    select account.id, account.email, account.created_at,
      account.email_confirmed_at, account.last_sign_in_at,
      ledger.updated_at as ledger_updated_at,
      case when ledger.user_id is null then 0
        else pg_catalog.jsonb_array_length(ledger.data -> 'transactions')
      end as transaction_count
    from auth.users as account
    left join public.moneytrail_ledgers as ledger on ledger.user_id = account.id
    where search_query = ''
      or pg_catalog.strpos(pg_catalog.lower(coalesce(account.email, '')), search_query) > 0
      or pg_catalog.strpos(account.id::text, search_query) > 0
    order by account.created_at desc nulls last, account.id asc
    offset (p_page::bigint - 1) * p_page_size::bigint
    limit p_page_size
  ) as selected;

  return pg_catalog.jsonb_build_object(
    'totals', result_totals,
    'users', result_users,
    'total', filtered_total,
    'page', p_page,
    'page_size', p_page_size
  );
end;
$$;

revoke all on function public.moneytrail_admin_overview(text, integer, integer) from public, anon, authenticated;
grant execute on function public.moneytrail_admin_overview(text, integer, integer) to authenticated;

comment on table moneytrail_private.admin_owner is 'A single operator-bound, verified Auth user UUID. No browser role can inspect or modify this binding.';
comment on function public.moneytrail_is_admin() is 'Checks the bound UUID and current verified, active Auth record. Never trusts caller role or email metadata.';
comment on function public.moneytrail_admin_overview(text, integer, integer) is 'Read-only user directory and synchronization counts for the single bound administrator; no ledger contents or financial values.';

commit;
