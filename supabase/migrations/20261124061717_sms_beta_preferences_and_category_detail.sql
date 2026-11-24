-- Keep the production SMS mode and legacy Shortcut contracts. V2 may opt in
-- to phone confirmation without changing the production mode.
begin;

alter table moneytrail_private.sms_settings
  add column beta_iphone_categories boolean not null default false,
  add column beta_category_depth text not null default 'primary'
    check (beta_category_depth in ('primary', 'secondary'));

alter table moneytrail_private.sms_category_rules
  add column auto_record boolean not null default false;

alter table moneytrail_private.sms_beta_reviews
  add column allows_subcategory boolean not null default false,
  add column suggested_category text,
  add column suggested_subcategory text;

create function public.moneytrail_sms_beta_get_preferences()
returns jsonb language sql stable security definer set search_path = '' as $$
  select pg_catalog.jsonb_build_object(
    'mode', case when settings.beta_iphone_categories then 'iphone' else coalesce(settings.mode, 'auto') end,
    'category_depth', coalesce(settings.beta_category_depth, 'primary')
  )
  from (select moneytrail_private.sms_require_account() as user_id) as caller
  left join moneytrail_private.sms_settings as settings on settings.user_id = caller.user_id;
$$;

create function public.moneytrail_sms_beta_set_preferences(p_mode text, p_category_depth text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare caller uuid := moneytrail_private.sms_require_account();
begin
  if p_mode is null or p_mode not in ('review', 'auto', 'iphone')
    or p_category_depth is null or p_category_depth not in ('primary', 'secondary') then
    raise exception using errcode = '22023', message = 'Invalid SMS preferences.';
  end if;

  insert into moneytrail_private.sms_settings as settings (user_id, mode, beta_iphone_categories, beta_category_depth)
  values (caller, case when p_mode = 'iphone' then 'auto' else p_mode end, p_mode = 'iphone', p_category_depth)
  on conflict (user_id) do update set
    mode = case when excluded.beta_iphone_categories then settings.mode else excluded.mode end,
    beta_iphone_categories = excluded.beta_iphone_categories,
    beta_category_depth = excluded.beta_category_depth;

  return pg_catalog.jsonb_build_object('mode', p_mode, 'category_depth', p_category_depth);
end;
$$;

-- The built-in pairs mirror EXPENSE_DETAILS in src/lib/expenseCategories.ts.
-- A null category checks whether a label is reserved by any built-in pair.
create function moneytrail_private.sms_beta_builtin_detail(p_category text, p_detail text)
returns boolean language sql immutable set search_path = '' as $$
  select exists (
    select 1 from (values
      ('食品酒水', array['买菜食材', '堂食聚餐', '外卖', '咖啡奶茶', '零食饮料', '酒水', '烟酒副食']),
      ('居住与家用', array['房租', '水电燃气', '物业', '日用品', '家居维修', '住宿']),
      ('交通出行', array['公共交通', '打车', '机票火车', '加油充电', '停车通行', '车辆保养维修']),
      ('衣着与美妆', array['衣物', '鞋包', '配饰', '护肤美妆']),
      ('休闲娱乐', array['电影演出', '游戏', '健身', '影音会员', '景区游玩', '旅行团', '休闲娱乐', '按摩足疗', '剧本杀密室', '电影影音', '桌游台球']),
      ('医疗保健', array['医疗服务', '药品', '体检', '保健品']),
      ('学习培训', array['教材', '课程培训', '考试报名']),
      ('人情往来', array['礼金红包', '送礼', '家庭支持']),
      ('通讯', array['手机话费与流量', '家庭宽带']),
      ('其他', array['宠物', '快递费', '保险保费', '数码'])
    ) as taxonomy(category, details)
    where (p_category is null or taxonomy.category = p_category) and p_detail = any(taxonomy.details)
  );
$$;

create function moneytrail_private.sms_beta_rule_pair_valid(p_category text, p_detail text)
returns boolean language sql immutable set search_path = '' as $$
  select moneytrail_private.sms_is_expense_category(p_category) is true
    and (p_detail is null or (
      pg_catalog.char_length(p_detail) between 1 and 40 and p_detail !~ '[[:cntrl:]]'
      and (moneytrail_private.sms_beta_builtin_detail(p_category, p_detail)
        or not moneytrail_private.sms_beta_builtin_detail(null, p_detail))
    ));
$$;

-- Legacy writers may update the suggestion, but may not transfer an automatic
-- recording opt-in to different categories or details. An exact no-op retains it.
create or replace function moneytrail_private.sms_upsert_merchant_rule(
  p_user uuid, p_merchant text, p_category text, p_subcategory text, p_preserve_detail boolean default false
)
returns void language plpgsql set search_path = '' as $$
declare
  key text := moneytrail_private.sms_merchant_key(p_merchant);
  normalized jsonb;
  prior jsonb;
  prior_auto_record boolean;
begin
  if p_merchant is null or pg_catalog.char_length(p_merchant) > 200 or p_merchant ~ '[[:cntrl:]]'
    or (p_category is not null and (not moneytrail_private.sms_can_remember_merchant(p_merchant)
      or not moneytrail_private.sms_is_merchant_category(p_category)))
    or (p_subcategory is not null and (pg_catalog.char_length(p_subcategory) > 40 or p_subcategory !~ '[^[:space:]]')) then
    raise exception using errcode = '22023', message = 'Invalid merchant category rule.';
  end if;
  if key = '' then key := pg_catalog.lower(pg_catalog.btrim(pg_catalog.normalize(p_merchant, 'NFKC'))); end if;
  if key = '' then raise exception using errcode = '22023', message = 'Invalid merchant category rule.'; end if;

  if p_category is not null then
    normalized := moneytrail_private.sms_normalize_merchant_rule(pg_catalog.jsonb_strip_nulls(
      pg_catalog.jsonb_build_object('category', p_category, 'subcategory', p_subcategory)
    ));
    select moneytrail_private.sms_normalize_merchant_rule(pg_catalog.jsonb_strip_nulls(
      pg_catalog.jsonb_build_object('category', rule.category, 'subcategory', rule.subcategory)
    )), rule.auto_record and rule.merchant = key into prior, prior_auto_record
    from moneytrail_private.sms_category_rules as rule
    where rule.user_id = p_user and moneytrail_private.sms_merchant_key(rule.merchant) = key
    order by (rule.merchant = key) desc, rule.merchant limit 1;

    if p_preserve_detail and prior->>'category' = normalized->>'category' and prior ? 'subcategory' then
      normalized := normalized || pg_catalog.jsonb_build_object('subcategory', prior->'subcategory');
    end if;
  end if;

  delete from moneytrail_private.sms_category_rules as rule where rule.user_id = p_user
    and (rule.merchant = key or moneytrail_private.sms_merchant_key(rule.merchant) = key);
  if p_category is null then return; end if;
  if (select pg_catalog.count(*) from moneytrail_private.sms_category_rules where user_id = p_user) >= 200 then
    raise exception using errcode = '54000', message = 'Merchant rule limit reached.';
  end if;
  insert into moneytrail_private.sms_category_rules (user_id, merchant, category, subcategory, auto_record)
  values (p_user, key, normalized->>'category', normalized->>'subcategory',
    coalesce(prior_auto_record and prior = normalized, false));
end;
$$;

create function public.moneytrail_sms_beta_list_rules()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare caller uuid := moneytrail_private.sms_require_account();
  rules jsonb;
begin
  select coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object('merchant', rule.merchant, 'auto_record', rule.auto_record)
    || moneytrail_private.sms_normalize_merchant_rule(pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'category', rule.category, 'subcategory', rule.subcategory
    ))) order by rule.merchant
  ), '[]'::jsonb) into rules
  from moneytrail_private.sms_category_rules as rule where rule.user_id = caller;
  return pg_catalog.jsonb_build_object('rules', rules);
end;
$$;

create function public.moneytrail_sms_beta_set_rule(p_merchant text, p_category text, p_subcategory text, p_auto_record boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare caller uuid := moneytrail_private.sms_require_account();
  key text := moneytrail_private.sms_merchant_key(p_merchant);
begin
  if p_category is not null and p_auto_record is null then
    raise exception using errcode = '22023', message = 'An explicit automatic recording choice is required.';
  end if;

  -- Match the lock already taken by the legacy rule writers and SMS receipt.
  insert into moneytrail_private.sms_settings(user_id) values (caller) on conflict do nothing;
  perform 1 from moneytrail_private.sms_settings where user_id = caller for update;
  perform moneytrail_private.sms_upsert_merchant_rule(caller, p_merchant, p_category, p_subcategory);

  if p_category is not null then
    update moneytrail_private.sms_category_rules as rule set auto_record = p_auto_record
      where rule.user_id = caller and rule.merchant = key
        and (not p_auto_record or moneytrail_private.sms_beta_rule_pair_valid(rule.category, rule.subcategory));
    if not found then
      raise exception using errcode = '22023', message = 'Automatic recording requires a supported merchant category and detail.';
    end if;
  end if;
  return public.moneytrail_sms_beta_list_rules();
end;
$$;

create function moneytrail_private.sms_beta_confirm(
  p_review_token text, p_category text, p_subcategory text, p_v2 boolean, p_automatic boolean
)
returns jsonb language plpgsql set search_path = '' as $$
declare
  invalid constant jsonb := pg_catalog.jsonb_build_object('accepted', false, 'status', 'invalid');
  duplicate_warning constant text := '账本中已有10分钟内同类型、同金额的记录，可能重复，请核对后确认。';
  review moneytrail_private.sms_beta_reviews%rowtype;
  entry moneytrail_private.sms_inbox%rowtype;
  review_user uuid;
  category text;
  detail text;
  classification_reason text;
  confirmed_draft jsonb;
  v_transaction_id text;
begin
  if p_review_token is null or pg_catalog.char_length(p_review_token) <> 78
    or p_review_token !~ '^mt_sms_review_[a-f0-9]{64}$'
    or p_category is null or pg_catalog.char_length(p_category) > 64
    or (p_v2 and (p_subcategory is null or pg_catalog.char_length(p_subcategory) > 40
      or p_subcategory !~ '[^[:space:]]' or p_subcategory ~ '[[:cntrl:]]')) then
    return invalid;
  end if;

  category := pg_catalog.btrim(pg_catalog.normalize(p_category, 'NFKC'));
  if not p_v2 then
    -- Normalize unambiguous aliases for the original category-only Shortcut.
    category := moneytrail_private.sms_normalize_transaction(pg_catalog.jsonb_build_object('category', category)) ->> 'category';
  end if;
  if moneytrail_private.sms_is_expense_category(category) is not true then return invalid; end if;

  select * into review from moneytrail_private.sms_beta_reviews
    where token_hash = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_review_token, 'UTF8')), 'hex');
  if review.inbox_id is null or review.expires_at <= pg_catalog.clock_timestamp()
    or review.allows_subcategory is distinct from p_v2 then return invalid; end if;

  if p_v2 then
    detail := pg_catalog.btrim(p_subcategory);
    if detail <> '未细分' and not moneytrail_private.sms_beta_builtin_detail(category, detail)
      and (category is distinct from review.suggested_category or detail is distinct from review.suggested_subcategory
        or moneytrail_private.sms_beta_builtin_detail(null, detail)) then return invalid; end if;
  end if;

  -- Keep the settings, inbox, ledger lock order used by account review.
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
  if entry.status <> 'pending' or entry.draft->>'kind' is distinct from 'expense' then return invalid; end if;

  v_transaction_id := 'sms-' || entry.id::text;
  confirmed_draft := entry.draft;
  if p_v2 then
    confirmed_draft := confirmed_draft || pg_catalog.jsonb_build_object('category', category, 'subcategory', detail);
  else
    if confirmed_draft->>'category' <> category then confirmed_draft := confirmed_draft - 'subcategory'; end if;
    confirmed_draft := pg_catalog.jsonb_set(confirmed_draft, '{category}', pg_catalog.to_jsonb(category));
  end if;
  classification_reason := case when p_automatic then '个人商户规则自动记账：' else '快捷指令确认：' end || category;
  confirmed_draft := pg_catalog.jsonb_set(confirmed_draft, '{smsEvidence,classificationReason}', pg_catalog.to_jsonb(classification_reason));

  if not moneytrail_private.sms_append(review_user,
    confirmed_draft || pg_catalog.jsonb_build_object('id', v_transaction_id, 'source', 'sms', 'sourceRef', v_transaction_id), true) then
    update moneytrail_private.sms_inbox set warnings = warnings || pg_catalog.jsonb_build_array(duplicate_warning)
      where id = entry.id and not (warnings ? duplicate_warning);
    return pg_catalog.jsonb_build_object('accepted', true, 'status', 'pending', 'id', entry.id);
  end if;

  update moneytrail_private.sms_inbox as inbox set status = 'recorded', raw_text = null,
    draft = confirmed_draft, warnings = '[]'::jsonb, reason = null, transaction_id = v_transaction_id
    where inbox.id = entry.id and inbox.user_id = review_user;
  return pg_catalog.jsonb_build_object('accepted', true, 'status', 'recorded', 'id', entry.id);
end;
$$;

create or replace function public.moneytrail_sms_beta_confirm(p_review_token text, p_category text)
returns jsonb language sql security definer set search_path = '' as $$
  select moneytrail_private.sms_beta_confirm(p_review_token, p_category, null, false, false);
$$;

create function public.moneytrail_sms_beta_confirm_v2(p_review_token text, p_category text, p_subcategory text)
returns jsonb language sql security definer set search_path = '' as $$
  select moneytrail_private.sms_beta_confirm(p_review_token, p_category, p_subcategory, true, false);
$$;

create function public.moneytrail_sms_beta_prepare_v2(p_token text, p_message text)
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
      'merchant', draft->>'merchant', 'category', draft->>'category', 'subcategory', coalesce(draft->>'subcategory', '未细分')
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

revoke all on function moneytrail_private.sms_beta_builtin_detail(text, text) from public, anon, authenticated;
revoke all on function moneytrail_private.sms_beta_rule_pair_valid(text, text) from public, anon, authenticated;
revoke all on function moneytrail_private.sms_beta_confirm(text, text, text, boolean, boolean) from public, anon, authenticated;
revoke all on function public.moneytrail_sms_beta_get_preferences() from public, anon, authenticated;
revoke all on function public.moneytrail_sms_beta_set_preferences(text, text) from public, anon, authenticated;
revoke all on function public.moneytrail_sms_beta_list_rules() from public, anon, authenticated;
revoke all on function public.moneytrail_sms_beta_set_rule(text, text, text, boolean) from public, anon, authenticated;
revoke all on function public.moneytrail_sms_beta_prepare_v2(text, text) from public, anon, authenticated;
revoke all on function public.moneytrail_sms_beta_confirm_v2(text, text, text) from public, anon, authenticated;
grant execute on function public.moneytrail_sms_beta_get_preferences() to authenticated;
grant execute on function public.moneytrail_sms_beta_set_preferences(text, text) to authenticated;
grant execute on function public.moneytrail_sms_beta_list_rules() to authenticated;
grant execute on function public.moneytrail_sms_beta_set_rule(text, text, text, boolean) to authenticated;
grant execute on function public.moneytrail_sms_beta_prepare_v2(text, text) to anon, authenticated;
grant execute on function public.moneytrail_sms_beta_confirm_v2(text, text, text) to anon, authenticated;

notify pgrst, 'reload schema';
commit;
