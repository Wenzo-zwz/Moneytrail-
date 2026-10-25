-- Restore only a missing fullwidth branch close in a complete ASCII ICBC
-- debit envelope. This changes the parser view; no stored SMS is rewritten.
begin;

create or replace function moneytrail_private.sms_repair_missing_branch_bracket(p_text text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  sms text;
  parts text[];
begin
  if p_text is null or pg_catalog.char_length(p_text) > 2048 then return p_text; end if;
  sms := pg_catalog.btrim(p_text, ' ' || pg_catalog.chr(9) || pg_catalog.chr(10) || pg_catalog.chr(13));
  parts := pg_catalog.regexp_match(sms,
    '^(尾号[0-9xX*]{4}卡(?:[0-9]{4}年)?[0-9]{1,2}月[0-9]{1,2}日[0-9]{1,2}:[0-9]{2}支出\()([^()（）\r\n]{1,160})（([^()（）\r\n]{1,40})(\)(?:[0-9]{1,20}|[0-9]{1,3}(?:,[0-9]{3}){1,6})(?:\.[0-9]{1,2})?元(?:[，,]余额(?:[0-9xX*]{1,20}|[0-9xX*]{1,3}(?:,[0-9xX*]{3}){1,6})(?:\.[0-9xX*]{1,2})?元)?[。.]?【工商银行】)$'
  );
  if parts is null or parts[3] !~ '(店|营业部|支行|分行)$' then return p_text; end if;
  return parts[1] || parts[2] || '（' || parts[3] || '）' || parts[4];
end;
$$;

revoke all on function moneytrail_private.sms_repair_missing_branch_bracket(text)
  from public, anon, authenticated;
comment on function moneytrail_private.sms_repair_missing_branch_bracket(text)
  is 'Private narrow parser-view repair for one missing fullwidth branch close; never rewrites stored SMS. All parser guards still apply.';

create or replace function moneytrail_private.sms_classify(p_merchant text)
returns jsonb language plpgsql immutable set search_path='' as $$
declare k text:=moneytrail_private.sms_merchant_key(p_merchant); c text:='待分类'; r text:='商户用途待分类'; kind text:='expense'; review boolean:=false;
begin
 if p_merchant ~ '群收款' then review:=true; r:='群收款需要核对';
 elsif pg_catalog.btrim(pg_catalog.normalize(p_merchant,'NFKC')) ~ '^(消费|支付|付款)?(微信零钱充值|支付宝余额充值|本人账户互转|本人账户间转账|信用卡还款)$' then kind:='transfer';r:='明确资金周转';
 elsif k='' then review:=true;r:='支付渠道或转账用途不明确';
 elsif k ~ '(药房|药店|医院|诊所|体检|买药)' then c:='医疗';
 elsif k ~ '(酒店|宾馆|住宿|房租|水费|电费|燃气|物业|宽带|话费|流量|手机充值)' then c:='居住';
 elsif k ~* '(滴滴|嘀嘀无限|出租车|打车|网约车|公交|地铁|火车票|铁路|12306|加油|油站|停车|通行费|ETC)' then c:='交通';
 elsif k ~ '(课程|培训|教材|书店|学费|考试)' then c:='学习';
 elsif k ~* '(台球|桌球|电影|影院|KTV|游戏|影音会员|视频会员|音乐会员|景区|门票|游乐园)' then c:='娱乐';
 elsif k ~ '(外卖|餐厅|饭店|餐饮|咖啡|奶茶|早餐|烧烤|火锅|面馆|快餐|食堂)' then c:='餐饮';
 elsif k ~ '(烟酒|副食|超市|便利店|服饰|服装|数码|日用品)' then c:='购物';
 elsif k ~ '美团' then c:='餐饮';r:='美团默认餐饮';
 elsif k ~ '(京东|淘宝|天猫|拼多多)' then c:='购物';r:='电商平台默认购物'; end if;
 if c<>'待分类' and r='商户用途待分类' then r:='商户关键词：'||c; end if;
 return pg_catalog.jsonb_build_object('category',c,'kind',kind,'requires_review',review,'reason',r);
end; $$;
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
  depth integer := 0;
  ch text;
  idx integer;
  classification jsonb;
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
  sms := pg_catalog.btrim(pg_catalog.normalize(moneytrail_private.sms_repair_missing_branch_bracket(p_text), 'NFKC'),
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
    '^尾号[0-9xX*]{4}卡(?:([0-9]{4})年)?([0-9]{1,2})月([0-9]{1,2})日([0-9]{1,2}):([0-9]{2})支出\((.*)\)((?:[0-9]{1,20}|[0-9]{1,3}(?:,[0-9]{3}){1,6})(?:\.[0-9]{1,2})?)元(?:,余额(?:[0-9xX*]{1,20}|[0-9xX*]{1,3}(?:,[0-9xX*]{3}){1,6})(?:\.[0-9xX*]{1,2})?元)?[。.]?【工商银行】$'
  );
  if parts is null then
    return failure || pg_catalog.jsonb_build_object('error', '暂不支持这条短信的格式，请手动核对后记账。');
  end if;
  merchant_name := pg_catalog.btrim(parts[6]);
  for idx in 1..pg_catalog.char_length(merchant_name) loop
    ch := pg_catalog.substr(merchant_name, idx, 1);
    if ch = '(' then depth := depth + 1; elsif ch = ')' then depth := depth - 1; end if;
    if depth < 0 then return failure || pg_catalog.jsonb_build_object('error','交易括号不配对。'); end if;
  end loop;
  if depth <> 0 or merchant_name ~ '(支出|【工商银行】)' then
    return failure || pg_catalog.jsonb_build_object('error','交易描述包含不配对括号或多事件。');
  end if;
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

  classification := moneytrail_private.sms_classify(merchant_name);
  review_needed := (classification ->> 'requires_review')::boolean;
  transaction_kind := classification ->> 'kind';
  if review_needed then result_warnings := pg_catalog.jsonb_build_array(classification ->> 'reason'); end if;

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
      'merchant', merchant_name, 'category', classification ->> 'category', 'source', 'sms', 'note', ''
    ),
    'warnings', result_warnings, 'requires_review', review_needed, 'error', null
  );
end;
$$;

revoke all on function moneytrail_private.moneytrail_parse_icbc_sms(text, timestamp with time zone, text)
  from public, anon, authenticated;


commit;
