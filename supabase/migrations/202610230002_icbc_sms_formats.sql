-- Apply after the SMS automatic-debit upgrade (202610230001). Bank balance
-- formatting must not block an otherwise valid debit. Commas are accepted only
-- as complete three-digit groups; balances never supply the recorded amount.
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
  sms := pg_catalog.btrim(pg_catalog.normalize(p_text, 'NFKC'),
    ' ' || pg_catalog.chr(9) || pg_catalog.chr(10) || pg_catalog.chr(13));
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
    '^尾号[0-9xX*]{4}卡(?:([0-9]{4})年)?([0-9]{1,2})月([0-9]{1,2})日([0-9]{1,2}):([0-9]{2})支出\(([^()]*)\)((?:[0-9]{1,20}|[0-9]{1,3}(?:,[0-9]{3}){1,6})(?:\.[0-9]{1,2})?)元(?:,余额(?:[0-9xX*]{1,20}|[0-9xX*]{1,3}(?:,[0-9xX*]{3}){1,6})(?:\.[0-9xX*]{1,2})?元)?[。.]?【工商银行】$'
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

  -- Strip grouping only from the independently captured debit amount.
  -- The optional balance is validated by the template but is never read.
  amount_text := pg_catalog.replace(parts[7], ',', '');
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
      'merchant', merchant_name, 'category', case
        when transaction_kind = 'expense' and not review_needed
          and merchant_name ~ '(药房|药店|医院|诊所)' then '医疗'
        else '待分类' end, 'source', 'sms', 'note', ''
    ),
    'warnings', result_warnings, 'requires_review', review_needed, 'error', null
  );
end;
$$;

revoke all on function moneytrail_private.moneytrail_parse_icbc_sms(text, timestamp with time zone, text)
  from public, anon, authenticated;
comment on function moneytrail_private.moneytrail_parse_icbc_sms(text, timestamp with time zone, text)
  is 'Private ICBC debit parser with strict grouped RMB amounts and balances. Eligible medical merchants classify as medical; ambiguous transfers, group collections, reversals, formats and dates still require review.';

-- Verify the reported bank format in this database before accepting the upgrade.
-- Synthetic input only: this assertion never receives or writes a ledger entry.
do $verify$
declare
  parsed jsonb;
begin
  parsed := moneytrail_private.moneytrail_parse_icbc_sms(
    '尾号xxxx卡10月23日09:47支出(消费支付宝-示例大药房)375元，余额12,345.94元。【工商银行】',
    '2026-10-23T01:47:24Z'::timestamp with time zone, 'review'
  );
  if parsed #>> '{draft,amountCents}' is distinct from '37500'
    or parsed #>> '{draft,category}' is distinct from '医疗'
    or parsed -> 'requires_review' is distinct from 'false'::jsonb
    or parsed -> 'error' is distinct from 'null'::jsonb
  then
    raise exception '短信识别规则自检未通过，本次更新已回滚。';
  end if;
end;
$verify$;

-- Replacing the helper updates future intake and explicit reprocessing only.
-- No account mode, token, inbox row or ledger is changed by this migration.
notify pgrst, 'reload schema';
commit;
