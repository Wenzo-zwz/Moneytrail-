-- Apply after 202610220001_ledger_accounts.sql and 202610220003_sms_parser.sql.
-- SMS tokens are narrow, write-only capabilities. Never use an account password,
-- service_role key or a normal account session in an iPhone automation.
begin;

create schema if not exists moneytrail_private;
revoke all on schema moneytrail_private from public, anon, authenticated;

create table if not exists moneytrail_private.sms_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  token_hash text unique,
  mode text not null default 'auto' check (mode in ('review', 'auto')),
  created_at timestamptz,
  last_received_at timestamptz,
  receipt_day date,
  receipt_count integer not null default 0 check (receipt_count between 0 and 100),
  constraint moneytrail_sms_hash check (token_hash is null or token_hash ~ '^[a-f0-9]{64}$')
);
create table if not exists moneytrail_private.sms_inbox (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  received_at timestamptz not null default pg_catalog.clock_timestamp(),
  fingerprint text not null check (fingerprint ~ '^[a-f0-9]{64}$'),
  status text not null check (status in ('pending', 'recorded', 'dismissed')),
  raw_text text,
  draft jsonb,
  warnings jsonb not null default '[]'::jsonb,
  reason text,
  transaction_id text,
  constraint moneytrail_sms_raw check (
    (status = 'pending' and raw_text is not null and pg_catalog.char_length(raw_text) between 1 and 2000)
    or (status <> 'pending' and raw_text is null)
  ),
  constraint moneytrail_sms_recorded check ((status = 'recorded') = (transaction_id is not null))
);
create index if not exists moneytrail_sms_owner_received on moneytrail_private.sms_inbox(user_id, received_at desc, id);
create index if not exists moneytrail_sms_owner_fingerprint on moneytrail_private.sms_inbox(user_id, fingerprint, received_at desc);
create index if not exists moneytrail_sms_owner_pending on moneytrail_private.sms_inbox(user_id) where status = 'pending';
alter table moneytrail_private.sms_settings enable row level security;
alter table moneytrail_private.sms_inbox enable row level security;
revoke all on table moneytrail_private.sms_settings, moneytrail_private.sms_inbox from public, anon, authenticated;

create or replace function moneytrail_private.sms_require_account()
returns uuid
language plpgsql stable
set search_path = ''
as $$
declare caller uuid := auth.uid();
begin
  if caller is null or not exists (
    select 1 from auth.users as account
    where account.id = caller and account.email is not null and pg_catalog.btrim(account.email) <> ''
      and account.email_confirmed_at is not null and account.deleted_at is null
      and (account.banned_until is null or account.banned_until <= pg_catalog.now())
  ) then
    raise exception using errcode = '42501', message = 'A verified active account is required.';
  end if;
  return caller;
end;
$$;
revoke all on function moneytrail_private.sms_require_account() from public, anon, authenticated;

create or replace function moneytrail_private.sms_config(p_user uuid)
returns jsonb
language sql stable
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'enabled', coalesce(settings.token_hash is not null, false),
    'mode', coalesce(settings.mode, 'auto'),
    'created_at', settings.created_at,
    'last_received_at', settings.last_received_at,
    'pending_count', (select pg_catalog.count(*) from moneytrail_private.sms_inbox as inbox where inbox.user_id = p_user and inbox.status = 'pending')
  ) from (select 1) as singleton
  left join moneytrail_private.sms_settings as settings on settings.user_id = p_user;
$$;
revoke all on function moneytrail_private.sms_config(uuid) from public, anon, authenticated;

create or replace function public.moneytrail_sms_config()
returns jsonb
language sql stable security definer
set search_path = ''
as $$ select moneytrail_private.sms_config(moneytrail_private.sms_require_account()); $$;
revoke all on function public.moneytrail_sms_config() from public, anon, authenticated;
grant execute on function public.moneytrail_sms_config() to authenticated;

create or replace function public.moneytrail_sms_rotate(p_mode text default 'auto')
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  caller uuid := moneytrail_private.sms_require_account();
  token text;
begin
  if p_mode is null or p_mode not in ('review', 'auto') then
    raise exception using errcode = '22023', message = 'Invalid SMS mode.';
  end if;
  token := 'mt_sms_' || pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', '') || pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', '');
  insert into moneytrail_private.sms_settings as settings (user_id, token_hash, mode, created_at)
  values (caller, pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(token, 'UTF8')), 'hex'), p_mode, pg_catalog.clock_timestamp())
  on conflict (user_id) do update set token_hash = excluded.token_hash, mode = excluded.mode, created_at = excluded.created_at;
  return pg_catalog.jsonb_build_object('token', token, 'config', moneytrail_private.sms_config(caller));
end;
$$;
revoke all on function public.moneytrail_sms_rotate(text) from public, anon, authenticated;
grant execute on function public.moneytrail_sms_rotate(text) to authenticated;

create or replace function public.moneytrail_sms_set_mode(p_mode text)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare caller uuid := moneytrail_private.sms_require_account();
begin
  if p_mode is null or p_mode not in ('review', 'auto') then
    raise exception using errcode = '22023', message = 'Invalid SMS mode.';
  end if;
  insert into moneytrail_private.sms_settings(user_id, mode) values(caller, p_mode)
  on conflict (user_id) do update set mode = excluded.mode;
  return moneytrail_private.sms_config(caller);
end;
$$;
revoke all on function public.moneytrail_sms_set_mode(text) from public, anon, authenticated;
grant execute on function public.moneytrail_sms_set_mode(text) to authenticated;

create or replace function public.moneytrail_sms_revoke()
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare caller uuid := moneytrail_private.sms_require_account();
begin
  update moneytrail_private.sms_settings set token_hash = null where user_id = caller;
  return moneytrail_private.sms_config(caller);
end;
$$;
revoke all on function public.moneytrail_sms_revoke() from public, anon, authenticated;
grant execute on function public.moneytrail_sms_revoke() to authenticated;

create or replace function public.moneytrail_sms_inbox(p_page integer default 1, p_page_size integer default 20)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare caller uuid := moneytrail_private.sms_require_account(); result_items jsonb;
begin
  if p_page is null or p_page_size is null or p_page < 1 or p_page > 1000000 or p_page_size < 1 or p_page_size > 50 then
    raise exception using errcode = '22023', message = 'Invalid SMS pagination.';
  end if;
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'id', entry.id, 'received_at', entry.received_at, 'status', entry.status,
    'raw_text', entry.raw_text, 'draft', entry.draft, 'warnings', entry.warnings,
    'reason', entry.reason, 'transaction_id', entry.transaction_id
  ) order by entry.received_at desc, entry.id), '[]'::jsonb) into result_items
  from (
    select inbox.* from moneytrail_private.sms_inbox as inbox where inbox.user_id = caller
    order by inbox.received_at desc, inbox.id limit p_page_size offset ((p_page - 1)::bigint * p_page_size)
  ) as entry;
  return pg_catalog.jsonb_build_object('items', result_items,
    'total', (select pg_catalog.count(*) from moneytrail_private.sms_inbox where user_id = caller),
    'page', p_page, 'page_size', p_page_size);
end;
$$;
revoke all on function public.moneytrail_sms_inbox(integer, integer) from public, anon, authenticated;
grant execute on function public.moneytrail_sms_inbox(integer, integer) to authenticated;

-- Append to the latest locked snapshot. Existing revision-checked saves still
-- reject stale clients; this helper never replaces the rest of the ledger.
create or replace function moneytrail_private.sms_append(p_user uuid, p_transaction jsonb, p_check_duplicates boolean default false)
returns boolean
language plpgsql
set search_path = ''
as $$
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
    raise exception using errcode = '40001', message = 'SMS transaction ID already exists with different content.';
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
$$;
revoke all on function moneytrail_private.sms_append(uuid, jsonb, boolean) from public, anon, authenticated;

create or replace function public.moneytrail_sms_confirm(p_id uuid, p_draft jsonb)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  caller uuid := moneytrail_private.sms_require_account();
  entry moneytrail_private.sms_inbox%rowtype;
  transaction jsonb;
  v_transaction_id text;
begin
  select inbox.* into entry from moneytrail_private.sms_inbox as inbox where inbox.id = p_id and inbox.user_id = caller for update;
  if entry.id is null then raise exception using errcode = '42501', message = 'SMS entry is unavailable.'; end if;
  if entry.status = 'recorded' then
    return pg_catalog.jsonb_build_object('status', 'recorded', 'transaction_id', entry.transaction_id);
  end if;
  if entry.status <> 'pending' then raise exception using errcode = '22023', message = 'SMS entry is no longer pending.'; end if;
  if p_draft is null or pg_catalog.jsonb_typeof(p_draft) <> 'object'
    or p_draft - array['kind','amountCents','date','merchant','category','note','source'] <> '{}'::jsonb
    or (p_draft ? 'source' and (p_draft ->> 'source' is distinct from 'sms'))
  then raise exception using errcode = '22023', message = 'Invalid SMS draft.'; end if;
  v_transaction_id := 'sms-' || entry.id::text;
  transaction := p_draft || pg_catalog.jsonb_build_object('id', v_transaction_id, 'source', 'sms', 'sourceRef', v_transaction_id);
  perform moneytrail_private.sms_append(caller, transaction);
  update moneytrail_private.sms_inbox set status = 'recorded', raw_text = null,
    draft = transaction - array['id','sourceRef'], reason = null, transaction_id = v_transaction_id
    where id = entry.id;
  return pg_catalog.jsonb_build_object('status', 'recorded', 'transaction_id', v_transaction_id);
end;
$$;
revoke all on function public.moneytrail_sms_confirm(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.moneytrail_sms_confirm(uuid, jsonb) to authenticated;

create or replace function public.moneytrail_sms_dismiss(p_id uuid)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare caller uuid := moneytrail_private.sms_require_account(); entry moneytrail_private.sms_inbox%rowtype;
begin
  select inbox.* into entry from moneytrail_private.sms_inbox as inbox where inbox.id = p_id and inbox.user_id = caller for update;
  if entry.id is null then raise exception using errcode = '42501', message = 'SMS entry is unavailable.'; end if;
  if entry.status = 'recorded' then raise exception using errcode = '22023', message = 'Recorded transactions must be managed in the ledger.'; end if;
  update moneytrail_private.sms_inbox set status = 'dismissed', raw_text = null, draft = null, reason = null, warnings = '[]'::jsonb where id = entry.id;
  return pg_catalog.jsonb_build_object('status', 'dismissed');
end;
$$;
revoke all on function public.moneytrail_sms_dismiss(uuid) from public, anon, authenticated;
grant execute on function public.moneytrail_sms_dismiss(uuid) to authenticated;

create or replace function public.moneytrail_receive_sms(p_token text, p_message text)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  settings moneytrail_private.sms_settings%rowtype;
  received timestamptz := pg_catalog.clock_timestamp();
  receipt_date date;
  digest text;
  previous_id uuid;
  entry_id uuid := pg_catalog.gen_random_uuid();
  parsed jsonb;
  transaction jsonb;
  v_transaction_id text;
  new_status text := 'pending';
  normalized_message text;
begin
  if p_token is null or pg_catalog.char_length(p_token) <> 71 or p_token !~ '^mt_sms_[a-f0-9]{64}$' then
    raise exception using errcode = '42501', message = 'SMS token is invalid or disabled.';
  end if;
  select config.* into settings from moneytrail_private.sms_settings as config
    join auth.users as account on account.id = config.user_id
    where config.token_hash = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_token, 'UTF8')), 'hex')
      and account.email is not null and pg_catalog.btrim(account.email) <> ''
      and account.email_confirmed_at is not null and account.deleted_at is null
      and (account.banned_until is null or account.banned_until <= received)
    for update of config;
  if settings.user_id is null then raise exception using errcode = '42501', message = 'SMS token is invalid or disabled.'; end if;
  if p_message is null or pg_catalog.char_length(p_message) < 1 or pg_catalog.char_length(p_message) > 2000 then
    raise exception using errcode = '22023', message = 'Only supported bank expense messages may be submitted.';
  end if;
  normalized_message := pg_catalog.normalize(p_message, 'NFKC');
  if normalized_message ~* '(验证码|校验码|动态码|短信口令|口令|密码|OTP|verification|one[ -]?time)'
    or normalized_message !~ '工商银行' or normalized_message !~ '支出'
  then raise exception using errcode = '22023', message = 'Only supported bank expense messages may be submitted.'; end if;
  receipt_date := (received at time zone 'Asia/Shanghai')::date;
  if settings.receipt_day = receipt_date and settings.receipt_count >= 100 then
    raise exception using errcode = '54000', message = 'SMS daily receipt limit reached.';
  end if;
  update moneytrail_private.sms_settings set
    receipt_day = receipt_date,
    receipt_count = case when settings.receipt_day = receipt_date then settings.receipt_count + 1 else 1 end,
    last_received_at = received where user_id = settings.user_id;
  digest := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_message, 'UTF8')), 'hex');
  select inbox.id into previous_id from moneytrail_private.sms_inbox as inbox
    where inbox.user_id = settings.user_id and inbox.fingerprint = digest and inbox.received_at >= received - interval '24 hours'
    order by inbox.received_at desc limit 1;
  if previous_id is not null then
    return pg_catalog.jsonb_build_object('accepted', true, 'status', 'duplicate', 'id', previous_id);
  end if;
  if (select pg_catalog.count(*) from moneytrail_private.sms_inbox where user_id = settings.user_id and status = 'pending') >= 200 then
    raise exception using errcode = '54000', message = 'SMS pending inbox limit reached. Review existing entries first.';
  end if;
  delete from moneytrail_private.sms_inbox where user_id = settings.user_id and status <> 'pending' and received_at < received - interval '30 days';
  -- Group collection is deliberately fixed to review; a generic "transfer"
  -- keyword must never silently exclude an actual AA purchase from spending.
  parsed := moneytrail_private.moneytrail_parse_icbc_sms(p_message, received, 'review');
  if settings.mode = 'auto' and parsed -> 'draft' is not null and parsed -> 'draft' <> 'null'::jsonb
    and parsed -> 'requires_review' = 'false'::jsonb and parsed -> 'error' = 'null'::jsonb then
    v_transaction_id := 'sms-' || entry_id::text;
    transaction := (parsed -> 'draft') || pg_catalog.jsonb_build_object('id', v_transaction_id, 'source', 'sms', 'sourceRef', v_transaction_id);
    if moneytrail_private.sms_append(settings.user_id, transaction, true) then
      new_status := 'recorded';
    else
      -- A CSV/manual entry may already represent this payment. Keep the SMS
      -- pending instead of silently adding or discarding a plausible duplicate.
      v_transaction_id := null;
      parsed := pg_catalog.jsonb_set(parsed, '{warnings}', (parsed -> 'warnings') ||
        pg_catalog.jsonb_build_array('账本中已有10分钟内同类型、同金额的记录，可能重复，请核对后确认。'));
    end if;
  end if;
  insert into moneytrail_private.sms_inbox(id, user_id, received_at, fingerprint, status, raw_text, draft, warnings, reason, transaction_id)
    values(entry_id, settings.user_id, received, digest, new_status,
      case when new_status = 'pending' then p_message else null end,
      parsed -> 'draft', coalesce(parsed -> 'warnings', '[]'::jsonb), parsed ->> 'error', v_transaction_id);
  return pg_catalog.jsonb_build_object('accepted', true, 'status', new_status, 'id', entry_id);
end;
$$;
revoke all on function public.moneytrail_receive_sms(text, text) from public, anon, authenticated;
grant execute on function public.moneytrail_receive_sms(text, text) to anon, authenticated;

comment on function public.moneytrail_receive_sms(text, text) is 'Write-only per-user SMS capability. No ledger read or account session required. Tokens are hashed, revocable and scoped to intake.';
comment on table moneytrail_private.sms_inbox is 'Only pending SMS retains original text; processed text is purged immediately. All access is through identity-bound RPCs.';

-- Refresh PostgREST schema discovery after installing these RPCs.
notify pgrst, 'reload schema';
commit;
