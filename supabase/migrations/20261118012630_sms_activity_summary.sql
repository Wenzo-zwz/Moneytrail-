-- Read-only activity from the existing inbox; no receipt or ledger is rewritten.
begin;

create or replace function public.moneytrail_sms_activity_summary()
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  caller uuid := moneytrail_private.sms_require_account();
  window_end timestamptz := pg_catalog.statement_timestamp();
  window_start timestamptz := window_end - interval '168 hours';
  result jsonb;
begin
  -- Cohort membership follows receipt time. The three buckets reflect each
  -- receipt's current state, including a later confirmation or dismissal.
  select pg_catalog.jsonb_build_object(
    'period_start', window_start,
    'period_end', window_end,
    'time_zone', 'Asia/Shanghai',
    'received_count', pg_catalog.count(*),
    'recorded_count', pg_catalog.count(*) filter (where inbox.status = 'recorded'),
    'pending_count', pg_catalog.count(*) filter (where inbox.status = 'pending'),
    'dismissed_count', pg_catalog.count(*) filter (where inbox.status = 'dismissed')
  ) into result
  from moneytrail_private.sms_inbox as inbox
  where inbox.user_id = caller
    and inbox.received_at >= window_start
    and inbox.received_at < window_end;
  return result;
end;
$$;

revoke all on function public.moneytrail_sms_activity_summary() from public, anon, authenticated;
grant execute on function public.moneytrail_sms_activity_summary() to authenticated;
notify pgrst, 'reload schema';
commit;
