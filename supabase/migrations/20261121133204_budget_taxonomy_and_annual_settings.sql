-- Expand category and budget validation without updating existing ledger or SMS rows.
-- The Shortcut transport and bank-specific intake rules keep their current signatures.
begin;

create function moneytrail_private.sms_is_expense_category(p_category text)
returns boolean language sql immutable strict set search_path = '' as $$
  select p_category in (
    '食品酒水', '居住与家用', '交通出行', '衣着与美妆', '休闲娱乐',
    '医疗保健', '学习培训', '人情往来', '通讯', '其他'
  );
$$;

create function moneytrail_private.sms_is_merchant_category(p_category text)
returns boolean language sql immutable strict set search_path = '' as $$
  select moneytrail_private.sms_is_expense_category(p_category)
    or p_category in ('本地生活', '餐饮', '娱乐', '购物', '交通', '居住', '医疗', '学习');
$$;

create or replace function moneytrail_private.sms_normalize_transaction(p_tx jsonb)
returns jsonb language plpgsql immutable strict set search_path = '' as $$
declare
  old_category text := p_tx->>'category';
  detail text := pg_catalog.regexp_replace(p_tx->>'subcategory', '^[[:space:]]+|[[:space:]]+$', '', 'g');
  new_category text;
  new_detail text := detail;
  merchant text := coalesce(p_tx->>'merchant', '');
begin
  if p_tx->>'kind' in ('income', 'transfer') then return p_tx; end if;
  if old_category = '餐饮' or (old_category = '本地生活' and detail in (
    '餐饮', '堂食', '堂食聚餐', '外卖', '咖啡奶茶', '买菜食材', '零食饮料', '酒水', '烟酒副食'
  )) then
    new_category := '食品酒水';
    if detail is null or detail in ('', '未细分') then new_detail := '堂食聚餐'; end if;
  elsif old_category = '娱乐' or (old_category = '本地生活' and detail in (
    '休闲娱乐', '按摩足疗', '剧本杀密室', '桌游台球', '电影影音', '电影演出',
    '景区游玩', '旅行团', '健身', '游戏', '影音会员'
  )) then
    new_category := '休闲娱乐';
    if detail is null or detail in ('', '未细分') then new_detail := '休闲娱乐'; end if;
  elsif old_category = '本地生活' then
    new_category := '待分类';
  elsif old_category = '购物' then
    new_category := case
      when detail in ('服饰', '服装', '衣物', '鞋包', '配饰', '护肤美妆') then '衣着与美妆'
      when detail in ('日用品', '家居维修') then '居住与家用'
      when detail in ('烟酒副食', '买菜食材', '零食饮料', '酒水') then '食品酒水'
      when detail = '数码' then '其他'
      else '待分类'
    end;
    if detail in ('服饰', '服装') then new_detail := '衣物'; end if;
  elsif old_category = '居住' then
    if detail in ('宽带', '家庭宽带') or (detail = '生活缴费' and merchant ~ '宽带') then
      new_category := '通讯'; new_detail := '家庭宽带';
    elsif detail in ('话费', '流量', '手机话费', '手机话费与流量')
      or (detail = '生活缴费' and merchant ~ '话费|手机充值|流量') then
      new_category := '通讯'; new_detail := '手机话费与流量';
    elsif detail = '通讯' then
      new_category := '通讯';
    elsif detail = '生活缴费' then
      if merchant ~ '水费|电费|燃气' then
        new_category := '居住与家用'; new_detail := '水电燃气';
      elsif merchant ~ '物业' then
        new_category := '居住与家用'; new_detail := '物业';
      else
        new_category := '待分类';
      end if;
    else
      new_category := '居住与家用';
    end if;
  else
    new_category := case old_category
      when '交通' then '交通出行'
      when '医疗' then '医疗保健'
      when '学习' then '学习培训'
      else old_category
    end;
  end if;
  if new_category = '食品酒水' and new_detail in ('餐饮', '堂食') then new_detail := '堂食聚餐'; end if;
  if new_category = '衣着与美妆' and new_detail in ('服饰', '服装') then new_detail := '衣物'; end if;
  if new_category = '交通出行' and new_detail = '加油' then new_detail := '加油充电'; end if;
  return p_tx || pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'category', new_category, 'subcategory', new_detail
  ));
end;
$$;

-- Keep a legacy ambiguous rule editable. It cannot classify a new receipt until
-- the account holder supplies its purpose.
create function moneytrail_private.sms_normalize_merchant_rule(p_rule jsonb)
returns jsonb language sql immutable strict set search_path = '' as $$
  select case when normalized->>'category' = '待分类' then p_rule else normalized end
  from (select moneytrail_private.sms_normalize_transaction(p_rule) as normalized) as rule;
$$;

create function moneytrail_private.moneytrail_valid_budget_periods(
  p_periods jsonb, p_year text, p_caps boolean
)
returns boolean language plpgsql immutable set search_path = '' as $$
declare
  period jsonb;
  period_month text;
  previous_month text := '';
  amount numeric;
begin
  if pg_catalog.jsonb_typeof(p_periods) is distinct from 'array' then return false; end if;
  if pg_catalog.jsonb_array_length(p_periods) > 12
    or (p_caps and pg_catalog.jsonb_array_length(p_periods) = 0) then return false; end if;
  for period in select value from pg_catalog.jsonb_array_elements(p_periods) loop
    if pg_catalog.jsonb_typeof(period) is distinct from 'object'
      or period - array['month', 'amountCents'] <> '{}'::jsonb
      or pg_catalog.jsonb_typeof(period->'month') is distinct from 'string' then return false; end if;
    period_month := period->>'month';
    if period_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' or pg_catalog.left(period_month, 4) <> p_year
      or period_month <= previous_month then return false; end if;
    previous_month := period_month;
    if p_caps and period->'amountCents' = 'null'::jsonb then continue; end if;
    if pg_catalog.jsonb_typeof(period->'amountCents') is distinct from 'number' then return false; end if;
    amount := (period->>'amountCents')::numeric;
    if amount < 0 or amount > 1000000000000 or pg_catalog.floor(amount) <> amount then return false; end if;
  end loop;
  return true;
end;
$$;

create function moneytrail_private.moneytrail_valid_annual_budgets(p_budgets jsonb)
returns boolean language plpgsql immutable set search_path = '' as $$
declare
  budget jsonb;
  budget_year numeric;
  year_text text;
  detail text;
  period_count integer := 0;
begin
  if pg_catalog.jsonb_typeof(p_budgets) is distinct from 'array' then return false; end if;
  if pg_catalog.jsonb_array_length(p_budgets) > 12000 then return false; end if;
  for budget in select value from pg_catalog.jsonb_array_elements(p_budgets) loop
    if pg_catalog.jsonb_typeof(budget) is distinct from 'object'
      or budget - array['category', 'subcategory', 'year', 'capChanges', 'monthlyOverrides'] <> '{}'::jsonb
      or pg_catalog.jsonb_typeof(budget->'category') is distinct from 'string'
      or not moneytrail_private.sms_is_expense_category(budget->>'category')
      or pg_catalog.jsonb_typeof(budget->'year') is distinct from 'number' then return false; end if;
    budget_year := (budget->>'year')::numeric;
    if budget_year < 1 or budget_year > 9999 or pg_catalog.floor(budget_year) <> budget_year then return false; end if;
    year_text := pg_catalog.lpad((budget_year::integer)::text, 4, '0');
    detail := budget->>'subcategory';
    if budget ? 'subcategory' and (
      pg_catalog.jsonb_typeof(budget->'subcategory') is distinct from 'string'
      or detail !~ '[^[:space:]]' or detail ~ '^[[:space:]]|[[:space:]]$'
      or pg_catalog.char_length(detail) > 40 or detail = '未细分'
    ) then return false; end if;
    if not moneytrail_private.moneytrail_valid_budget_periods(budget->'capChanges', year_text, true)
      or not moneytrail_private.moneytrail_valid_budget_periods(budget->'monthlyOverrides', year_text, false)
      then return false;
    end if;
    period_count := period_count + pg_catalog.jsonb_array_length(budget->'capChanges')
      + pg_catalog.jsonb_array_length(budget->'monthlyOverrides');
    if period_count > 12000 then return false; end if;
  end loop;
  return not exists (
    select 1 from pg_catalog.jsonb_array_elements(p_budgets) as budgets(value)
    group by (value->>'year')::numeric, value->>'category', value->>'subcategory' having count(*) > 1
  );
end;
$$;

revoke all on function moneytrail_private.sms_is_expense_category(text) from public, anon, authenticated;
revoke all on function moneytrail_private.sms_is_merchant_category(text) from public, anon, authenticated;
revoke all on function moneytrail_private.sms_normalize_merchant_rule(jsonb) from public, anon, authenticated;
revoke all on function moneytrail_private.moneytrail_valid_budget_periods(jsonb, text, boolean) from public, anon, authenticated;
revoke all on function moneytrail_private.moneytrail_valid_annual_budgets(jsonb) from public, anon, authenticated;

create or replace function moneytrail_private.sms_classify(p_merchant text)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare
  k text := moneytrail_private.sms_merchant_key(p_merchant);
  normalized text := pg_catalog.normalize(p_merchant, 'NFKC');
  category text := '待分类';
  reason text := '商户用途待分类';
  kind text := 'expense';
  purpose text[];
  review boolean := false;
  detail text;
  platform text;
begin
  if normalized ~ '美团' or moneytrail_private.sms_is_platform_only_merchant(p_merchant) then platform := '美团';
  elsif normalized ~ '京东' then platform := '京东';
  elsif normalized ~ '淘宝' then platform := '淘宝';
  elsif normalized ~ '天猫' then platform := '天猫';
  elsif normalized ~ '拼多多' then platform := '拼多多';
  elsif normalized ~ '滴滴|嘀嘀无限' then platform := '滴滴';
  end if;

  if p_merchant ~ '群收款' then
    review := true; reason := '群收款需要核对';
  elsif pg_catalog.btrim(normalized) ~ '^(消费|支付|付款)?(微信零钱充值|支付宝余额充值|本人账户互转|本人账户间转账|信用卡还款)$' then
    kind := 'transfer'; reason := '明确资金周转';
  elsif moneytrail_private.sms_is_platform_only_merchant(p_merchant) then
    review := true; reason := '仅有美团平台名称，具体用途需核对';
  elsif k = '' then
    review := true; reason := '支付渠道或转账用途不明确';
  elsif not moneytrail_private.sms_can_remember_merchant(p_merchant) then
    review := true;
  else
    purpose := case
      when k ~ '宠物|猫粮|狗粮|猫砂|兽医' then array['其他', '宠物']
      when k ~ '保费|人寿保险|商业保险|医疗保险|车险' then array['其他', '保险保费']
      when k ~ '份子钱|礼金|结婚红包|婚礼红包' then array['人情往来', '礼金红包']
      when k ~ '孝敬父母|赡养费' then array['人情往来', '家庭支持']
      when k ~ '生日礼物|送礼' then array['人情往来', '送礼']
      when k ~ '宽带' then array['通讯', '家庭宽带']
      when k ~ '话费|流量|手机充值' then array['通讯', '手机话费与流量']
      when k ~ '药房|药店|买药' then array['医疗保健', '药品']
      when k ~ '体检' then array['医疗保健', '体检']
      when k ~ '保健品' then array['医疗保健', '保健品']
      when k ~ '医院|诊所|挂号|看病' then array['医疗保健', '医疗服务']
      when k ~ '酒店|宾馆|住宿' then array['居住与家用', '住宿']
      when k ~ '房租' then array['居住与家用', '房租']
      when k ~ '水费|电费|燃气' then array['居住与家用', '水电燃气']
      when k ~ '物业' then array['居住与家用', '物业']
      when k ~ '家居维修' then array['居住与家用', '家居维修']
      when k ~ '日用品|纸巾|清洁用品' then array['居住与家用', '日用品']
      when k ~ '滴滴|嘀嘀无限|出租车|打车|网约车' then array['交通出行', '打车']
      when k ~ '机票|火车票|铁路|12306' then array['交通出行', '机票火车']
      when k ~ '公交|地铁' then array['交通出行', '公共交通']
      when k ~ '加油|油站|充电桩|充电站' then array['交通出行', '加油充电']
      when k ~* '停车|通行费|etc' then array['交通出行', '停车通行']
      when k ~ '汽修|车辆维修|车辆保养|汽车维修|汽车保养' then array['交通出行', '车辆保养维修']
      when k ~ '教材|书店|书籍' then array['学习培训', '教材']
      when k ~ '考试' then array['学习培训', '考试报名']
      when k ~ '课程|培训|学费' then array['学习培训', '课程培训']
      when k ~* '按摩|足浴|足疗|推拿|(^|[^a-z])spa([^a-z]|$)' then array['休闲娱乐', '按摩足疗']
      when k ~ '剧本杀|密室' then array['休闲娱乐', '剧本杀密室']
      when k ~ '桌游|棋牌|台球|桌球' then array['休闲娱乐', '桌游台球']
      when k ~ '影音会员|视频会员|音乐会员' then array['休闲娱乐', '影音会员']
      when k ~* '电影|影院|ktv|演出' then array['休闲娱乐', '电影演出']
      when k ~ '游戏' then array['休闲娱乐', '游戏']
      when k ~ '健身' then array['休闲娱乐', '健身']
      when k ~ '旅行团|跟团游' then array['休闲娱乐', '旅行团']
      when k ~ '景区|游乐园' then array['休闲娱乐', '景区游玩']
      when k ~ '买菜|农贸市场|菜市场|生鲜食材' then array['食品酒水', '买菜食材']
      when k ~ '外卖' then array['食品酒水', '外卖']
      when k ~ '咖啡|奶茶' then array['食品酒水', '咖啡奶茶']
      when k ~ '餐厅|饭店|餐饮|早餐|烧烤|火锅|面馆|快餐|食堂|聚餐' then array['食品酒水', '堂食聚餐']
      when k ~ '零食|饮料' then array['食品酒水', '零食饮料']
      when k ~ '酒水' then array['食品酒水', '酒水']
      when k ~ '烟酒|副食' then array['食品酒水', '烟酒副食']
      when k ~ '服饰|服装|衣物' then array['衣着与美妆', '衣物']
      when k ~ '鞋店|鞋包' then array['衣着与美妆', '鞋包']
      when k ~ '配饰' then array['衣着与美妆', '配饰']
      when k ~ '护肤|美妆|化妆品' then array['衣着与美妆', '护肤美妆']
      when k ~ '快递费|寄件费' then array['其他', '快递费']
      when k ~ '数码' then array['其他', '数码']
    end;
    if purpose is not null then category := purpose[1]; detail := purpose[2]; end if;
  end if;
  if category <> '待分类' then reason := '商户关键词：' || category; end if;
  return pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'category', category, 'kind', kind, 'requires_review', review, 'reason', reason,
    'subcategory', detail, 'platform', platform
  ));
end;
$$;

alter table moneytrail_private.sms_category_rules
  drop constraint sms_category_rules_category_check,
  add constraint sms_category_rules_category_check
    check (moneytrail_private.sms_is_merchant_category(category));

create or replace function moneytrail_private.sms_can_remember_merchant(p_merchant text)
returns boolean language sql immutable set search_path='' as $$
 select coalesce(moneytrail_private.sms_merchant_key(p_merchant)<>''
  and not moneytrail_private.sms_is_platform_only_merchant(p_merchant)
  and moneytrail_private.sms_merchant_key(p_merchant) !~ '^(京东|京东商城|京东平台|淘宝|淘宝网|淘宝平台|天猫|天猫商城|天猫平台|拼多多|拼多多平台|滴滴|滴滴出行|抖音|抖音平台)$'
  and moneytrail_private.sms_merchant_key(p_merchant) !~ '^(待补充商户|待补充|未知商户|未知|不详|超市|便利店|商场|商户不详|未提供商户|未识别商户|无商户|[-—]+)$',false);
$$;

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
    or p_data - array['version', 'transactions', 'budgetCents', 'billCheckedMonths', 'annualBudgets'] <> '{}'::jsonb
    or (p_data -> 'version') is distinct from '1'::jsonb
    or pg_catalog.jsonb_typeof(p_data -> 'budgetCents') is distinct from 'number'
    or pg_catalog.jsonb_typeof(p_data -> 'transactions') is distinct from 'array'
    or pg_catalog.jsonb_typeof(p_data -> 'billCheckedMonths') is distinct from 'array'
    or (p_data ? 'annualBudgets' and not moneytrail_private.moneytrail_valid_annual_budgets(p_data->'annualBudgets'))
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
      or (entry->>'category' <> '待分类' and not moneytrail_private.sms_is_merchant_category(entry->>'category'))
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

CREATE OR REPLACE FUNCTION public.save_moneytrail_ledger(p_data jsonb, p_expected_revision bigint)
 RETURNS SETOF moneytrail_ledgers
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
      raise exception using errcode='PT409',message='Ledger changed on another device. Reload before saving.';
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
  -- Snapshots produced by earlier clients omit annual settings. An explicit
  -- empty array can still clear the settings when requested by a current client.
  if not p_data ? 'annualBudgets' and prior.data ? 'annualBudgets' then
    p_data:=pg_catalog.jsonb_set(p_data,'{annualBudgets}',prior.data->'annualBudgets');
  end if;
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
    raise exception using errcode = 'PT409', message = 'Ledger changed on another device. Reload before saving.';
  end if;
  return next saved;
end;
$function$;

create or replace function moneytrail_private.sms_upsert_merchant_rule(
 p_user uuid,p_merchant text,p_category text,p_subcategory text,p_preserve_detail boolean default false
)
returns void language plpgsql set search_path='' as $$
declare k text:=moneytrail_private.sms_merchant_key(p_merchant); normalized jsonb; prior jsonb;
begin
 if p_merchant is null or pg_catalog.char_length(p_merchant)>200 or p_merchant ~ '[[:cntrl:]]'
  or (p_category is not null and (not moneytrail_private.sms_can_remember_merchant(p_merchant)
    or not moneytrail_private.sms_is_merchant_category(p_category)))
  or (p_subcategory is not null and (pg_catalog.char_length(p_subcategory)>40 or p_subcategory !~ '[^[:space:]]'))
 then raise exception using errcode='22023',message='Invalid merchant category rule.'; end if;
 if k='' then k:=pg_catalog.lower(pg_catalog.btrim(pg_catalog.normalize(p_merchant,'NFKC'))); end if;
 if k='' then raise exception using errcode='22023',message='Invalid merchant category rule.'; end if;
 normalized:=moneytrail_private.sms_normalize_merchant_rule(pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object('category',p_category,'subcategory',p_subcategory)));
 if p_category is not null and p_preserve_detail then
  select moneytrail_private.sms_normalize_merchant_rule(pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object('category',r.category,'subcategory',r.subcategory))) into prior
  from moneytrail_private.sms_category_rules r
  where r.user_id=p_user and moneytrail_private.sms_merchant_key(r.merchant)=k
  order by (r.merchant=k) desc,r.merchant limit 1;
  if prior->>'category'=normalized->>'category' and prior ? 'subcategory' then normalized:=normalized||pg_catalog.jsonb_build_object('subcategory',prior->'subcategory'); end if;
 end if;
 delete from moneytrail_private.sms_category_rules r where r.user_id=p_user
  and (r.merchant=k or moneytrail_private.sms_merchant_key(r.merchant)=k);
 if p_category is null then return; end if;
 if (select pg_catalog.count(*) from moneytrail_private.sms_category_rules where user_id=p_user)>=200 then
  raise exception using errcode='54000',message='Merchant rule limit reached.';
 end if;
 insert into moneytrail_private.sms_category_rules(user_id,merchant,category,subcategory)
 values(p_user,k,normalized->>'category',normalized->>'subcategory');
end; $$;

create or replace function public.moneytrail_sms_category_rules()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare caller uuid:=moneytrail_private.sms_require_account(); result jsonb;
begin
 select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('merchant',r.merchant)
  ||moneytrail_private.sms_normalize_merchant_rule(pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object('category',r.category,'subcategory',r.subcategory))) order by r.merchant),'[]'::jsonb)
 into result from moneytrail_private.sms_category_rules r where r.user_id=caller;
 return pg_catalog.jsonb_build_object('rules',result);
end; $$;

CREATE OR REPLACE FUNCTION public.save_moneytrail_ledger_with_rules(p_data jsonb, p_expected_revision bigint, p_rules jsonb)
 RETURNS SETOF moneytrail_ledgers
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
 caller uuid:=moneytrail_private.sms_require_account(); prior public.moneytrail_ledgers%rowtype;
 saved public.moneytrail_ledgers%rowtype; item jsonb; incoming jsonb; original jsonb; normalized jsonb; matched jsonb; k text;
begin
 if p_rules is null or pg_catalog.jsonb_typeof(p_rules)<>'array' then raise exception using errcode='22023',message='Invalid merchant rule intents.'; end if;
 if pg_catalog.jsonb_array_length(p_rules)>200 or not public.moneytrail_valid_payload(p_data)
  or p_expected_revision is null or p_expected_revision<0 or p_expected_revision>=9007199254740991
 then raise exception using errcode='22023',message='Invalid ledger or merchant rule intents.'; end if;
 -- Same global account lock order as intake: settings before ledger.
 insert into moneytrail_private.sms_settings(user_id) values(caller) on conflict do nothing;
 perform 1 from moneytrail_private.sms_settings where user_id=caller for update;
 select * into prior from public.moneytrail_ledgers where user_id=caller for update;
 if (p_expected_revision=0 and prior.user_id is not null) or (p_expected_revision>0 and (prior.user_id is null or prior.revision<>p_expected_revision)) then
  raise exception using errcode='PT409',message='Ledger changed on another device. Reload before saving.';
 end if;
 for item in select value from pg_catalog.jsonb_array_elements(p_rules) loop
  if pg_catalog.jsonb_typeof(item)<>'object' or item-array['transactionId','merchant','category','subcategory']<>'{}'::jsonb
   or pg_catalog.jsonb_typeof(item->'transactionId') is distinct from 'string'
   or pg_catalog.jsonb_typeof(item->'merchant') is distinct from 'string'
   or pg_catalog.jsonb_typeof(item->'category') is distinct from 'string'
   or (item ? 'subcategory' and pg_catalog.jsonb_typeof(item->'subcategory') is distinct from 'string')
   or not moneytrail_private.sms_valid_metadata(item)
   or not moneytrail_private.sms_is_merchant_category(item->>'category')
   or not moneytrail_private.sms_can_remember_merchant(item->>'merchant')
  then raise exception using errcode='22023',message='Invalid merchant rule intent.'; end if;
  if (select pg_catalog.count(*) from pg_catalog.jsonb_array_elements(p_rules) candidate where candidate->>'transactionId'=item->>'transactionId')<>1 then
   raise exception using errcode='22023',message='Duplicate merchant rule transaction.';
  end if;
  select value into incoming from pg_catalog.jsonb_array_elements(p_data->'transactions') where value->>'id'=item->>'transactionId';
  incoming:=moneytrail_private.sms_normalize_transaction(incoming);
  normalized:=moneytrail_private.sms_normalize_transaction(item);
  k:=moneytrail_private.sms_merchant_key(item->>'merchant');
  if incoming is null or incoming->>'kind'<>'expense' or not moneytrail_private.sms_can_remember_merchant(incoming->>'merchant')
   or moneytrail_private.sms_merchant_key(incoming->>'merchant')<>k
   or incoming->>'category' is distinct from normalized->>'category'
   or incoming->>'subcategory' is distinct from normalized->>'subcategory'
  then raise exception using errcode='22023',message='Merchant rule does not match incoming transaction.'; end if;
  select value into original from pg_catalog.jsonb_array_elements(prior.data->'transactions') where value->>'id'=item->>'transactionId';
  if original is not null and (original->>'kind'<>'expense' or not moneytrail_private.sms_can_remember_merchant(original->>'merchant') or moneytrail_private.sms_merchant_key(original->>'merchant')<>k) then
   raise exception using errcode='22023',message='Original transaction cannot establish this merchant rule.';
  end if;
  if exists(select 1 from pg_catalog.jsonb_array_elements(p_rules) other
   where moneytrail_private.sms_merchant_key(other->>'merchant')=k
    and ((moneytrail_private.sms_normalize_transaction(other)->>'category') is distinct from normalized->>'category'
      or (moneytrail_private.sms_normalize_transaction(other)->>'subcategory') is distinct from normalized->>'subcategory')) then
   raise exception using errcode='22023',message='Conflicting merchant rule intents.';
  end if;
 end loop;
 select * into saved from public.save_moneytrail_ledger(p_data,p_expected_revision);
 -- An absent detail on an explicit intent clears that detail. The old save RPC's
 -- metadata-preservation contract remains intact for ordinary/older callers.
 select coalesce(pg_catalog.jsonb_agg(case when rule.value is not null then
  (entry.value-'subcategory') || (moneytrail_private.sms_normalize_transaction(rule.value)-array['transactionId','merchant','category'])
  else entry.value end order by entry.ordinality),'[]'::jsonb) into matched
 from pg_catalog.jsonb_array_elements(saved.data->'transactions') with ordinality entry(value,ordinality)
 left join lateral(select value from pg_catalog.jsonb_array_elements(p_rules) where value->>'transactionId'=entry.value->>'id') rule on true;
 -- Re-resolve only new/changed refund links after explicit detail clears. Older
 -- unchanged links keep deliberate manual edits and each refund keeps its receipt.
 select coalesce(pg_catalog.jsonb_agg(
  case when entry.value->>'kind'='refund' and entry.value ? 'linkedTransactionId'
   and (old_tx.value->>'kind' is distinct from 'refund'
    or old_tx.value->>'linkedTransactionId' is distinct from entry.value->>'linkedTransactionId')
  then (entry.value-array['category','subcategory','platform'])
   ||pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'category',source_tx.value->'category','subcategory',source_tx.value->'subcategory','platform',source_tx.value->'platform'))
  else entry.value end order by entry.ordinality),'[]'::jsonb) into matched
 from pg_catalog.jsonb_array_elements(matched) with ordinality entry(value,ordinality)
 left join lateral(select value from pg_catalog.jsonb_array_elements(prior.data->'transactions') where value->>'id'=entry.value->>'id') old_tx on true
 left join lateral(select value from pg_catalog.jsonb_array_elements(matched) where value->>'id'=entry.value->>'linkedTransactionId' and value->>'kind'='expense') source_tx on true;
 saved.data:=pg_catalog.jsonb_set(saved.data,'{transactions}',matched);
 if not public.moneytrail_valid_payload(saved.data) then raise exception using errcode='22023',message='Invalid saved merchant snapshot.'; end if;
 update public.moneytrail_ledgers set data=saved.data where user_id=caller;
 for item in select value from pg_catalog.jsonb_array_elements(p_rules) loop
  perform moneytrail_private.sms_upsert_merchant_rule(caller,item->>'merchant',item->>'category',item->>'subcategory');
 end loop;
 return next saved;
end; $function$;

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
  if moneytrail_private.sms_is_expense_category(rule->>'category') then
   draft:=p->'draft';
   if rule->>'category'<>draft->>'category' or rule ? 'subcategory' then draft:=draft-'subcategory'; end if;
   draft:=draft||rule;
   draft:=pg_catalog.jsonb_set(draft,'{smsEvidence,classificationReason}',pg_catalog.to_jsonb('个人商户规则：'||(rule->>'category')));
   p:=pg_catalog.jsonb_set(p,'{draft}',draft);
  end if;
 end if;
 -- A soundly parsed expense with an unknown purpose may establish a rule
 -- after confirmation. True parsing/safety warnings are kept separate.
 if p->'requires_review'='false'::jsonb and p#>>'{draft,kind}'='expense'
   and p#>>'{draft,category}'='待分类' then
  p:=p||pg_catalog.jsonb_build_object('requires_review',true,'error','请核对商户用途与分类。');
 end if;
 return p;
end; $$;

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
   or p_draft->>'category' is null or not moneytrail_private.sms_is_merchant_category(p_draft->>'category')
  then raise exception using errcode='22023',message='Original SMS cannot establish this merchant rule.'; end if;
 end if;
 -- Reuse the existing owner/metadata validation and receipt evidence rebuild.
 result:=public.moneytrail_sms_confirm(p_id,p_draft);
 if p_remember then perform moneytrail_private.sms_upsert_merchant_rule(caller,p_draft->>'merchant',p_draft->>'category',p_draft->>'subcategory'); end if;
 return result;
end; $$;

notify pgrst,'reload schema';
commit;
