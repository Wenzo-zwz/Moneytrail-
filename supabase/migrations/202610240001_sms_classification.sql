-- Append-only SMS classification, account rules and selected pending processing.
begin;
create table if not exists moneytrail_private.sms_category_rules (
 user_id uuid not null references auth.users(id) on delete cascade,
 merchant text not null, category text not null,
 primary key(user_id,merchant),
 check (char_length(merchant) between 1 and 200),
 check (category in ('餐饮','购物','交通','居住','医疗','娱乐','学习','其他'))
);
alter table moneytrail_private.sms_category_rules enable row level security;
revoke all on moneytrail_private.sms_category_rules from public, anon, authenticated;

create or replace function moneytrail_private.sms_merchant_key(p_merchant text)
returns text language plpgsql immutable set search_path='' as $$
declare k text := pg_catalog.lower(pg_catalog.btrim(pg_catalog.normalize(p_merchant,'NFKC'))); previous text;
begin
 if k is null or char_length(k)>200 then return ''; end if;
 loop
 previous:=k;
 k:=pg_catalog.regexp_replace(k,'^(消费|支付(?!宝)|付款)[-—:[:space:]]*','');
 k:=pg_catalog.regexp_replace(k,'^((快捷支付[-[:space:]]*)?(财付通|微信支付|微信|支付宝|美团支付|滴滴支付|银联商务|银联)|快捷支付)[-—:[:space:]]*','');
 k:=pg_catalog.btrim(k);
 exit when previous=k;
 end loop;
 if k ~ '[[:cntrl:]]' or k ~ '(群收款|退款|退回|冲正|撤销|失败|未成功|取消)' or pg_catalog.regexp_replace(k,'(手机|话费|流量)充值','','g') ~ '(转账|转出|转入|充值|提现|取现|取款|支取|还款|偿还|缴款|还贷|贷款|余额宝|零钱通|花呗|借呗|白条|网商贷|理财|基金|证券|买入|申购|赎回)' then return ''; end if;
 return pg_catalog.btrim(k);
end; $$;

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
 elsif k ~* '(电影|影院|KTV|游戏|影音会员|视频会员|音乐会员|景区|门票|游乐园)' then c:='娱乐';
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

-- Apply personal rules only after all format, date and ambiguity guards pass.
create or replace function moneytrail_private.sms_parse_for_account(p_user uuid,p_text text,p_received timestamptz)
returns jsonb language plpgsql stable set search_path='' as $$
declare p jsonb; c text;
begin
 p:=moneytrail_private.moneytrail_parse_icbc_sms(p_text,p_received,'review');
 if p->'requires_review'='false'::jsonb and p#>>'{draft,kind}'='expense' then
 select category into c from moneytrail_private.sms_category_rules where user_id=p_user and merchant=moneytrail_private.sms_merchant_key(p#>>'{draft,merchant}');
 if c is not null then p:=pg_catalog.jsonb_set(p,'{draft,category}',pg_catalog.to_jsonb(c)); end if;
 end if;
 return p;
end; $$;

create or replace function public.moneytrail_sms_category_rules()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare caller uuid:=moneytrail_private.sms_require_account(); r jsonb;
begin
 select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('merchant',merchant,'category',category) order by merchant),'[]'::jsonb) into r from moneytrail_private.sms_category_rules where user_id=caller;
 return pg_catalog.jsonb_build_object('rules',r);
end; $$;

create or replace function public.moneytrail_sms_set_category_rule(p_merchant text,p_category text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare caller uuid:=moneytrail_private.sms_require_account(); k text:=moneytrail_private.sms_merchant_key(p_merchant);
begin
 if k='' or k ~ '[[:cntrl:]]' or (p_category is not null and p_category not in ('餐饮','购物','交通','居住','医疗','娱乐','学习','其他')) then raise exception using errcode='22023',message='Invalid merchant category rule.'; end if;
 -- The same per-account lock serializes rule edits, intake and selected batches.
 insert into moneytrail_private.sms_settings(user_id) values(caller) on conflict do nothing;
 perform 1 from moneytrail_private.sms_settings where user_id=caller for update;
 if p_category is null then delete from moneytrail_private.sms_category_rules where user_id=caller and merchant=k;
 else
 if not exists(select 1 from moneytrail_private.sms_category_rules where user_id=caller and merchant=k) and (select count(*) from moneytrail_private.sms_category_rules where user_id=caller)>=200 then raise exception using errcode='54000',message='Merchant rule limit reached.'; end if;
 insert into moneytrail_private.sms_category_rules(user_id,merchant,category) values(caller,k,p_category) on conflict(user_id,merchant) do update set category=excluded.category;
 end if;
 return public.moneytrail_sms_category_rules();
end; $$;

create or replace function public.moneytrail_sms_preview_pending()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare caller uuid:=moneytrail_private.sms_require_account(); entry moneytrail_private.sms_inbox%rowtype; p jsonb; eligible boolean; items jsonb:='[]'; n integer:=0; total integer;
begin
 select count(*)::integer into total from moneytrail_private.sms_inbox where user_id=caller and status='pending';
 for entry in select * from moneytrail_private.sms_inbox where user_id=caller and status='pending' order by received_at,id limit 200 loop
 p:=moneytrail_private.sms_parse_for_account(caller,entry.raw_text,entry.received_at);
 eligible:=p->'requires_review'='false'::jsonb and p->'error'='null'::jsonb and p->'draft'<>'null'::jsonb;
 if eligible and exists (
 select 1 from public.moneytrail_ledgers ledger,
 lateral pg_catalog.jsonb_array_elements(ledger.data->'transactions') candidate
 where ledger.user_id=caller and candidate->>'kind'=p#>>'{draft,kind}'
 and candidate->'amountCents'=p#>'{draft,amountCents}'
 and pg_catalog.abs(pg_catalog.date_part('epoch',(candidate->>'date')::timestamp-(p#>>'{draft,date}')::timestamp))<=600
 ) then
 eligible:=false;
 p:=pg_catalog.jsonb_set(p,'{warnings}','["账本可能已有相同扣款，请人工核对。"]'::jsonb);
 end if;
 if eligible then n:=n+1; end if;
 items:=items||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('id',entry.id,'draft',p->'draft','eligible',coalesce(eligible,false),'reason',case when eligible then '格式及用途核对通过' else coalesce(p->>'error',p#>>'{warnings,0}','需要人工确认') end));
 end loop;
 return pg_catalog.jsonb_build_object('items',items,'recordable_count',n,'pending_count',total);
end; $$;

create or replace function public.moneytrail_sms_apply_pending(p_items jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare caller uuid:=moneytrail_private.sms_require_account(); item jsonb; entry moneytrail_private.sms_inbox%rowtype; p jsonb; txid text; n integer:=0; total integer;
begin
 if p_items is null or pg_catalog.jsonb_typeof(p_items)<>'array' then raise exception using errcode='22023',message='Invalid SMS selection.'; end if;
 if pg_catalog.jsonb_array_length(p_items)>200 then raise exception using errcode='22023',message='At most 200 SMS entries may be selected.'; end if;
 if exists(select 1 from pg_catalog.jsonb_array_elements(p_items) i where pg_catalog.jsonb_typeof(i)<>'object' or not(i ? 'id' and i ? 'draft') or i-array['id','draft']<>'{}'::jsonb or pg_catalog.jsonb_typeof(i->'id')<>'string' or (i->>'id')!~'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') then raise exception using errcode='22023',message='Invalid SMS selection.'; end if;
 if (select count(distinct (i->>'id')::uuid) from pg_catalog.jsonb_array_elements(p_items) i)<>pg_catalog.jsonb_array_length(p_items) then raise exception using errcode='22023',message='Duplicate SMS selection.'; end if;
 insert into moneytrail_private.sms_settings(user_id) values(caller) on conflict do nothing;
 perform 1 from moneytrail_private.sms_settings where user_id=caller for update;
 -- Lock every selected inbox before touching the ledger, in a consistent order.
 perform 1 from moneytrail_private.sms_inbox where user_id=caller and id in(select (i->>'id')::uuid from pg_catalog.jsonb_array_elements(p_items)i) order by received_at,id for update;
 for item in select i from pg_catalog.jsonb_array_elements(p_items)i loop
 select * into entry from moneytrail_private.sms_inbox where user_id=caller and id=(item->>'id')::uuid;
 if entry.id is null then raise exception using errcode='42501',message='SMS entry is unavailable.'; end if;
 if entry.status='recorded' then
 if entry.draft is distinct from item->'draft' then raise exception using errcode='40001',message='SMS preview has changed.'; end if;
 continue;
 end if;
 if entry.status<>'pending' then raise exception using errcode='40001',message='SMS entry is no longer pending.'; end if;
 p:=moneytrail_private.sms_parse_for_account(caller,entry.raw_text,entry.received_at);
 if p->'draft' is distinct from item->'draft' or p->'requires_review'<>'false'::jsonb or p->'error'<>'null'::jsonb or p->'draft'='null'::jsonb then raise exception using errcode='40001',message='SMS preview has changed; preview again.'; end if;
 txid:='sms-'||entry.id::text;
 if moneytrail_private.sms_append(caller,(p->'draft')||pg_catalog.jsonb_build_object('id',txid,'source','sms','sourceRef',txid),true) then
 update moneytrail_private.sms_inbox set status='recorded',raw_text=null,draft=p->'draft',warnings='[]',reason=null,transaction_id=txid where id=entry.id and user_id=caller;
 n:=n+1;
 end if;
 end loop;
 select count(*)::integer into total from moneytrail_private.sms_inbox where user_id=caller and status='pending';
 return pg_catalog.jsonb_build_object('recorded_count',n,'pending_count',total);
end; $$;

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
  parsed := moneytrail_private.sms_parse_for_account(settings.user_id, p_message, received);
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
      order by inbox.received_at, inbox.id limit 200 for update skip locked
    ) as target;

  foreach entry_id in array locked_ids loop
    select inbox.* into entry from moneytrail_private.sms_inbox as inbox
      where inbox.id = entry_id and inbox.user_id = caller and inbox.status = 'pending';
    if entry.id is null then continue; end if;
    -- Use the original receipt as the reference for year inference and stale
    -- message checks, so waiting in an inbox does not change a transaction date.
    parsed := moneytrail_private.sms_parse_for_account(caller, entry.raw_text, entry.received_at);
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

revoke all on function moneytrail_private.sms_merchant_key(text) from public,anon,authenticated;
revoke all on function moneytrail_private.sms_classify(text) from public,anon,authenticated;
revoke all on function moneytrail_private.sms_parse_for_account(uuid,text,timestamptz) from public,anon,authenticated;
revoke all on function public.moneytrail_sms_category_rules() from public,anon,authenticated;
grant execute on function public.moneytrail_sms_category_rules() to authenticated;
revoke all on function public.moneytrail_sms_set_category_rule(text,text) from public,anon,authenticated;
grant execute on function public.moneytrail_sms_set_category_rule(text,text) to authenticated;
revoke all on function public.moneytrail_sms_preview_pending() from public,anon,authenticated;
grant execute on function public.moneytrail_sms_preview_pending() to authenticated;
revoke all on function public.moneytrail_sms_apply_pending(jsonb) from public,anon,authenticated;
grant execute on function public.moneytrail_sms_apply_pending(jsonb) to authenticated;
notify pgrst,'reload schema';
commit;
