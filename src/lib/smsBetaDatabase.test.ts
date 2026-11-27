import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

const migrations = import.meta.glob("../../supabase/migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const owner = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const invalid = { accepted: false, status: "invalid" };
let db: PGlite;

type Receipt = {
  accepted: boolean;
  status: string;
  id: string;
  review_token: string;
  amount?: string;
  merchant?: string;
  suggested_category?: string;
  suggested_subcategory?: string;
  category_depth?: "primary" | "secondary";
  category?: string;
  subcategory?: string;
};
type InboxItem = { id: string; status: string; draft: Record<string, unknown>; warnings: string[]; raw_text: string | null };
type Ledger = { data: { transactions: Record<string, unknown>[] }; revision: number };
type BetaPreferences = { mode: "review" | "auto" | "iphone"; category_depth: "primary" | "secondary" };
type BetaRule = { merchant: string; category: string; subcategory?: string; auto_record: boolean };

async function rpc<T>(name: string, args: unknown[] = [], account?: string): Promise<T> {
  const role = account ? "authenticated" : "anon";
  const parameters = args.map((_, index) => "$" + (index + 1)).join(",");
  await db.exec("set role " + role);
  await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ role, sub: account })]);
  try {
    return (await db.query<{ value: T }>("select public." + name + "(" + parameters + ") as value", args)).rows[0].value;
  } finally {
    await db.exec("reset role");
  }
}

async function rotate(account = owner, mode = "auto") {
  return (await rpc<{ token: string }>("moneytrail_sms_rotate", [mode], account)).token;
}

function prepare(token: string, message: string) {
  return rpc<Receipt>("moneytrail_sms_beta_prepare", [token, message]);
}

function confirm(token: string, category: string | null) {
  return rpc<Receipt>("moneytrail_sms_beta_confirm", [token, category]);
}

function preferences(account: string) {
  return rpc<BetaPreferences>("moneytrail_sms_beta_get_preferences", [], account);
}

function setPreferences(mode: BetaPreferences["mode"], depth: BetaPreferences["category_depth"] = "primary", account = owner) {
  return rpc<BetaPreferences>("moneytrail_sms_beta_set_preferences", [mode, depth], account);
}

function prepareV2(token: string, message: string) {
  return rpc<Receipt>("moneytrail_sms_beta_prepare_v2", [token, message]);
}

function confirmV2(token: string, category: string, subcategory: string) {
  return rpc<Receipt>("moneytrail_sms_beta_confirm_v2", [token, category, subcategory]);
}

function setBetaRule(merchant: string, category: string | null, subcategory: string, autoRecord: boolean) {
  return rpc<{ rules: BetaRule[] }>("moneytrail_sms_beta_set_rule", [merchant, category, subcategory, autoRecord], owner);
}

async function sms(merchant = "消费支付宝-清泉咖啡", amount = "30.90", minutesAgo = 0) {
  const date = (await db.query<{ value: string }>(
    "select to_char((clock_timestamp() at time zone 'Asia/Shanghai') - $1::int * interval '1 minute', 'YYYY年MM月DD日HH24:MI') as value",
    [minutesAgo],
  )).rows[0].value;
  return `尾号1234卡${date}支出(${merchant})${amount}元，余额9876.54元。【工商银行】`;
}

async function ledger(account = owner) {
  return (await db.query<Ledger>(
    "select data, revision::integer as revision from public.moneytrail_ledgers where user_id = $1::uuid",
    [account],
  )).rows[0];
}

async function inbox(account = owner) {
  return (await rpc<{ items: InboxItem[] }>("moneytrail_sms_inbox", [], account)).items;
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create schema auth;
    create table auth.users(id uuid primary key, email text, email_confirmed_at timestamptz, banned_until timestamptz, deleted_at timestamptz);
    create function auth.uid() returns uuid language sql stable set search_path = '' as
      $$select (nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb->>'sub')::uuid$$;
    grant usage on schema public, auth to anon, authenticated;
  `);
  for (const path of Object.keys(migrations).sort()) await db.exec(migrations[path]);
}, 30_000);

beforeEach(async () => {
  await db.exec("reset role; truncate auth.users cascade;");
  await db.query("insert into auth.users values ($1,'a@example.invalid',now(),null,null), ($2,'b@example.invalid',now(),null,null)", [owner, other]);
});

afterAll(async () => { await db?.close(); });

it("stages a recognized payment and keeps the SMS pending when the shortcut stops", async () => {
  const raw = await sms();
  const result = await prepare(await rotate(), raw);
  expect(result).toEqual({
    accepted: true, status: "pending", id: expect.any(String), review_token: expect.stringMatching(/^mt_sms_review_[a-f0-9]{64}$/),
    amount: "30.90", merchant: "消费支付宝-清泉咖啡", suggested_category: "食品酒水",
  });
  expect(await ledger()).toBeUndefined();
  expect(await inbox()).toMatchObject([{ id: result.id, status: "pending", raw_text: raw }]);
  expect(JSON.stringify(await inbox())).not.toContain(result.review_token);
});

it("records an explicit category with preserved SMS evidence and applies a repeat only once", async () => {
  const result = await prepare(await rotate(), await sms());
  expect(await confirm(result.review_token, "交通出行")).toEqual({ accepted: true, status: "recorded", id: result.id });
  const saved = await ledger();
  expect(saved).toMatchObject({
    revision: 1,
    data: { transactions: [{
      id: "sms-" + result.id, sourceRef: "sms-" + result.id, source: "sms", kind: "expense",
      amountCents: 3090, category: "交通出行", merchant: "消费支付宝-清泉咖啡",
      smsEvidence: { text: expect.any(String), classificationReason: "快捷指令确认：交通出行" },
    }] },
  });
  expect(saved.data.transactions[0]).not.toHaveProperty("subcategory");
  expect(saved.data.transactions[0].smsEvidence).toMatchObject({
    text: expect.not.stringMatching(/1234|9876\.54/),
  });
  expect(await inbox()).toMatchObject([{ id: result.id, status: "recorded", raw_text: null }]);
  expect(await confirm(result.review_token, "食品酒水")).toEqual({ accepted: true, status: "recorded", id: result.id });
  expect(await ledger()).toEqual(saved);
});

it.each([
  ["餐饮", "食品酒水"],
  ["居住", "居住与家用"],
  ["交通", "交通出行"],
  ["娱乐", "休闲娱乐"],
  ["医疗", "医疗保健"],
  ["学习", "学习培训"],
])("maps legacy category %s to %s", async (alias, category) => {
  const result = await prepare(await rotate(), await sms());
  expect((await confirm(result.review_token, alias)).status).toBe("recorded");
  expect((await ledger()).data.transactions[0].category).toBe(category);
});

it.each(["消费-清泉商贸有限公司", "消费美团支付"])("prompts for the purpose of a clear debit (%s)", async merchant => {
  const result = await prepare(await rotate(), await sms(merchant, "1,375.9"));
  expect(result).toMatchObject({ status: "pending", review_token: expect.stringMatching(/^mt_sms_review_/), amount: "1375.90", merchant });
  expect(result).not.toHaveProperty("suggested_category");
  expect(await ledger()).toBeUndefined();
  expect((await confirm(result.review_token, "其他")).status).toBe("recorded");
  expect((await ledger()).data.transactions[0].amountCents).toBe(137590);
});

it("retains review for non-expense types, parser errors, questionable dates and unverified bank formats", async () => {
  const token = await rotate();
  const otherCases = [
    await sms("转账财付通-群收款"),
    await sms("信用卡还款"),
    await sms("转账-某医院"),
    await sms("消费-清泉咖啡退款"),
    await sms("消费美团支付", "30.90", -11),
    await sms("消费-青石餐厅", "30.90", 8 * 24 * 60),
    (await sms()).replace(/\d{2}月\d{2}日/, "02月30日"),
    "您今日支出30.90元【工商银行】",
    "尾号1234卡11月10日14:50工商银行收入(工资)30元，余额88元。【工商银行】",
    "〖招商银行〗您账户1234于11月10日14:50在〖清泉咖啡〗快捷支付30元，余额88元。",
    "【建设银行】您尾号1234的储蓄卡账户支出30元。",
  ];
  for (const raw of otherCases) {
    const result = await prepare(token, raw);
    expect(result).toEqual({ accepted: true, status: "pending", review_token: "", id: expect.any(String) });
  }
  expect(await ledger()).toBeUndefined();
  expect(await inbox()).toHaveLength(otherCases.length);
});

it("rejects credential and unrelated messages before they can enter the inbox", async () => {
  const token = await rotate();
  await expect(prepare("mt_sms_" + "0".repeat(64), await sms())).rejects.toMatchObject({ code: "42501" });
  for (const raw of ["工商银行验证码123456", "支付宝支出30元", "", (await sms()).replace("消费支付宝", "OTP123")]) {
    await expect(prepare(token, raw)).rejects.toMatchObject({ code: "22023" });
  }
  expect(await inbox()).toEqual([]);
});

it("rejects invalid and non-specific categories while preserving the draft", async () => {
  const result = await prepare(await rotate(), await sms());
  for (const category of [null, "", "待分类", "购物", "本地生活", "稍后处理", "收入", "自定义"]) {
    expect(await confirm(result.review_token, category)).toEqual(invalid);
  }
  expect(await ledger()).toBeUndefined();
  expect(await inbox()).toMatchObject([{ id: result.id, status: "pending" }]);
});

it("deduplicates across both SMS endpoints without issuing a new review token", async () => {
  const token = await rotate();
  const raw = await sms();
  const result = await prepare(token, raw);
  expect(await prepare(token, raw)).toEqual({ accepted: true, status: "duplicate", id: result.id, review_token: "" });
  expect(await rpc("moneytrail_receive_sms", [token, raw])).toEqual({ accepted: true, status: "duplicate", id: result.id });
  expect(await ledger()).toBeUndefined();

  const automaticRaw = await sms("消费-甜玉药店", "6");
  const automatic = await rpc<Receipt>("moneytrail_receive_sms", [token, automaticRaw]);
  expect(automatic).toEqual({ accepted: true, status: "recorded", id: expect.any(String) });
  expect(await prepare(token, automaticRaw)).toEqual({ accepted: true, status: "duplicate", id: automatic.id, review_token: "" });
  expect((await ledger()).data.transactions).toHaveLength(1);
});

it("cannot use either account intake token, a receipt ID, or a second account's token to change a pending SMS", async () => {
  const aliceToken = await rotate(owner, "review");
  const bobToken = await rotate(other);
  const raw = await sms();
  const old = await rpc<Receipt>("moneytrail_receive_sms", [aliceToken, raw]);
  expect(await prepare(aliceToken, raw)).toEqual({ accepted: true, status: "duplicate", id: old.id, review_token: "" });
  const current = await prepare(bobToken, raw);
  for (const token of [aliceToken, bobToken, old.id, current.id, current.review_token.replace(/.$/, "z")]) {
    expect(await confirm(token, "其他")).toEqual(invalid);
  }
  expect(await ledger(owner)).toBeUndefined();
  expect(await ledger(other)).toBeUndefined();
  expect((await confirm(current.review_token, "其他")).id).toBe(current.id);
  expect(await ledger(owner)).toBeUndefined();
  expect((await ledger(other)).data.transactions).toHaveLength(1);
});

it.each(["expired", "rotated", "revoked", "banned", "dismissed"] as const)("rejects a review token once %s", async state => {
  const result = await prepare(await rotate(), await sms());
  if (state === "expired") {
    await db.query("update moneytrail_private.sms_beta_reviews set expires_at=now()-interval '1 second' where inbox_id=$1", [result.id]);
  } else if (state === "rotated") {
    await rotate();
  } else if (state === "revoked") {
    await rpc("moneytrail_sms_revoke", [], owner);
  } else if (state === "banned") {
    await db.query("update auth.users set banned_until=now()+interval '1 hour' where id=$1", [owner]);
  } else {
    await rpc("moneytrail_sms_dismiss", [result.id], owner);
  }
  expect(await confirm(result.review_token, "其他")).toEqual(invalid);
  expect(await ledger()).toBeUndefined();
  if (state === "banned") await db.query("update auth.users set banned_until=null where id=$1", [owner]);
  expect((await inbox()).at(0)?.status).toBe(state === "dismissed" ? "dismissed" : "pending");
});

it("defers if the ledger already contains a possible match by confirmation time", async () => {
  const token = await rotate();
  const raw = await sms();
  const result = await prepare(token, raw);
  const pending = (await inbox())[0];
  const transaction: Record<string, unknown> = { ...pending.draft, id: "csv-1", source: "csv" };
  delete transaction.smsEvidence;
  await rpc("save_moneytrail_ledger", [{ version: 1, transactions: [transaction], budgetCents: 0, billCheckedMonths: [] }, 0], owner);
  const saved = await ledger();
  expect(await confirm(result.review_token, "其他")).toEqual({ accepted: true, status: "pending", id: result.id });
  expect(await confirm(result.review_token, "医疗保健")).toEqual({ accepted: true, status: "pending", id: result.id });
  expect(await ledger()).toEqual(saved);
  expect(await inbox()).toMatchObject([{ id: result.id, raw_text: raw, status: "pending", warnings: [expect.stringContaining("可能重复")] }]);
});

it("hides serialized receipt hashes and shared helper from API roles", async () => {
  const privileges = (await db.query<{ allowed: boolean }>(`
    select has_table_privilege(role, 'moneytrail_private.sms_beta_reviews', 'SELECT')
      or has_function_privilege(role, 'moneytrail_private.sms_receive(text,text,boolean)', 'EXECUTE')
      or has_function_privilege(role, 'moneytrail_private.sms_beta_builtin_detail(text,text)', 'EXECUTE')
      or has_function_privilege(role, 'moneytrail_private.sms_normalize_transaction(jsonb)', 'EXECUTE')
      as allowed from (values ('anon'), ('authenticated')) as roles(role)
  `)).rows;
  expect(privileges).toEqual([{ allowed: false }, { allowed: false }]);
});

it("sets iPhone confirmation for one account and keeps the original SMS entry point working", async () => {
  const token = await rotate();
  await rotate(other, "review");
  expect(await preferences(owner)).toEqual({ mode: "auto", category_depth: "primary" });
  expect(await setPreferences("iphone", "secondary")).toEqual({ mode: "iphone", category_depth: "secondary" });
  expect(await preferences(other)).toEqual({ mode: "review", category_depth: "primary" });
  await expect(rpc("moneytrail_sms_beta_get_preferences")).rejects.toMatchObject({ code: "42501" });

  const original = await rpc<Receipt>("moneytrail_receive_sms", [token, await sms(undefined, "12.56")]);
  expect(original.status).toBe("recorded");
  const beta = await prepareV2(token, await sms(undefined, "13.57"));
  expect(beta).toMatchObject({ category_depth: "secondary", status: "pending", review_token: expect.stringMatching(/^mt_sms_review_/) });
  expect((await ledger()).data.transactions).toHaveLength(1);
});

it("recommends an existing merchant rule and records only a valid explicit secondary selection", async () => {
  const token = await rotate();
  await setPreferences("iphone", "secondary");
  await rpc("moneytrail_sms_set_merchant_rule", ["清泉咖啡", "食品酒水", "咖啡奶茶"], owner);
  const raw = await sms();
  const result = await prepareV2(token, raw);
  expect(result).toMatchObject({ status: "pending", suggested_category: "食品酒水", suggested_subcategory: "咖啡奶茶" });
  expect(await confirmV2(result.review_token, "交通出行", "咖啡奶茶")).toEqual(invalid);
  expect(await inbox()).toMatchObject([{ id: result.id, status: "pending", raw_text: raw }]);
  expect(await ledger()).toBeUndefined();

  expect(await confirmV2(result.review_token, "食品酒水", "堂食聚餐")).toMatchObject({ status: "recorded", id: result.id });
  expect(await confirmV2(result.review_token, "食品酒水", "堂食聚餐")).toMatchObject({ status: "recorded", id: result.id });
  expect(await prepareV2(token, raw)).toMatchObject({ status: "duplicate", id: result.id });
  expect((await ledger()).data.transactions).toMatchObject([{ category: "食品酒水", subcategory: "堂食聚餐" }]);
});

it("records 食品采购 as a built-in 食品酒水 detail without a merchant rule", async () => {
  const token = await rotate();
  await setPreferences("iphone", "secondary");
  const result = await prepareV2(token, await sms());
  expect(result).toMatchObject({ status: "pending", suggested_subcategory: "" });
  expect(await confirmV2(result.review_token, "交通出行", "食品采购")).toEqual(invalid);
  expect(await ledger()).toBeUndefined();

  expect(await confirmV2(result.review_token, "食品酒水", "食品采购")).toMatchObject({ status: "recorded" });
  expect((await ledger()).data.transactions).toMatchObject([{ category: "食品酒水", subcategory: "食品采购" }]);
});

it("normalizes a legacy 食品采购 rule and reserves the detail for 食品酒水", async () => {
  await expect(setBetaRule("清泉咖啡", "交通出行", "食品采购", true)).rejects.toMatchObject({ code: "22023" });
  expect(await rpc("moneytrail_sms_set_merchant_rule", ["清泉咖啡", "本地生活", "食品采购"], owner)).toEqual({
    rules: [{ merchant: "清泉咖啡", category: "食品酒水", subcategory: "食品采购" }],
  });
});

it("allows explicitly recording only the first level even when a detail was suggested", async () => {
  const token = await rotate();
  await setPreferences("iphone");
  await rpc("moneytrail_sms_set_merchant_rule", ["清泉咖啡", "食品酒水", "咖啡奶茶"], owner);
  const result = await prepareV2(token, await sms());
  expect(result).toMatchObject({ category_depth: "primary", suggested_subcategory: "咖啡奶茶" });
  expect(await confirmV2(result.review_token, "食品酒水", "未细分")).toMatchObject({ status: "recorded" });
  const [entry] = (await ledger()).data.transactions;
  expect(entry.category).toBe("食品酒水");
  expect(entry.subcategory ?? "未细分").toBe("未细分");
});

it("auto-records only the permitted merchant, with the saved category and duplicate protection", async () => {
  const token = await rotate();
  await setPreferences("iphone", "secondary");
  expect(await setBetaRule("清泉咖啡(东店)", "食品酒水", "咖啡奶茶", true)).toMatchObject({
    rules: [{ merchant: "清泉咖啡(东店)", category: "食品酒水", subcategory: "咖啡奶茶", auto_record: true }],
  });
  expect(await rpc<{ rules: BetaRule[] }>("moneytrail_sms_beta_list_rules", [], other)).toEqual({ rules: [] });
  const raw = await sms("消费财付通-清泉咖啡(东店)", "18.26");
  const recorded = await prepareV2(token, raw);
  expect(recorded).toMatchObject({ status: "recorded", amount: "18.26", category: "食品酒水", subcategory: "咖啡奶茶", review_token: "" });
  expect(await prepareV2(token, raw)).toMatchObject({ status: "duplicate", id: recorded.id });
  expect(await prepareV2(token, await sms("消费财付通-清泉咖啡(西店)", "19.26"))).toMatchObject({ status: "pending", review_token: expect.stringMatching(/^mt_sms_review_/) });
  expect(await prepareV2(token, await sms("转账财付通-微信转账", "0.20"))).toMatchObject({ status: "pending", review_token: "" });
  expect((await ledger()).data.transactions).toMatchObject([{ id: "sms-" + recorded.id, category: "食品酒水", subcategory: "咖啡奶茶" }]);
});

it("uses review mode for every receipt and revokes auto permission when a saved classification changes", async () => {
  const token = await rotate();
  await setBetaRule("清泉咖啡", "食品酒水", "咖啡奶茶", true);
  await setPreferences("review");
  expect(await prepareV2(token, await sms(undefined, "10.10"))).toMatchObject({ status: "pending", review_token: "" });
  await setPreferences("iphone");
  await rpc("moneytrail_sms_set_merchant_rule", ["清泉咖啡", "学习培训", "未细分"], owner);
  expect(await prepareV2(token, await sms(undefined, "10.11"))).toMatchObject({
    status: "pending", suggested_category: "学习培训", review_token: expect.stringMatching(/^mt_sms_review_/),
  });
  expect(await ledger()).toBeUndefined();
});
