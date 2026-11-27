-- Explicitly associate a confirmed SMS refund with an expense in the same ledger.
begin;

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
  -- A linked refund can only append to an existing ledger. Validate it with
  -- that complete snapshot, which also contains the referenced expense.
  if (p_transaction ? 'linkedTransactionId') is not true then
    next_data := pg_catalog.jsonb_build_object('version', 1, 'transactions', pg_catalog.jsonb_build_array(p_transaction), 'budgetCents', 0, 'billCheckedMonths', '[]'::jsonb);
    if not public.moneytrail_valid_payload(next_data) then
      raise exception using errcode = '22023', message = 'Invalid SMS transaction.';
    end if;
    insert into public.moneytrail_ledgers(user_id, data, revision, updated_at)
      values(p_user, next_data, 1, pg_catalog.clock_timestamp()) on conflict (user_id) do nothing
    returning * into snapshot;
    if snapshot.user_id is not null then return true; end if;
  end if;
  select ledger.* into snapshot from public.moneytrail_ledgers as ledger where ledger.user_id = p_user for update;
  if snapshot.user_id is null then raise exception using errcode = '22023', message = 'SMS ledger is unavailable.'; end if;
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
  ledger_transactions jsonb;
  original_expense jsonb;
  original_id text;
  refund_amount numeric;
  refunded_amount numeric;
  v_transaction_id text;
begin
  -- Follow account settings, inbox, ledger lock order used by SMS intake and
  -- confirm-with-rule. The ledger lock also serializes concurrent web edits.
  insert into moneytrail_private.sms_settings(user_id) values(caller) on conflict do nothing;
  perform 1 from moneytrail_private.sms_settings where user_id = caller for update;
  select inbox.* into entry from moneytrail_private.sms_inbox as inbox where inbox.id = p_id and inbox.user_id = caller for update;
  if entry.id is null then raise exception using errcode = '42501', message = 'SMS entry is unavailable.'; end if;
  if entry.status = 'recorded' then
    return pg_catalog.jsonb_build_object('status', 'recorded', 'transaction_id', entry.transaction_id);
  end if;
  if entry.status <> 'pending' then raise exception using errcode = '22023', message = 'SMS entry is no longer pending.'; end if;
  if p_draft is null or pg_catalog.jsonb_typeof(p_draft) <> 'object'
    or p_draft - array['kind','amountCents','date','merchant','category','note','source','subcategory','platform','smsEvidence','linkedTransactionId'] <> '{}'::jsonb
    or not moneytrail_private.sms_valid_metadata(p_draft)
    or (p_draft ? 'source' and p_draft ->> 'source' is distinct from 'sms')
  then raise exception using errcode = '22023', message = 'Invalid SMS draft.'; end if;

  v_transaction_id := 'sms-' || entry.id::text;
  transaction := moneytrail_private.sms_normalize_transaction(
    p_draft || pg_catalog.jsonb_build_object('id', v_transaction_id, 'source', 'sms', 'sourceRef', v_transaction_id));
  if transaction ? 'linkedTransactionId' then
    original_id := transaction ->> 'linkedTransactionId';
    if transaction ->> 'kind' is distinct from 'refund'
      or pg_catalog.jsonb_typeof(transaction -> 'linkedTransactionId') is distinct from 'string'
      or pg_catalog.char_length(original_id) > 128 or original_id !~ '[^[:space:]]'
      or pg_catalog.jsonb_typeof(transaction -> 'amountCents') is distinct from 'number'
      or not public.moneytrail_valid_local_datetime(transaction ->> 'date') then
      raise exception using errcode = '22023', message = 'Invalid SMS refund linkage.';
    end if;
    refund_amount := (transaction ->> 'amountCents')::numeric;
    if refund_amount < 1 or refund_amount > 1000000000000 or pg_catalog.floor(refund_amount) <> refund_amount then
      raise exception using errcode = '22023', message = 'Invalid SMS refund amount.';
    end if;

    select ledger.data -> 'transactions' into ledger_transactions
    from public.moneytrail_ledgers as ledger where ledger.user_id = caller for update;
    select item.value into original_expense
    from pg_catalog.jsonb_array_elements(ledger_transactions) as item(value)
    where item.value ->> 'id' = original_id and item.value ->> 'kind' = 'expense';
    if original_expense is null or (original_expense ->> 'date')::timestamp > (transaction ->> 'date')::timestamp then
      raise exception using errcode = '22023', message = 'The original expense is unavailable for this refund.';
    end if;

    select coalesce(pg_catalog.sum((item.value ->> 'amountCents')::numeric), 0) into refunded_amount
    from pg_catalog.jsonb_array_elements(ledger_transactions) as item(value)
    where item.value ->> 'kind' = 'refund' and item.value ->> 'linkedTransactionId' = original_id;
    if refunded_amount + refund_amount > (original_expense ->> 'amountCents')::numeric then
      raise exception using errcode = '22023', message = 'Linked refunds exceed the original expense amount.';
    end if;

    original_expense := moneytrail_private.sms_normalize_transaction(original_expense);
    transaction := (transaction - array['category','subcategory','platform'])
      || pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
        'category', original_expense -> 'category', 'subcategory', original_expense -> 'subcategory',
        'platform', original_expense -> 'platform'));
  end if;

  -- Rebuild the evidence from this refund receipt, independent of the original expense.
  transaction := transaction - 'smsEvidence';
  if entry.raw_text is not null then
    transaction := transaction || pg_catalog.jsonb_build_object('smsEvidence',
      moneytrail_private.sms_evidence(entry.raw_text, entry.received_at, '人工确认：' || (transaction ->> 'category')));
  end if;
  perform moneytrail_private.sms_append(caller, transaction);
  -- The link lives in the ledger. Preserve the existing inbox draft shape for older clients.
  update moneytrail_private.sms_inbox set status = 'recorded', raw_text = null,
    draft = transaction - array['id','sourceRef','linkedTransactionId'], reason = null, transaction_id = v_transaction_id
    where id = entry.id;
  return pg_catalog.jsonb_build_object('status', 'recorded', 'transaction_id', v_transaction_id);
end;
$$;

revoke all on function public.moneytrail_sms_confirm(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.moneytrail_sms_confirm(uuid, jsonb) to authenticated;

notify pgrst, 'reload schema';
commit;
