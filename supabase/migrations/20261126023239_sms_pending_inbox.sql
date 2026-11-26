-- Paginate pending SMS independently of the full inbox and its history.
begin;

create or replace function public.moneytrail_sms_pending_inbox(p_page integer default 1, p_page_size integer default 20)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  caller uuid := moneytrail_private.sms_require_account();
  result_items jsonb;
begin
  if p_page is null or p_page_size is null or p_page < 1 or p_page > 1000000
    or p_page_size < 1 or p_page_size > 50 then
    raise exception using errcode = '22023', message = 'Invalid SMS pagination.';
  end if;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'id', entry.id, 'received_at', entry.received_at, 'status', entry.status,
    'raw_text', entry.raw_text, 'draft', entry.draft, 'warnings', entry.warnings,
    'reason', entry.reason, 'transaction_id', entry.transaction_id
  ) order by entry.received_at desc, entry.id), '[]'::jsonb) into result_items
  from (
    select inbox.* from moneytrail_private.sms_inbox as inbox
    where inbox.user_id = caller and inbox.status = 'pending'
    order by inbox.received_at desc, inbox.id limit p_page_size offset ((p_page - 1)::bigint * p_page_size)
  ) as entry;

  return pg_catalog.jsonb_build_object(
    'items', result_items,
    'total', (select pg_catalog.count(*) from moneytrail_private.sms_inbox where user_id = caller and status = 'pending'),
    'page', p_page, 'page_size', p_page_size
  );
end;
$$;

revoke all on function public.moneytrail_sms_pending_inbox(integer, integer) from public, anon, authenticated;
grant execute on function public.moneytrail_sms_pending_inbox(integer, integer) to authenticated;

notify pgrst, 'reload schema';
commit;
