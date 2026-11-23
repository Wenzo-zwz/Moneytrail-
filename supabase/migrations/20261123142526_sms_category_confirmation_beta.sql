-- Stage beta Shortcut payments in the same SMS inbox before allowing an explicit category selection.
begin;

create table moneytrail_private.sms_beta_reviews (
  inbox_id uuid primary key references moneytrail_private.sms_inbox(id) on delete cascade,
  token_hash text not null unique,
  intake_token_hash text not null,
  expires_at timestamptz not null
);
alter table moneytrail_private.sms_beta_reviews enable row level security;
revoke all on table moneytrail_private.sms_beta_reviews from public, anon, authenticated;

create function moneytrail_private.sms_beta_category_ready(p_parsed jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select p_parsed #>> '{draft,kind}' = 'expense'
    and p_parsed #>> '{draft,merchant}' !~ '(转账|转出|转入|转存|汇款|取现|支取|提现|还款|偿还|零钱通|余额宝|理财|借款|收款|待支付|待付款|处理中)'
    and (p_parsed #>> '{draft,merchant}' !~ '充值' or p_parsed #>> '{draft,merchant}' ~ '(手机充值|话费充值)')
    and (
      -- The account parser deliberately marks an otherwise clean, uncategorized expense for review.
      (p_parsed -> 'warnings' = '[]'::jsonb and (
        (p_parsed -> 'requires_review' = 'false'::jsonb and p_parsed -> 'error' = 'null'::jsonb)
        or (p_parsed #>> '{draft,category}' = '待分类' and p_parsed ->> 'error' = '请核对商户用途与分类。')
      ))
      -- The strict ICBC parser isolates a platform-only merchant warning from date or payment warnings.
      or (p_parsed -> 'error' = 'null'::jsonb
        and moneytrail_private.sms_is_platform_only_merchant(p_parsed #>> '{draft,merchant}')
        and p_parsed -> 'warnings' = pg_catalog.jsonb_build_array('仅有美团平台名称，具体用途需核对'))
    );
$$;
revoke all on function moneytrail_private.sms_beta_category_ready(jsonb) from public, anon, authenticated;

create function moneytrail_private.sms_receive(p_token text, p_message text, p_prompt_for_category boolean)
returns jsonb
language plpgsql
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
  bank_code text;
  legacy_icbc boolean;
  review_bank_code text;
  review_amount text := '(?:[0-9]+|[0-9]{1,3}(?:,[0-9]{3})+)(?:\.[0-9]{1,2})?';
  review_debit_pattern text;
  cmb_debit_pattern text;
  income_candidate boolean;
  result jsonb;
  draft jsonb;
  review_token text;
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
    raise exception using errcode = '22023', message = 'Only supported bank transaction messages may be submitted.';
  end if;
  normalized_message := pg_catalog.normalize(p_message, 'NFKC');
  bank_code := moneytrail_private.sms_bank_code(normalized_message);
  review_bank_code := moneytrail_private.sms_review_bank_source(normalized_message);
  if review_bank_code='cmb' then normalized_message:=moneytrail_private.sms_cmb_text(p_message); end if;
  income_candidate := moneytrail_private.sms_income_candidate(p_message);
  -- Require the amount beside the debit action or its explicit amount field;
  -- a later balance or available limit must never supply the expense amount.
  review_debit_pattern := '(?:支出|消费(?:支出|交易)?|扣款|扣费|批扣|代扣|转出|支取)[[:space:],:]*(?:(?:(?:金额)?[[:space:]]*(?:为|:)[[:space:]]*|金额[[:space:]]*)?(?:(?:人民币|RMB|CNY)[[:space:]]*'
    || review_amount || '(?:[[:space:]]*元)?|' || review_amount || '[[:space:]]*元)|金额[[:space:]]*(?:为|:)[[:space:]]*'
    || review_amount || ')(?![0-9.]|,[0-9])';
  cmb_debit_pattern := pg_catalog.replace(review_debit_pattern, '(?:支出|消费', '(?:快捷支付|支出|消费');
  -- Earlier ICBC intake retained unknown layouts for review. Preserve that
  -- receipt path without treating an unverified signature as a parsed bank.
  legacy_icbc := bank_code is null and normalized_message ~ '工商银行' and normalized_message ~ '支出'
    and pg_catalog.replace(pg_catalog.replace(normalized_message, '中国工商银行', ''), '工商银行', '') !~ '银行';
  if normalized_message ~* '(验证码|校验码|动态码|短信口令|口令|密码|OTP|verification|one[ -]?time)'
    or (bank_code is distinct from 'icbc' and review_bank_code is null and not legacy_icbc and not income_candidate)
    or (bank_code='icbc' and normalized_message !~ '支出' and not income_candidate)
    or (review_bank_code is not null and not income_candidate and (
      normalized_message !~* (case when review_bank_code='cmb' then cmb_debit_pattern else review_debit_pattern end)
      or normalized_message ~* '(美元|美金|港币|港元|日元|欧元|英镑|外币|澳元|加元|新加坡元|新西兰元|USD|HKD|JPY|EUR|GBP|AUD|CAD|SGD|NZD|[$€£₩₹¥])'
      or normalized_message ~ '(促销|优惠券|抽奖|积分兑换|(?:消费|支付)满|消费享优惠|每[[:space:]]*(?:消费|支付)|可获|敬请(?:使用|参与))'
      or normalized_message ~ '(账单|应还|最低还款|还款提醒|到期还款|还款日)'
    ))
  then raise exception using errcode = '22023', message = 'Only supported bank transaction messages may be submitted.'; end if;
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
  if income_candidate then parsed:=moneytrail_private.sms_parse_for_account(settings.user_id,p_message,received);
  elsif review_bank_code='cmb' then parsed:=moneytrail_private.sms_parse_cmb(p_message,received);
  else parsed := moneytrail_private.sms_parse_for_account(settings.user_id, p_message, received); end if;
  if review_bank_code is not null and not income_candidate then
    parsed := pg_catalog.jsonb_set(parsed, '{requires_review}', 'true'::jsonb);
    if parsed -> 'draft' is null or parsed -> 'draft' = 'null'::jsonb then
      parsed := pg_catalog.jsonb_set(parsed, '{error}', pg_catalog.to_jsonb('该银行短信已接收，当前格式需手动核对金额、时间和商户。'::text));
    end if;
  end if;
  if not p_prompt_for_category and review_bank_code is null and not legacy_icbc and not income_candidate and settings.mode = 'auto' and parsed -> 'draft' is not null and parsed -> 'draft' <> 'null'::jsonb
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
  result := pg_catalog.jsonb_build_object('accepted', true, 'status', new_status, 'id', entry_id);
  draft := parsed -> 'draft';
  if p_prompt_for_category and review_bank_code is null and bank_code = 'icbc' and not income_candidate
    and moneytrail_private.sms_beta_category_ready(parsed) then
    review_token := 'mt_sms_review_' || pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', '')
      || pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', '');
    insert into moneytrail_private.sms_beta_reviews(inbox_id, token_hash, intake_token_hash, expires_at)
      values (entry_id, pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(review_token, 'UTF8')), 'hex'),
        settings.token_hash, pg_catalog.clock_timestamp() + interval '10 minutes');
    result := result || pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'review_token', review_token,
      'amount', ((draft ->> 'amountCents')::numeric / 100)::numeric(13, 2)::text,
      'merchant', draft ->> 'merchant',
      'suggested_category', nullif(draft ->> 'category', '待分类')
    ));
  end if;
  return result;
end;
$$;

revoke all on function moneytrail_private.sms_receive(text, text, boolean) from public, anon, authenticated;

create or replace function public.moneytrail_receive_sms(p_token text, p_message text)
returns jsonb language sql security definer set search_path = '' as $$
  select moneytrail_private.sms_receive(p_token, p_message, false);
$$;

create function public.moneytrail_sms_beta_prepare(p_token text, p_message text)
returns jsonb language sql security definer set search_path = '' as $$
  select pg_catalog.jsonb_build_object('review_token', '') || moneytrail_private.sms_receive(p_token, p_message, true);
$$;

create function public.moneytrail_sms_beta_confirm(p_review_token text, p_category text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  invalid constant jsonb := pg_catalog.jsonb_build_object('accepted', false, 'status', 'invalid');
  duplicate_warning constant text := '账本中已有10分钟内同类型、同金额的记录，可能重复，请核对后确认。';
  review moneytrail_private.sms_beta_reviews%rowtype;
  entry moneytrail_private.sms_inbox%rowtype;
  review_user uuid;
  category text;
  confirmed_draft jsonb;
  v_transaction_id text;
begin
  if p_review_token is null or pg_catalog.char_length(p_review_token) <> 78
    or p_review_token !~ '^mt_sms_review_[a-f0-9]{64}$'
    or p_category is null or pg_catalog.char_length(p_category) > 64 then
    return invalid;
  end if;

  -- Normalize unambiguous legacy aliases using the ledger's existing taxonomy.
  category := moneytrail_private.sms_normalize_transaction(
    pg_catalog.jsonb_build_object('category', pg_catalog.btrim(pg_catalog.normalize(p_category, 'NFKC')))
  ) ->> 'category';
  if moneytrail_private.sms_is_expense_category(category) is not true then return invalid; end if;

  select * into review from moneytrail_private.sms_beta_reviews
    where token_hash = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_review_token, 'UTF8')), 'hex');
  if review.inbox_id is null or review.expires_at <= pg_catalog.clock_timestamp() then return invalid; end if;

  -- Take locks in the same order as account review and bulk apply: settings, then inbox, then ledger.
  select config.user_id into review_user
    from moneytrail_private.sms_inbox as inbox
    join moneytrail_private.sms_settings as config on config.user_id = inbox.user_id
    join auth.users as account on account.id = config.user_id
    where inbox.id = review.inbox_id and config.token_hash = review.intake_token_hash
      and account.email is not null and pg_catalog.btrim(account.email) <> ''
      and account.email_confirmed_at is not null and account.deleted_at is null
      and (account.banned_until is null or account.banned_until <= pg_catalog.clock_timestamp())
    for update of config;
  if review_user is null then return invalid; end if;

  select * into entry from moneytrail_private.sms_inbox
    where id = review.inbox_id and user_id = review_user for update;
  if entry.id is null or review.expires_at <= pg_catalog.clock_timestamp() then return invalid; end if;
  if entry.status = 'recorded' then
    return pg_catalog.jsonb_build_object('accepted', true, 'status', 'recorded', 'id', entry.id);
  end if;
  if entry.status <> 'pending' or entry.draft ->> 'kind' is distinct from 'expense' then return invalid; end if;

  v_transaction_id := 'sms-' || entry.id::text;
  confirmed_draft := entry.draft;
  if confirmed_draft ->> 'category' <> category then confirmed_draft := confirmed_draft - 'subcategory'; end if;
  confirmed_draft := pg_catalog.jsonb_set(confirmed_draft, '{category}', pg_catalog.to_jsonb(category));
  confirmed_draft := pg_catalog.jsonb_set(confirmed_draft, '{smsEvidence,classificationReason}', pg_catalog.to_jsonb('快捷指令确认：' || category));

  if not moneytrail_private.sms_append(review_user,
    confirmed_draft || pg_catalog.jsonb_build_object('id', v_transaction_id, 'source', 'sms', 'sourceRef', v_transaction_id), true) then
    update moneytrail_private.sms_inbox set warnings = warnings || pg_catalog.jsonb_build_array(duplicate_warning)
      where id = entry.id and not (warnings ? duplicate_warning);
    return pg_catalog.jsonb_build_object('accepted', true, 'status', 'pending', 'id', entry.id);
  end if;

  update moneytrail_private.sms_inbox set status = 'recorded', raw_text = null,
    draft = confirmed_draft, warnings = '[]'::jsonb, reason = null, transaction_id = v_transaction_id
    where id = entry.id;
  return pg_catalog.jsonb_build_object('accepted', true, 'status', 'recorded', 'id', entry.id);
end;
$$;

revoke all on function public.moneytrail_receive_sms(text, text) from public, anon, authenticated;
revoke all on function public.moneytrail_sms_beta_prepare(text, text) from public, anon, authenticated;
revoke all on function public.moneytrail_sms_beta_confirm(text, text) from public, anon, authenticated;
grant execute on function public.moneytrail_receive_sms(text, text) to anon, authenticated;
grant execute on function public.moneytrail_sms_beta_prepare(text, text) to anon, authenticated;
grant execute on function public.moneytrail_sms_beta_confirm(text, text) to anon, authenticated;

notify pgrst, 'reload schema';
commit;
