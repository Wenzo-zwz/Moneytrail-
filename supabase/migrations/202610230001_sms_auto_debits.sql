-- Apply after SMS migrations 003 and 004. A validated ICBC debit is an expense
-- even when the description names a bare merchant or payment channel. Unknown
-- merchant/category is distinct from an ambiguous transfer or failed debit.
begin;

create schema if not exists moneytrail_private;
revoke all on schema moneytrail_private from public, anon, authenticated;

create or replace function moneytrail_private.moneytrail_parse_icbc_sms(
  p_text text,
  p_received_at timestamp with time zone,
  p_group_kind text default 'review'
)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  sms text;
  parts text[];
  merchant_name text;
  amount_text text;
  amount_cents bigint;
  local_receipt timestamp without time zone;
  transaction_time timestamp without time zone;
  transaction_year integer;
  transaction_month integer;
  transaction_day integer;
  transaction_hour integer;
  transaction_minute integer;
  transaction_kind text := 'expense';
  review_needed boolean := false;
  result_warnings jsonb := '[]'::jsonb;
  failure jsonb := pg_catalog.jsonb_build_object(
    'draft', null, 'warnings', '[]'::jsonb, 'requires_review', true, 'error', null
  );
begin
  if p_group_kind is null or p_group_kind not in ('review', 'expense', 'transfer') then
    return failure || pg_catalog.jsonb_build_object('error', '群收款处理方式无效，请重新配置。');
  end if;
  if p_text is null or pg_catalog.char_length(p_text) < 1 or pg_catalog.char_length(p_text) > 2048 then
    return failure || pg_catalog.jsonb_build_object('error', '短信为空或过长，无法安全识别。');
  end if;
  if p_received_at is null or not pg_catalog.isfinite(p_received_at) then
    return failure || pg_catalog.jsonb_build_object('error', '短信接收时间无效。');
  end if;

  -- NFKC folds fullwidth digits, decimal points, colons, commas and brackets.
  -- PostgreSQL (including Supabase) is UTF-8; this is not a locale guess.
  sms := pg_catalog.btrim(pg_catalog.normalize(p_text, 'NFKC'));
  if sms ~* '(验证码|校验码|动态码|短信口令|口令|密码|OTP|verification|one[ -]?time)' then
    return failure || pg_catalog.jsonb_build_object('error', '验证码或安全验证短信不用于记账。');
  end if;
  if sms ~* '(美元|美金|港币|港元|日元|欧元|英镑|外币|澳元|加元|新加坡元|新西兰元|USD|HKD|JPY|EUR|GBP|AUD|CAD|SGD|NZD|[$€£₩₹¥])' then
    return failure || pg_catalog.jsonb_build_object('error', '目前仅支持明确的人民币支出，请手动核对币种。');
  end if;

  -- Anchor the entire message. A second event, an extra transaction amount,
  -- negative amounts, decimal fractions below one cent or unsupported bank
  -- signatures cannot accidentally match part of an otherwise valid message.
  parts := pg_catalog.regexp_match(sms,
    '^尾号[0-9xX*]{4}卡(?:([0-9]{4})年)?([0-9]{1,2})月([0-9]{1,2})日([0-9]{1,2}):([0-9]{2})支出\(([^()]*)\)([0-9]{1,20}(?:\.[0-9]{1,2})?)元(?:,余额[0-9xX*]{1,20}(?:\.[0-9xX*]{1,2})?元)?[。.]?【工商银行】$'
  );
  if parts is null then
    return failure || pg_catalog.jsonb_build_object('error', '暂不支持这条短信的格式，请手动核对后记账。');
  end if;
  merchant_name := pg_catalog.btrim(parts[6]);
  if pg_catalog.char_length(merchant_name) not between 1 and 200
    or merchant_name ~ '[[:cntrl:]]'
    or pg_catalog.regexp_replace(merchant_name, '[[:space:]]', '', 'g')
      ~* '([0-9](?:[0-9,.]*[0-9])?(元|人民币)|人民币[0-9]|(CNY|RMB)[0-9])'
  then
    return failure || pg_catalog.jsonb_build_object('error', '交易描述为空、过长或包含多笔金额，请手动核对。');
  end if;

  amount_text := parts[7];
  if pg_catalog.char_length(pg_catalog.split_part(amount_text, '.', 1)) > 11 then
    return failure || pg_catalog.jsonb_build_object('error', '交易金额超出支持范围，请手动核对。');
  end if;
  -- Integer-only decimal conversion: 30.90 -> 30 * 100 + 90.
  amount_cents := pg_catalog.split_part(amount_text, '.', 1)::bigint * 100
    + pg_catalog.rpad(pg_catalog.split_part(amount_text, '.', 2), 2, '0')::bigint;
  if amount_cents < 1 or amount_cents > 1000000000000 then
    return failure || pg_catalog.jsonb_build_object('error', '交易金额必须大于零且在支持范围内。');
  end if;

  local_receipt := p_received_at at time zone 'Asia/Shanghai';
  transaction_year := coalesce(parts[1]::integer, pg_catalog.date_part('year', local_receipt)::integer);
  transaction_month := parts[2]::integer;
  transaction_day := parts[3]::integer;
  transaction_hour := parts[4]::integer;
  transaction_minute := parts[5]::integer;
  if transaction_year not between 1 and 9999
    or transaction_month not between 1 and 12 or transaction_day not between 1 and 31
    or transaction_hour not between 0 and 23 or transaction_minute not between 0 and 59
  then
    return failure || pg_catalog.jsonb_build_object('error', '交易日期或时间无效，请手动核对。');
  end if;

  -- At New Year a December SMS belongs to the previous year. A provisional
  -- first-of-month timestamp permits inferring a leap year before strict day
  -- validation; make_timestamp below never silently rolls an invalid day over.
  transaction_time := pg_catalog.make_timestamp(transaction_year, transaction_month, 1,
    transaction_hour, transaction_minute, 0) + (transaction_day - 1) * interval '1 day';
  if parts[1] is null and transaction_time > local_receipt + interval '2 days' then
    transaction_year := transaction_year - 1;
  end if;
  begin
    if transaction_year < 1 then
      return failure || pg_catalog.jsonb_build_object('error', '交易日期或时间无效，请手动核对。');
    end if;
    transaction_time := pg_catalog.make_timestamp(transaction_year, transaction_month,
      transaction_day, transaction_hour, transaction_minute, 0);
  exception when datetime_field_overflow then
    return failure || pg_catalog.jsonb_build_object('error', '交易日期或时间无效，请手动核对。');
  end;

  -- The anchored bank template already states 支出 with a separate amount and
  -- transaction time. A bare merchant/payment channel needs categorization,
  -- not another approval, unless one of the explicit ambiguity guards matches.
  if merchant_name ~ '^(转账)?(财付通|微信|微信支付)-?群收款$' then
    merchant_name := pg_catalog.regexp_replace(merchant_name, '^转账', '');
    if p_group_kind = 'review' then
      review_needed := true;
      result_warnings := result_warnings || pg_catalog.jsonb_build_array('群收款可能是消费或转账，请核对后确认。');
    else
      transaction_kind := p_group_kind;
    end if;
  elsif merchant_name ~ '(转账|转出|转入|充值|提现|取现|取款|支取|还款|偿还|缴款|还贷|贷款|余额宝|零钱通|花呗|借呗|白条|网商贷|理财|基金|证券|买入|申购|赎回)' then
    transaction_kind := 'transfer';
    review_needed := true;
    result_warnings := result_warnings || pg_catalog.jsonb_build_array('交易涉及转账、资金存取、还款或投资，请核对实际用途。');
  elsif merchant_name ~ '群收款' then
    -- Extra labels or qualifiers are outside the recognized group template.
    -- A 消费/支付 prefix must not bypass the user's group-review preference.
    review_needed := true;
    result_warnings := result_warnings || pg_catalog.jsonb_build_array('群收款可能是消费或转账，请核对后确认。');
  end if;

  if merchant_name ~ '(退款|退回|冲正|撤销|失败|未成功|取消)' then
    review_needed := true;
    result_warnings := result_warnings || pg_catalog.jsonb_build_array('交易描述涉及退款、撤销或失败，请手动核对实际扣款。');
  end if;

  if transaction_time > local_receipt + interval '10 minutes' then
    review_needed := true;
    result_warnings := result_warnings || pg_catalog.jsonb_build_array('交易时间晚于短信接收时间，请核对。');
  elsif transaction_time < local_receipt - interval '7 days' then
    review_needed := true;
    result_warnings := result_warnings || pg_catalog.jsonb_build_array('交易时间已超过7天，请核对是否重复或补录。');
  end if;

  return pg_catalog.jsonb_build_object(
    'draft', pg_catalog.jsonb_build_object(
      'kind', transaction_kind, 'amountCents', amount_cents,
      'date', pg_catalog.to_char(transaction_time, 'YYYY-MM-DD"T"HH24:MI'),
      'merchant', merchant_name, 'category', '待分类', 'source', 'sms', 'note', ''
    ),
    'warnings', result_warnings, 'requires_review', review_needed, 'error', null
  );
end;
$$;

revoke all on function moneytrail_private.moneytrail_parse_icbc_sms(text, timestamp with time zone, text)
  from public, anon, authenticated;
comment on function moneytrail_private.moneytrail_parse_icbc_sms(text, timestamp with time zone, text)
  is 'Private ICBC debit parser. Valid ordinary debits can record with an unknown category; transfers, group collections, failed/reversed debits, invalid formats and dates still require review.';

-- Reclassification is explicit and account-bound. Applying this migration never
-- processes existing inbox rows or changes the account's chosen recording mode.
create or replace function public.moneytrail_sms_reprocess_pending()
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  caller uuid := moneytrail_private.sms_require_account();
  settings moneytrail_private.sms_settings%rowtype;
  locked_ids uuid[];
  entry_id uuid;
  entry moneytrail_private.sms_inbox%rowtype;
  parsed jsonb;
  transaction jsonb;
  v_transaction_id text;
  recorded_count integer := 0;
  pending_count integer;
begin
  -- Match ingestion's settings -> inbox -> ledger ordering. Holding this row
  -- serializes mode changes and incoming receipts for the same account.
  select config.* into settings from moneytrail_private.sms_settings as config
    where config.user_id = caller for update;
  if settings.user_id is null or settings.mode <> 'auto' then
    raise exception using errcode = '22023', message = 'Automatic SMS recording must be selected before reprocessing.';
  end if;

  -- Acquire every target lock before acquiring any ledger lock. Individual
  -- confirmations lock inbox then ledger; locking rows lazily during appends
  -- would introduce the reverse order between two such operations.
  select coalesce(pg_catalog.array_agg(target.id order by target.received_at, target.id), '{}'::uuid[])
    into locked_ids from (
      select inbox.id, inbox.received_at from moneytrail_private.sms_inbox as inbox
      where inbox.user_id = caller and inbox.status = 'pending'
      order by inbox.received_at, inbox.id for update skip locked
    ) as target;

  foreach entry_id in array locked_ids loop
    select inbox.* into entry from moneytrail_private.sms_inbox as inbox
      where inbox.id = entry_id and inbox.user_id = caller and inbox.status = 'pending';
    if entry.id is null then continue; end if;
    -- Use the original receipt as the reference for year inference and stale
    -- message checks, so waiting in an inbox does not change a transaction date.
    parsed := moneytrail_private.moneytrail_parse_icbc_sms(entry.raw_text, entry.received_at, 'review');
    if parsed -> 'draft' is not null and parsed -> 'draft' <> 'null'::jsonb
      and parsed -> 'requires_review' = 'false'::jsonb and parsed -> 'error' = 'null'::jsonb then
      v_transaction_id := 'sms-' || entry.id::text;
      transaction := (parsed -> 'draft') || pg_catalog.jsonb_build_object(
        'id', v_transaction_id, 'source', 'sms', 'sourceRef', v_transaction_id
      );
      if moneytrail_private.sms_append(caller, transaction, true) then
        update moneytrail_private.sms_inbox set status = 'recorded', raw_text = null,
          draft = parsed -> 'draft', warnings = '[]'::jsonb, reason = null,
          transaction_id = v_transaction_id where id = entry.id and user_id = caller;
        recorded_count := recorded_count + 1;
        continue;
      end if;
      parsed := pg_catalog.jsonb_set(parsed, '{warnings}', (parsed -> 'warnings') ||
        pg_catalog.jsonb_build_array('账本中已有10分钟内同类型、同金额的记录，可能重复，请核对后确认。'));
    end if;
    update moneytrail_private.sms_inbox set draft = parsed -> 'draft',
      warnings = coalesce(parsed -> 'warnings', '[]'::jsonb), reason = parsed ->> 'error'
      where id = entry.id and user_id = caller;
  end loop;

  select pg_catalog.count(*)::integer into pending_count
    from moneytrail_private.sms_inbox where user_id = caller and status = 'pending';
  return pg_catalog.jsonb_build_object('recorded_count', recorded_count, 'pending_count', pending_count);
end;
$$;
revoke all on function public.moneytrail_sms_reprocess_pending() from public, anon, authenticated;
grant execute on function public.moneytrail_sms_reprocess_pending() to authenticated;
comment on function public.moneytrail_sms_reprocess_pending() is 'Explicitly reparse only the signed-in active account pending SMS and append eligible ordinary debits to the latest ledger. Never overrides review mode or group review.';

notify pgrst, 'reload schema';
commit;
