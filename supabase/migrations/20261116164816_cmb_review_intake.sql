-- Add CMB to the review-only receipt boundary. The established parsers,
-- receiver, token ownership and every business row remain unchanged.
begin;

create or replace function moneytrail_private.sms_review_bank_source(p_text text)
returns text language plpgsql immutable set search_path='' as $$
declare t text; signature text[]; claims integer; bank text;
begin
 if p_text is null or pg_catalog.char_length(p_text)>2000 then return null; end if;
 t:=pg_catalog.btrim(pg_catalog.normalize(p_text,'NFKC'),' '||pg_catalog.chr(9)||pg_catalog.chr(10)||pg_catalog.chr(13));
 -- Count unknown and round bank markers too; only one boundary claim is valid.
 select count(*)::integer into claims from pg_catalog.regexp_matches(t,'【[^【】]*银行[^【】]*】|\([^()]*银行[^()]*\)','g');
 if claims<>1 then return null; end if;
 signature:=pg_catalog.regexp_match(t,'^(【(?:中国农业银行|农业银行|中国银行|中国建设银行|建设银行|招商银行)】|\((?:中国农业银行|农业银行|中国银行|中国建设银行|建设银行|招商银行)\))');
 if signature is null then
  signature:=pg_catalog.regexp_match(t,'(【(?:中国农业银行|农业银行|中国银行|中国建设银行|建设银行|招商银行)】|\((?:中国农业银行|农业银行|中国银行|中国建设银行|建设银行|招商银行)\))[。.]?$');
 end if;
 if signature is null or pg_catalog.replace(t,signature[1],'') ~ '银行' then return null; end if;
 bank:=pg_catalog.regexp_replace(signature[1],'[【】()]','','g');
 return case bank when '农业银行' then 'abc' when '中国农业银行' then 'abc'
  when '中国银行' then 'boc' when '建设银行' then 'ccb' when '中国建设银行' then 'ccb'
  when '招商银行' then 'cmb' end;
end; $$;

revoke all on function moneytrail_private.sms_review_bank_source(text) from public,anon,authenticated;

notify pgrst,'reload schema';
commit;
