import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const migrations = import.meta.glob("../../supabase/migrations/*.sql", {
  query: "?raw", import: "default", eager: true,
}) as Record<string, string>;
const repairPath = Object.keys(migrations).find(path => path.endsWith("_sms_missing_branch_bracket.sql"));
const repairMigration = repairPath ? migrations[repairPath] : "";
const classificationMigration = migrations["../../supabase/migrations/202610240001_sms_classification.sql"];
const USER = "11111111-1111-4111-8111-111111111111";
const RECEIVED = "2026-10-24T13:18:00Z";
const merchant = "消费财付通-示例台球俱乐部（青年路店";
const sms = (detail = merchant, amount = "88") =>
  `尾号xxxx卡10月24日21:17支出(${detail})${amount}元，余额xxxx元。【工商银行】`;
type Parsed = { draft: { kind: string; amountCents: number; merchant: string; category: string; smsEvidence?: { text: string } } | null; requires_review: boolean; error: string | null };
let db: PGlite;

async function parse(text = sms(), received = RECEIVED): Promise<Parsed> {
  return (await db.query<{ result: Parsed }>(
    "select moneytrail_private.moneytrail_parse_icbc_sms($1,$2::timestamptz,'review') result", [text, received],
  )).rows[0].result;
}
async function rpc(name: string, args: unknown[] = []): Promise<any> {
  return (await db.query<{ result: any }>(
    `select public.${name}(${args.map((_, index) => `$${index + 1}`).join(",")}) result`, args,
  )).rows[0].result;
}
async function pending(text: string) {
  return (await db.query<{ id: string }>(
    "insert into moneytrail_private.sms_inbox(user_id,received_at,fingerprint,status,raw_text) values($1,$2,repeat('a',64),'pending',$3) returning id",
    [USER, RECEIVED, text],
  )).rows[0].id;
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`create role anon nologin; create role authenticated nologin;
    create schema auth;
    create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz,deleted_at timestamptz);
    create function auth.uid() returns uuid language sql stable as $$select (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid$$;
    grant usage on schema public,auth to anon,authenticated;`);
  for (const path of Object.keys(migrations).sort()) await db.exec(migrations[path]);
}, 30000);
afterAll(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec(`reset role; truncate auth.users cascade;
    insert into auth.users values('${USER}','test@invalid',now(),null,null);`);
  await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ sub: USER })]);
});

describe("narrow ICBC missing branch bracket recovery", () => {
  it("recovers the original 88-yuan billiards debit independently of its balance", async () => {
    const result = await parse();
    expect(result).toMatchObject({ draft: { kind: "expense", amountCents: 8800,
      merchant: "消费财付通-示例台球俱乐部(青年路店)", category: "本地生活", subcategory: "桌游台球" }, requires_review: false, error: null });
    expect(result.draft?.smsEvidence?.text).toContain("余额[已隐藏]元");
    expect(result.draft?.smsEvidence?.text).not.toContain("12,345.94");
  });

  it.each(["店", "青年路店", "青年路分店", "青年路门店", "青年路营业部", "青年路支行", "青年路分行", `${"青".repeat(39)}店`])(
    "recovers only one clearly bounded branch label: %s", async branch => {
      expect(await parse(sms(`消费财付通-示例台球（${branch}`))).toMatchObject({ draft: { amountCents: 8800, category: "本地生活", subcategory: "桌游台球" }, requires_review: false });
    },
  );

  it.each(["消费财付通-示例台球（青年路店）", "消费财付通-示例桌球(青年路店)"])(
    "preserves balanced merchant brackets: %s", async detail => {
      expect(await parse(sms(detail))).toMatchObject({ draft: { merchant: detail.normalize("NFKC"), category: "本地生活", subcategory: "桌游台球" }, requires_review: false });
    },
  );

  it.each([
    "消费财付通-示例台球（青年路", "消费财付通-示例台球（", "消费财付通-示例台球（青年（路店",
    "烟酒(副食", "消费财付通-示例台球(青年路店", "消费财付通-示例台球（青年路店(",
    `消费财付通-示例台球（${"青".repeat(40)}店`, "消费财付通-示例台球（青年路20元店",
    "消费财付通-示例台球（青年路店30元", "消费财付通-示例台球（青年路支出店",
    "消费财付通-示例台球（青年路\n店",
  ])("rejects malformed or ambiguous merchant details: %s", async detail => {
    expect(await parse(sms(detail))).toMatchObject({ draft: null, requires_review: true, error: expect.any(String) });
  });

  it.each([
    sms().replace(")88元", "88元"), sms().replace("支出(", "支出（"),
    sms().replace("88元", "88元另支出20元"), sms().replace("xxxx元", "20元另支出30元"),
    sms().replace("工商银行", "招商银行"), `${sms()}其他通知`, sms().replace("10月24日", "2月30日"),
    sms().replace("88元", "-88元"), sms().replace("xxxx元", "12,34元"),
  ])("retains whole-message, amount, date and bank guards: %s", async text => {
    expect(await parse(text)).toMatchObject({ draft: null, requires_review: true, error: expect.any(String) });
  });

  it.each(["转账财付通-群收款", "微信转账-张三", "转账财付通-群收款（青年路店", "微信转账-张三（青年路店"])(
    "keeps a group collection or unknown transfer pending: %s", async detail => {
      expect((await parse(sms(detail))).requires_review).toBe(true);
    },
  );

  it("retains the original date review thresholds", async () => {
    expect((await parse(sms(), "2026-11-02T13:18:00Z")).requires_review).toBe(true);
    expect((await parse(sms(), "2026-10-24T12:00:00Z")).requires_review).toBe(true);
  });

  it("keeps grouped amounts independent from masked balances", async () => {
    expect(await parse(sms(merchant, "1,088.25").replace("xxxx元", "xx,xxx.94元")))
      .toMatchObject({ draft: { amountCents: 108825, category: "本地生活", subcategory: "桌游台球" }, requires_review: false });
  });

  it.each(["消费财付通-美元台球（青年路店", "消费财付通-验证码台球（青年路店", "消费财付通-示例台球（青年路\t店"])(
    "retains currency, security-code and control-character guards: %s", async detail => {
      expect(await parse(sms(detail))).toMatchObject({ draft: null, requires_review: true, error: expect.any(String) });
    },
  );

  it("keeps the helper immutable and private to the parser", async () => {
    const functionName = "moneytrail_private.sms_repair_missing_branch_bracket(text)";
    for (const role of ["anon", "authenticated"]) {
      expect((await db.query<{ allowed: boolean }>("select has_function_privilege($1,$2,'EXECUTE') allowed", [role, functionName])).rows[0].allowed).toBe(false);
    }
    expect((await db.query("select provolatile,prosecdef from pg_proc where oid=$1::regprocedure", [functionName])).rows[0])
      .toEqual({ provolatile: "i", prosecdef: false });
  });

  it("does not migrate stored SMS text and applies only the selected recovered debit", async () => {
    await db.exec(classificationMigration);
    const recoveredId = await pending(sms());
    const transferText = sms("微信转账-张三", "20");
    const transferId = await pending(transferText);
    expect((await parse()).draft).toBeNull();
    const before = (await db.query("select * from moneytrail_private.sms_inbox order by id")).rows;
    await db.exec(repairMigration);
    expect((await db.query("select * from moneytrail_private.sms_inbox order by id")).rows).toEqual(before);
    const preview = await rpc("moneytrail_sms_preview_pending");
    expect(preview.recordable_count).toBe(1);
    expect(preview.items.find((item: any) => item.id === transferId).eligible).toBe(false);
    expect((await db.query("select * from moneytrail_private.sms_inbox order by id")).rows).toEqual(before);
    const selected = preview.items.filter((item: any) => item.id === recoveredId).map(({ id, draft }: any) => ({ id, draft }));
    expect(await rpc("moneytrail_sms_apply_pending", [selected])).toEqual({ recorded_count: 1, pending_count: 1 });
    expect(await rpc("moneytrail_sms_apply_pending", [selected])).toEqual({ recorded_count: 0, pending_count: 1 });
    const ledger = (await db.query<{ data: any }>("select data from public.moneytrail_ledgers where user_id=$1", [USER])).rows[0].data;
    expect(ledger.transactions).toHaveLength(1);
    // This test deliberately reapplies the historical repair migration.
    expect(ledger.transactions[0]).toMatchObject({ amountCents: 8800, category: "娱乐", kind: "expense" });
    expect((await db.query("select status,raw_text from moneytrail_private.sms_inbox where id=$1", [transferId])).rows[0])
      .toEqual({ status: "pending", raw_text: transferText });
    expect((await db.query("select status,raw_text from moneytrail_private.sms_inbox where id=$1", [recoveredId])).rows[0])
      .toEqual({ status: "recorded", raw_text: null });
  });
});
