-- Classify the stated purpose, never infer dining from a shared Meituan identity.
-- No inbox, rule or ledger data is rewritten by this migration.
begin;

create or replace function moneytrail_private.sms_is_platform_only_merchant(p_merchant text)
returns boolean language plpgsql immutable set search_path='' as $$
declare k text; previous text;
begin
 if p_merchant is null or pg_catalog.char_length(p_merchant)>200 or p_merchant ~ '[[:cntrl:]]' then return false; end if;
 k:=pg_catalog.lower(pg_catalog.btrim(pg_catalog.normalize(p_merchant,'NFKC')));
 if pg_catalog.char_length(k)>200 or k ~ '[[:cntrl:]]'
   or k ~ '(群收款|退款|退回|冲正|撤销|失败|未成功|取消)'
   or pg_catalog.regexp_replace(k,'(手机|话费|流量)充值','','g') ~ '(转账|转出|转入|充值|提现|取现|取款|支取|还款|偿还|缴款|还贷|贷款|余额宝|零钱通|花呗|借呗|白条|网商贷|理财|基金|证券|买入|申购|赎回)'
 then return false; end if;
 loop
   if k in ('美团','美团平台','美团平台商户','美团网','美团支付','美团北京三快在线科技有限公司','美团北京三快在线科技有限公','北京三快在线科技有限公司','北京三快科技有限公司') then return true; end if;
   previous:=k;
   k:=pg_catalog.btrim(pg_catalog.regexp_replace(k,'^(消费|支付(?!宝)|付款)[-—:[:space:]]*',''));
   -- Test the exact identity before stripping 美团支付 as a channel.
   if k in ('美团','美团平台','美团平台商户','美团网','美团支付','美团北京三快在线科技有限公司','美团北京三快在线科技有限公','北京三快在线科技有限公司','北京三快科技有限公司') then return true; end if;
   k:=pg_catalog.btrim(pg_catalog.regexp_replace(k,'^((快捷支付[-[:space:]]*)?(财付通|微信支付|微信|支付宝|美团支付|滴滴支付|银联商务|银联)|快捷支付)[-—:[:space:]]*',''));
   exit when previous=k;
 end loop;
 return false;
end; $$;

create or replace function moneytrail_private.sms_classify(p_merchant text)
returns jsonb language plpgsql immutable set search_path='' as $$
declare k text:=moneytrail_private.sms_merchant_key(p_merchant); c text:='待分类'; r text:='商户用途待分类'; kind text:='expense'; review boolean:=false;
begin
 if p_merchant ~ '群收款' then review:=true; r:='群收款需要核对';
 elsif pg_catalog.btrim(pg_catalog.normalize(p_merchant,'NFKC')) ~ '^(消费|支付|付款)?(微信零钱充值|支付宝余额充值|本人账户互转|本人账户间转账|信用卡还款)$' then kind:='transfer';r:='明确资金周转';
 elsif moneytrail_private.sms_is_platform_only_merchant(p_merchant) then r:='美团平台名称无法判断消费用途';
 elsif k='' then review:=true;r:='支付渠道或转账用途不明确';
 elsif k ~ '(药房|药店|医院|诊所|体检|买药)' then c:='医疗';
 elsif k ~ '(酒店|宾馆|住宿|房租|水费|电费|燃气|物业|宽带|话费|流量|手机充值)' then c:='居住';
 elsif k ~* '(滴滴|嘀嘀无限|出租车|打车|网约车|公交|地铁|火车票|铁路|12306|加油|油站|停车|通行费|ETC)' then c:='交通';
 elsif k ~ '(课程|培训|教材|书店|学费|考试)' then c:='学习';
 elsif k ~* '(台球|桌球|按摩|足浴|足疗|推拿|(^|[^a-z])spa([^a-z]|$)|剧本杀|密室|桌游|棋牌|电影|影院|KTV|游戏|影音会员|视频会员|音乐会员|景区|门票|游乐园)' then c:='娱乐';
 elsif k ~ '(外卖|餐厅|饭店|餐饮|咖啡|奶茶|早餐|烧烤|火锅|面馆|快餐|食堂)' then c:='餐饮';
 elsif k ~ '(烟酒|副食|超市|便利店|服饰|服装|数码|日用品)' then c:='购物';
 elsif k ~ '(京东|淘宝|天猫|拼多多)' then c:='购物';r:='电商平台默认购物'; end if;
 if c<>'待分类' and r='商户用途待分类' then r:='商户关键词：'||c; end if;
 return pg_catalog.jsonb_build_object('category',c,'kind',kind,'requires_review',review,'reason',r);
end; $$;

-- Old platform rules remain visible/deletable but cannot supply a purpose.
create or replace function moneytrail_private.sms_parse_for_account(p_user uuid,p_text text,p_received timestamptz)
returns jsonb language plpgsql stable set search_path='' as $$
declare p jsonb; c text;
begin
 p:=moneytrail_private.moneytrail_parse_icbc_sms(p_text,p_received,'review');
 if p->'requires_review'='false'::jsonb and p#>>'{draft,kind}'='expense'
   and not moneytrail_private.sms_is_platform_only_merchant(p#>>'{draft,merchant}') then
 select category into c from moneytrail_private.sms_category_rules where user_id=p_user and merchant=moneytrail_private.sms_merchant_key(p#>>'{draft,merchant}');
 if c is not null then p:=pg_catalog.jsonb_set(p,'{draft,category}',pg_catalog.to_jsonb(c)); end if;
 end if;
 return p;
end; $$;

create or replace function public.moneytrail_sms_set_category_rule(p_merchant text,p_category text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare caller uuid:=moneytrail_private.sms_require_account(); k text:=moneytrail_private.sms_merchant_key(p_merchant); platform_only boolean:=moneytrail_private.sms_is_platform_only_merchant(p_merchant);
begin
 -- A pure 美团支付 identity has an empty legacy merchant key. Permit removal
 -- (including any legacy exact stored name) without enabling new platform rules.
 if p_category is null and platform_only and k='' then k:='美团支付'; end if;
 if k='' or k ~ '[[:cntrl:]]'
   or (p_category is not null and (platform_only or p_category not in ('餐饮','购物','交通','居住','医疗','娱乐','学习','其他')))
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

revoke all on function moneytrail_private.sms_is_platform_only_merchant(text) from public,anon,authenticated;
revoke all on function moneytrail_private.sms_classify(text) from public,anon,authenticated;
revoke all on function moneytrail_private.sms_parse_for_account(uuid,text,timestamptz) from public,anon,authenticated;
revoke all on function public.moneytrail_sms_set_category_rule(text,text) from public,anon,authenticated;
grant execute on function public.moneytrail_sms_set_category_rule(text,text) to authenticated;

commit;
