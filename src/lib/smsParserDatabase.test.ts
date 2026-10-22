/** Executes the migration in real PostgreSQL; no mocked regex or date parser. */
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import migration from "../../supabase/migrations/202610220003_sms_parser.sql?raw";

type ParsedSms = {
  draft: null | {
    kind: "expense" | "transfer";
    amountCents: number;
    date: string;
    merchant: string;
    category: "待分类";
    source: "sms";
    note: "";
  };
  warnings: string[];
  requires_review: boolean;
  error: string | null;
};

let db: PGlite;
const RECEIVED = "2026-10-22T11:28:00Z"; // 19:28 in Shanghai.
const SAMPLE = "尾号xxxx卡10月22日19:27支出(转账财付通-群收款)30.90元，余额8xxxx元。【工商银行】";
function debit(description = "消费-咖啡店", amount = "30.90", date = "10月22日19:27", balance = "89999.18") {
  return `尾号1234卡${date}支出(${description})${amount}元，余额${balance}元。【工商银行】`;
}
async function parse(text: string | null, received: string | null = RECEIVED, groupKind?: string | null): Promise<ParsedSms> {
  const result = groupKind === undefined
    ? await db.query<{ result: ParsedSms }>("select moneytrail_private.moneytrail_parse_icbc_sms($1::text,$2::timestamptz) as result", [text, received])
    : await db.query<{ result: ParsedSms }>("select moneytrail_private.moneytrail_parse_icbc_sms($1::text,$2::timestamptz,$3::text) as result", [text, received, groupKind]);
  return result.rows[0].result;
}
function expectRejected(result: ParsedSms) {
  expect(result.draft).toBeNull();
  expect(result.requires_review).toBe(true);
  expect(result.warnings).toEqual([]);
  expect(typeof result.error).toBe("string");
  expect(result.error?.length).toBeGreaterThan(0);
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec("create role anon nologin; create role authenticated nologin;");
  await db.exec(migration);
}, 30_000);
afterAll(async () => { await db?.close(); });

describe("private PostgreSQL ICBC SMS parser", () => {
  it("extracts the provided masked group-collection sample, requiring confirmation by default", async () => {
    expect(await parse(SAMPLE)).toEqual({
      draft: {
        kind: "expense", amountCents: 3090, date: "2026-10-22T19:27",
        merchant: "财付通-群收款", category: "待分类", source: "sms", note: "",
      },
      warnings: ["群收款可能是消费或转账，请核对后确认。"], requires_review: true, error: null,
    });
  });

  it.each(["expense", "transfer"] as const)("uses an explicit %s group interpretation only when supplied", async (groupKind) => {
    expect(await parse(SAMPLE, RECEIVED, groupKind)).toMatchObject({
      draft: { kind: groupKind, amountCents: 3090, merchant: "财付通-群收款" },
      warnings: [], requires_review: false, error: null,
    });
  });

  it.each(["转账微信群收款", "微信-群收款", "转账微信支付-群收款"])("keeps the recognized group description %s pending by default", async (description) => {
    const result = await parse(debit(description));
    expect(result.draft?.merchant).toBe(description.replace(/^转账/, ""));
    expect(result.requires_review).toBe(true);
    expect(result.draft?.kind).toBe("expense");
  });

  it.each(["转账-个人收款", "支付宝充值", "微信零钱提现", "信用卡还款"])("does not count %s as spending even with an expense group preference", async (description) => {
    const result = await parse(debit(description), RECEIVED, "expense");
    expect(result).toMatchObject({ draft: { kind: "transfer", merchant: description }, requires_review: true, error: null });
    expect(result.warnings).toHaveLength(1);
  });

  it.each(["消费-咖啡店", "商户-超市", "支付-地铁"])("recognizes a recent, unambiguous debit description %s", async (description) => {
    expect(await parse(debit(description))).toMatchObject({
      draft: { kind: "expense", amountCents: 3090, merchant: description }, warnings: [], requires_review: false, error: null,
    });
  });

  it("requires review for a bare merchant description whose purpose is unclear", async () => {
    expect(await parse(debit("某某商店"))).toMatchObject({ draft: { kind: "expense" }, requires_review: true, error: null });
  });

  it.each(["支付-财付通-群收款", "消费群收款", "商户-其他群收款"])("never lets a debit prefix bypass group confirmation: %s", async (description) => {
    expect(await parse(debit(description))).toMatchObject({ draft: { kind: "expense" }, requires_review: true, error: null });
  });

  it.each(["支付退款", "消费退回", "支付冲正", "商户撤销", "支付失败", "支付未成功", "消费取消"])("requires review for reversal or failure language: %s", async (description) => {
    const result = await parse(debit(description));
    expect(result.requires_review).toBe(true);
    expect(result.warnings).toContain("交易描述涉及退款、撤销或失败，请手动核对实际扣款。");
  });

  it("never substitutes the numeric balance for the transaction amount or exposes it", async () => {
    const result = await parse(debit("消费-咖啡店", "30.90", undefined, "89999.18"));
    expect(result.draft?.amountCents).toBe(3090);
    expect(JSON.stringify(result)).not.toContain("89999");
    expect(Object.keys(result.draft!).sort()).toEqual(["kind", "amountCents", "date", "merchant", "category", "source", "note"].sort());
    expectRejected(await parse("尾号1234卡10月22日19:27余额89999.18元。【工商银行】"));
  });

  it("accepts fullwidth digits and punctuation without floating point conversion", async () => {
    const fullwidth = "尾号１２３４卡１０月２２日１９：２７支出（消费-咖啡店）３０．９０元，余额８９９９９．１８元。【工商银行】";
    expect(await parse(fullwidth)).toEqual(await parse(debit()));
  });

  it.each([["0.01", 1], ["0.1", 10], ["30", 3000], ["10000000000.00", 1_000_000_000_000]] as const)("converts %s yuan to exactly %i integer cents", async (amount, cents) => {
    expect((await parse(debit("消费-商店", amount))).draft?.amountCents).toBe(cents);
  });

  it.each(["0", "0.00", "-30.90", "+30.90", "30.901", "30.", ".90", "1e3", "NaN", "10000000000.01", "99999999999999999999.99"])("rejects invalid or out-of-range amount %s", async (amount) => {
    expectRejected(await parse(debit("消费-商店", amount)));
  });

  it.each([
    debit("消费-套餐20.00元"),
    debit("消费-套餐20.00 元"),
    debit("消费-人民币20.00"),
    debit("消费-RMB20.00"),
    debit() + debit("消费-另一商店", "12.00"),
    debit().replace("，余额", "，另支出12.00元，余额"),
    debit().replace("工商银行", "建设银行"),
    debit().replace("支出", "收入"),
    debit().replace("支出", "支出人民币"),
    "余额30.90元。【工商银行】",
  ])("rejects unsupported banks, multiple amounts and non-debit formats", async (message) => {
    expectRejected(await parse(message));
  });

  it.each(["美元", "港币", "日元", "USD", "EUR", "£", "¥"])("rejects foreign or ambiguous currency marker %s", async (currency) => {
    expectRejected(await parse(debit(`消费-${currency}商店`)));
  });

  it.each(["验证码123456", "动态码123456", "登录密码123456", "OTP123456"])("rejects security text %s without echoing any original text", async (securityText) => {
    const message = debit(`消费-${securityText}`);
    const result = await parse(message);
    expectRejected(result);
    expect(JSON.stringify(result)).not.toContain("123456");
    expect(JSON.stringify(result)).not.toContain("89999.18");
    expect(JSON.stringify(result)).not.toContain(message);
  });

  it.each(["2月29日19:27", "4月31日19:27", "0月22日19:27", "13月22日19:27", "10月0日19:27", "10月32日19:27", "10月22日24:00", "10月22日19:60", "0000年10月22日19:27"])("rejects impossible date or time %s", async (date) => {
    expectRejected(await parse(debit("消费-商店", "30.90", date), "2026-03-01T12:00:00+08:00"));
  });

  it("accepts an actual leap date and infers the prior leap year before validating February 29", async () => {
    expect((await parse(debit("消费-商店", "30.90", "2024年2月29日19:27"), "2024-02-29T19:28:00+08:00")).draft?.date).toBe("2024-02-29T19:27");
    const inferred = await parse(debit("消费-商店", "30.90", "2月29日19:27"), "2025-01-01T00:00:00+08:00");
    expect(inferred.draft?.date).toBe("2024-02-29T19:27");
    expect(inferred.requires_review).toBe(true);
  });

  it("infers December in the previous year at New Year", async () => {
    const result = await parse(debit("消费-商店", "30.90", "12月31日23:59"), "2027-01-01T00:01:00+08:00");
    expect(result).toMatchObject({ draft: { date: "2026-12-31T23:59" }, warnings: [], requires_review: false });
  });

  it("uses Shanghai's year even when the UTC receipt is still in the previous year", async () => {
    const result = await parse(debit("消费-商店", "30.90", "1月1日00:02"), "2026-12-31T16:03:00Z");
    expect(result).toMatchObject({ draft: { date: "2027-01-01T00:02" }, warnings: [], requires_review: false });
  });

  it("requires confirmation for future timestamps beyond ten minutes", async () => {
    expect((await parse(debit("消费-商店", "30.90", "10月22日19:38"))).requires_review).toBe(false);
    const result = await parse(debit("消费-商店", "30.90", "10月22日19:39"));
    expect(result.requires_review).toBe(true);
    expect(result.warnings).toEqual(["交易时间晚于短信接收时间，请核对。"]);
    expect((await parse(debit("消费-商店", "30.90", "2027年10月22日19:27"))).requires_review).toBe(true);
  });

  it("requires confirmation for timestamps older than seven days", async () => {
    expect((await parse(debit("消费-商店", "30.90", "10月15日19:28"))).requires_review).toBe(false);
    const result = await parse(debit("消费-商店", "30.90", "10月15日19:27"));
    expect(result.requires_review).toBe(true);
    expect(result.warnings).toEqual(["交易时间已超过7天，请核对是否重复或补录。"]);
  });

  it.each(["", " ", null, "x".repeat(2049)])("rejects blank, absent or oversized messages", async (message) => {
    expectRejected(await parse(message));
  });

  it.each([null, "infinity", "-infinity"])("rejects an absent or non-finite receipt timestamp", async (received) => {
    expectRejected(await parse(SAMPLE, received));
  });

  it.each([null, "", "auto", "EXPENSE"])("rejects an invalid group interpretation %s", async (groupKind) => {
    expectRejected(await parse(SAMPLE, RECEIVED, groupKind));
  });

  it.each(["", " ", "消费-" + "店".repeat(198), "消费-\n商店"])("rejects an empty, too-long or control-character merchant", async (description) => {
    expectRejected(await parse(debit(description)));
  });

  it.each(["anon", "authenticated"] as const)("denies %s direct parser execution and private schema access", async (role) => {
    const privileges = await db.query<{ schema_allowed: boolean; function_allowed: boolean }>(`
      select pg_catalog.has_schema_privilege($1, 'moneytrail_private', 'USAGE') as schema_allowed,
        pg_catalog.has_function_privilege($1, 'moneytrail_private.moneytrail_parse_icbc_sms(text,timestamptz,text)', 'EXECUTE') as function_allowed
    `, [role]);
    expect(privileges.rows[0]).toEqual({ schema_allowed: false, function_allowed: false });
    await db.exec(`set role ${role}`);
    try { await expect(parse(SAMPLE)).rejects.toMatchObject({ code: "42501" }); }
    finally { await db.exec("reset role"); }
  });

  it("revokes default PUBLIC execution and safely reapplies the migration", async () => {
    await db.exec(migration);
    const grants = await db.query<{ count: number }>(`
      select pg_catalog.count(*)::integer as count from pg_catalog.pg_proc as procedure,
        lateral pg_catalog.aclexplode(coalesce(procedure.proacl, pg_catalog.acldefault('f', procedure.proowner))) as permission
      where procedure.oid = 'moneytrail_private.moneytrail_parse_icbc_sms(text,timestamptz,text)'::regprocedure
        and permission.grantee = 0 and permission.privilege_type = 'EXECUTE'
    `);
    expect(grants.rows[0].count).toBe(0);
    expect((await parse(SAMPLE)).draft?.amountCents).toBe(3090);
  });
});
