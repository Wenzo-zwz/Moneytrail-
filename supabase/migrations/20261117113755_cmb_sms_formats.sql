-- Two bounded CMB review formats; no automatic posting or business-data rewrite.
begin;

create or replace function moneytrail_private.sms_cmb_text(p_text text)
returns text language plpgsql immutable set search_path='' as $$
declare t text; boundary text:=' '||pg_catalog.chr(9)||pg_catalog.chr(10)||pg_catalog.chr(13);
 -- Unicode 17.0 General_Category=Cf, including supplementary-plane tags.
 -- Source: https://www.unicode.org/Public/17.0.0/ucd/extracted/DerivedGeneralCategory.txt
 format_controls text:='['||pg_catalog.chr(173)||pg_catalog.chr(1536)||'-'||pg_catalog.chr(1541)||pg_catalog.chr(1564)||pg_catalog.chr(1757)||pg_catalog.chr(1807)||pg_catalog.chr(2192)||'-'||pg_catalog.chr(2193)||pg_catalog.chr(2274)||pg_catalog.chr(6158)||pg_catalog.chr(8203)||'-'||pg_catalog.chr(8207)||pg_catalog.chr(8234)||'-'||pg_catalog.chr(8238)||pg_catalog.chr(8288)||'-'||pg_catalog.chr(8292)||pg_catalog.chr(8294)||'-'||pg_catalog.chr(8303)||pg_catalog.chr(65279)||pg_catalog.chr(65529)||'-'||pg_catalog.chr(65531)||pg_catalog.chr(69821)||pg_catalog.chr(69837)||pg_catalog.chr(78896)||'-'||pg_catalog.chr(78911)||pg_catalog.chr(113824)||'-'||pg_catalog.chr(113827)||pg_catalog.chr(119155)||'-'||pg_catalog.chr(119162)||pg_catalog.chr(917505)||pg_catalog.chr(917536)||'-'||pg_catalog.chr(917631)||']';
begin
 if p_text is null or pg_catalog.char_length(p_text)>2000 then return null; end if;
 t:=pg_catalog.btrim(pg_catalog.normalize(p_text,'NFKC'),boundary);
 -- iOS copying can append these two object/format markers. Only a trailing
 -- suffix is removable; do not silently repair hidden characters in values.
 t:=pg_catalog.rtrim(t,boundary||pg_catalog.chr(8204)||pg_catalog.chr(65532));
 if t ~ '[[:cntrl:]]' or t ~ format_controls
  or pg_catalog.strpos(t,pg_catalog.chr(65532))>0 then return null; end if;
 return t;
end; $$;

create or replace function moneytrail_private.sms_cmb_credit_identity(p_text text)
returns boolean language sql immutable set search_path='' as $$
 select coalesce(moneytrail_private.sms_cmb_text(p_text) ~ '^您尾号[0-9xX*×•]{4}的招行信用卡于[0-9]{1,2}月[0-9]{1,2}日[0-9]{1,2}时[0-9]{1,2}分消费人民币[0-9][0-9,.]{0,30}元[。.]?$',false);
$$;

create or replace function moneytrail_private.sms_review_bank_source(p_text text)
returns text language plpgsql immutable set search_path='' as $$
declare t text; cmb text; signature text[]; claims integer; bank text;
begin
 if p_text is null or pg_catalog.char_length(p_text)>2000 then return null; end if;
 cmb:=moneytrail_private.sms_cmb_text(p_text);
 if cmb is not null then
  -- This whole identity sentence is the only unsigned CMB source admitted.
  if cmb ~ '您尾号[0-9xX*×•]{4}的招行信用卡于' then
   if moneytrail_private.sms_cmb_credit_identity(cmb) then return 'cmb'; end if;
   -- Do not reinterpret an altered CMB identity as another bank's signed SMS.
   return null;
  end if;
  select count(*)::integer into claims from pg_catalog.regexp_matches(cmb,'【[^【】]*银行[^【】]*】|〖[^〖〗]*银行[^〖〗]*〗|\([^()]*银行[^()]*\)','g');
  if claims=1 then
   signature:=pg_catalog.regexp_match(cmb,'^(【招商银行】|〖招商银行〗|\(招商银行\))');
   if signature is null then signature:=pg_catalog.regexp_match(cmb,'(【招商银行】|〖招商银行〗|\(招商银行\))[。.]?$'); end if;
   if signature is not null and pg_catalog.replace(cmb,signature[1],'') !~ '银行' then return 'cmb'; end if;
  end if;
 end if;
 -- Established ABC/BOC/CCB source handling remains unchanged.
 t:=pg_catalog.btrim(pg_catalog.normalize(p_text,'NFKC'),' '||pg_catalog.chr(9)||pg_catalog.chr(10)||pg_catalog.chr(13));
 select count(*)::integer into claims from pg_catalog.regexp_matches(t,'【[^【】]*银行[^【】]*】|\([^()]*银行[^()]*\)','g');
 if claims<>1 then return null; end if;
 signature:=pg_catalog.regexp_match(t,'^(【(?:中国农业银行|农业银行|中国银行|中国建设银行|建设银行)】|\((?:中国农业银行|农业银行|中国银行|中国建设银行|建设银行)\))');
 if signature is null then signature:=pg_catalog.regexp_match(t,'(【(?:中国农业银行|农业银行|中国银行|中国建设银行|建设银行)】|\((?:中国农业银行|农业银行|中国银行|中国建设银行|建设银行)\))[。.]?$'); end if;
 if signature is null or pg_catalog.replace(t,signature[1],'') ~ '银行' then return null; end if;
 bank:=pg_catalog.regexp_replace(signature[1],'[【】()]','','g');
 return case bank when '农业银行' then 'abc' when '中国农业银行' then 'abc'
  when '中国银行' then 'boc' when '建设银行' then 'ccb' when '中国建设银行' then 'ccb' end;
end; $$;

create or replace function moneytrail_private.sms_parse_cmb(p_text text,p_received timestamptz)
returns jsonb language plpgsql immutable set search_path='' as $$
declare
 t text:=moneytrail_private.sms_cmb_text(p_text); parts text[]; amount_text text; amount_cents bigint;
 yy integer; mm integer; dd integer; hh integer; mi integer; local_receipt timestamp; event_time timestamp;
 merchant text; classification jsonb;
 warnings jsonb:=pg_catalog.jsonb_build_array('招商银行格式仍需本人核对，确认后才会入账。');
 failure jsonb:=pg_catalog.jsonb_build_object('draft',null,'warnings','[]'::jsonb,'requires_review',true,'error','招商银行短信格式需手动核对金额、时间和商户。');
begin
 if t is null or moneytrail_private.sms_review_bank_source(p_text) is distinct from 'cmb' then return failure; end if;
 if p_received is null or not pg_catalog.isfinite(p_received) then return failure||pg_catalog.jsonb_build_object('error','短信接收时间无效。'); end if;
 if t ~* '(验证码|校验码|动态码|短信口令|口令|密码|OTP|verification|one[ -]?time)'
  or t ~* '(美元|美金|港币|港元|日元|欧元|英镑|外币|澳元|加元|新加坡元|新西兰元|USD|HKD|JPY|EUR|GBP|AUD|CAD|SGD|NZD|[$€£₩₹¥])'
  or t ~ '(退款|退回|退货|冲正|撤销|转账|转出|转入|还款|偿还|提现|充值|收入|失败|未成功|取消|待支付|待付款|处理中)'
 then return failure; end if;
 parts:=pg_catalog.regexp_match(t,'^〖招商银行〗您账户[0-9xX*×•]{4}于([0-9]{1,2})月([0-9]{1,2})日([0-9]{1,2}):([0-9]{1,2})在〖([^〖〗【】\r\n]{1,200})〗快捷支付((?:[0-9]{1,20}|[0-9]{1,3}(?:,[0-9]{3}){1,6})(?:\.[0-9]{1,2})?)元,余额(?:[0-9xX*×•]{1,20}|[0-9xX*×•]{1,3}(?:,[0-9xX*×•]{3}){1,6})(?:\.[0-9xX*×•]{1,2})?元[。.]?$');
 if parts is not null then
  merchant:=pg_catalog.btrim(parts[5]); amount_text:=parts[6];
  if merchant='' or merchant ~ '[[:cntrl:]]' or merchant ~ '(银行|快捷支付|支出|消费|扣款|余额)'
   or merchant ~* '([0-9][0-9,.]*(元|人民币)|人民币[0-9]|(?:CNY|RMB)[0-9])' then return failure; end if;
  warnings:=warnings||pg_catalog.jsonb_build_array('快捷支付描述可能是支付渠道或收款方，请核对实际商户和用途。');
 else
  parts:=pg_catalog.regexp_match(t,'^您尾号[0-9xX*×•]{4}的招行信用卡于([0-9]{1,2})月([0-9]{1,2})日([0-9]{1,2})时([0-9]{1,2})分消费人民币((?:[0-9]{1,20}|[0-9]{1,3}(?:,[0-9]{3}){1,6})(?:\.[0-9]{1,2})?)元[。.]?$');
  if parts is null then return failure; end if;
  amount_text:=parts[5]; merchant:='待补充商户';
  warnings:=warnings||pg_catalog.jsonb_build_array('短信未提供具体商户，请补充实际商户并核对分类。');
 end if;
 amount_text:=pg_catalog.replace(amount_text,',','');
 if pg_catalog.char_length(pg_catalog.split_part(amount_text,'.',1))>11 then return failure; end if;
 amount_cents:=pg_catalog.split_part(amount_text,'.',1)::bigint*100+pg_catalog.rpad(pg_catalog.split_part(amount_text,'.',2),2,'0')::bigint;
 if amount_cents<1 or amount_cents>1000000000000 then return failure||pg_catalog.jsonb_build_object('error','交易金额必须大于零且在支持范围内。'); end if;
 local_receipt:=p_received at time zone 'Asia/Shanghai'; yy:=pg_catalog.date_part('year',local_receipt)::integer;
 mm:=parts[1]::integer; dd:=parts[2]::integer; hh:=parts[3]::integer; mi:=parts[4]::integer;
 if yy not between 1 and 9999 or mm not between 1 and 12 or dd not between 1 and 31 or hh not between 0 and 23 or mi not between 0 and 59 then return failure; end if;
 event_time:=pg_catalog.make_timestamp(yy,mm,1,hh,mi,0)+(dd-1)*interval '1 day';
 if event_time>local_receipt+interval '2 days' then yy:=yy-1; end if;
 if yy<1 then return failure; end if;
 begin event_time:=pg_catalog.make_timestamp(yy,mm,dd,hh,mi,0);
 exception when datetime_field_overflow then return failure; end;
 if event_time>local_receipt+interval '10 minutes' then warnings:=warnings||pg_catalog.jsonb_build_array('交易时间晚于短信接收时间，请核对。');
 elsif event_time<local_receipt-interval '7 days' then warnings:=warnings||pg_catalog.jsonb_build_array('交易时间已超过7天，请核对是否重复或补录。'); end if;
 classification:=moneytrail_private.sms_classify(merchant);
 return pg_catalog.jsonb_build_object('draft',pg_catalog.jsonb_build_object('kind','expense','amountCents',amount_cents,
  'date',pg_catalog.to_char(event_time,'YYYY-MM-DD"T"HH24:MI'),'merchant',merchant,'category',classification->>'category','source','sms','note','')
  ||(classification-array['category','kind','requires_review','reason'])
  ||pg_catalog.jsonb_build_object('smsEvidence',moneytrail_private.sms_evidence(p_text,p_received,classification->>'reason')),
  'warnings',warnings,'requires_review',true,'error',null);
end; $$;

revoke all on function moneytrail_private.sms_cmb_text(text) from public,anon,authenticated;
revoke all on function moneytrail_private.sms_cmb_credit_identity(text) from public,anon,authenticated;
revoke all on function moneytrail_private.sms_parse_cmb(text,timestamptz) from public,anon,authenticated;
revoke all on function moneytrail_private.sms_review_bank_source(text) from public,anon,authenticated;

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
  bank_code text;
  legacy_icbc boolean;
  review_bank_code text;
  review_amount text := '(?:[0-9]+|[0-9]{1,3}(?:,[0-9]{3})+)(?:\.[0-9]{1,2})?';
  review_debit_pattern text;
  cmb_debit_pattern text;
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
  bank_code := moneytrail_private.sms_bank_code(normalized_message);
  review_bank_code := moneytrail_private.sms_review_bank_source(normalized_message);
  if review_bank_code='cmb' then normalized_message:=moneytrail_private.sms_cmb_text(p_message); end if;
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
    or (bank_code is distinct from 'icbc' and review_bank_code is null and not legacy_icbc)
    or (bank_code='icbc' and normalized_message !~ '支出')
    or (review_bank_code is not null and (
      normalized_message !~* (case when review_bank_code='cmb' then cmb_debit_pattern else review_debit_pattern end)
      or normalized_message ~* '(美元|美金|港币|港元|日元|欧元|英镑|外币|澳元|加元|新加坡元|新西兰元|USD|HKD|JPY|EUR|GBP|AUD|CAD|SGD|NZD|[$€£₩₹¥])'
      or normalized_message ~ '(促销|优惠券|抽奖|积分兑换|(?:消费|支付)满|消费享优惠|每[[:space:]]*(?:消费|支付)|可获|敬请(?:使用|参与))'
      or normalized_message ~ '(账单|应还|最低还款|还款提醒|到期还款|还款日)'
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
  if review_bank_code='cmb' then parsed:=moneytrail_private.sms_parse_cmb(p_message,received);
  else parsed := moneytrail_private.sms_parse_for_account(settings.user_id, p_message, received); end if;
  if review_bank_code is not null then
    parsed := pg_catalog.jsonb_set(parsed, '{requires_review}', 'true'::jsonb);
    if parsed -> 'draft' is null or parsed -> 'draft' = 'null'::jsonb then
      parsed := pg_catalog.jsonb_set(parsed, '{error}', pg_catalog.to_jsonb('该银行短信已接收，当前格式需手动核对金额、时间和商户。'::text));
    end if;
  end if;
  if review_bank_code is null and not legacy_icbc and settings.mode = 'auto' and parsed -> 'draft' is not null and parsed -> 'draft' <> 'null'::jsonb
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

revoke all on function public.moneytrail_receive_sms(text,text) from public,anon,authenticated;
grant execute on function public.moneytrail_receive_sms(text,text) to anon,authenticated;
notify pgrst,'reload schema';
commit;
