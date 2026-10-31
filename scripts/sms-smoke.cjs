/* Real SDK/browser integration with intercepted service fixtures.
 * This does not verify hosted authorization, a real iPhone, or bank SMS delivery.
 */
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { mkdir } = require("node:fs/promises");
const path = require("node:path");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..");
const PORT = Number(process.env.MONEYTRAIL_SMS_SMOKE_PORT || 5177);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const BASE = `${ORIGIN}/Moneytrail-/`;
const PROJECT = "https://sms-fixture.supabase.co";
const PUBLIC_KEY = "sb_publishable_sms_fixture";
const ARTIFACTS = path.join(ROOT, "test-results", "sms");
const OWNER = "11111111-1111-4111-8111-111111111111";
const MEMBER = "22222222-2222-4222-8222-222222222222";
const GROUP = "31111111-1111-4111-8111-111111111111";
const OTHER = "32222222-2222-4222-8222-222222222222";
const PASSWORD = "Fixture-password-123!";
const RAW = "尾号xxxx卡10月22日19:27支出(转账财付通-群收款)30.90元，余额8xxxx元。【工商银行】";
const clone = (value) => JSON.parse(JSON.stringify(value));
const empty = () => ({ version: 1, transactions: [], budgetCents: 0, billCheckedMonths: [] });
const manual = { id: "existing-manual", kind: "expense", amountCents: 5800, date: "2026-10-22T10:30", merchant: "已有消费", category: "本地生活", subcategory: "餐饮", source: "manual", note: "保留原账目" };
let checks = 0;
const passed = (message) => { checks += 1; process.stdout.write(`PASS ${message}\n`); };

function authUser(id) {
  return { id, aud: "authenticated", role: "authenticated", email: id === OWNER ? "owner@example.test" : "member@example.test", email_confirmed_at: "2026-10-01T00:00:00Z", phone: "", app_metadata: { provider: "email", providers: ["email"] }, user_metadata: {}, identities: [], created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z" };
}
function token(id) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ sub: id, aud: "authenticated", role: "authenticated", iat: 1790000000, exp: 4102444800 })}.${Buffer.alloc(32, 3).toString("base64url")}`;
}
function session(id) { return { access_token: token(id), token_type: "bearer", expires_in: 3600 * 24 * 365 * 30, refresh_token: `fixture-refresh-${id}`, user: authUser(id) }; }
function identity(request) {
  try { return JSON.parse(Buffer.from((request.headers().authorization || "").split(".")[1], "base64url").toString()).sub; }
  catch { return null; }
}
function mockBackend({ missingSms = false, ordinaryPending = false, missingReprocess = false, groupedBalancePending = false } = {}) {
  const ledgers = new Map([[OWNER, { data: { ...empty(), budgetCents: 900000, transactions: [manual], billCheckedMonths: ["2026-09"] }, revision: 1, updated_at: "2026-10-22T11:00:00Z" }], [MEMBER, { data: empty(), revision: 1, updated_at: "2026-10-22T11:00:00Z" }]]);
  const inboxes = new Map([[OWNER, [
    { id: GROUP, received_at: "2026-10-22T11:27:00Z", status: "pending", raw_text: RAW, draft: { kind: "expense", amountCents: 3090, date: "2026-10-22T19:27", merchant: "财付通-群收款", category: "待分类", source: "sms", note: "" }, warnings: ["群收款需确认是消费还是转账。"], reason: null, transaction_id: null },
    { id: OTHER, received_at: "2026-10-22T11:20:00Z", status: "pending", raw_text: "您今日支出12元。【工商银行】", draft: null, warnings: [], reason: "未能识别完整交易，请手动核对。", transaction_id: null },
  ]], [MEMBER, []]]);
  const configs = new Map([OWNER, MEMBER].map((id) => [id, { enabled: false, mode: "auto", created_at: null, last_received_at: id === OWNER ? "2026-10-22T11:27:00Z" : null }]));
  const ordinaryIds = new Set();
  const reprocessedDrafts = new Map();
  if (groupedBalancePending) {
    const id = "35000000-0000-4000-8000-000000000001";
    const draft = { kind: "expense", amountCents: 37500, date: "2026-10-23T09:47", merchant: "消费支付宝-阿里健康大药房医药连锁有限公", category: "医疗", source: "sms", note: "" };
    ordinaryIds.add(id); reprocessedDrafts.set(id, draft);
    inboxes.get(OWNER).unshift({ id, received_at: "2026-10-23T01:47:24Z", status: "pending", raw_text: "尾号xxxx卡10月23日09:47支出(消费支付宝-阿里健康大药房医药连锁有限公)375元，余额12,345.94元。【工商银行】", draft: null, warnings: [], reason: "暂不支持这条短信的格式，请手动核对后记账。", transaction_id: null });
    configs.set(OWNER, { ...configs.get(OWNER), enabled: true, created_at: "2026-10-22T11:00:00Z", last_received_at: "2026-10-23T01:47:24Z" });
    ledgers.get(OWNER).data.billCheckedMonths.push("2026-10");
  }
  if (ordinaryPending) {
    const examples = [["街角咖啡店", 1200, "本地生活"], ["滴滴出行", 2350, "交通"], ["美团外卖", 880, "本地生活"], ["某某便利店", 1680, "购物"]];
    const records = examples.map(([merchant, amountCents, category], index) => {
      const id = `34000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
      ordinaryIds.add(id); reprocessedDrafts.set(id, { kind: "expense", amountCents, date: `2026-10-22T19:1${index}`, merchant, category, source: "sms", note: "" });
      return { id, received_at: `2026-10-22T11:1${index}:00Z`, status: "pending", raw_text: `尾号xxxx卡10月22日19:1${index}支出(${merchant})${(amountCents / 100).toFixed(2)}元，余额8xxxx元。【工商银行】`, draft: { kind: "expense", amountCents, date: `2026-10-22T19:1${index}`, merchant, category: "待分类", source: "sms", note: "" }, warnings: ["交易用途尚不明确，请核对后确认。"], reason: null, transaction_id: null };
    });
    inboxes.set(OWNER, [...records, ...inboxes.get(OWNER)]);
    configs.set(OWNER, { ...configs.get(OWNER), enabled: true, created_at: "2026-10-22T11:00:00Z" });
    ledgers.get(OWNER).data.billCheckedMonths.push("2026-10");
  }
  const requests = []; const routeErrors = []; const secrets = []; const ledgerRead = { fail: false };
  const config = (id) => ({ ...clone(configs.get(id)), pending_count: inboxes.get(id).filter((item) => item.status === "pending").length });
  async function attach(context) {
    await context.route("**/*", async (route) => {
      try {
        const request = route.request(); const url = new URL(request.url());
        if (url.origin === ORIGIN) return route.continue();
        assert.equal(url.origin, PROJECT, `Unexpected external request ${url.origin}`);
        const headers = { "access-control-allow-origin": ORIGIN, "access-control-allow-headers": "*", "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS", "access-control-expose-headers": "x-supabase-api-version", "x-supabase-api-version": "2024-01-01", "content-type": "application/json" };
        const respond = (data, status = 200) => route.fulfill({ status, headers, body: status === 204 ? "" : JSON.stringify(data) });
        if (request.method() === "OPTIONS") return respond({}, 204);
        const id = identity(request); const body = request.postData() ? JSON.parse(request.postData()) : null;
        requests.push({ path: url.pathname, id, body: clone(body) });
        if (url.pathname === "/auth/v1/token") {
          if (body?.password !== PASSWORD) return respond({ code: "invalid_credentials", msg: "Invalid credentials" }, 400);
          return respond(session(body.email === "owner@example.test" ? OWNER : MEMBER));
        }
        if (url.pathname === "/auth/v1/user") return id ? respond(authUser(id)) : respond({ code: "bad_jwt" }, 401);
        if (url.pathname === "/auth/v1/logout") return respond({}, 204);
        if (!id || !ledgers.has(id)) return respond({ code: "42501", message: "Not authenticated" }, 403);
        if (url.pathname === "/rest/v1/rpc/moneytrail_is_admin") return respond(false);
        if (url.pathname === "/rest/v1/moneytrail_ledgers") {
          assert.equal(url.searchParams.get("user_id"), `eq.${id}`);
          if (ledgerRead.fail) return respond({ code: "42501", message: "Fixture ledger read unavailable" }, 403);
          return respond([{ user_id: id, ...clone(ledgers.get(id)) }]);
        }
        if (url.pathname === "/rest/v1/rpc/save_moneytrail_ledger") {
          const current = ledgers.get(id);
          if (body.p_expected_revision !== current.revision) return respond({ code: "40001", message: "Stale revision" }, 409);
          const updated = { data: clone(body.p_data), revision: current.revision + 1, updated_at: new Date().toISOString() };
          ledgers.set(id, updated); return respond([{ user_id: id, ...updated }]);
        }
        if (url.pathname.startsWith("/rest/v1/rpc/moneytrail_sms_")) {
          if (missingSms) return respond({ code: "PGRST202", message: "Function missing" }, 404);
          const action = url.pathname.split("moneytrail_sms_")[1];
          if (action === "category_rules") return respond({ rules: [] });
          if (action === "config") return respond(config(id));
          if (action === "rotate") {
            assert.deepEqual(Object.keys(body), ["p_mode"]);
            assert(["auto", "review"].includes(body.p_mode));
            const secret = `mt_sms_${String(secrets.length + 1).padStart(64, "a")}`;
            secrets.push(secret); configs.set(id, { ...configs.get(id), enabled: true, mode: body.p_mode, created_at: "2026-10-22T11:30:00Z" });
            return respond({ token: secret, config: config(id) });
          }
          if (action === "set_mode") {
            assert.deepEqual(Object.keys(body), ["p_mode"]); assert(["auto", "review"].includes(body.p_mode));
            configs.set(id, { ...configs.get(id), mode: body.p_mode }); return respond(config(id));
          }
          if (action === "revoke") {
            configs.set(id, { ...configs.get(id), enabled: false, created_at: null }); return respond(config(id));
          }
          if (action === "inbox") {
            assert.deepEqual(Object.keys(body).sort(), ["p_page", "p_page_size"]);
            const page = Number(body.p_page); const pageSize = Number(body.p_page_size); const items = inboxes.get(id);
            return respond({ items: clone(items.slice((page - 1) * pageSize, page * pageSize)), total: items.length, page, page_size: pageSize });
          }
          if (action === "preview_pending") {
            if (missingReprocess) return respond({ code: "PGRST202", message: "Function missing" }, 404);
            assert.deepEqual(body, {});
            const items = inboxes.get(id).filter(item => item.status === "pending").map(item => ({ id: item.id, draft: clone(reprocessedDrafts.get(item.id) || item.draft), eligible: ordinaryIds.has(item.id), reason: ordinaryIds.has(item.id) ? "商户分类规则" : "需要确认用途" }));
            return respond({ items, recordable_count: items.filter(item => item.eligible).length, pending_count: items.length });
          }
          if (action === "apply_pending") {
            assert.deepEqual(Object.keys(body), ["p_items"]); assert.equal(configs.get(id).mode, "auto");
            let recorded = 0;
            for (const selected of body.p_items) {
              const item = inboxes.get(id).find(item => item.id === selected.id);
              assert(item && ordinaryIds.has(item.id), "only preview-eligible messages can be applied");
              if (item.status !== "pending") continue;
              const draft = clone(reprocessedDrafts.get(item.id)); assert.deepEqual(selected.draft, draft);
              const transaction = { ...draft, id: `sms-${item.id}`, sourceRef: `sms-${item.id}` }; const current = ledgers.get(id);
              ledgers.set(id, { data: { ...current.data, transactions: [...current.data.transactions, transaction], billCheckedMonths: current.data.billCheckedMonths.filter(month => month !== transaction.date.slice(0, 7)) }, revision: current.revision + 1, updated_at: "2026-10-22T11:40:00Z" });
              Object.assign(item, { status: "recorded", raw_text: null, draft, warnings: [], reason: null, transaction_id: transaction.id }); recorded++;
            }
            return respond({ recorded_count: recorded, pending_count: inboxes.get(id).filter(item => item.status === "pending").length });
          }
          if (action === "confirm" || action === "dismiss") {
            const item = inboxes.get(id).find((item) => item.id === body.p_id);
            if (!item) return respond({ code: "42501", message: "Message unavailable" }, 403);
            if (action === "confirm") {
              assert.equal(item.status, "pending");
              const transaction = { ...clone(body.p_draft), id: `sms-${item.id}`, source: "sms", sourceRef: `sms-${item.id}` };
              const current = ledgers.get(id); const month = transaction.date.slice(0, 7);
              ledgers.set(id, { data: { ...current.data, transactions: [...current.data.transactions, transaction], billCheckedMonths: current.data.billCheckedMonths.filter((checked) => checked !== month) }, revision: current.revision + 1, updated_at: "2026-10-22T11:35:00Z" });
              item.status = "recorded"; item.raw_text = null; item.transaction_id = transaction.id;
              return respond({ status: "recorded", transaction_id: transaction.id });
            }
            item.status = "dismissed"; item.raw_text = null;
            return respond({ status: "dismissed" });
          }
        }
        throw Error(`Unexpected fixture endpoint ${request.method()} ${url.pathname}`);
      } catch (error) {
        if (/Target.*closed|Request.*already handled|Route.*already handled/.test(String(error))) return;
        routeErrors.push(String(error)); try { await route.abort(); } catch {}
      }
    });
  }
  return { attach, requests, routeErrors, ledgers, inboxes, configs, secrets, ledgerRead };
}
async function ready(server, output) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw Error(`SMS dev server exited: ${output()}`);
    try { if (/ready in/i.test(output()) && (await fetch(BASE)).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw Error(`SMS dev server not ready: ${output()}`);
}
async function fixture(browser, backend, { width = 1440, sms = true } = {}) {
  const context = await browser.newContext({ viewport: { width, height: width <= 393 ? 852 : 1000 }, locale: "zh-CN", timezoneId: "Asia/Shanghai", ...(width <= 393 ? { isMobile: true, hasTouch: true } : {}) });
  await backend.attach(context);
  const page = await context.newPage(); const errors = [];
  page.on("pageerror", (error) => errors.push(error.message)); page.setDefaultTimeout(12000);
  await page.clock.setFixedTime(new Date("2026-10-22T11:30:00Z"));
  await page.goto(sms ? `${BASE}?view=sms` : BASE, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "登录我的账本", exact: true }).waitFor();
  return { page, context, errors };
}
async function login(page, email = "owner@example.test") {
  await page.getByLabel("邮箱", { exact: true }).fill(email); await page.getByLabel("密码", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "登录我的账本", exact: true }).click();
}
async function until(predicate, description) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise((resolve) => setTimeout(resolve, 25)); }
  throw Error(`Timed out waiting for ${description}`);
}
async function noOverflow(page, description) {
  const dimensions = await page.evaluate(() => ({ actual: document.documentElement.scrollWidth, viewport: innerWidth }));
  assert(dimensions.actual <= dimensions.viewport + 1, `${description} overflow: ${JSON.stringify(dimensions)}`);
}
async function noSecretStorage(page, backend) {
  const stored = await page.evaluate(() => [...Object.values(localStorage), ...Object.values(sessionStorage)].join("\n"));
  for (const secret of backend.secrets) {
    assert(!stored.includes(secret), "SMS capability token must never be persisted to browser storage");
    assert(!page.url().includes(secret), "SMS capability token must never appear in the URL");
  }
}
async function noSecretDom(page, backend) {
  const rendered = await page.evaluate(() => [document.body.innerText, ...Array.from(document.querySelectorAll("input,textarea"), (element) => element.value)].join("\n"));
  for (const secret of backend.secrets) assert(!rendered.includes(secret), "a discarded one-time token must leave the DOM and form values");
}
async function openSms(page) {
  await page.getByRole("button", { name: "我的账户", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "我的账户", exact: true });
  await dialog.getByRole("button", { name: "短信自动记账", exact: true }).click();
}

// Workflow selectors are kept accessible so the test exercises the shipped UI.
async function ownerWorkflow(browser) {
  const backend = mockBackend(); const { page, context, errors } = await fixture(browser, backend, { sms: false });
  try {
    await login(page); await page.locator(".hero-amount").waitFor();
    assert.equal(backend.requests.filter((request) => request.path.includes("moneytrail_sms_") && !request.path.endsWith("moneytrail_sms_category_rules")).length, 0, "personal ledger must not fetch sensitive SMS inbox before it is opened");
    await page.locator(".page-header").getByRole("button", { name: "短信自动记账", exact: true }).click();
    await page.getByRole("heading", { name: "短信自动记账", exact: true }).waitFor();
    await page.getByText("财付通-群收款", { exact: true }).first().waitFor();
    assert.equal(backend.ledgers.get(OWNER).data.transactions.length, 1, "a pending group collection is not part of spending until confirmed");
    passed("SMS inbox opens only on request and group collection remains outside the ledger until review");

    await page.getByRole("button", { name: "同意转发并启用", exact: true }).click();
    await until(() => backend.secrets.length === 1, "token creation");
    assert.equal(backend.configs.get(OWNER).mode, "auto");
    await page.getByRole("dialog", { name: "接入令牌，仅显示这一次", exact: true }).waitFor();
    await page.getByRole("button", { name: "显示令牌", exact: true }).click();
    await page.getByText(backend.secrets[0], { exact: true }).waitFor();
    await noSecretStorage(page, backend); await noOverflow(page, "desktop SMS panel");
    await page.screenshot({ path: path.join(ARTIFACTS, "desktop-token.png"), fullPage: true, animations: "disabled" });
    passed("explicit enable creates an account-bound token and leaves it out of URLs and browser storage");

    await page.goBack();
    await page.locator(".hero-amount").waitFor(); await openSms(page);
    await page.getByRole("heading", { name: "短信自动记账", exact: true }).waitFor();
    await noSecretDom(page, backend);
    assert.equal(backend.secrets.length, 1, "merely reopening must not silently rotate the token");
    passed("leaving the page clears the one-time token without rotating it on reopen");

    await page.getByRole("radio", { name: /全部先待确认/ }).check();
    await page.getByRole("button", { name: "保存记录方式", exact: true }).click();
    await until(() => backend.configs.get(OWNER).mode === "review", "review-only mode save");
    await until(async () => (await page.getByRole("button", { name: "保存记录方式", exact: true }).isDisabled()), "review mode refresh");
    await page.getByRole("radio", { name: /自动记录明确消费/ }).check();
    await page.getByRole("button", { name: "保存记录方式", exact: true }).click();
    await until(() => backend.configs.get(OWNER).mode === "auto", "automatic mode save");
    await page.getByRole("button", { name: "刷新收件箱", exact: true }).waitFor();
    assert.equal(backend.ledgers.get(OWNER).data.transactions.length, 1, "changing future intake mode must not count existing pending messages");
    passed("recording mode changes explicitly save for future SMS and leave pending group collections unchanged");

    const group = page.locator(".sms-message").filter({ hasText: "财付通-群收款" });
    await group.getByRole("button", { name: "核对并记录", exact: true }).click();
    await page.screenshot({ path: path.join(ARTIFACTS, "desktop-sms.png"), fullPage: true, animations: "disabled" });
    await group.getByLabel("商户或用途", { exact: true }).fill("朋友聚餐AA");
    await group.getByRole("combobox", { name: /^分类/ }).selectOption("本地生活");
    await group.getByRole("button", { name: "确认并记入账本", exact: true }).click();
    await until(() => backend.ledgers.get(OWNER).data.transactions.length === 2, "confirmed SMS append");
    assert.deepEqual(backend.ledgers.get(OWNER).data.transactions[0], manual);
    assert.equal(backend.ledgers.get(OWNER).data.transactions[1].merchant, "朋友聚餐AA");
    assert.equal(backend.ledgers.get(OWNER).data.transactions[1].amountCents, 3090);
    assert.equal(backend.ledgers.get(OWNER).data.budgetCents, 900000);
    assert.equal(backend.inboxes.get(OWNER)[0].raw_text, null);
    await noSecretStorage(page, backend);
    await page.getByRole("button", { name: "返回账本", exact: true }).click();
    await until(async () => (await page.locator(".hero-amount").innerText()).includes("88.90"), "refreshed account spending");
    passed("confirming an edited pending SMS appends to the current ledger, preserves its budget and refreshes spending");

    await openSms(page);
    const other = page.locator(".sms-message").filter({ hasText: "未能识别完整交易" });
    await other.getByRole("button", { name: "核对并记录", exact: true }).click();
    assert.equal(await other.getByLabel("交易时间", { exact: true }).inputValue(), "", "unparsed SMS must not invent transaction time from receipt time");
    await other.getByRole("button", { name: "忽略此条", exact: true }).click();
    await until(() => backend.inboxes.get(OWNER)[1].status === "dismissed", "dismissal");
    assert.equal(backend.ledgers.get(OWNER).data.transactions.length, 2);
    assert.equal(backend.inboxes.get(OWNER)[1].raw_text, null);
    passed("dismissing an unrecognized message removes its raw text without adding spending");

    const autoId = "33333333-3333-4333-8333-333333333333";
    const autoDraft = { kind: "expense", amountCents: 1200, date: "2026-10-22T19:36", merchant: "自动记录的便利店消费", category: "待分类", source: "sms", note: "" };
    const current = backend.ledgers.get(OWNER);
    backend.ledgers.set(OWNER, { data: { ...current.data, transactions: [...current.data.transactions, { ...autoDraft, id: `sms-${autoId}`, sourceRef: `sms-${autoId}` }] }, revision: current.revision + 1, updated_at: "2026-10-22T11:36:00Z" });
    backend.inboxes.get(OWNER).unshift({ id: autoId, received_at: "2026-10-22T11:36:00Z", status: "recorded", raw_text: null, draft: autoDraft, warnings: [], reason: null, transaction_id: `sms-${autoId}` });
    await page.getByRole("button", { name: "刷新收件箱", exact: true }).click();
    await page.getByRole("heading", { name: autoDraft.merchant, exact: true }).waitFor();
    await page.getByRole("button", { name: "返回账本", exact: true }).click();
    await until(async () => (await page.locator(".hero-amount").innerText()).includes("100.90"), "server-added automatic transaction refresh");
    passed("refreshing SMS also refreshes an automatically appended cloud transaction in the personal ledger");
    await openSms(page);
    await page.getByRole("button", { name: "更换接入令牌", exact: true }).waitFor();

    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "更换接入令牌", exact: true }).click();
    await until(() => backend.secrets.length === 2, "token rotation");
    await page.getByRole("dialog", { name: "接入令牌，仅显示这一次", exact: true }).waitFor();
    await noSecretStorage(page, backend);
    await page.getByRole("button", { name: "我已保存", exact: true }).click();
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "停用接入", exact: true }).click();
    await until(() => !backend.configs.get(OWNER).enabled, "token revocation");
    await noSecretDom(page, backend);
    passed("rotation and revocation are explicit, and revocation clears the one-time plaintext token");
    assert.deepEqual(errors, []); assert.deepEqual(backend.routeErrors, []);
  } finally { await context.close(); }
}
async function entryWorkflow(browser) {
  for (const width of [393, 320]) {
    const backend = mockBackend(); const { page, context, errors } = await fixture(browser, backend, { width, sms: false });
    try {
      await login(page); await page.locator(".hero-amount").waitFor();
      await noOverflow(page, `${width}px overview with SMS entry`);
      await page.getByRole("button", { name: "设置", exact: true }).click();
      const firstCard = page.locator(".settings-grid > section").first();
      await firstCard.getByRole("heading", { name: "短信自动记账", exact: true }).waitFor();
      const entry = firstCard.getByRole("button", { name: "打开短信自动记账", exact: true });
      const bounds = await entry.boundingBox();
      assert(bounds && bounds.y >= 0 && bounds.y + bounds.height < 750, "SMS setup entry should be visible at the top without scrolling");
      await noOverflow(page, `${width}px settings with first SMS card`);
      if (width === 393) await page.screenshot({ path: path.join(ARTIFACTS, "mobile-settings-entry-393.png"), animations: "disabled" });
      await entry.click();
      await page.getByRole("heading", { name: "短信自动记账", exact: true }).waitFor();
      assert.equal(new URL(page.url()).searchParams.get("view"), "sms");
      assert.deepEqual(errors, []); assert.deepEqual(backend.routeErrors, []);
      passed(`${width}px settings show SMS as the first card without scrolling and open the inbox`);
    } finally { await context.close(); }
  }
}
async function missingMigrationWorkflow(browser) {
  const backend = mockBackend({ missingSms: true }); const { page, context, errors } = await fixture(browser, backend);
  try {
    await login(page); await page.getByText(/短信自动记账尚未开通|短信自动化尚未开通|短信接收尚未开通|短信服务尚未开通/).first().waitFor();
    assert.equal(backend.secrets.length, 0);
    await page.getByRole("button", { name: "返回账本", exact: true }).click();
    await page.locator(".hero-amount").waitFor();
    passed("an unapplied SMS migration gives setup guidance while the existing personal ledger remains usable");
    assert.deepEqual(errors, []); assert.deepEqual(backend.routeErrors, []);
  } finally { await context.close(); }
}
async function accountSwitchWorkflow(browser) {
  const backend = mockBackend(); const { page, context, errors } = await fixture(browser, backend);
  try {
    await login(page); await page.getByRole("button", { name: "同意转发并启用", exact: true }).click();
    await until(() => backend.secrets.length === 1, "owner token creation before logout");
    await page.getByRole("button", { name: "我已保存", exact: true }).click();
    await page.getByRole("button", { name: "返回账本", exact: true }).click();
    await page.getByRole("button", { name: "我的账户", exact: true }).click();
    const account = page.getByRole("dialog", { name: "我的账户", exact: true });
    await account.getByRole("button", { name: "退出登录并清除本机副本", exact: true }).click();
    await page.getByRole("button", { name: "登录我的账本", exact: true }).waitFor();
    await login(page, "member@example.test"); await page.locator(".hero-amount").waitFor();
    await openSms(page);
    await until(() => backend.requests.some((request) => request.path.endsWith("moneytrail_sms_inbox") && request.id === MEMBER), "member-owned SMS inbox");
    await page.getByRole("button", { name: "同意转发并启用", exact: true }).waitFor();
    assert.equal(await page.getByText("财付通-群收款", { exact: true }).count(), 0);
    assert.equal((await page.locator("body").innerText()).includes(RAW), false);
    await noSecretDom(page, backend); await noSecretStorage(page, backend);
    assert.equal(backend.configs.get(MEMBER).enabled, false);
    passed("logout and a different account cannot recover the previous account token or SMS inbox");
    assert.deepEqual(errors, []); assert.deepEqual(backend.routeErrors, []);
  } finally { await context.close(); }
}
async function mobileWorkflow(browser) {
  const backend = mockBackend(); const { page, context, errors } = await fixture(browser, backend, { width: 393 });
  try {
    await login(page); await page.getByText("财付通-群收款", { exact: true }).first().waitFor();
    await noOverflow(page, "393px SMS inbox");
    await page.locator("summary").filter({ hasText: "iPhone 配置步骤" }).click();
    await page.locator(".sms-message").first().getByRole("button", { name: "核对并记录", exact: true }).click();
    await noOverflow(page, "393px expanded guide and review form");
    await page.getByRole("button", { name: "同意转发并启用", exact: true }).click();
    await until(() => backend.secrets.length === 1, "mobile token creation");
    await page.getByRole("button", { name: "显示令牌", exact: true }).click();
    await page.getByText(backend.secrets[0], { exact: true }).waitFor();
    await noOverflow(page, "393px token and iPhone instructions"); await noSecretStorage(page, backend);
    await page.screenshot({ path: path.join(ARTIFACTS, "mobile-token-393.png"), fullPage: true, animations: "disabled" });
    await page.getByRole("button", { name: "我已保存", exact: true }).click();
    await page.screenshot({ path: path.join(ARTIFACTS, "mobile-sms-393.png"), fullPage: true, animations: "disabled" });
    passed("iPhone-sized inbox, one-time token and setup instructions fit without horizontal overflow");
    assert.deepEqual(errors, []); assert.deepEqual(backend.routeErrors, []);
  } finally { await context.close(); }
}
async function reprocessWorkflow(browser) {
  const backend = mockBackend({ ordinaryPending: true }); const { page, context, errors } = await fixture(browser, backend, { width: 393 });
  try {
    await login(page); const preview = page.getByRole("button", { name: "预览待确认短信", exact: true });
    const applyCount = () => backend.requests.filter(request => request.path.endsWith("moneytrail_sms_apply_pending")).length;
    await preview.click(); await page.getByText("待确认预览：可入账 4 笔，保留确认 2 笔").waitFor();
    assert.equal(backend.ledgers.get(OWNER).data.transactions.length, 1);
    await page.getByRole("button", { name: "关闭预览", exact: true }).click();
    assert.equal(applyCount(), 0); assert.equal(backend.inboxes.get(OWNER).filter(item => item.status === "pending").length, 6);
    passed("closing read-only pending preview leaves ledger and inbox unchanged");
    await preview.click(); await page.getByRole("button", { name: "确认应用可入账记录", exact: true }).click();
    await until(async () => /已入账 4 笔，仍有 2 笔待确认/.test(await page.locator(".sms-notice").innerText()), "apply result");
    await until(async () => await page.locator(".sms-message.recorded").count() === 4, "refreshed inbox");
    const book = backend.ledgers.get(OWNER).data;
    assert.deepEqual(book.transactions[0], manual); assert.equal(book.transactions.length, 5); assert.equal(book.budgetCents, 900000); assert.deepEqual(book.billCheckedMonths, ["2026-09"]);
    assert.deepEqual(book.transactions.slice(1).map(t => t.category), ["本地生活", "交通", "本地生活", "购物"]);
    assert.equal(backend.inboxes.get(OWNER).find(item => item.id === GROUP).status, "pending"); assert.equal(backend.inboxes.get(OWNER).find(item => item.id === OTHER).status, "pending");
    const request = backend.requests.find(request => request.path.endsWith("moneytrail_sms_apply_pending")); assert.equal(request.body.p_items.length, 4);
    assert(backend.inboxes.get(OWNER).filter(item => item.status === "recorded").every(item => item.raw_text === null));
    await noOverflow(page, "393px preview/apply result"); await page.screenshot({ path: path.join(ARTIFACTS, "mobile-reprocessed-393.png"), fullPage: true, animations: "disabled" });
    await preview.click(); await page.getByText("待确认预览：可入账 0 笔，保留确认 2 笔").waitFor(); assert.equal(await page.getByRole("button", { name: "确认应用可入账记录", exact: true }).isEnabled(), false);
    assert.equal(applyCount(), 1); assert.equal(book.transactions.length, 5);
    await page.getByRole("button", { name: "返回账本", exact: true }).click(); await until(async () => (await page.locator(".hero-amount").innerText()).includes("119.10"), "applied spending refresh");
    assert.deepEqual(errors, []); assert.deepEqual(backend.routeErrors, []);
    passed("exact preview apply classifies four clear merchants, preserves group/unknown and prevents repeated application");
  } finally { await context.close(); }
}
async function groupedBalanceReprocessWorkflow(browser) {
  const backend = mockBackend({ groupedBalancePending: true }); const { page, context, errors } = await fixture(browser, backend, { width: 393 });
  try {
    await login(page); const pharmacyId = "35000000-0000-4000-8000-000000000001";
    await page.getByText("暂不支持这条短信的格式，请手动核对后记账。", { exact: true }).waitFor(); assert.equal(backend.inboxes.get(OWNER).find(item => item.id === pharmacyId).draft, null);
    await page.getByRole("button", { name: "预览待确认短信", exact: true }).click();
    const view = page.locator(".sms-classification-preview"); await view.getByText(/医疗/).waitFor(); assert.equal(backend.ledgers.get(OWNER).data.transactions.length, 1);
    await page.getByRole("button", { name: "确认应用可入账记录", exact: true }).click();
    await until(async () => /已入账 1 笔，仍有 2 笔待确认/.test(await page.locator(".sms-notice").innerText()), "pharmacy apply");
    const recorded = page.locator(".sms-message.recorded").filter({ hasText: "阿里健康大药房" }); await recorded.waitFor(); assert((await recorded.innerText()).includes("375.00"));
    const book = backend.ledgers.get(OWNER).data; assert.deepEqual(book.transactions[0], manual); assert.equal(book.transactions.length, 2); assert.equal(book.budgetCents, 900000); assert.deepEqual(book.billCheckedMonths, ["2026-09"]); assert.equal(book.transactions[1].category, "医疗"); assert.equal(book.transactions[1].amountCents, 37500);
    const item = backend.inboxes.get(OWNER).find(item => item.id === pharmacyId); assert.equal(item.raw_text, null); assert.equal(item.draft.category, "医疗");
    assert.equal(backend.inboxes.get(OWNER).find(item => item.id === GROUP).status, "pending"); assert.equal(backend.requests.filter(r => r.path.endsWith("moneytrail_sms_confirm")).length, 0);
    await page.getByRole("button", { name: "预览待确认短信", exact: true }).click(); await page.getByText("待确认预览：可入账 0 笔，保留确认 2 笔").waitFor(); assert.equal(await page.getByRole("button", { name: "确认应用可入账记录", exact: true }).isEnabled(), false);
    await noOverflow(page, "393px grouped balance preview"); await page.screenshot({ path: path.join(ARTIFACTS, "mobile-pharmacy-reprocessed-393.png"), fullPage: true, animations: "disabled" });
    await page.getByRole("button", { name: "返回账本", exact: true }).click(); await until(async () => (await page.locator(".hero-amount").innerText()).includes("433.00"), "pharmacy spending");
    await page.locator(".mobile-nav").getByRole("button", { name: "账目", exact: true }).click(); const row = page.locator(".transaction-row").filter({ hasText: "阿里健康大药房" }); await row.waitFor(); assert((await row.innerText()).includes("医疗"));
    assert.deepEqual(errors, []); assert.deepEqual(backend.routeErrors, []); passed("legacy null draft previews medical category then applies once without treating balance as spending");
  } finally { await context.close(); }
}
async function missingReprocessWorkflow(browser) {
  const backend = mockBackend({ ordinaryPending: true, missingReprocess: true }); const { page, context, errors } = await fixture(browser, backend);
  try {
    await login(page); await page.getByRole("button", { name: "预览待确认短信", exact: true }).click(); await until(async () => /自动入账规则尚未升级/.test(await page.locator(".sms-notice").innerText()), "missing preview upgrade");
    assert.equal(backend.ledgers.get(OWNER).data.transactions.length, 1); assert.equal(backend.inboxes.get(OWNER).filter(item => item.status === "pending").length, 6); assert.deepEqual(errors, []); assert.deepEqual(backend.routeErrors, []);
    passed("missing preview migration explains upgrade without changing pending receipts");
  } finally { await context.close(); }
}
async function reprocessLayoutWorkflow(browser) {
  const backend = mockBackend({ ordinaryPending: true }); const { page, context, errors } = await fixture(browser, backend, { width: 320 });
  try {
    await login(page); await page.getByRole("button", { name: "预览待确认短信", exact: true }).click(); await page.getByText("待确认预览：可入账 4 笔，保留确认 2 笔").waitFor();
    await noOverflow(page, "320px pending preview controls"); assert.equal(await page.getByRole("button", { name: "确认应用可入账记录", exact: true }).isEnabled(), true); assert.equal(backend.ledgers.get(OWNER).data.transactions.length, 1);
    assert.deepEqual(errors, []); assert.deepEqual(backend.routeErrors, []); passed("320px preview fits without overflow or silently processing receipts");
  } finally { await context.close(); }
}

async function monthRolloverWorkflow(browser) {
  const backend = mockBackend(); const { page, context, errors } = await fixture(browser, backend, { sms: false });
  try {
    await page.clock.setFixedTime(new Date("2026-10-31T15:59:00Z"));
    await login(page); await page.locator(".hero-amount").waitFor();
    assert.equal(await page.locator("#month").inputValue(), "2026-10");
    await openSms(page);
    await page.clock.setFixedTime(new Date("2026-10-31T16:01:00Z"));
    const current = backend.ledgers.get(OWNER);
    const transaction = { ...manual, id: "november-expense", amountCents: 2500, date: "2026-11-01T00:01" };
    backend.ledgers.set(OWNER, { ...current, data: { ...current.data, transactions: [...current.data.transactions, transaction] }, revision: current.revision + 1 });
    await page.getByRole("button", { name: "刷新收件箱", exact: true }).click();
    await page.getByRole("button", { name: "刷新收件箱", exact: true }).waitFor();
    await page.getByRole("button", { name: "返回账本", exact: true }).click();
    await until(async () => (await page.locator("#month").inputValue()) === "2026-11", "calendar month rollover while SMS panel is open");
    assert((await page.locator(".hero-amount").innerText()).includes("25.00"));
    passed("current-month dashboard follows Shanghai midnight and includes a new month's server-added expense");

    await page.locator("#month").fill("2026-09");
    await openSms(page);
    await page.clock.setFixedTime(new Date("2026-11-30T16:01:00Z"));
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.getByRole("button", { name: "返回账本", exact: true }).click();
    assert.equal(await page.locator("#month").inputValue(), "2026-09", "rollover preserves an explicitly selected historical month");
    assert.deepEqual(errors, []); assert.deepEqual(backend.routeErrors, []);
    passed("calendar rollover preserves a deliberately selected historical month");
  } finally { await context.close(); }
}

async function ledgerRefreshFailureWorkflow(browser, batch = false) {
  const backend = mockBackend({ ordinaryPending: batch }); const { page, context, errors } = await fixture(browser, backend);
  try {
    await login(page);
    if (batch) {
      await page.getByRole("button", { name: "预览待确认短信", exact: true }).click();
      await page.getByText("待确认预览：可入账 4 笔，保留确认 2 笔").waitFor();
      backend.ledgerRead.fail = true;
      await page.getByRole("button", { name: "确认应用可入账记录", exact: true }).click();
    } else {
      const group = page.locator(".sms-message").filter({ hasText: "财付通-群收款" });
      await group.getByRole("button", { name: "核对并记录", exact: true }).click();
      await group.getByLabel("商户或用途", { exact: true }).fill("核对后的消费");
      await group.getByRole("combobox", { name: /^分类/ }).selectOption("购物");
      backend.ledgerRead.fail = true;
      await group.getByRole("button", { name: "确认并记入账本", exact: true }).click();
    }
    await until(async () => /已入账 4 笔|已确认并记入云端账本/.test(await page.locator(".sms-notice").innerText()), "successful SMS write despite failed ledger read");
    assert((await page.locator(".sms-notice").innerText()).includes("首页账目尚未刷新"), "successful server write must explain that the homepage still shows stale spending");
    assert.equal(backend.ledgers.get(OWNER).data.transactions.length, batch ? 5 : 2);
    assert((await page.locator(".hero-amount").textContent()).includes("58.00"));
    const endpoint = batch ? "moneytrail_sms_apply_pending" : "moneytrail_sms_confirm";
    backend.ledgerRead.fail = false;
    await page.getByRole("button", { name: "重试账本同步", exact: true }).click();
    await until(async () => (await page.locator(".hero-amount").textContent()).includes(batch ? "119.10" : "88.90"), "retry refresh updates spending without resubmitting the SMS");
    assert.equal(backend.requests.filter(request => request.path.endsWith(endpoint)).length, 1);
    assert.deepEqual(errors, []); assert.deepEqual(backend.routeErrors, []);
    passed(`${batch ? "batch" : "single"} SMS success explains stale homepage after a failed refresh and offers a read-only retry`);
  } finally { await context.close(); }
}

(async () => {
  await mkdir(ARTIFACTS, { recursive: true });
  let output = "";
  const server = spawn(process.execPath, [path.join(ROOT, "node_modules", "vite", "bin", "vite.js"), "--host", "127.0.0.1", "--port", String(PORT)], { cwd: ROOT, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, MONEYTRAIL_BASE_PATH: "/Moneytrail-/", VITE_SUPABASE_URL: PROJECT, VITE_SUPABASE_PUBLISHABLE_KEY: PUBLIC_KEY, VITE_SUPABASE_ANON_KEY: "" } });
  server.stdout.on("data", (chunk) => { output += chunk; }); server.stderr.on("data", (chunk) => { output += chunk; });
  let browser;
  try {
    await ready(server, () => output);
    browser = await chromium.launch({ headless: true, ...(process.env.MONEYTRAIL_CHROMIUM_PATH ? { executablePath: process.env.MONEYTRAIL_CHROMIUM_PATH } : {}), args: ["--no-sandbox"] });
    await monthRolloverWorkflow(browser); await ledgerRefreshFailureWorkflow(browser); await ledgerRefreshFailureWorkflow(browser, true); await entryWorkflow(browser); await ownerWorkflow(browser); await missingMigrationWorkflow(browser); await accountSwitchWorkflow(browser); await mobileWorkflow(browser); await reprocessWorkflow(browser); await groupedBalanceReprocessWorkflow(browser); await missingReprocessWorkflow(browser); await reprocessLayoutWorkflow(browser);
    process.stdout.write(`\n${checks} SMS browser checks passed using intercepted service fixtures. Live SMS forwarding and iOS execution still require phone verification.\n`);
  } catch (error) { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; }
  finally { if (browser) await browser.close(); server.kill(); }
})();
