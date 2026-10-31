/* Browser integration with the real Supabase SDK and intercepted fixture responses.
 * These checks do not verify a hosted Supabase project, JWT signatures, or email delivery.
 */
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { mkdir, readFile } = require("node:fs/promises");
const path = require("node:path");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..");
const PORT = Number(process.env.MONEYTRAIL_ACCOUNT_SMOKE_PORT || 5175);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const BASE = `${ORIGIN}/Moneytrail-/`;
const PROJECT = "https://test-project.supabase.co";
const ARTIFACTS = path.join(ROOT, "test-results", "accounts");
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const PASSWORD = "Fixture-password-123!";
const CACHE = (id) => `moneytrail:cloud:v1:${encodeURIComponent(PROJECT)}:${id}`;
const copy = (value) => JSON.parse(JSON.stringify(value));
const empty = () => ({ version: 1, transactions: [], budgetCents: 0, billCheckedMonths: [] });
const transaction = (id, merchant, cents = 1000) => ({ id, kind: "expense", amountCents: cents, date: "2026-10-22T12:30", merchant, category: "本地生活", subcategory: "餐饮", source: "manual", note: "" });
let checks = 0;
const passed = (name) => { checks += 1; process.stdout.write(`PASS ${name}\n`); };

function user(id) {
  return { id, aud: "authenticated", role: "authenticated", email: id === B ? "b@example.test" : "a@example.test", email_confirmed_at: "2026-10-01T00:00:00Z", phone: "", app_metadata: { provider: "email", providers: ["email"] }, user_metadata: {}, identities: [], created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z" };
}
function token(id) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ sub: id, aud: "authenticated", role: "authenticated", email: user(id).email, iat: 1790000000, exp: 4102444800 })}.${Buffer.alloc(32, 1).toString("base64url")}`;
}
function session(id) { return { access_token: token(id), token_type: "bearer", expires_in: 3600 * 24 * 365 * 30, refresh_token: `fixture-refresh-${id}`, user: user(id) }; }

function mockBackend() {
  const ledgers = new Map([
    [A, { data: { ...empty(), transactions: [transaction("shared-id", "账户 A 原有消费")], budgetCents: 50000 }, revision: 1, updated_at: "2026-10-22T04:30:00Z" }],
    [B, { data: { ...empty(), transactions: [transaction("b-only", "账户 B 原有消费", 2000)] }, revision: 1, updated_at: "2026-10-22T04:30:00Z" }],
  ]);
  const requests = [];
  const merchantRules = new Map([[A, []], [B, []]]);
  const accepted = [];
  let recoveryRedirect = null;
  let userUpdates = 0;
  let logoutGate = null;
  let releaseLogout;
  function identity(request) {
    try { return JSON.parse(Buffer.from((request.headers().authorization || "").split(".")[1], "base64url").toString()).sub; }
    catch { return null; }
  }
  async function attach(context) {
    await context.route("**/*", async (route) => {
      const request = route.request(); const url = new URL(request.url());
      if (url.origin === ORIGIN) return route.continue();
      assert.equal(url.origin, PROJECT, `unexpected external request: ${url.origin}`);
      const headers = { "access-control-allow-origin": ORIGIN, "access-control-allow-headers": "*", "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS", "access-control-expose-headers": "x-supabase-api-version", "content-type": "application/json", "x-supabase-api-version": "2024-01-01" };
      const respond = (body, status = 200) => route.fulfill({ status, headers, body: status === 204 ? "" : JSON.stringify(body) });
      if (request.method() === "OPTIONS") return respond({}, 204);
      const body = request.postData() ? JSON.parse(request.postData()) : null;
      const id = identity(request);
      requests.push({ path: url.pathname, method: request.method(), id, body: copy(body) });
      if (url.pathname === "/auth/v1/token") {
        if (url.searchParams.get("grant_type") === "pkce") return respond(session(A));
        const selected = body?.email === "b@example.test" ? B : A;
        if (body?.password !== PASSWORD) return respond({ code: "invalid_credentials", msg: "Invalid login credentials" }, 400);
        return respond(session(selected));
      }
      if (url.pathname === "/auth/v1/signup") return respond({ user: { ...user(A), email: body.email }, session: null });
      if (url.pathname === "/auth/v1/recover") { recoveryRedirect = url.searchParams.get("redirect_to"); return respond({}); }
      if (url.pathname === "/auth/v1/logout") { if (logoutGate) await logoutGate; return respond({}, 204); }
      if (url.pathname === "/auth/v1/user") {
        if (!id) return respond({ code: "bad_jwt", msg: "Not authenticated" }, 401);
        if (request.method() === "PUT") userUpdates += 1;
        return respond(user(id));
      }
      if (!id || !ledgers.has(id)) return respond({ code: "42501", message: "Not authenticated" }, 403);
      if (url.pathname === "/rest/v1/rpc/moneytrail_is_admin") return respond(false);
      if (url.pathname === "/rest/v1/rpc/moneytrail_sms_category_rules") return respond({ rules: merchantRules.get(id) });
      if (url.pathname === "/rest/v1/rpc/moneytrail_admin_overview") return respond({ code: "42501", message: "Administrator access required" }, 403);
      if (url.pathname === "/rest/v1/moneytrail_ledgers") {
        assert.equal(request.method(), "GET");
        assert.equal(url.searchParams.get("user_id"), `eq.${id}`, "SDK query must select its own user");
        return respond([{ ...copy(ledgers.get(id)), user_id: id }]);
      }
      if (["/rest/v1/rpc/save_moneytrail_ledger", "/rest/v1/rpc/save_moneytrail_ledger_with_rules"].includes(url.pathname)) {
        assert.deepEqual(Object.keys(body).sort(), body.p_rules ? ["p_data", "p_expected_revision", "p_rules"] : ["p_data", "p_expected_revision"]);
        const existing = ledgers.get(id);
        if (existing.revision !== body.p_expected_revision) return respond({ code: "PT409", message: "Revision conflict" }, 409);
        const next = { data: copy(body.p_data), revision: existing.revision + 1, updated_at: new Date().toISOString() };
        for (const rule of body.p_rules || []) {
          assert(next.data.transactions.some(transaction => transaction.id === rule.transactionId && transaction.merchant === rule.merchant && transaction.category === rule.category && transaction.subcategory === rule.subcategory));
          merchantRules.set(id, [...merchantRules.get(id).filter(item => item.merchant !== rule.merchant), { merchant: rule.merchant, category: rule.category, ...(rule.subcategory ? { subcategory: rule.subcategory } : {}) }]);
        }
        ledgers.set(id, next); accepted.push({ id, ...copy(next) });
        return respond([{ user_id: id, ...next }]);
      }
      throw new Error(`Unexpected fixture endpoint ${request.method()} ${url.pathname}`);
    });
  }
  return { attach, ledgers, requests, accepted,
    holdLogout() { logoutGate = new Promise((resolve) => { releaseLogout = resolve; }); },
    releaseLogout() { releaseLogout?.(); logoutGate = null; },
    get recoveryRedirect() { return recoveryRedirect; }, get userUpdates() { return userUpdates; } };
}

async function ready(server, output) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Account dev server exited: ${output()}`);
    try { if (/ready in/i.test(output()) && (await fetch(BASE)).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Account dev server not ready: ${output()}`);
}
async function fixture(browser, backend, mobile = false, legacy) {
  const context = await browser.newContext({ viewport: { width: mobile ? 393 : 1440, height: mobile ? 852 : 1000 }, locale: "zh-CN", timezoneId: "Asia/Shanghai", acceptDownloads: true, ...(mobile ? { isMobile: true, hasTouch: true } : {}) });
  await backend.attach(context);
  if (legacy) await context.addInitScript((data) => { if (!sessionStorage.getItem("fixture-seeded")) { localStorage.setItem("moneytrail:v1", JSON.stringify(data)); sessionStorage.setItem("fixture-seeded", "1"); } }, legacy);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.setDefaultTimeout(12000);
  await page.clock.setFixedTime(new Date("2026-10-22T04:30:00Z"));
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "登录我的账本", exact: true }).waitFor();
  return { page, context, errors };
}
async function login(page, email = "a@example.test", password = PASSWORD) {
  await page.getByLabel("邮箱", { exact: true }).fill(email);
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录我的账本", exact: true }).click();
}
async function cache(page, id = A) { return page.evaluate((key) => JSON.parse(localStorage.getItem(key) || "null"), CACHE(id)); }
async function cacheWait(page, id, predicate) {
  await page.waitForFunction(({ key, source }) => { const value = JSON.parse(localStorage.getItem(key) || "null"); return new Function("value", `return (${source})(value)`)(value); }, { key: CACHE(id), source: predicate.toString() });
}
async function noOverflow(page, name) {
  const size = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: innerWidth }));
  assert(size.width <= size.viewport + 1, `${name}: horizontal overflow ${JSON.stringify(size)}`);
}
async function accountDialog(page) {
  await page.getByRole("button", { name: "我的账户", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "我的账户", exact: true });
  await dialog.waitFor(); return dialog;
}
async function addManual(page, merchant) {
  await page.getByRole("button", { name: "记一笔", exact: true }).click();
  const modal = page.getByRole("dialog", { name: "记下一笔", exact: true });
  await modal.getByLabel("金额（元）", { exact: true }).fill("12.34");
  await modal.getByLabel("商户 / 对方", { exact: true }).fill(merchant);
  await modal.getByLabel("发生时间", { exact: true }).fill("2026-10-22T13:30");
  await modal.getByLabel("分类", { exact: true }).selectOption("本地生活");
  const acceptDuplicate = (confirmation) => confirmation.accept();
  page.on("dialog", acceptDuplicate);
  await modal.getByRole("button", { name: "确认保存", exact: true }).click();
  try { await modal.waitFor({ state: "detached" }); }
  catch (error) { throw new Error(`${error.message}\nEditor text: ${await modal.textContent()}`); }
  finally { page.off("dialog", acceptDuplicate); }
}

async function authWorkflow(browser) {
  const backend = mockBackend(); const { page, context, errors } = await fixture(browser, backend);
  try {
    await noOverflow(page, "desktop auth");
    await page.screenshot({ path: path.join(ARTIFACTS, "desktop-login.png"), fullPage: true, animations: "disabled" });
    await login(page, "a@example.test", "wrong-password");
    await page.getByRole("alert").waitFor();
    assert.match(await page.getByRole("alert").textContent(), /邮箱或密码不正确/, "typed SDK error should produce the translated login error");
    assert.equal(await page.locator(".hero-amount").count(), 0);
    passed("wrong password remains on the login screen without exposing a ledger");

    await page.getByRole("button", { name: "注册账号", exact: true }).click();
    await page.getByLabel("邮箱", { exact: true }).fill("new@example.test");
    await page.getByLabel("密码", { exact: true }).fill(PASSWORD);
    await page.getByLabel("确认密码", { exact: true }).fill("Different-password-456!");
    await page.getByRole("button", { name: "创建账号", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "两次输入的密码不一致" }).waitFor();
    assert.equal(backend.requests.filter((request) => request.path === "/auth/v1/signup").length, 0);
    await page.getByLabel("确认密码", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: "创建账号", exact: true }).click();
    await page.getByText(/注册请求已提交/).waitFor();
    assert.equal(await page.locator(".hero-amount").count(), 0);
    passed("registration validates confirmation and waits for email verification rather than inventing a session");

    await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.getByRole("button", { name: "忘记密码？", exact: true }).click();
    await page.getByLabel("邮箱", { exact: true }).fill("a@example.test");
    await page.getByRole("button", { name: "发送重置邮件", exact: true }).click();
    await page.getByText(/如果此邮箱可以接收重置邮件/).waitFor();
    assert(backend.recoveryRedirect, "SDK sends a recovery redirect URL");
    const callback = new URL(backend.recoveryRedirect);
    assert.equal(callback.pathname, "/Moneytrail-/");
    callback.searchParams.set("code", "fixture-recovery-code");
    await page.goto(callback.href, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "设置新的登录密码", exact: true }).waitFor();
    assert.equal(await page.locator(".hero-amount").count(), 0, "password recovery gates the ledger");
    await page.getByLabel("新密码", { exact: true }).fill(PASSWORD);
    await page.getByLabel("确认密码", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: "更新密码", exact: true }).click();
    await page.getByRole("button", { name: "进入我的账本", exact: true }).waitFor();
    assert.equal(backend.userUpdates, 1);
    await page.getByRole("button", { name: "进入我的账本", exact: true }).click();
    await page.locator(".hero-amount").waitFor();
    passed("SDK PKCE recovery callback stays gated until password update succeeds");
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
}

async function ledgerWorkflow(browser) {
  const backend = mockBackend();
  const legacy = { ...empty(), transactions: [transaction("shared-id", "旧本机消费", 3800)], budgetCents: 100000 };
  const { page, context, errors } = await fixture(browser, backend, false, legacy);
  try {
    assert.equal(await page.getByText("旧本机消费", { exact: true }).count(), 0, "signed-out UI must not reveal legacy merchants");
    await login(page);
    await cacheWait(page, A, (value) => value && !value.dirty);
    await page.locator(".hero-amount").waitFor();
    assert.equal(backend.accepted.length, 0, "login alone must not upload the legacy book");
    assert.deepEqual((await cache(page)).data, backend.ledgers.get(A).data);
    passed("login reads only the account book and does not automatically upload old device records");

    let dialog = await accountDialog(page);
    assert.equal(await dialog.getByRole("button", { name: "确认迁移至此账户", exact: true }).isDisabled(), true);
    const downloadPromise = page.waitForEvent("download");
    await dialog.getByRole("button", { name: "备份旧本机账本", exact: true }).click();
    const backup = await downloadPromise;
    assert.deepEqual(JSON.parse(await readFile(await backup.path(), "utf8")), legacy);
    page.once("dialog", async (confirmation) => { assert.match(confirmation.message(), /a@example\.test/); await confirmation.accept(); });
    await dialog.getByRole("button", { name: "确认迁移至此账户", exact: true }).click();
    await cacheWait(page, A, (value) => value && !value.dirty && value.data.transactions.length === 2);
    assert.equal(backend.accepted.length, 1);
    assert.equal(backend.ledgers.get(A).data.budgetCents, 50000);
    assert.equal(new Set(backend.ledgers.get(A).data.transactions.map((item) => item.id)).size, 2);
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem("moneytrail:v1"))), legacy);
    await dialog.getByRole("button", { name: "关闭账户窗口", exact: true }).click();
    passed("explicit backed-up migration preserves the existing account book, rebases ID collisions, and keeps the old copy");

    await context.setOffline(true);
    await addManual(page, "离线账户消费");
    await cacheWait(page, A, (value) => value && value.dirty && value.data.transactions.length === 3);
    assert.equal(backend.accepted.length, 1);
    assert.equal((await cache(page)).data.transactions.some((item) => item.merchant === "离线账户消费"), true);
    await context.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await cacheWait(page, A, (value) => value && !value.dirty && value.data.transactions.length === 3);
    assert.equal(backend.ledgers.get(A).data.transactions.length, 3);
    passed("offline edits stay durable and pending until a successful online cloud acknowledgement");

    await context.setOffline(true);
    const remote = copy(backend.ledgers.get(A));
    remote.revision += 1;
    remote.data.transactions.push(transaction("remote-only", "另一设备消费", 5600));
    backend.ledgers.set(A, remote);
    await addManual(page, "本机待核对消费");
    await cacheWait(page, A, (value) => value && value.dirty && value.data.transactions.some((item) => item.merchant === "本机待核对消费"));
    await context.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await page.locator(".sync-state.conflict").first().waitFor();
    await page.getByRole("alert").filter({ hasText: "首页金额尚未更新到云端最新账本" }).waitFor();
    assert.equal(backend.ledgers.get(A).data.transactions.some((item) => item.merchant === "本机待核对消费"), false);
    dialog = await accountDialog(page);
    await dialog.getByRole("heading", { name: "两个设备的账目需要核对", exact: true }).waitFor();
    const localBackupPromise = page.waitForEvent("download");
    page.once("dialog", (confirmation) => confirmation.accept());
    await dialog.getByRole("button", { name: "采用云端版本", exact: true }).click();
    const localBackup = JSON.parse(await readFile(await (await localBackupPromise).path(), "utf8"));
    assert(localBackup.transactions.some((item) => item.merchant === "本机待核对消费"));
    await cacheWait(page, A, (value) => value && !value.dirty && value.data.transactions.some((item) => item.merchant === "另一设备消费"));
    assert.equal((await cache(page)).data.transactions.some((item) => item.merchant === "本机待核对消费"), false);
    await dialog.getByRole("button", { name: "关闭账户窗口", exact: true }).click();
    passed("stale cloud revision preserves local edits and requires an explicit backed-up conflict choice");

    const otherPage = await context.newPage();
    otherPage.setDefaultTimeout(12000);
    otherPage.on("pageerror", (error) => errors.push(error.message));
    await otherPage.goto(BASE, { waitUntil: "networkidle" });
    await otherPage.locator(".hero-amount").waitFor();
    backend.holdLogout();
    dialog = await accountDialog(page);
    await dialog.getByRole("button", { name: "退出登录并清除本机副本", exact: true }).click();
    await otherPage.getByText(/另一页面已移除此账户的本机副本/).first().waitFor();
    assert.equal(await otherPage.locator(".hero-amount").count(), 0, "another tab must hide the ledger before the logout API returns");
    assert.equal(await cache(otherPage, A), null);
    const readCount = backend.requests.filter((request) => request.path === "/rest/v1/moneytrail_ledgers").length;
    await otherPage.evaluate(() => { window.dispatchEvent(new Event("focus")); window.dispatchEvent(new Event("online")); });
    await otherPage.waitForTimeout(150);
    assert.equal(await cache(otherPage, A), null, "a stopped tab must not resurrect the purged account cache");
    assert.equal(backend.requests.filter((request) => request.path === "/rest/v1/moneytrail_ledgers").length, readCount);
    backend.releaseLogout();
    await page.getByRole("button", { name: "登录我的账本", exact: true }).waitFor();
    await otherPage.getByRole("button", { name: "登录我的账本", exact: true }).waitFor();
    await otherPage.close();
    passed("another open tab hides its ledger immediately and cannot restore a purged cache while logout is delayed");
    assert.equal(await cache(page, A), null, "explicit signout purges account A cache");
    assert.equal(await page.getByText("账户 A 原有消费", { exact: true }).count(), 0);
    await login(page, "b@example.test");
    await cacheWait(page, B, (value) => value && !value.dirty);
    assert.deepEqual((await cache(page, B)).data, backend.ledgers.get(B).data);
    assert.equal(await cache(page, A), null);
    assert.equal((await cache(page, B)).data.transactions.length, 1);
    assert.equal(backend.accepted.some((request) => request.id === B), false, "B must not receive legacy or A records automatically");
    await noOverflow(page, "desktop signed-in account B");
    passed("signout clears the old account cache and account B receives only its own ledger");
    assert.deepEqual(errors, []);
  } finally { backend.releaseLogout(); await context.close(); }
}

async function mobileWorkflow(browser) {
  const backend = mockBackend(); const { page, context, errors } = await fixture(browser, backend, true);
  try {
    await noOverflow(page, "393px login");
    await page.screenshot({ path: path.join(ARTIFACTS, "mobile-login.png"), fullPage: true, animations: "disabled" });
    await login(page, "b@example.test");
    await cacheWait(page, B, (value) => value && !value.dirty);
    await noOverflow(page, "393px dashboard");
    const dialog = await accountDialog(page);
    await noOverflow(page, "393px account dialog");
    await page.screenshot({ path: path.join(ARTIFACTS, "mobile-account.png"), fullPage: true, animations: "disabled" });
    await dialog.getByRole("button", { name: "关闭账户窗口", exact: true }).click();
    await addManual(page, "手机账户消费");
    await cacheWait(page, B, (value) => value && !value.dirty && value.data.transactions.length === 2);
    assert.deepEqual(errors, []);
    passed("393px mobile login, account management, recording and sync fit without horizontal overflow");
  } finally { await context.close(); }
}

(async () => {
  await mkdir(ARTIFACTS, { recursive: true });
  let output = "";
  const server = spawn(process.execPath, [path.join(ROOT, "node_modules", "vite", "bin", "vite.js"), "--host", "127.0.0.1", "--port", String(PORT)], {
    cwd: ROOT, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, MONEYTRAIL_BASE_PATH: "/Moneytrail-/", VITE_SUPABASE_URL: PROJECT, VITE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test_public_key", VITE_SUPABASE_ANON_KEY: "" },
  });
  server.stdout.on("data", (chunk) => { output += chunk.toString(); });
  server.stderr.on("data", (chunk) => { output += chunk.toString(); });
  let browser;
  try {
    await ready(server, () => output);
    browser = await chromium.launch({ headless: true, ...(process.env.MONEYTRAIL_CHROMIUM_PATH ? { executablePath: process.env.MONEYTRAIL_CHROMIUM_PATH } : {}), args: ["--no-sandbox"] });
    await authWorkflow(browser);
    await ledgerWorkflow(browser);
    await mobileWorkflow(browser);
    process.stdout.write(`\n${checks} account browser checks passed using intercepted fixture responses. Hosted authentication, email delivery, JWT verification and real iPhone checks remain separate.\n`);
  } catch (error) {
    process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    if (server.pid) { try { server.kill(); } catch {} }
  }
})();
