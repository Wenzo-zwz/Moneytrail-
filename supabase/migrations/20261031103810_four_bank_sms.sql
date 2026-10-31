-- Four-bank receipt registration. Only the established ICBC formats auto-post.
-- ABC/BOC/CCB remain review-only until current real-device samples are verified.
-- No existing ledger, inbox, settings, token or merchant-rule rows are rewritten.
begin;

create or replace function moneytrail_private.sms_bank_code(p_text text)
returns text language plpgsql immutable set search_path='' as $$
declare t text; signature text[]; claims integer;
begin
 if p_text is null or pg_catalog.char_length(p_text)>2000 then return null; end if;
 t:=pg_catalog.btrim(pg_catalog.normalize(p_text,'NFKC'),' '||pg_catalog.chr(9)||pg_catalog.chr(10)||pg_catalog.chr(13));
 -- Require exactly one bank-labelled signature, at the end. A second known or
 -- unknown bank claim must not select a parser from a convenient substring.
 select count(*)::integer into claims
 from pg_catalog.regexp_matches(t,'【[^【】]*银行[^【】]*】','g');
 if claims<>1 then return null; end if;
 signature:=pg_catalog.regexp_match(t,'【(中国工商银行|工商银行|中国农业银行|农业银行|中国银行|中国建设银行|建设银行)】[。.]?$');
 if signature is null then return null; end if;
 return case signature[1]
  when '工商银行' then 'icbc' when '中国工商银行' then 'icbc'
  when '农业银行' then 'abc' when '中国农业银行' then 'abc'
  when '中国银行' then 'boc'
  when '建设银行' then 'ccb' when '中国建设银行' then 'ccb' end;
end; $$;

create or replace function moneytrail_private.sms_parse_bank(p_text text,p_received timestamptz)
returns jsonb language plpgsql immutable set search_path='' as $$
declare
 bank text:=moneytrail_private.sms_bank_code(p_text);
 t text; parts text[]; amount_text text; amount_cents bigint;
 local_receipt timestamp; event_time timestamp;
 yy integer; mm integer; dd integer; hh integer; mi integer;
 merchant text; classification jsonb;
 warnings jsonb:=pg_catalog.jsonb_build_array('新增银行格式尚未完成实机验证，请核对后入账。');
 failure jsonb:=pg_catalog.jsonb_build_object('draft',null,'warnings','[]'::jsonb,'requires_review',true,'error','暂不支持这条短信的完整格式，请对照原文核对后记账。');
begin
 if bank is null then return failure||pg_catalog.jsonb_build_object('error','银行签名不支持或不唯一。'); end if;
 if bank='icbc' then return moneytrail_private.moneytrail_parse_icbc_sms(p_text,p_received,'review'); end if;
 if p_received is null or not pg_catalog.isfinite(p_received) then return failure||pg_catalog.jsonb_build_object('error','短信接收时间无效。'); end if;
 t:=pg_catalog.btrim(pg_catalog.normalize(p_text,'NFKC'),' '||pg_catalog.chr(9)||pg_catalog.chr(10)||pg_catalog.chr(13));
 if t ~* '(验证码|校验码|动态码|短信口令|口令|密码|OTP|verification|one[ -]?time)' then return failure||pg_catalog.jsonb_build_object('error','验证码或安全验证短信不用于记账。'); end if;
 if t ~* '(美元|美金|港币|港元|日元|欧元|英镑|外币|澳元|加元|新加坡元|新西兰元|USD|HKD|JPY|EUR|GBP|AUD|CAD|SGD|NZD|[$€£₩₹¥])' then return failure||pg_catalog.jsonb_build_object('error','目前仅支持明确的人民币支出，请手动核对币种。'); end if;

 -- These two optional draft layouts come from historical official examples,
 -- not a claim that current credit/debit notifications share one bank format.
 if bank='abc' then
  parts:=pg_catalog.regexp_match(t,'^您[0-9xX*×•]{4}的信用卡([0-9]{1,2})月([0-9]{1,2})日([0-9]{1,2}):([0-9]{2})消费((?:[0-9]{1,20}|[0-9]{1,3}(?:,[0-9]{3}){1,6})(?:\.[0-9]{1,2})?)元,可用余额(?:[0-9xX*×•]{1,20}|[0-9xX*×•]{1,3}(?:,[0-9xX*×•]{3}){1,6})(?:\.[0-9xX*×•]{1,2})?元[。.]?【(?:中国)?农业银行】[。.]?$');
  merchant:='待补充商户';
  warnings:=warnings||pg_catalog.jsonb_build_array('短信未提供具体商户，请补充商户并核对分类。');
 elsif bank='ccb' then
  parts:=pg_catalog.regexp_match(t,'^您尾号[0-9xX*×•]{4}的储蓄卡活期账户([0-9]{1,2})月([0-9]{1,2})日([0-9]{1,2})时([0-9]{1,2})分,歌华批扣人民币((?:[0-9]{1,20}|[0-9]{1,3}(?:,[0-9]{3}){1,6})(?:\.[0-9]{1,2})?)元,活期余额(?:[0-9xX*×•]{1,20}|[0-9xX*×•]{1,3}(?:,[0-9xX*×•]{3}){1,6})(?:\.[0-9xX*×•]{1,2})?元[。.]?【(?:中国)?建设银行】[。.]?$');
  merchant:='歌华批扣';
 else
  return failure||pg_catalog.jsonb_build_object('error','中国银行短信已接收，当前格式需手动核对金额、时间和商户。');
 end if;
 if parts is null then return failure; end if;
 amount_text:=pg_catalog.replace(parts[5],',','');
 if pg_catalog.char_length(pg_catalog.split_part(amount_text,'.',1))>11 then return failure||pg_catalog.jsonb_build_object('error','交易金额超出支持范围。'); end if;
 amount_cents:=pg_catalog.split_part(amount_text,'.',1)::bigint*100+pg_catalog.rpad(pg_catalog.split_part(amount_text,'.',2),2,'0')::bigint;
 if amount_cents<1 or amount_cents>1000000000000 then return failure||pg_catalog.jsonb_build_object('error','交易金额必须大于零且在支持范围内。'); end if;

 local_receipt:=p_received at time zone 'Asia/Shanghai';
 yy:=pg_catalog.date_part('year',local_receipt)::integer;
 mm:=parts[1]::integer; dd:=parts[2]::integer; hh:=parts[3]::integer; mi:=parts[4]::integer;
 if yy not between 1 and 9999 or mm not between 1 and 12 or dd not between 1 and 31 or hh not between 0 and 23 or mi not between 0 and 59 then return failure||pg_catalog.jsonb_build_object('error','交易日期或时间无效，请手动核对。'); end if;
 event_time:=pg_catalog.make_timestamp(yy,mm,1,hh,mi,0)+(dd-1)*interval '1 day';
 if event_time>local_receipt+interval '2 days' then yy:=yy-1; end if;
 if yy<1 then return failure||pg_catalog.jsonb_build_object('error','交易日期或时间无效，请手动核对。'); end if;
 begin
  event_time:=pg_catalog.make_timestamp(yy,mm,dd,hh,mi,0);
 exception when datetime_field_overflow then
  return failure||pg_catalog.jsonb_build_object('error','交易日期或时间无效，请手动核对。');
 end;
 if event_time>local_receipt+interval '10 minutes' then warnings:=warnings||pg_catalog.jsonb_build_array('交易时间晚于短信接收时间，请核对。');
 elsif event_time<local_receipt-interval '7 days' then warnings:=warnings||pg_catalog.jsonb_build_array('交易时间已超过7天，请核对是否重复或补录。'); end if;
 classification:=moneytrail_private.sms_classify(merchant);
 return pg_catalog.jsonb_build_object(
  'draft',pg_catalog.jsonb_build_object('kind','expense','amountCents',amount_cents,'date',pg_catalog.to_char(event_time,'YYYY-MM-DD"T"HH24:MI'),'merchant',merchant,'category',classification->>'category','source','sms','note','')
   ||(classification-array['category','kind','requires_review','reason'])
   ||pg_catalog.jsonb_build_object('smsEvidence',moneytrail_private.sms_evidence(p_text,p_received,classification->>'reason')),
  'warnings',warnings,'requires_review',true,'error',null);
end; $$;

revoke all on function moneytrail_private.sms_bank_code(text) from public,anon,authenticated;
revoke all on function moneytrail_private.sms_parse_bank(text,timestamptz) from public,anon,authenticated;


create or replace function moneytrail_private.sms_parse_for_account(p_user uuid,p_text text,p_received timestamptz)
returns jsonb language plpgsql stable set search_path='' as $$
declare p jsonb; rule jsonb; draft jsonb; k text;
begin
 p:=moneytrail_private.sms_parse_bank(p_text,p_received);
 if p->'requires_review'='false'::jsonb and p#>>'{draft,kind}'='expense'
  and moneytrail_private.sms_can_remember_merchant(p#>>'{draft,merchant}') then
  k:=moneytrail_private.sms_merchant_key(p#>>'{draft,merchant}');
  select moneytrail_private.sms_normalize_transaction(pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object('category',r.category,'subcategory',r.subcategory))) into rule
  from moneytrail_private.sms_category_rules r
  where r.user_id=p_user and moneytrail_private.sms_merchant_key(r.merchant)=k
  order by (r.merchant=k) desc,r.merchant limit 1;
  if rule is not null then
   draft:=p->'draft';
   if rule->>'category'<>draft->>'category' or rule ? 'subcategory' then draft:=draft-'subcategory'; end if;
   draft:=draft||rule;
   draft:=pg_catalog.jsonb_set(draft,'{smsEvidence,classificationReason}',pg_catalog.to_jsonb('个人商户规则：'||(rule->>'category')));
   p:=pg_catalog.jsonb_set(p,'{draft}',draft);
  end if;
 end if;
 return p;
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
    or moneytrail_private.sms_bank_code(normalized_message) is null
    or (moneytrail_private.sms_bank_code(normalized_message)='icbc' and normalized_message !~ '支出')
    or (moneytrail_private.sms_bank_code(normalized_message)<>'icbc' and (
      -- New-bank intake needs an amount attached to an actual debit action.
      -- A 消费 mention in income, notification settings or marketing is not
      -- enough. This is a bounded receipt gate, not a whole-bank parser.
      normalized_message !~* '(支出|消费|扣款|扣费|批扣|代扣|转出|支取)[[:space:]]*(?:(?:金额)?[[:space:]]*(?:为|:)[[:space:]]*|金额[[:space:]]*)?(?:人民币|RMB|CNY)?[[:space:]]*[0-9]+(?:,[0-9]{3})*(?:\.[0-9]{1,2})?[[:space:]]*元'
      or normalized_message ~* '(美元|美金|港币|港元|日元|欧元|英镑|外币|澳元|加元|新加坡元|新西兰元|USD|HKD|JPY|EUR|GBP|AUD|CAD|SGD|NZD|[$€£₩₹¥])'
      or normalized_message ~ '(促销|优惠券|抽奖|积分兑换|(?:消费|支付)满|消费享优惠|每[[:space:]]*(?:消费|支付)|可获|敬请(?:使用|参与))'
    ))
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

create or replace function public.moneytrail_sms_confirm_with_rule(p_id uuid,p_draft jsonb,p_remember boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
declare caller uuid:=moneytrail_private.sms_require_account(); entry moneytrail_private.sms_inbox%rowtype; original jsonb; result jsonb;
begin
 if p_remember is null then raise exception using errcode='22023',message='Invalid remember choice.'; end if;
 insert into moneytrail_private.sms_settings(user_id) values(caller) on conflict do nothing;
 perform 1 from moneytrail_private.sms_settings where user_id=caller for update;
 select inbox.* into entry from moneytrail_private.sms_inbox inbox where inbox.user_id=caller and inbox.id=p_id for update;
 if entry.id is null then raise exception using errcode='42501',message='SMS entry is unavailable.'; end if;
 -- A recorded retry must neither replace its rule nor validate the stale draft.
 if entry.status='recorded' then return public.moneytrail_sms_confirm(p_id,p_draft); end if;
 if p_remember then
  original:=moneytrail_private.sms_parse_bank(entry.raw_text,entry.received_at);
  if entry.status<>'pending' or original->'requires_review' is distinct from 'false'::jsonb
   or original#>>'{draft,kind}' is distinct from 'expense'
   or not moneytrail_private.sms_can_remember_merchant(original#>>'{draft,merchant}')
   or p_draft->>'kind' is distinct from 'expense'
   or not moneytrail_private.sms_can_remember_merchant(p_draft->>'merchant')
   or moneytrail_private.sms_merchant_key(original#>>'{draft,merchant}')<>moneytrail_private.sms_merchant_key(p_draft->>'merchant')
   or p_draft->>'category' is null or p_draft->>'category' not in ('本地生活','餐饮','购物','交通','居住','医疗','娱乐','学习','其他')
  then raise exception using errcode='22023',message='Original SMS cannot establish this merchant rule.'; end if;
 end if;
 -- Reuse the existing owner/metadata validation and receipt evidence rebuild.
 result:=public.moneytrail_sms_confirm(p_id,p_draft);
 if p_remember then perform moneytrail_private.sms_upsert_merchant_rule(caller,p_draft->>'merchant',p_draft->>'category',p_draft->>'subcategory'); end if;
 return result;
end; $$;

revoke all on function moneytrail_private.sms_parse_for_account(uuid,text,timestamptz) from public,anon,authenticated;
revoke all on function public.moneytrail_receive_sms(text,text) from public,anon,authenticated;
grant execute on function public.moneytrail_receive_sms(text,text) to anon,authenticated;
revoke all on function public.moneytrail_sms_confirm_with_rule(uuid,jsonb,boolean) from public,anon,authenticated;
grant execute on function public.moneytrail_sms_confirm_with_rule(uuid,jsonb,boolean) to authenticated;
notify pgrst,'reload schema';
commit;
