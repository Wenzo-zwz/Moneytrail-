-- Auto-record only verified salary credits when the account permits it.
-- Other inflows remain review-only and refunds never link or post at intake.
begin;

create or replace function moneytrail_private.sms_parse_income(p_text text,p_received timestamptz)
returns jsonb language plpgsql immutable set search_path='' as $$
declare
 t text:=moneytrail_private.sms_cmb_text(p_text); bank text; parts text[]; purpose text;
 amount_text text; amount_cents bigint; kind text; category text; detail text; reason text;
 yy integer; mm integer; dd integer; hh integer; mi integer; local_receipt timestamp; event_time timestamp;
 salary_auto_ready boolean := false;
 warnings jsonb:=pg_catalog.jsonb_build_array('请核对此笔资金流入并确认是否入账。');
 failure jsonb:=pg_catalog.jsonb_build_object('draft',null,'warnings','[]'::jsonb,'requires_review',true,'error','该银行收入短信格式尚未完成验证，请手动补充并核对金额、时间和用途。');
begin
 if not moneytrail_private.sms_income_candidate(p_text) then return failure; end if;
 bank:=moneytrail_private.sms_income_bank(t);
 if p_received is null or not pg_catalog.isfinite(p_received) then return failure||pg_catalog.jsonb_build_object('error','短信接收时间无效。'); end if;
 -- Recognize an obscured transaction token before any numeric extraction. A
 -- later balance is never a fallback for this independent amount field.
 if t ~* '(?:收入|入账|到账|转入|存入)[[:space:],:]*(?:\([^()\r\n]{1,200}\)[[:space:]]*)?(?:(?:金额)?[[:space:]]*(?:为|:)[[:space:]]*|金额[[:space:]]*)?(?:人民币|RMB|CNY)?[[:space:]]*[0-9xX*×•,.]*[xX*×•][0-9xX*×•,.]*[[:space:]]*元' then
  return failure||pg_catalog.jsonb_build_object('error','交易金额已打码，无法确定真实金额；请补全金额，不能使用余额代替。');
 end if;
 if bank<>'icbc' then return failure; end if;
 parts:=pg_catalog.regexp_match(t,'^尾号[0-9xX*×•]{4}卡(?:([0-9]{4})年)?([0-9]{1,2})月([0-9]{1,2})日([0-9]{1,2}):([0-9]{2})工商银行收入\(([^()]{1,200})\)((?:[0-9]{1,20}|[0-9]{1,3}(?:,[0-9]{3}){1,6})(?:\.[0-9]{1,2})?)元(?:,余额(?:[0-9xX*×•]{1,20}|[0-9xX*×•]{1,3}(?:,[0-9xX*×•]{3}){1,6})(?:\.[0-9xX*×•]{1,2})?元)?[。.]?【(?:中国)?工商银行】[。.]?$');
 if parts is null then return failure; end if;
 purpose:=pg_catalog.btrim(parts[6]);
 if purpose='' or purpose ~ '[[:cntrl:]]' or purpose ~ '(银行|支出|扣款|余额)'
  or (purpose ~ '消费' and purpose !~ '退款')
  or pg_catalog.regexp_replace(purpose,'[[:space:]]','','g') ~* '([0-9](?:[0-9,.]*[0-9])?(元|人民币)|人民币[0-9]|(?:CNY|RMB)[0-9])'
 then return failure||pg_catalog.jsonb_build_object('error','收入用途不明确或包含多笔交易，请手动核对。'); end if;
 amount_text:=pg_catalog.replace(parts[7],',','');
 if pg_catalog.char_length(pg_catalog.split_part(amount_text,'.',1))>11 then return failure||pg_catalog.jsonb_build_object('error','交易金额超出支持范围。'); end if;
 amount_cents:=pg_catalog.split_part(amount_text,'.',1)::bigint*100+pg_catalog.rpad(pg_catalog.split_part(amount_text,'.',2),2,'0')::bigint;
 if amount_cents<1 or amount_cents>1000000000000 then return failure||pg_catalog.jsonb_build_object('error','交易金额必须大于零且在支持范围内。'); end if;
 -- Only a completed, explicit refund in the recognized bank credit layout
 -- can prefill a refund draft. It remains pending for the account holder.
 if purpose ~ '(退款|退回|退货|冲正|撤销|退费|返还)' then
  if purpose !~ '退款' or purpose ~ '(申请|请求|受理|审核|处理|进度|提醒|通知|预计|预期|预约|明日|明天|次日|稍后|暂未|尚未|未到账|未入账|未退|待退|待到账|待入账|将于|将退款|将到账|将入账|退款中|失败|不成功|不通过|不予退款|无法退款|拒绝|驳回|撤销|作废|关闭|冲正|无效|取消)' then
   return failure||pg_catalog.jsonb_build_object('error','该笔资金流入的退款状态或用途不明确，请核对实际到账与原支出。');
  end if;
  kind:='refund'; category:='待分类'; reason:='按短信明确的退款到账生成退款候选，请核对原支出。';
 elsif purpose ~ '((?:本人|同名|自有)(?:账户|银行卡|卡)?(?:互转|转账|转入|转出|划转)|同名账户|自有账户|资金归集|余额充值|零钱充值|信用卡还款|理财赎回|基金赎回|定期转活期|贷款|借款)' then
  kind:='transfer'; category:='待分类'; reason:='短信用途涉及本人资金周转、赎回或借贷，请核对资金来源，勿计作工资收入。';
 elsif purpose ~ '(转账|汇款|划转|转存|转入|转出|存入|汇入|提现|充值|还款|赎回)' then
  return failure||pg_catalog.jsonb_build_object('error','该笔资金流入可能是转账或资金周转，请手动确认类型和用途。');
 elsif purpose ~ '(工资|薪资|薪酬|薪金|奖金|津贴|补贴|劳务报酬|劳务费|稿酬)' then
  kind:='income'; category:='其他';
  detail:=case when purpose ~ '(工资|薪资|薪酬|薪金)' then '工资' when purpose ~ '奖金' then '奖金' when purpose ~ '(津贴|补贴)' then '补贴' else '劳务报酬' end;
  reason:='按短信明确的工资或报酬用途生成收入候选，请核对来源、金额和交易时间。';
 else
  return failure||pg_catalog.jsonb_build_object('error','收入用途尚不明确，可能涉及转账或退款，请手动确认类型和用途。');
 end if;
 warnings:=warnings||pg_catalog.jsonb_build_array(reason);
 local_receipt:=p_received at time zone 'Asia/Shanghai'; yy:=coalesce(parts[1]::integer,pg_catalog.date_part('year',local_receipt)::integer);
 mm:=parts[2]::integer; dd:=parts[3]::integer; hh:=parts[4]::integer; mi:=parts[5]::integer;
 if yy not between 1 and 9999 or mm not between 1 and 12 or dd not between 1 and 31 or hh not between 0 and 23 or mi not between 0 and 59 then return failure||pg_catalog.jsonb_build_object('error','交易日期或时间无效，请手动核对。'); end if;
 event_time:=pg_catalog.make_timestamp(yy,mm,1,hh,mi,0)+(dd-1)*interval '1 day';
 if parts[1] is null and event_time>local_receipt+interval '2 days' then yy:=yy-1; end if;
 if yy<1 then return failure||pg_catalog.jsonb_build_object('error','交易日期或时间无效，请手动核对。'); end if;
 begin event_time:=pg_catalog.make_timestamp(yy,mm,dd,hh,mi,0);
 exception when datetime_field_overflow then return failure||pg_catalog.jsonb_build_object('error','交易日期或时间无效，请手动核对。'); end;
 if event_time>local_receipt+interval '10 minutes' then warnings:=warnings||pg_catalog.jsonb_build_array('交易时间晚于短信接收时间，请核对。');
 elsif event_time<local_receipt-interval '7 days' then warnings:=warnings||pg_catalog.jsonb_build_array('交易时间已超过7天，请核对是否重复或补录。');
 else
  -- Anchor the payroll purpose. Transfers, non-salary earnings, credit
  -- reversals, and free-form payment descriptions all stay review-only.
  salary_auto_ready := kind = 'income' and detail = '工资'
    and purpose ~ '^(?:(?:[[:alnum:]·.-]{2,64})(?:股份有限公司|有限责任公司|有限公司)[[:space:]]*)?(?:(?:[1-9][0-9]{3}年)?(?:0?[1-9]|1[0-2])月[[:space:]]*)?(?:代发[[:space:]]*)?工资$'
    and purpose !~ '(转账|汇款|转入|转出|汇入|划转|同名|退款|退回|冲正|撤销|借款|贷款|充值|还款|赎回|申请|请求|待发|待付|未发|未付|失败|异常|测试)';
 end if;
 return pg_catalog.jsonb_build_object('draft',pg_catalog.jsonb_build_object('kind',kind,'amountCents',amount_cents,
  'date',pg_catalog.to_char(event_time,'YYYY-MM-DD"T"HH24:MI'),'merchant',purpose,'category',category,'source','sms','note','')
  ||case when detail is not null then pg_catalog.jsonb_build_object('subcategory',detail) else '{}'::jsonb end
  ||pg_catalog.jsonb_build_object('smsEvidence',moneytrail_private.sms_evidence(p_text,p_received,reason)),
  'warnings',warnings,'requires_review',true,'error',null)
  ||case when salary_auto_ready then pg_catalog.jsonb_build_object('salary_auto_ready',true) else '{}'::jsonb end;
end; $$;

-- Shared intake for the production, original beta and V2 entry points. The
-- original beta keeps its review-only income behaviour.
create or replace function moneytrail_private.sms_receive(
  p_token text, p_message text, p_prompt_for_category boolean, p_allow_salary_auto boolean
)
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
  record_salary boolean;
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
  record_salary := p_allow_salary_auto and income_candidate and bank_code = 'icbc'
    and (settings.mode = 'auto' or (p_prompt_for_category and settings.beta_iphone_categories))
    and (parsed -> 'salary_auto_ready') is not distinct from 'true'::jsonb;
  if record_salary or (
    not p_prompt_for_category and review_bank_code is null and not legacy_icbc and not income_candidate
    and settings.mode = 'auto' and parsed -> 'draft' is not null and parsed -> 'draft' <> 'null'::jsonb
    and parsed -> 'requires_review' = 'false'::jsonb and parsed -> 'error' = 'null'::jsonb
  ) then
    v_transaction_id := 'sms-' || entry_id::text;
    draft := parsed -> 'draft';
    if record_salary then
      draft := pg_catalog.jsonb_set(draft, '{smsEvidence,classificationReason}', pg_catalog.to_jsonb('工行明确工资到账：自动记账'::text));
    end if;
    transaction := draft || pg_catalog.jsonb_build_object('id', v_transaction_id, 'source', 'sms', 'sourceRef', v_transaction_id);
    if moneytrail_private.sms_append(settings.user_id, transaction, true) then
      new_status := 'recorded';
      if record_salary then
        parsed := parsed || pg_catalog.jsonb_build_object('draft', draft, 'warnings', '[]'::jsonb);
      end if;
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

create or replace function moneytrail_private.sms_receive(p_token text, p_message text, p_prompt_for_category boolean)
returns jsonb language sql set search_path = '' as $$
  select moneytrail_private.sms_receive(p_token, p_message, p_prompt_for_category, true);
$$;

create or replace function public.moneytrail_sms_beta_prepare(p_token text, p_message text)
returns jsonb language sql security definer set search_path = '' as $$
  select pg_catalog.jsonb_build_object('review_token', '') || moneytrail_private.sms_receive(p_token, p_message, true, false);
$$;

create or replace function public.moneytrail_sms_beta_prepare_v2(p_token text, p_message text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  settings moneytrail_private.sms_settings%rowtype;
  receipt jsonb;
  confirmation jsonb;
  draft jsonb;
  v_inbox_id uuid;
  key text;
  recommendation jsonb;
  rule_auto_record boolean;
  v_suggested_category text;
  v_suggested_subcategory text;
begin
  if p_token is null or pg_catalog.char_length(p_token) <> 71 or p_token !~ '^mt_sms_[a-f0-9]{64}$' then
    raise exception using errcode = '42501', message = 'SMS token is invalid or disabled.';
  end if;

  -- Hold the same account lock through intake and any automatic confirmation.
  select * into settings from moneytrail_private.sms_settings
    where token_hash = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_token, 'UTF8')), 'hex')
    for update;
  if settings.user_id is null then raise exception using errcode = '42501', message = 'SMS token is invalid or disabled.'; end if;

  -- Shortcuts needs even unused keys to exist when resolving dictionary values.
  receipt := pg_catalog.jsonb_build_object(
      'review_token', '', 'category_depth', settings.beta_category_depth,
      'suggested_category', '', 'suggested_subcategory', '', 'amount', '', 'merchant', '', 'category', '', 'subcategory', ''
    )
    || (moneytrail_private.sms_receive(p_token, p_message, settings.beta_iphone_categories) - 'suggested_category');
  if receipt->>'status' <> 'recorded' and receipt->>'review_token' = '' then return receipt; end if;

  v_inbox_id := (receipt->>'id')::uuid;
  select inbox.draft into draft from moneytrail_private.sms_inbox as inbox
    where inbox.id = v_inbox_id and inbox.user_id = settings.user_id;
  if receipt->>'status' = 'recorded' then
    return receipt || pg_catalog.jsonb_build_object(
      'amount', ((draft->>'amountCents')::numeric / 100)::numeric(13, 2)::text,
      'merchant', draft->>'merchant',
      'category', case when draft->>'kind' = 'income' and draft->>'subcategory' = '工资' then '收入' else draft->>'category' end,
      'subcategory', coalesce(draft->>'subcategory', '未细分')
    );
  end if;

  if moneytrail_private.sms_can_remember_merchant(draft->>'merchant') then
    key := moneytrail_private.sms_merchant_key(draft->>'merchant');
    select moneytrail_private.sms_normalize_transaction(pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'category', rule.category, 'subcategory', rule.subcategory
    ))), rule.auto_record and rule.merchant = key into recommendation, rule_auto_record
    from moneytrail_private.sms_category_rules as rule
    where rule.user_id = settings.user_id and moneytrail_private.sms_merchant_key(rule.merchant) = key
    order by (rule.merchant = key) desc, rule.merchant limit 1;
  end if;
  if moneytrail_private.sms_beta_rule_pair_valid(recommendation->>'category', recommendation->>'subcategory') then
    v_suggested_category := recommendation->>'category';
    v_suggested_subcategory := coalesce(recommendation->>'subcategory', '未细分');
  end if;

  update moneytrail_private.sms_beta_reviews as review set allows_subcategory = true,
    suggested_category = v_suggested_category, suggested_subcategory = v_suggested_subcategory
    where review.inbox_id = v_inbox_id;

  if rule_auto_record and v_suggested_category is not null then
    confirmation := moneytrail_private.sms_beta_confirm(receipt->>'review_token', v_suggested_category, v_suggested_subcategory, true, true);
    delete from moneytrail_private.sms_beta_reviews as review where review.inbox_id = v_inbox_id;
    receipt := receipt || pg_catalog.jsonb_build_object('review_token', '');
    if confirmation->>'status' = 'recorded' then
      return receipt || pg_catalog.jsonb_build_object('status', 'recorded', 'category', v_suggested_category, 'subcategory', v_suggested_subcategory);
    end if;
    return receipt;
  end if;

  return receipt || pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'suggested_category', v_suggested_category, 'suggested_subcategory', v_suggested_subcategory
  ));
end;
$$;

revoke all on function moneytrail_private.sms_receive(text, text, boolean, boolean) from public, anon, authenticated;

notify pgrst, 'reload schema';
commit;
