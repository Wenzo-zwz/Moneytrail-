/* Real SDK/browser integration with intercepted service fixtures.
 * This does not verify hosted authorization, a real iPhone, or bank SMS delivery.
 */
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { mkdir } = require("node:fs/promises");
const path = require("node:path");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..");
const PORT = Number(process.env.MONEYTRAIL_SMS_SMOKE_PORT || 5187);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const BASE = `${ORIGIN}/Moneytrail-/`;
const PROJECT = "https://sms-fixture.supabase.co";
const PUBLIC_KEY = "sb_publishable_sms_fixture";
const ARTIFACTS = path.join(ROOT, "test-results", "classification");
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
function mockBackend({ missingSms = false, ordinaryPending = false } = {}) {
  const ledgers = new Map([[OWNER, { data: { ...empty(), budgetCents: 900000, transactions: [manual], billCheckedMonths: ["2026-09"] }, revision: 1, updated_at: "2026-10-22T11:00:00Z" }], [MEMBER, { data: empty(), revision: 1, updated_at: "2026-10-22T11:00:00Z" }]]);
  const inboxes = new Map([[OWNER, [
    { id: GROUP, received_at: "2026-10-22T11:27:00Z", status: "pending", raw_text: RAW, draft: { kind: "expense", amountCents: 3090, date: "2026-10-22T19:27", merchant: "财付通-群收款", category: "待分类", source: "sms", note: "" }, warnings: ["群收款需确认是消费还是转账。"], reason: null, transaction_id: null },
    { id: OTHER, received_at: "2026-10-22T11:20:00Z", status: "pending", raw_text: "您今日支出12元。【工商银行】", draft: null, warnings: [], reason: "未能识别完整交易，请手动核对。", transaction_id: null },
  ]], [MEMBER, []]]);
  const configs = new Map([OWNER, MEMBER].map((id) => [id, { enabled: false, mode: "auto", created_at: null, last_received_at: id === OWNER ? "2026-10-22T11:27:00Z" : null }]));
  if (ordinaryPending) {
    const examples = [["快捷支付-财付通", 1200], ["支付宝", 2350], ["美团外卖", 880], ["某某便利店", 1680]];
    const records = examples.map(([merchant, amountCents], index) => {
      const id = `34000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
      return { id, received_at: `2026-10-22T11:1${index}:00Z`, status: "pending", raw_text: `尾号xxxx卡10月22日19:1${index}支出(${merchant})${(amountCents / 100).toFixed(2)}元，余额8xxxx元。【工商银行】`, draft: { kind: "expense", amountCents, date: `2026-10-22T19:1${index}`, merchant, category: "待分类", source: "sms", note: "" }, warnings: ["交易用途尚不明确，请核对后确认。"], reason: null, transaction_id: null };
    });
    inboxes.set(OWNER, [...records, ...inboxes.get(OWNER)]);
    configs.set(OWNER, { ...configs.get(OWNER), enabled: true, created_at: "2026-10-22T11:00:00Z" });
    ledgers.get(OWNER).data.billCheckedMonths.push("2026-10");
  }
  const rules = new Map([[OWNER, []], [MEMBER, []]]);
  const controls = { failPush: false, missingRules: false, delayPreview: 0 };
  const requests = []; const routeErrors = []; const secrets = [];
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
          return respond([{ user_id: id, ...clone(ledgers.get(id)) }]);
        }
        if (url.pathname === "/rest/v1/rpc/save_moneytrail_ledger") {
          if (controls.failPush) return respond({ code: "network", message: "Fixture offline" }, 503);
          const current = ledgers.get(id);
          if (body.p_expected_revision !== current.revision) return respond({ code: "40001", message: "Stale revision" }, 409);
          const updated = { data: clone(body.p_data), revision: current.revision + 1, updated_at: new Date().toISOString() };
          ledgers.set(id, updated); return respond([{ user_id: id, ...updated }]);
        }
        if (url.pathname.startsWith("/rest/v1/rpc/moneytrail_sms_")) {
          if (missingSms) return respond({ code: "PGRST202", message: "Function missing" }, 404);
          const action = url.pathname.split("moneytrail_sms_")[1];
          if (action === "category_rules") return controls.missingRules ? respond({ code: "PGRST202" }, 404) : respond({ rules: rules.get(id) });
          if (action === "set_category_rule") { const next = rules.get(id).filter(r => r.merchant !== body.p_merchant); if (body.p_category !== null) next.push({ merchant: body.p_merchant, category: body.p_category }); rules.set(id, next); return respond({ rules: next }); }
          if (action === "preview_pending") {
            if (controls.delayPreview) await new Promise(resolve => setTimeout(resolve, controls.delayPreview));
            const items = inboxes.get(id).filter(item => item.status === "pending").map(item => ({ id: item.id, draft: item.draft, eligible: item.draft?.merchant === "美团外卖", reason: item.draft?.merchant === "美团外卖" ? "餐饮商户" : "需要确认用途" }));
            return respond({ items, recordable_count: items.filter(i => i.eligible).length, pending_count: items.length });
          }
          if (action === "apply_pending") {
            assert.equal(body.p_items.length, 1); const selected = body.p_items[0]; const item = inboxes.get(id).find(i => i.id === selected.id); assert.equal(item.draft.merchant, "美团外卖");
            const transaction = { ...clone(selected.draft), id: `sms-${item.id}`, sourceRef: `sms-${item.id}` }; const current = ledgers.get(id);
            current.data.transactions.push(transaction); current.revision++; Object.assign(item, { status: "recorded", raw_text: null, transaction_id: transaction.id });
            return respond({ recorded_count: 1, pending_count: inboxes.get(id).filter(i => i.status === "pending").length });
          }
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
  return { attach, requests, routeErrors, ledgers, inboxes, configs, secrets, controls };
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
async function openSms(page) {
  await page.getByRole("button", { name: "我的账户", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "我的账户", exact: true });
  await dialog.getByRole("button", { name: "短信自动记账", exact: true }).click();
}

// Workflow selectors are kept accessible so the test exercises the shipped UI.
async function workflow(browser, width) {
  const backend = mockBackend({ ordinaryPending: true });
  backend.configs.get(OWNER).mode = "review";
  backend.ledgers.get(OWNER).data.transactions.push({ ...manual, id: "uncategorized", merchant: "滴滴出行", category: "待分类" });
  const { page, context, errors } = await fixture(browser, backend, { width });
  try {
    await login(page); await page.getByRole("button", { name: "预览待确认短信", exact: true }).waitFor();
    const before = clone(backend.ledgers.get(OWNER).data);
    await page.getByRole("button", { name: "预览待确认短信", exact: true }).click();
    await until(async () => { const text = await page.locator(".sms-classification").innerText(); if (text.includes("待确认预览")) return true; const notice = await page.locator(".sms-notice").innerText(); if (notice) throw new Error(notice); return false; }, "pending preview");
    assert.deepEqual(backend.ledgers.get(OWNER).data, before);
    await page.getByRole("button", { name: "确认应用可入账记录", exact: true }).click();
    await page.getByText("已入账 1 笔，仍有 5 笔待确认。").waitFor();
    assert.equal(backend.ledgers.get(OWNER).data.transactions.length, 3);
    assert.equal(backend.configs.get(OWNER).mode, "review", "explicit historical apply preserves review intake mode");
    assert.equal(backend.inboxes.get(OWNER).find(i => i.id === GROUP).status, "pending");
    await page.getByRole("button", { name: "预览账本待分类", exact: true }).click();
    await page.getByText(/账本分类预览：/).waitFor();
    assert.equal(backend.ledgers.get(OWNER).data.transactions.find(t => t.id === "uncategorized").category, "待分类");
    await page.getByRole("button", { name: "确认更新分类", exact: true }).click();
    await until(() => backend.ledgers.get(OWNER).data.transactions.find(t => t.id === "uncategorized").category === "交通", "category persisted");
    await until(async () => await page.getByRole("button", { name: "撤销本次分类" }).isEnabled(), "undo ready");
    await page.getByRole("button", { name: "撤销本次分类" }).click();
    await until(() => backend.ledgers.get(OWNER).data.transactions.find(t => t.id === "uncategorized").category === "待分类", "undo persisted");
    await page.locator(".sms-rule-editor summary").click();
    await page.getByLabel("具体商户", { exact: true }).fill("财付通-群收款");
    assert.equal(await page.getByLabel("以后这家都这样分类").isEnabled(), false);
    for (const merchant of ["美团", "美团支付", "消费美团支付-美团北京三快在线科技有限公司"]) {
      await page.getByLabel("具体商户", { exact: true }).fill(merchant);
      await page.getByText("美团平台默认归入本地生活，细类未细分。请填写具体门店，不能保存整个平台的用途规则。", { exact: true }).waitFor();
      assert.equal(await page.getByLabel("以后这家都这样分类").count(), 0);
      assert.equal(await page.getByRole("button", { name: "保存商户规则", exact: true }).isEnabled(), false);
    }
    await page.getByLabel("具体商户", { exact: true }).fill("巷口咖啡");
    await page.getByLabel("以后这家都这样分类").check();
    await page.getByRole("button", { name: "保存商户规则", exact: true }).click();
    await page.getByRole("button", { name: "删除规则", exact: true }).waitFor();
    await until(async () => await page.getByRole("button", { name: "删除规则" }).isEnabled(), "rule ready");
    await page.getByRole("button", { name: "删除规则", exact: true }).click();
    await until(async () => await page.getByRole("button", { name: "删除规则" }).count() === 0, "rule deleted");
    await noOverflow(page, `${width}px classification tools`);
    assert.deepEqual(errors, []); assert.deepEqual(backend.routeErrors, []);
    await page.screenshot({ path: path.join(ARTIFACTS, `classification-${width}.png`), fullPage: true });
    passed(`${width}px review-mode preview/apply preserves mode, category update/undo and exact rule save/delete`);
  } finally { await context.close(); }
}
async function lateAccountWorkflow(browser) {
  const backend = mockBackend({ ordinaryPending: true }); backend.controls.delayPreview = 1500;
  const { page, context, errors } = await fixture(browser, backend, { width: 390 });
  try {
    await login(page); await page.getByRole("button", { name: "预览待确认短信", exact: true }).click();
    await page.getByRole("button", { name: "返回账本", exact: true }).click();
    await page.getByRole("button", { name: "我的账户", exact: true }).click();
    await page.getByRole("dialog", { name: "我的账户", exact: true }).getByRole("button", { name: "退出登录并清除本机副本", exact: true }).click();
    await page.getByRole("button", { name: "登录我的账本", exact: true }).waitFor();
    await login(page, "member@example.test"); await page.locator(".hero-amount").waitFor();
    await openSms(page); await page.getByRole("heading", { name: "短信自动记账", exact: true }).waitFor();
    await page.waitForTimeout(1700);
    assert.equal(await page.getByText(/待确认预览：/).count(), 0);
    assert.equal(await page.getByText("财付通-群收款", { exact: true }).count(), 0);
    assert.equal(backend.ledgers.get(MEMBER).data.transactions.length, 0);
    assert.deepEqual(errors, []); assert.deepEqual(backend.routeErrors, []);
    passed("late preview discarded after leaving SMS and switching account");
  } finally { await context.close(); }
}
async function failureWorkflow(browser) {
  const backend = mockBackend();
  backend.controls.missingRules = true;
  backend.ledgers.get(OWNER).data.transactions.push({ ...manual, id: "uncategorized", merchant: "滴滴出行", category: "待分类" });
  const { page, context, errors } = await fixture(browser, backend, { width: 390 });
  try {
    await login(page); await page.getByRole("button", { name: "预览账本待分类", exact: true }).click();
    await page.locator(".sms-rule-editor summary").click();
    await page.getByText(/自动入账规则尚未升级/).first().waitFor();
    await page.getByText("财付通-群收款", { exact: true }).first().waitFor();
    backend.controls.missingRules = false;
    await page.getByRole("button", { name: "预览账本待分类", exact: true }).click();
    await page.getByText(/账本分类预览：/).waitFor();
    backend.controls.failPush = true;
    await page.getByRole("button", { name: "确认更新分类", exact: true }).click();
    await until(async () => (await page.locator(".sms-notice").innerText()).includes("等待同步"), "truthful offline classification notice");
    assert(!(await page.locator(".sms-notice").innerText()).includes("已同步"));
    assert.equal(backend.ledgers.get(OWNER).data.transactions.find(t => t.id === "uncategorized").category, "待分类");
    assert.equal(await page.getByRole("button", { name: "撤销本次分类" }).isEnabled(), false);
    assert.deepEqual(errors, []); assert.deepEqual(backend.routeErrors, []);
    passed("missing classification migration leaves inbox usable; failed sync says waiting and blocks undo until clean");
  } finally { await context.close(); }
}
(async () => {
  await mkdir(ARTIFACTS, { recursive: true }); let output = "";
  const server = spawn(process.execPath, [path.join(ROOT, "node_modules", "vite", "bin", "vite.js"), "--host", "127.0.0.1", "--port", String(PORT)], { cwd: ROOT, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, MONEYTRAIL_BASE_PATH: "/Moneytrail-/", VITE_SUPABASE_URL: PROJECT, VITE_SUPABASE_PUBLISHABLE_KEY: PUBLIC_KEY, VITE_SUPABASE_ANON_KEY: "" } });
  server.stdout.on("data", c => { output += c; }); server.stderr.on("data", c => { output += c; }); let browser;
  try { await ready(server, () => output); browser = await chromium.launch({ headless: true, ...(process.env.MONEYTRAIL_CHROMIUM_PATH ? { executablePath: process.env.MONEYTRAIL_CHROMIUM_PATH } : {}) }); await workflow(browser, 390); await workflow(browser, 1440); await failureWorkflow(browser); await lateAccountWorkflow(browser); }
  catch (error) { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; }
  finally { if (browser) await browser.close(); server.kill(); }
})();
