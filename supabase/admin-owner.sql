-- Run in the project's SQL editor after the single-admin migration.
-- Replace the email placeholder below with the owner's registered email.
-- Project operators can bind one verified account; browser roles cannot run this.
begin;

-- Serialize operator attempts before inspecting or creating the sole binding.
lock table moneytrail_private.admin_owner in exclusive mode;

do $moneytrail_bind_owner$
declare
  requested_email text := pg_catalog.lower(pg_catalog.btrim('ADMIN_EMAIL_HERE'));
  candidates uuid[];
  candidate_id uuid;
  current_owner uuid;
begin
  if requested_email !~ '^[^[:space:]@]+@[^[:space:]@]+$'
    or pg_catalog.char_length(requested_email) > 254
  then
    raise exception using errcode = '22023', message = 'Replace the administrator email placeholder with the registered owner email.';
  end if;

  -- Match the complete address, never a prefix/wildcard or JWT email claim.
  -- Lock matching Auth records until commit so verification cannot change while
  -- the initial binding is created. Every later RPC still rechecks that record.
  select pg_catalog.array_agg(candidate.id) into candidates
  from (
    select account.id
    from auth.users as account
    where pg_catalog.lower(pg_catalog.btrim(account.email)) = requested_email
      and account.email_confirmed_at is not null
      and account.deleted_at is null
      and (account.banned_until is null or account.banned_until <= pg_catalog.now())
    for update
  ) as candidate;

  if coalesce(pg_catalog.cardinality(candidates), 0) = 0 then
    raise exception using errcode = '22023', message = 'No eligible verified account matches the administrator email. Register and confirm this email first.';
  end if;
  if pg_catalog.cardinality(candidates) <> 1 then
    raise exception using errcode = '21000', message = 'More than one eligible verified account matches the administrator email. Resolve the duplicate before binding.';
  end if;
  candidate_id := candidates[1];

  select user_id into current_owner from moneytrail_private.admin_owner where id = true;
  if current_owner is not null and current_owner <> candidate_id then
    raise exception using errcode = '42501', message = 'A different administrator is already bound. Refusing to replace it.';
  end if;

  -- Repeating setup for the same owner leaves the original binding unchanged.
  if current_owner is null then
    insert into moneytrail_private.admin_owner(id, user_id) values (true, candidate_id);
  end if;
end;
$moneytrail_bind_owner$;

select 'Administrator configured' as status,
  account.email as administrator_email,
  owner.user_id
from moneytrail_private.admin_owner as owner
join auth.users as account on account.id = owner.user_id
where owner.id = true;

commit;
