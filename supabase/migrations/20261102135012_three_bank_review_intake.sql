-- Public ABC/BOC/CCB examples are receipt compatibility cases, not verified
-- parser formats. Keep them pending without rewriting any business data.
begin;

create or replace function moneytrail_private.sms_review_bank_source(p_text text)
returns text language plpgsql immutable set search_path='' as $$
declare t text; signature text[]; claims integer; bank text;
begin
 if p_text is null or pg_catalog.char_length(p_text)>2000 then return null; end if;
 t:=pg_catalog.btrim(pg_catalog.normalize(p_text,'NFKC'),' '||pg_catalog.chr(9)||pg_catalog.chr(10)||pg_catalog.chr(13));
 -- One explicit bank marker at a boundary. Count unknown and round markers
 -- too, so another bank claim cannot be hidden from the strict parser gate.
 select count(*)::integer into claims from pg_catalog.regexp_matches(t,'【[^【】]*银行[^【】]*】|\([^()]*银行[^()]*\)','g');
 if claims<>1 then return null; end if;
 signature:=pg_catalog.regexp_match(t,'^(【(?:中国农业银行|农业银行|中国银行|中国建设银行|建设银行)】|\((?:中国农业银行|农业银行|中国银行|中国建设银行|建设银行)\))');
 if signature is null then
  signature:=pg_catalog.regexp_match(t,'(【(?:中国农业银行|农业银行|中国银行|中国建设银行|建设银行)】|\((?:中国农业银行|农业银行|中国银行|中国建设银行|建设银行)\))[。.]?$');
 end if;
 if signature is null or pg_catalog.replace(t,signature[1],'') ~ '银行' then return null; end if;
 bank:=pg_catalog.regexp_replace(signature[1],'[【】()]','','g');
 return case bank when '农业银行' then 'abc' when '中国农业银行' then 'abc'
  when '中国银行' then 'boc' when '建设银行' then 'ccb' when '中国建设银行' then 'ccb' end;
end; $$;

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
  -- Require the amount beside the debit action or its explicit amount field;
  -- a later balance or available limit must never supply the expense amount.
  review_debit_pattern := '(?:支出|消费(?:支出|交易)?|扣款|扣费|批扣|代扣|转出|支取)[[:space:],:]*(?:(?:(?:金额)?[[:space:]]*(?:为|:)[[:space:]]*|金额[[:space:]]*)?(?:(?:人民币|RMB|CNY)[[:space:]]*'
    || review_amount || '(?:[[:space:]]*元)?|' || review_amount || '[[:space:]]*元)|金额[[:space:]]*(?:为|:)[[:space:]]*'
    || review_amount || ')(?![0-9.]|,[0-9])';
  -- Earlier ICBC intake retained unknown layouts for review. Preserve that
  -- receipt path without treating an unverified signature as a parsed bank.
  legacy_icbc := bank_code is null and normalized_message ~ '工商银行' and normalized_message ~ '支出'
    and pg_catalog.replace(pg_catalog.replace(normalized_message, '中国工商银行', ''), '工商银行', '') !~ '银行';
  if normalized_message ~* '(验证码|校验码|动态码|短信口令|口令|密码|OTP|verification|one[ -]?time)'
    or (bank_code is distinct from 'icbc' and review_bank_code is null and not legacy_icbc)
    or (bank_code='icbc' and normalized_message !~ '支出')
    or (review_bank_code is not null and (
      normalized_message !~* review_debit_pattern
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
  parsed := moneytrail_private.sms_parse_for_account(settings.user_id, p_message, received);
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

notify pgrst,'reload schema';
commit;

