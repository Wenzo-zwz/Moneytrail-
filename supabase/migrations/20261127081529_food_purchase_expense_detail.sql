-- Keep the SMS confirmation taxonomy aligned with EXPENSE_DETAILS.
begin;

create or replace function moneytrail_private.sms_beta_builtin_detail(p_category text, p_detail text)
returns boolean language sql immutable set search_path = '' as $$
  select exists (
    select 1 from (values
      ('食品酒水', array['买菜食材', '食品采购', '堂食聚餐', '外卖', '咖啡奶茶', '零食饮料', '酒水', '烟酒副食']),
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

-- Legacy local-life rows use the same food details as the client normalizer.
-- This changes normalization on access without rewriting stored rows.
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
    '餐饮', '堂食', '堂食聚餐', '外卖', '咖啡奶茶', '买菜食材', '食品采购', '零食饮料', '酒水', '烟酒副食'
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

revoke all on function moneytrail_private.sms_beta_builtin_detail(text, text) from public, anon, authenticated;

notify pgrst, 'reload schema';
commit;
