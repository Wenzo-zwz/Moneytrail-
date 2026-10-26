-- Canonical local-life categories and permanent masked SMS receipts.
-- DDL only: existing ledgers, inbox entries and personal rules are not rewritten.
begin;

create or replace function moneytrail_private.sms_normalize_transaction(p_tx jsonb)
returns jsonb language sql immutable set search_path='' as $$
 select case when p_tx->>'category' in ('餐饮','娱乐') then
 p_tx || pg_catalog.jsonb_build_object('category','本地生活','subcategory',coalesce(p_tx->>'subcategory',case when p_tx->>'category'='餐饮' then '餐饮' else '休闲娱乐' end)) else p_tx end;
$$;
create or replace function moneytrail_private.sms_mask_evidence(p_text text)
returns text language plpgsql immutable set search_path='' as $$
declare t text:=pg_catalog.normalize(p_text,'NFKC');
begin
 t:=pg_catalog.regexp_replace(t,'((?:银行卡|信用卡|储蓄卡|借记卡|卡|账户|账号)[[:space:]]*\([[:space:]]*)[0-9*xX×•]+(?:[ -][0-9*xX×•]{4})*([[:space:]]*\))','\1[已隐藏]\2','g');
 t:=pg_catalog.regexp_replace(t,'((?:信用卡|储蓄卡|借记卡|银行卡|账户)(?:为|是)?[[:space:]]*[:：]?[[:space:]]*)[0-9*xX×•]{4,}(?:[ -][0-9*xX×•]{4})*','\1[已隐藏]','g');
 t:=pg_catalog.regexp_replace(t,'(卡[[:space:]]*[:：]?[[:space:]]*)[0-9*xX×•]{4,}(?=[[:space:]]*(?:于|在|支出|消费|支付|付款|扣款|退款|转账|[，,。；;]))','\1[已隐藏]','g');
 t:=pg_catalog.regexp_replace(t,'((?:尾号|末四位|末4位|卡号|账号)(?:为|是)?[[:space:]]*[:：]?[[:space:]]*)[0-9*xX×•]+(?:[ -][0-9*xX×•]{4})*','\1[已隐藏]','g');
 t:=pg_catalog.regexp_replace(t,'[0-9*xX×•]{4,}(?=的?(?:信用卡|储蓄卡|借记卡|银行卡|账户|账号|卡(?=于|在|消费|支付|支出|付款|扣款|退款|转账|[0-9]|[[:space:]，,。;；:]|$)))','[已隐藏]','g');
 t:=pg_catalog.regexp_replace(t,'((?:(?:账户|可用|活期|信用卡)?余额|剩余(?:金额|余额)?|可用额度)(?:为|是)?[[:space:]]*[:：]?[[:space:]]*)(?:(?:人民币|RMB|CNY|[¥￥])[[:space:]]*)?[+−-]?[0-9*xX×•]+(?:[, .[:space:]][0-9*xX×•]+)*','\1[已隐藏]','gi');
 return t;
end; $$;
create or replace function moneytrail_private.sms_evidence(p_text text,p_received timestamptz,p_reason text)
returns jsonb language sql immutable set search_path='' as $$
 select pg_catalog.jsonb_build_object('text',moneytrail_private.sms_mask_evidence(p_text),'receivedAt',pg_catalog.to_char(p_received at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'classificationReason',pg_catalog.left(p_reason,200),'ruleVersion','local-life-v1');
$$;
create or replace function moneytrail_private.sms_valid_metadata(p_tx jsonb)
returns boolean language plpgsql immutable set search_path='' as $$
declare e jsonb:=p_tx->'smsEvidence'; stamp timestamptz;
begin
 if p_tx ? 'subcategory' and (pg_catalog.jsonb_typeof(p_tx->'subcategory') is distinct from 'string' or pg_catalog.char_length(p_tx->>'subcategory')>40 or p_tx->>'subcategory' !~ '[^[:space:]]') then return false; end if;
 if p_tx ? 'platform' and (pg_catalog.jsonb_typeof(p_tx->'platform') is distinct from 'string' or p_tx->>'platform' not in ('美团','京东','淘宝','天猫','拼多多','滴滴')) then return false; end if;
 if p_tx ? 'smsEvidence' then
  if pg_catalog.jsonb_typeof(e) is distinct from 'object' or e-array['text','receivedAt','classificationReason','ruleVersion']<>'{}'::jsonb
   or pg_catalog.jsonb_typeof(e->'text') is distinct from 'string' or pg_catalog.char_length(e->>'text')>3000 or e->>'text' !~ '[^[:space:]]' then return false; end if;
  if e ? 'classificationReason' and (pg_catalog.jsonb_typeof(e->'classificationReason') is distinct from 'string' or pg_catalog.char_length(e->>'classificationReason')>200) then return false; end if;
  if e ? 'ruleVersion' and (pg_catalog.jsonb_typeof(e->'ruleVersion') is distinct from 'string' or pg_catalog.char_length(e->>'ruleVersion')>64) then return false; end if;
  if e ? 'receivedAt' then
   if pg_catalog.jsonb_typeof(e->'receivedAt') is distinct from 'string' or e->>'receivedAt' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-5][0-9](\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$' then return false; end if;
   -- PostgreSQL accepts 24:00 and leap seconds by normalizing them; the client does not.
   if not public.moneytrail_valid_local_datetime(pg_catalog.left(e->>'receivedAt',16)) then return false; end if;
   stamp:=(e->>'receivedAt')::timestamptz;
   if not pg_catalog.isfinite(stamp) then return false; end if;
  end if;
 end if;
 return true;
exception when others then return false;
end; $$;

create or replace function public.moneytrail_valid_payload(p_data jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  entry jsonb;
  amount numeric;
  month_value jsonb;
begin
  -- The limit covers the complete snapshot, not only the transactions array.
  if p_data is null
    or pg_catalog.octet_length(p_data::text) > 5242880
    or pg_catalog.jsonb_typeof(p_data) is distinct from 'object'
    or p_data - array['version', 'transactions', 'budgetCents', 'billCheckedMonths'] <> '{}'::jsonb
    or (p_data -> 'version') is distinct from '1'::jsonb
    or pg_catalog.jsonb_typeof(p_data -> 'budgetCents') is distinct from 'number'
    or pg_catalog.jsonb_typeof(p_data -> 'transactions') is distinct from 'array'
    or pg_catalog.jsonb_typeof(p_data -> 'billCheckedMonths') is distinct from 'array'
  then
    return false;
  end if;

  amount := (p_data ->> 'budgetCents')::numeric;
  if amount < 0 or amount > 1000000000000 or pg_catalog.floor(amount) <> amount
    or pg_catalog.jsonb_array_length(p_data -> 'transactions') > 100000
    or pg_catalog.jsonb_array_length(p_data -> 'billCheckedMonths') > 12000
  then
    return false;
  end if;

  for month_value in select value from pg_catalog.jsonb_array_elements(p_data -> 'billCheckedMonths') loop
    if pg_catalog.jsonb_typeof(month_value) is distinct from 'string'
      or (month_value #>> '{}') !~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
      or pg_catalog.left(month_value #>> '{}', 4) = '0000'
    then
      return false;
    end if;
  end loop;
  if (select pg_catalog.count(*) from pg_catalog.jsonb_array_elements(p_data -> 'billCheckedMonths'))
    <> (select pg_catalog.count(distinct value) from pg_catalog.jsonb_array_elements(p_data -> 'billCheckedMonths'))
  then
    return false;
  end if;

  for entry in select value from pg_catalog.jsonb_array_elements(p_data -> 'transactions') loop
    if pg_catalog.jsonb_typeof(entry) is distinct from 'object'
      or entry - array['id', 'kind', 'amountCents', 'date', 'merchant', 'category', 'source', 'note', 'sourceRef', 'linkedTransactionId', 'subcategory', 'platform', 'smsEvidence'] <> '{}'::jsonb
      or pg_catalog.jsonb_typeof(entry -> 'id') is distinct from 'string'
      or pg_catalog.char_length(entry ->> 'id') > 128
      or (entry ->> 'id') !~ '[^[:space:]]'
      or pg_catalog.jsonb_typeof(entry -> 'kind') is distinct from 'string'
      or (entry ->> 'kind') not in ('expense', 'refund', 'transfer', 'income')
      or pg_catalog.jsonb_typeof(entry -> 'amountCents') is distinct from 'number'
      or pg_catalog.jsonb_typeof(entry -> 'date') is distinct from 'string'
      or not public.moneytrail_valid_local_datetime(entry ->> 'date')
      or pg_catalog.jsonb_typeof(entry -> 'merchant') is distinct from 'string'
      or pg_catalog.char_length(entry ->> 'merchant') > 200
      or (entry ->> 'merchant') !~ '[^[:space:]]'
      or pg_catalog.jsonb_typeof(entry -> 'category') is distinct from 'string'
      or (entry ->> 'category') not in ('本地生活', '餐饮', '购物', '交通', '居住', '娱乐', '医疗', '学习', '其他', '待分类')
      or pg_catalog.jsonb_typeof(entry -> 'source') is distinct from 'string'
      or (entry ->> 'source') not in ('manual', 'sms', 'wechat', 'alipay', 'csv')
      or pg_catalog.jsonb_typeof(entry -> 'note') is distinct from 'string'
      or pg_catalog.char_length(entry ->> 'note') > 2000
    then
      return false;
    end if;
    if not moneytrail_private.sms_valid_metadata(entry) then return false; end if;
    amount := (entry ->> 'amountCents')::numeric;
    if amount <= 0 or amount > 1000000000000 or pg_catalog.floor(amount) <> amount then
      return false;
    end if;
    if entry ? 'sourceRef' and (
      pg_catalog.jsonb_typeof(entry -> 'sourceRef') is distinct from 'string'
      or pg_catalog.char_length(entry ->> 'sourceRef') > 200
      or (entry ->> 'sourceRef') !~ '[^[:space:]]'
    ) then
      return false;
    end if;
    if entry ? 'linkedTransactionId' and (
      (entry ->> 'kind') <> 'refund'
      or pg_catalog.jsonb_typeof(entry -> 'linkedTransactionId') is distinct from 'string'
      or pg_catalog.char_length(entry ->> 'linkedTransactionId') > 128
      or (entry ->> 'linkedTransactionId') !~ '[^[:space:]]'
    ) then
      return false;
    end if;
  end loop;

  if (select pg_catalog.count(*) from pg_catalog.jsonb_array_elements(p_data -> 'transactions'))
    <> (select pg_catalog.count(distinct value ->> 'id') from pg_catalog.jsonb_array_elements(p_data -> 'transactions'))
  then
    return false;
  end if;
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_data -> 'transactions') as refunds(value)
    where refunds.value ? 'linkedTransactionId'
      and not exists (
        select 1
        from pg_catalog.jsonb_array_elements(p_data -> 'transactions') as expenses(value)
        where expenses.value ->> 'id' = refunds.value ->> 'linkedTransactionId'
          and expenses.value ->> 'kind' = 'expense'
      )
  ) then
    return false;
  end if;
  return true;
exception when others then
  -- Malformed values are never a reason to accept a snapshot.
  return false;
end;
$$;

create or replace function public.save_moneytrail_ledger(p_data jsonb, p_expected_revision bigint)
returns setof public.moneytrail_ledgers
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := auth.uid();
  saved public.moneytrail_ledgers%rowtype;
  prior public.moneytrail_ledgers%rowtype;
  merged jsonb;
begin
  if caller is null then
    raise exception using errcode = '28000', message = 'Authentication is required.';
  end if;
  if p_expected_revision is null or p_expected_revision < 0 or p_expected_revision >= 9007199254740991
    or not public.moneytrail_valid_payload(p_data)
  then
    raise exception using errcode = '22023', message = 'Invalid ledger snapshot or revision.';
  end if;

  -- Lock and compare before preserving metadata; only incoming IDs survive.
  if p_expected_revision > 0 then
    select * into prior from public.moneytrail_ledgers where user_id=caller for update;
    if prior.user_id is null or prior.revision<>p_expected_revision then
      raise exception using errcode='40001',message='Ledger changed on another device. Reload before saving.';
    end if;
  end if;
  select coalesce(pg_catalog.jsonb_agg(moneytrail_private.sms_normalize_transaction(
    (coalesce(old.value,'{}'::jsonb)-array['id','kind','amountCents','date','merchant','category','source','note','sourceRef','linkedTransactionId']) || incoming.value
  ) order by incoming.ordinality),'[]'::jsonb) into merged
  from pg_catalog.jsonb_array_elements(p_data->'transactions') with ordinality incoming(value,ordinality)
  left join lateral (select value from pg_catalog.jsonb_array_elements(prior.data->'transactions') where value->>'id'=incoming.value->>'id') old on true;
  -- A new/changed refund association deliberately inherits even missing metadata.
  -- Resolve against the complete canonical incoming snapshot, independent of order,
  -- after legacy normalization and old-client preservation. Keep the refund's receipt.
  select coalesce(pg_catalog.jsonb_agg(
    case when incoming.value->>'kind'='refund'
      and incoming.value ? 'linkedTransactionId'
      and (old.value->>'kind' is distinct from 'refund'
        or old.value->>'linkedTransactionId' is distinct from incoming.value->>'linkedTransactionId')
    then (incoming.value-array['category','subcategory','platform'])
      || pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
        'category',original.value->'category','subcategory',original.value->'subcategory','platform',original.value->'platform'))
    else incoming.value end order by incoming.ordinality),'[]'::jsonb) into merged
  from pg_catalog.jsonb_array_elements(merged) with ordinality incoming(value,ordinality)
  left join lateral (select value from pg_catalog.jsonb_array_elements(prior.data->'transactions') where value->>'id'=incoming.value->>'id') old on true
  left join lateral (select value from pg_catalog.jsonb_array_elements(merged) where value->>'id'=incoming.value->>'linkedTransactionId' and value->>'kind'='expense') original on true;
  p_data:=pg_catalog.jsonb_set(p_data,'{transactions}',merged);
  if not public.moneytrail_valid_payload(p_data) then raise exception using errcode='22023',message='Preserved ledger snapshot is too large or invalid.'; end if;

  if p_expected_revision = 0 then
    insert into public.moneytrail_ledgers as target (user_id, data, revision, updated_at)
      values (caller, p_data, 1, pg_catalog.clock_timestamp())
      on conflict (user_id) do nothing
      returning target.* into saved;
  else
    update public.moneytrail_ledgers as target
      set data = p_data,
          revision = target.revision + 1,
          updated_at = pg_catalog.clock_timestamp()
      where target.user_id = caller and target.revision = p_expected_revision
      returning target.* into saved;
  end if;

  if saved.user_id is null then
    raise exception using errcode = '40001', message = 'Ledger changed on another device. Reload before saving.';
  end if;
  return next saved;
end;
$$;

create or replace function moneytrail_private.sms_classify(p_merchant text)
returns jsonb language plpgsql immutable set search_path='' as $$
declare k text:=moneytrail_private.sms_merchant_key(p_merchant); c text:='待分类'; r text:='商户用途待分类'; kind text:='expense'; review boolean:=false; detail text; platform text; normalized text:=pg_catalog.normalize(p_merchant,'NFKC');
begin
 if p_merchant ~ '群收款' then review:=true; r:='群收款需要核对';
 elsif pg_catalog.btrim(pg_catalog.normalize(p_merchant,'NFKC')) ~ '^(消费|支付|付款)?(微信零钱充值|支付宝余额充值|本人账户互转|本人账户间转账|信用卡还款)$' then kind:='transfer';r:='明确资金周转';
 elsif moneytrail_private.sms_is_platform_only_merchant(p_merchant) then c:='本地生活';r:='美团平台默认本地生活';
 elsif k='' then review:=true;r:='支付渠道或转账用途不明确';
 elsif k ~ '(药房|药店|医院|诊所|体检|买药)' then c:='医疗';
 elsif k ~ '(酒店|宾馆|住宿|房租|水费|电费|燃气|物业|宽带|话费|流量|手机充值)' then c:='居住';
 elsif k ~* '(滴滴|嘀嘀无限|出租车|打车|网约车|公交|地铁|火车票|铁路|12306|加油|油站|停车|通行费|ETC)' then c:='交通';
 elsif k ~ '(课程|培训|教材|书店|学费|考试)' then c:='学习';
 elsif k ~* '(台球|桌球|按摩|足浴|足疗|推拿|(^|[^a-z])spa([^a-z]|$)|剧本杀|密室|桌游|棋牌|电影|影院|KTV|游戏|影音会员|视频会员|音乐会员|景区|门票|游乐园)' then c:='本地生活';
 elsif k ~ '(外卖|餐厅|饭店|餐饮|咖啡|奶茶|早餐|烧烤|火锅|面馆|快餐|食堂)' then c:='本地生活';
 elsif k ~ '(烟酒|副食|超市|便利店|服饰|服装|数码|日用品)' then c:='购物';
 elsif k ~ '(京东|淘宝|天猫|拼多多)' then c:='购物';r:='电商平台默认购物'; end if;
 if c<>'待分类' and r='商户用途待分类' then r:='商户关键词：'||c; end if;
 if normalized ~ '美团' or moneytrail_private.sms_is_platform_only_merchant(p_merchant) then platform:='美团';
 elsif normalized ~ '京东' then platform:='京东'; elsif normalized ~ '淘宝' then platform:='淘宝'; elsif normalized ~ '天猫' then platform:='天猫'; elsif normalized ~ '拼多多' then platform:='拼多多'; elsif normalized ~ '(滴滴|嘀嘀无限)' then platform:='滴滴'; end if;
 if c='医疗' then detail:=case when k ~ '(药房|药店|买药)' then '药品' when k ~ '(医院|诊所|体检)' then '医疗服务' end;
 elsif c='居住' then detail:=case when k ~ '(酒店|宾馆|住宿)' then '住宿' when k ~ '房租' then '房租' when k ~ '(水费|电费|燃气|物业|宽带|话费|流量|手机充值)' then '生活缴费' end;
 elsif c='交通' then detail:=case when k ~ '(滴滴|嘀嘀无限|出租车|打车|网约车)' then '打车' when k ~ '(公交|地铁|火车票|铁路|12306)' then '公共交通' when k ~ '(加油|油站)' then '加油' when k ~* '(停车|通行费|ETC)' then '停车通行' end;
 elsif c='学习' then detail:=case when k ~ '(教材|书店)' then '教材' when k ~ '(课程|培训|学费|考试)' then '课程培训' end;
 elsif c='本地生活' then detail:=case when k ~* '(按摩|足浴|足疗|推拿|(^|[^a-z])spa([^a-z]|$))' then '按摩足疗' when k ~ '(剧本杀|密室)' then '剧本杀密室' when k ~ '(桌游|棋牌|台球|桌球)' then '桌游台球' when k ~* '(电影|影院|ktv|游戏|影音会员|视频会员|音乐会员)' then '电影影音' when k ~ '(景区|门票|游乐园)' then '景区游玩' when k ~ '外卖' then '外卖' when k ~ '(咖啡|奶茶)' then '咖啡奶茶' when k ~ '(餐厅|饭店|餐饮|早餐|烧烤|火锅|面馆|快餐|食堂)' then '餐饮' end;
 elsif c='购物' then detail:=case when k ~ '(烟酒|副食)' then '烟酒副食' when k ~ '(超市|便利店)' then '超市便利' when k ~ '(服饰|服装)' then '服饰' when k ~ '数码' then '数码' when k ~ '日用品' then '日用品' end; end if;
 return pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object('category',c,'kind',kind,'requires_review',review,'reason',r,'subcategory',detail,'platform',platform));
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
    ) || (classification - array['category','kind','requires_review','reason']) || pg_catalog.jsonb_build_object('smsEvidence',moneytrail_private.sms_evidence(p_text,p_received_at,classification->>'reason')),
    'warnings', result_warnings, 'requires_review', review_needed, 'error', null
  );
end;
$$;

create or replace function moneytrail_private.sms_parse_for_account(p_user uuid,p_text text,p_received timestamptz)
returns jsonb language plpgsql stable set search_path='' as $$
declare p jsonb; c text; normalized text; draft jsonb;
begin
 p:=moneytrail_private.moneytrail_parse_icbc_sms(p_text,p_received,'review');
 if p->'requires_review'='false'::jsonb and p#>>'{draft,kind}'='expense'
   and not moneytrail_private.sms_is_platform_only_merchant(p#>>'{draft,merchant}') then
  select category into c from moneytrail_private.sms_category_rules where user_id=p_user and merchant=moneytrail_private.sms_merchant_key(p#>>'{draft,merchant}');
  if c is not null then
   normalized:=case when c in ('餐饮','娱乐') then '本地生活' else c end;
   draft:=p->'draft';
   if normalized<>draft->>'category' or c in ('餐饮','娱乐') then draft:=draft-'subcategory'; end if;
   draft:=moneytrail_private.sms_normalize_transaction(draft||pg_catalog.jsonb_build_object('category',c));
   draft:=pg_catalog.jsonb_set(draft,'{smsEvidence,classificationReason}',pg_catalog.to_jsonb('个人商户规则：'||normalized));
   p:=pg_catalog.jsonb_set(p,'{draft}',draft);
  end if;
 end if;
 return p;
end; $$;

alter table moneytrail_private.sms_category_rules drop constraint sms_category_rules_category_check;
alter table moneytrail_private.sms_category_rules add constraint sms_category_rules_category_check check(category in ('本地生活','餐饮','购物','交通','居住','医疗','娱乐','学习','其他'));

create or replace function public.moneytrail_sms_set_category_rule(p_merchant text,p_category text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare caller uuid:=moneytrail_private.sms_require_account(); k text:=moneytrail_private.sms_merchant_key(p_merchant); platform_only boolean:=moneytrail_private.sms_is_platform_only_merchant(p_merchant);
begin
 -- A pure 美团支付 identity has an empty legacy merchant key. Permit removal
 -- (including any legacy exact stored name) without enabling new platform rules.
 if p_category is null and platform_only and k='' then k:='美团支付'; end if;
 if k='' or k ~ '[[:cntrl:]]'
   or (p_category is not null and (platform_only or p_category not in ('本地生活','餐饮','购物','交通','居住','医疗','娱乐','学习','其他')))
 then raise exception using errcode='22023',message='Invalid merchant category rule.'; end if;
 -- Keep the same per-account serialization used by intake and selected batches.
 insert into moneytrail_private.sms_settings(user_id) values(caller) on conflict do nothing;
 perform 1 from moneytrail_private.sms_settings where user_id=caller for update;
 if p_category is null then delete from moneytrail_private.sms_category_rules where user_id=caller and merchant=k;
 else
 if not exists(select 1 from moneytrail_private.sms_category_rules where user_id=caller and merchant=k) and (select count(*) from moneytrail_private.sms_category_rules where user_id=caller)>=200 then raise exception using errcode='54000',message='Merchant rule limit reached.'; end if;
 insert into moneytrail_private.sms_category_rules(user_id,merchant,category) values(caller,k,p_category) on conflict(user_id,merchant) do update set category=excluded.category;
 end if;
 return public.moneytrail_sms_category_rules();
end; $$;

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
    or p_draft - array['kind','amountCents','date','merchant','category','note','source','subcategory','platform','smsEvidence'] <> '{}'::jsonb
    or not moneytrail_private.sms_valid_metadata(p_draft)
    or (p_draft ? 'source' and (p_draft ->> 'source' is distinct from 'sms'))
  then raise exception using errcode = '22023', message = 'Invalid SMS draft.'; end if;
  v_transaction_id := 'sms-' || entry.id::text;
  transaction := p_draft || pg_catalog.jsonb_build_object('id', v_transaction_id, 'source', 'sms', 'sourceRef', v_transaction_id);
  transaction:=moneytrail_private.sms_normalize_transaction(transaction);
  -- The owner may edit the draft, but receipt text/time come only from the locked inbox.
  transaction:=transaction-'smsEvidence';
  if entry.raw_text is not null then transaction:=transaction||pg_catalog.jsonb_build_object('smsEvidence',moneytrail_private.sms_evidence(entry.raw_text,entry.received_at,'人工确认：'||(transaction->>'category'))); end if;
  perform moneytrail_private.sms_append(caller, transaction);
  update moneytrail_private.sms_inbox set status = 'recorded', raw_text = null,
    draft = transaction - array['id','sourceRef'], reason = null, transaction_id = v_transaction_id
    where id = entry.id;
  return pg_catalog.jsonb_build_object('status', 'recorded', 'transaction_id', v_transaction_id);
end;
$$;

revoke all on function moneytrail_private.sms_normalize_transaction(jsonb) from public,anon,authenticated;

revoke all on function moneytrail_private.sms_mask_evidence(text) from public,anon,authenticated;

revoke all on function moneytrail_private.sms_evidence(text,timestamptz,text) from public,anon,authenticated;

revoke all on function moneytrail_private.sms_valid_metadata(jsonb) from public,anon,authenticated;

revoke all on function public.moneytrail_valid_payload(jsonb) from public,anon,authenticated;

revoke all on function moneytrail_private.sms_classify(text) from public,anon,authenticated;

revoke all on function moneytrail_private.moneytrail_parse_icbc_sms(text,timestamptz,text) from public,anon,authenticated;

revoke all on function moneytrail_private.sms_parse_for_account(uuid,text,timestamptz) from public,anon,authenticated;

notify pgrst,'reload schema';
commit;
