/* Browser integration using the real SDK and intercepted service fixtures.
 * This does not verify hosted JWT signatures, email delivery, or a live owner binding.
 */
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { mkdir } = require("node:fs/promises");
const path = require("node:path");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..");
const PORT = Number(process.env.MONEYTRAIL_ADMIN_SMOKE_PORT || 5176);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const BASE = `${ORIGIN}/Moneytrail-/`;
const PROJECT = "https://admin-fixture.supabase.co";
const PUBLIC_KEY = "sb_publishable_admin_fixture";
const ARTIFACTS = path.join(ROOT, "test-results", "admin");
const OWNER = "11111111-1111-4111-8111-111111111111";
const MEMBER = "22222222-2222-4222-8222-222222222222";
const PASSWORD = "Fixture-password-123!";
const PRIVATE_EMAIL = "private-directory-only@example.test";
const clone = (value) => JSON.parse(JSON.stringify(value));
const empty = () => ({ version: 1, transactions: [], budgetCents: 0, billCheckedMonths: [] });
let checks = 0;
const passed = (message) => { checks += 1; process.stdout.write(`PASS ${message}\n`); };

function authUser(id, forgedMetadata = false) {
  return {
    id, aud: "authenticated", role: "authenticated",
    email: id === OWNER ? "owner@example.test" : "member@example.test",
    email_confirmed_at: "2026-10-01T00:00:00Z", phone: "",
    app_metadata: { provider: "email", providers: ["email"], ...(forgedMetadata ? { role: "admin", is_admin: true } : {}) },
    user_metadata: forgedMetadata ? { role: "admin", isAdmin: true, admin: true } : {},
    identities: [], created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z",
  };
}
function token(id) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ sub: id, aud: "authenticated", role: "authenticated", iat: 1790000000, exp: 4102444800 })}.${Buffer.alloc(32, 2).toString("base64url")}`;
}
function session(id, forgedMetadata = false) {
  return { access_token: token(id), token_type: "bearer", expires_in: 3600 * 24 * 365 * 30, refresh_token: `fixture-refresh-${id}`, user: authUser(id, forgedMetadata) };
}
function identity(request) {
  try { return JSON.parse(Buffer.from((request.headers().authorization || "").split(".")[1], "base64url").toString()).sub; }
  catch { return null; }
}

function mockBackend({ missingAdmin = false, forgedMemberMetadata = false, staleMemberGrant = false } = {}) {
  const directory = Array.from({ length: 42 }, (_, index) => ({
    id: index === 0 ? OWNER : index === 1 ? MEMBER : `30000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    email: index === 0 ? "owner@example.test" : index === 1 ? "member@example.test" : index === 2 ? PRIVATE_EMAIL : index === 40 ? "needle@example.test" : `member-${String(index).padStart(3, "0")}@example.test`,
    created_at: index >= 40 ? "2026-10-21T00:00:00Z" : "2026-10-01T00:00:00Z",
    email_confirmed_at: index === 0 || index % 3 ? "2026-10-02T00:00:00Z" : null,
    last_sign_in_at: index % 4 ? "2026-10-22T03:00:00Z" : null,
    ledger_updated_at: index < 20 ? "2026-10-22T04:00:00Z" : null,
    transaction_count: index < 20 ? index + 1 : 0,
  }));
  const ledgers = new Map([OWNER, MEMBER].map((id) => [id, { data: empty(), revision: 1, updated_at: "2026-10-22T04:30:00Z" }]));
  const requests = [];
  const routeErrors = [];
  let ownerEnabled = true;
  let nextOverviewGate = null;
  let heldOverview = false;
  let releaseOverview;
  const overview = (body) => {
    const query = String(body?.p_query || "").trim().toLowerCase();
    const selected = directory.filter((user) => !query || user.email.toLowerCase().includes(query));
    const page = Number(body?.p_page || 1); const pageSize = Number(body?.p_page_size || 20);
    return {
      totals: { users: directory.length, confirmed_users: directory.filter((user) => user.email_confirmed_at).length, new_users_7d: 2, ledgers: 20, synced_24h: 12 },
      users: clone(selected.slice((page - 1) * pageSize, page * pageSize)), total: selected.length, page, page_size: pageSize,
    };
  };
  async function attach(context) {
    await context.route("**/*", async (route) => {
      try {
        const request = route.request(); const url = new URL(request.url());
        if (url.origin === ORIGIN) return route.continue();
        assert.equal(url.origin, PROJECT, `Unexpected external request ${url.origin}`);
        const headers = {
          "access-control-allow-origin": ORIGIN, "access-control-allow-headers": "*", "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
          "access-control-expose-headers": "x-supabase-api-version", "x-supabase-api-version": "2024-01-01", "content-type": "application/json",
        };
        const respond = (data, status = 200) => route.fulfill({ status, headers, body: status === 204 ? "" : JSON.stringify(data) });
        if (request.method() === "OPTIONS") return respond({}, 204);
        const id = identity(request); const body = request.postData() ? JSON.parse(request.postData()) : null;
        requests.push({ path: url.pathname, id, body: clone(body), authorization: request.headers().authorization });
        if (url.pathname === "/auth/v1/token") {
          if (body?.password !== PASSWORD) return respond({ code: "invalid_credentials", msg: "Invalid credentials" }, 400);
          const selected = body.email === "owner@example.test" ? OWNER : MEMBER;
          return respond(session(selected, selected === MEMBER && forgedMemberMetadata));
        }
        if (url.pathname === "/auth/v1/user") return id ? respond(authUser(id, id === MEMBER && forgedMemberMetadata)) : respond({ code: "bad_jwt", msg: "Not authenticated" }, 401);
        if (url.pathname === "/auth/v1/logout") return respond({}, 204);
        if (!id || !ledgers.has(id)) return respond({ code: "42501", message: "Not authenticated" }, 403);
        if (url.pathname === "/rest/v1/rpc/moneytrail_is_admin") {
          if (missingAdmin) return respond({ code: "PGRST202", message: "Function missing" }, 404);
          return respond((id === OWNER && ownerEnabled) || (id === MEMBER && staleMemberGrant));
        }
        if (url.pathname === "/rest/v1/rpc/moneytrail_admin_overview") {
          if (missingAdmin) return respond({ code: "PGRST202", message: "Function missing" }, 404);
          if (id !== OWNER || !ownerEnabled) return respond({ code: "42501", message: "Administrator access required" }, 403);
          assert.deepEqual(Object.keys(body).sort(), ["p_page", "p_page_size", "p_query"]);
          const response = overview(body);
          if (nextOverviewGate) {
            const gate = nextOverviewGate; nextOverviewGate = null; heldOverview = true;
            await gate;
          }
          return respond(response);
        }
        if (url.pathname === "/rest/v1/moneytrail_ledgers") {
          assert.equal(url.searchParams.get("user_id"), `eq.${id}`);
          return respond([{ user_id: id, ...clone(ledgers.get(id)) }]);
        }
        if (url.pathname === "/rest/v1/rpc/save_moneytrail_ledger") {
          const current = ledgers.get(id);
          if (body.p_expected_revision !== current.revision) return respond({ code: "40001", message: "Stale revision" }, 409);
          const updated = { data: clone(body.p_data), revision: current.revision + 1, updated_at: new Date().toISOString() };
          ledgers.set(id, updated); return respond([{ user_id: id, ...updated }]);
        }
        throw Error(`Unexpected fixture endpoint ${request.method()} ${url.pathname}`);
      } catch (error) {
        if (/Target.*closed|Request.*already handled|Route.*already handled/.test(String(error))) return;
        routeErrors.push(String(error));
        try { await route.abort(); } catch {}
      }
    });
  }
  return {
    attach, requests, routeErrors, directory,
    revokeOwner() { ownerEnabled = false; },
    holdNextOverview() { nextOverviewGate = new Promise((resolve) => { releaseOverview = resolve; }); heldOverview = false; },
    releaseOverview() { releaseOverview?.(); nextOverviewGate = null; },
    get heldOverview() { return heldOverview; },
  };
}

async function ready(server, output) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw Error(`Admin dev server exited: ${output()}`);
    try { if (/ready in/i.test(output()) && (await fetch(BASE)).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw Error(`Admin dev server not ready: ${output()}`);
}
async function fixture(browser, backend, { width = 1440, admin = true, tamper = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height: width <= 393 ? 852 : 1000 }, locale: "zh-CN", timezoneId: "Asia/Shanghai", ...(width <= 393 ? { isMobile: true, hasTouch: true } : {}) });
  await backend.attach(context);
  if (tamper) await context.addInitScript(() => {
    localStorage.setItem("isAdmin", "true"); localStorage.setItem("admin", "true"); localStorage.setItem("moneytrail:admin", JSON.stringify({ role: "admin", is_admin: true }));
  });
  const page = await context.newPage(); const errors = [];
  page.on("pageerror", (error) => errors.push(error.message)); page.setDefaultTimeout(12000);
  await page.clock.setFixedTime(new Date("2026-10-22T04:30:00Z"));
  await page.goto(admin ? `${BASE}?view=admin` : BASE, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "登录我的账本", exact: true }).waitFor();
  return { page, context, errors };
}
async function login(page, email = "owner@example.test") {
  await page.getByLabel("邮箱", { exact: true }).fill(email);
  await page.getByLabel("密码", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "登录我的账本", exact: true }).click();
}
async function noOverflow(page, description) {
  const dimensions = await page.evaluate(() => ({ actual: document.documentElement.scrollWidth, viewport: innerWidth }));
  assert(dimensions.actual <= dimensions.viewport + 1, `${description} overflow: ${JSON.stringify(dimensions)}`);
}
async function noAdminStorage(page) {
  const stored = await page.evaluate(() => Object.values(localStorage).join("\n"));
  assert(!stored.includes(PRIVATE_EMAIL), "directory metadata must not be persisted to localStorage");
  assert(!stored.includes("needle@example.test"), "search results must not be persisted to localStorage");
}
function userEmail(page, email) { return page.getByText(email, { exact: true }).filter({ visible: true }).first(); }
async function until(predicate, description) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise((resolve) => setTimeout(resolve, 25)); }
  throw Error(`Timed out waiting for ${description}`);
}

async function ownerWorkflow(browser) {
  const backend = mockBackend(); const { page, context, errors } = await fixture(browser, backend);
  try {
    assert.equal(await page.getByText(PRIVATE_EMAIL, { exact: true }).count(), 0);
    await login(page);
    await page.getByRole("heading", { name: "管理后台", exact: true }).waitFor();
    await userEmail(page, PRIVATE_EMAIL).waitFor();
    await noOverflow(page, "desktop admin"); await noAdminStorage(page);
    await page.screenshot({ path: path.join(ARTIFACTS, "desktop-admin.png"), fullPage: true, animations: "disabled" });
    passed("the signed-in owner sees the server-authorized dashboard without persisting its user directory");

    await page.getByRole("button", { name: "返回账本", exact: true }).click();
    await page.locator(".hero-amount").waitFor();
    await page.getByRole("button", { name: "我的账户", exact: true }).click();
    const account = page.getByRole("dialog", { name: "我的账户", exact: true });
    await account.getByRole("button", { name: "管理员后台", exact: true }).click();
    await userEmail(page, PRIVATE_EMAIL).waitFor();
    passed("only the authorized account receives an admin entry in its account menu");

    await page.getByRole("button", { name: "下一页", exact: true }).click();
    await until(() => backend.requests.some((request) => request.path.endsWith("moneytrail_admin_overview") && request.body?.p_page === 2), "page 2 request");
    await userEmail(page, backend.directory[20].email).waitFor();
    await page.getByRole("button", { name: "上一页", exact: true }).click();
    await userEmail(page, PRIVATE_EMAIL).waitFor();
    const search = page.getByRole("searchbox");
    await search.fill("needle");
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    await userEmail(page, "needle@example.test").waitFor();
    assert.equal(await page.getByText(PRIVATE_EMAIL, { exact: true }).count(), 0);
    assert(backend.requests.some((request) => request.body?.p_query === "needle" && request.body?.p_page === 1));
    await noAdminStorage(page);
    passed("user directory pagination and explicit email search request the matching server page");

    backend.revokeOwner();
    await page.getByRole("button", { name: "刷新管理数据", exact: true }).click();
    await page.getByRole("heading", { name: "当前账户无法进入管理后台", exact: true }).waitFor();
    assert.equal(await page.getByText("needle@example.test", { exact: true }).count(), 0, "revoked metadata must disappear");
    await noAdminStorage(page);
    passed("revoking server access makes refresh discard previously visible admin metadata");
    assert.deepEqual(errors, []); assert.deepEqual(backend.routeErrors, []);
  } finally { backend.releaseOverview(); await context.close(); }
}

async function deniedWorkflow(browser) {
  const backend = mockBackend({ forgedMemberMetadata: true });
  const { page, context, errors } = await fixture(browser, backend, { tamper: true });
  try {
    await login(page, "member@example.test");
    await page.getByRole("heading", { name: "仅限管理员访问", exact: true }).waitFor();
    assert.equal(await page.getByText(PRIVATE_EMAIL, { exact: true }).count(), 0);
    assert.equal(backend.requests.filter((request) => request.path.endsWith("moneytrail_admin_overview")).length, 0, "gate must not query the directory for denied users");
    const result = await page.evaluate(async ({ project, key, bearer }) => {
      const response = await fetch(`${project}/rest/v1/rpc/moneytrail_admin_overview`, { method: "POST", headers: { apikey: key, Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" }, body: JSON.stringify({ p_query: "", p_page: 1, p_page_size: 20 }) });
      return { status: response.status, data: await response.json() };
    }, { project: PROJECT, key: PUBLIC_KEY, bearer: token(MEMBER) });
    assert.equal(result.status, 403); assert.equal(result.data.code, "42501");
    assert.equal(JSON.stringify(result.data).includes(PRIVATE_EMAIL), false);
    await noAdminStorage(page);
    passed("a direct admin URL and forged role/localStorage flags cannot grant a normal account access");
    assert.deepEqual(errors, []); assert.deepEqual(backend.routeErrors, []);
  } finally { await context.close(); }
}

async function missingMigrationWorkflow(browser) {
  const backend = mockBackend({ missingAdmin: true }); const { page, context, errors } = await fixture(browser, backend, { admin: false });
  try {
    await login(page, "member@example.test"); await page.locator(".hero-amount").waitFor();
    await page.getByRole("button", { name: "我的账户", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "我的账户", exact: true }); await dialog.waitFor();
    assert.equal(await dialog.getByRole("button", { name: "管理员后台", exact: true }).count(), 0);
    await dialog.getByRole("button", { name: "关闭账户窗口", exact: true }).click();
    await page.goto(`${BASE}?view=admin`, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "管理后台尚未启用", exact: true }).waitFor();
    assert.equal(await page.getByText(PRIVATE_EMAIL, { exact: true }).count(), 0);
    passed("a missing admin migration leaves the personal ledger usable and fails closed on the admin route");
    assert.deepEqual(errors, []); assert.deepEqual(backend.routeErrors, []);
  } finally { await context.close(); }
}

async function staleGrantWorkflow(browser) {
  const backend = mockBackend({ staleMemberGrant: true }); const { page, context, errors } = await fixture(browser, backend);
  try {
    await login(page, "member@example.test");
    await until(() => backend.requests.some((request) => request.path.endsWith("moneytrail_admin_overview")), "the freshly protected overview request");
    await page.getByRole("heading", { name: "当前账户无法进入管理后台", exact: true }).waitFor();
    assert.equal(await page.getByText(PRIVATE_EMAIL, { exact: true }).count(), 0);
    await noAdminStorage(page);
    passed("a stale UI access grant cannot bypass authorization on the overview RPC");
    assert.deepEqual(errors, []); assert.deepEqual(backend.routeErrors, []);
  } finally { await context.close(); }
}

async function staleResponseWorkflow(browser) {
  const backend = mockBackend(); const { page, context, errors } = await fixture(browser, backend);
  try {
    await login(page); await userEmail(page, PRIVATE_EMAIL).waitFor();
    backend.holdNextOverview();
    await page.getByRole("button", { name: "刷新管理数据", exact: true }).click();
    await until(() => backend.heldOverview, "held owner overview");
    assert.equal(await page.getByText(PRIVATE_EMAIL, { exact: true }).count(), 0, "refresh clears old directory before checking access");
    await page.getByRole("button", { name: /^退出/ }).click();
    await page.getByRole("button", { name: "登录我的账本", exact: true }).waitFor();
    await login(page, "member@example.test");
    await page.getByRole("heading", { name: "仅限管理员访问", exact: true }).waitFor();
    backend.releaseOverview(); await page.waitForTimeout(150);
    assert.equal(await page.getByText(PRIVATE_EMAIL, { exact: true }).count(), 0);
    await noAdminStorage(page);
    passed("a late owner response cannot show admin metadata after logout and login as another account");
    assert.deepEqual(errors, []); assert.deepEqual(backend.routeErrors, []);
  } finally { backend.releaseOverview(); await context.close(); }
}

async function mobileWorkflow(browser) {
  for (const width of [320, 393]) {
    const backend = mockBackend(); const { page, context, errors } = await fixture(browser, backend, { width });
    try {
      await login(page); await userEmail(page, PRIVATE_EMAIL).waitFor();
      await noOverflow(page, `${width}px admin dashboard`);
      await page.screenshot({ path: path.join(ARTIFACTS, `mobile-admin-${width}.png`), fullPage: true, animations: "disabled" });
      await page.getByRole("searchbox").fill("needle"); await page.getByRole("button", { name: "搜索", exact: true }).click();
      await userEmail(page, "needle@example.test").waitFor();
      await noOverflow(page, `${width}px admin search`); await noAdminStorage(page);
      assert.deepEqual(errors, []); assert.deepEqual(backend.routeErrors, []);
      passed(`${width}px admin dashboard and search fit without horizontal overflow`);
    } finally { await context.close(); }
  }
}

(async () => {
  await mkdir(ARTIFACTS, { recursive: true });
  let output = "";
  const server = spawn("npm", ["run", "dev", "--", "--port", String(PORT)], { cwd: ROOT, detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, MONEYTRAIL_BASE_PATH: "/Moneytrail-/", VITE_SUPABASE_URL: PROJECT, VITE_SUPABASE_PUBLISHABLE_KEY: PUBLIC_KEY, VITE_SUPABASE_ANON_KEY: "" } });
  server.stdout.on("data", (chunk) => { output += chunk; }); server.stderr.on("data", (chunk) => { output += chunk; });
  let browser;
  try {
    await ready(server, () => output);
    browser = await chromium.launch({ headless: true, ...(process.env.MONEYTRAIL_CHROMIUM_PATH ? { executablePath: process.env.MONEYTRAIL_CHROMIUM_PATH } : {}), args: ["--no-sandbox"] });
    await ownerWorkflow(browser); await deniedWorkflow(browser); await missingMigrationWorkflow(browser); await staleGrantWorkflow(browser); await staleResponseWorkflow(browser); await mobileWorkflow(browser);
    process.stdout.write(`\n${checks} admin browser checks passed using intercepted fixture responses. Hosted owner binding, authentication and JWT verification remain separate.\n`);
  } catch (error) { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; }
  finally { if (browser) await browser.close(); if (server.pid) try { process.kill(-server.pid, "SIGTERM"); } catch {} }
})();
