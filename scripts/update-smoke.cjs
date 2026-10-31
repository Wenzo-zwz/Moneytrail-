/* Real production service-worker update lifecycle against an isolated dist copy.
 * Build in device-only mode first. This does not exercise Safari or a real iPhone.
 */
const assert = require("node:assert/strict");
const http = require("node:http");
const { mkdtemp, cp, readFile, appendFile, rm, mkdir } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..");
const PORT = Number(process.env.MONEYTRAIL_UPDATE_SMOKE_PORT || 4188);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const KEY = "moneytrail:v1";
const DRAFT = "未保存的短信草稿，更新前请保留";
const CACHE = "moneytrail-update-preserved";
const CACHE_ENTRY = "/update-preserved-cache-entry";
const CACHE_CONTENT = "existing offline cache content";
const BOOK = {
  version: 1, budgetCents: 50000, billCheckedMonths: ["2026-09"],
  transactions: [{ id: "update-preserved", kind: "expense", amountCents: 1234, date: "2026-10-22T12:30", merchant: "更新前已保存的消费", category: "本地生活", subcategory: "餐饮", source: "manual", note: "保留预算及原账目" }],
};
const types = { ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".css": "text/css", ".json": "application/json", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png" };

(async () => {
  let stage; let server; let browser; let workerRequests = 0;
  let installGate; let releaseInstall;
  try {
    const html = await readFile(path.join(ROOT, "dist", "index.html"), "utf8");
    assert(html.includes('src="/assets/'), "Build the root-path device-only production site before running this check.");
    stage = await mkdtemp(path.join(os.tmpdir(), "moneytrail-update-"));
    await cp(path.join(ROOT, "dist"), stage, { recursive: true });
    server = http.createServer(async (request, response) => {
      try {
        const pathname = decodeURIComponent(new URL(request.url, ORIGIN).pathname);
        if (pathname === "/sw.js") workerRequests += 1;
        if (pathname === "/update-install-gate") {
          await installGate;
          response.writeHead(204); response.end(); return;
        }
        const filename = path.resolve(stage, `.${pathname === "/" ? "/index.html" : pathname}`);
        if (!filename.startsWith(`${stage}${path.sep}`)) { response.writeHead(403); response.end(); return; }
        const body = await readFile(filename);
        response.writeHead(200, { "content-type": types[path.extname(filename)] || "application/octet-stream", "cache-control": "no-store" });
        response.end(body);
      } catch { response.writeHead(404); response.end(); }
    });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(PORT, "127.0.0.1", resolve); });
    browser = await chromium.launch({ headless: true, ...(process.env.MONEYTRAIL_CHROMIUM_PATH ? { executablePath: process.env.MONEYTRAIL_CHROMIUM_PATH } : {}), args: ["--no-sandbox"] });
    const context = await browser.newContext({ viewport: { width: 393, height: 852 }, locale: "zh-CN", timezoneId: "Asia/Shanghai", isMobile: true, hasTouch: true });
    const page = await context.newPage(); const errors = [];
    page.on("pageerror", error => errors.push(error.message)); page.setDefaultTimeout(15000);
    await page.clock.setFixedTime(new Date("2026-10-22T04:30:00Z"));
    await page.goto(ORIGIN, { waitUntil: "networkidle" });
    await page.locator(".hero-amount").waitFor();
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });
    await page.evaluate(({ key, book }) => localStorage.setItem(key, JSON.stringify(book)), { key: KEY, book: BOOK });
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
    await page.locator(".hero-amount").waitFor();
    await page.locator(".mobile-nav").getByRole("button", { name: "设置", exact: true }).click();
    const settings = page.locator("section").filter({ has: page.getByRole("heading", { name: "应用更新", exact: true }) });
    const requestsBeforeCheck = workerRequests;
    await settings.getByRole("button", { name: "检查更新", exact: true }).click();
    await settings.getByText("当前已是最新版本。", { exact: true }).waitFor();
    assert(workerRequests > requestsBeforeCheck, "The settings check must actually request the production worker script.");
    assert.equal(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length), 1);
    process.stdout.write("PASS settings can explicitly check the existing production registration and report the current version\n");

    await context.setOffline(true);
    await settings.getByRole("button", { name: "检查更新", exact: true }).click();
    await settings.getByRole("alert").waitFor();
    assert.equal(await settings.getByText("当前已是最新版本。", { exact: true }).count(), 0);
    assert.match(await settings.getByRole("alert").innerText(), /离线|联网|网络|失败|未能/);
    await context.setOffline(false);
    process.stdout.write("PASS an offline settings check reports the failure without claiming the app is current\n");

    await page.locator(".mobile-nav").getByRole("button", { name: "录入", exact: true }).click();
    const draft = page.getByLabel("银行消费短信", { exact: true });
    await draft.fill(DRAFT);
    await page.evaluate(() => { window.__moneytrailUpdateDocument = "original-document"; });
    const other = await context.newPage();
    other.on("pageerror", error => errors.push(error.message));
    await other.goto(ORIGIN, { waitUntil: "networkidle" });
    await other.locator(".hero-amount").waitFor();
    await other.locator(".mobile-nav").getByRole("button", { name: "录入", exact: true }).click();
    const otherDraft = other.getByLabel("银行消费短信", { exact: true });
    await otherDraft.fill(`${DRAFT}（另一标签页）`);
    await other.evaluate(() => { window.__moneytrailUpdateDocument = "other-document"; });

    // Change only the staged worker script. Its real install/activate lifecycle
    // must wait while the existing controlled page retains its in-memory input.
    await appendFile(path.join(stage, "sw.js"), `\n// Production update fixture ${Date.now()}\n`);
    await page.evaluate(async () => { const registration = await navigator.serviceWorker.getRegistration(); await registration.update(); });
    await page.getByRole("heading", { name: "发现新版本", exact: true }).waitFor();
    await page.waitForFunction(async () => Boolean((await navigator.serviceWorker.getRegistration()).waiting));
    assert.equal(await draft.inputValue(), DRAFT);
    assert.equal(await page.evaluate(() => window.__moneytrailUpdateDocument), "original-document");
    assert.deepEqual(await page.evaluate(key => JSON.parse(localStorage.getItem(key)), KEY), BOOK);
    const dimensions = await page.evaluate(() => ({ actual: document.documentElement.scrollWidth, viewport: innerWidth }));
    assert(dimensions.actual <= dimensions.viewport + 1, "Mobile update notice must not cause horizontal overflow.");
    await mkdir(path.join(ROOT, "test-results", "update"), { recursive: true });
    await page.screenshot({ path: path.join(ROOT, "test-results", "update", "waiting-update-393.png"), animations: "disabled" });
    process.stdout.write("PASS a real waiting worker shows an update notice without reloading or losing an unsaved draft\n");

    let globalConfirmation;
    page.once("dialog", async dialog => { globalConfirmation = dialog.message(); await dialog.dismiss(); });
    await page.getByRole("button", { name: "更新并重新打开", exact: true }).click();
    assert.match(globalConfirmation, /保存正在填写的记录/);
    assert.equal(await draft.inputValue(), DRAFT);
    assert.equal(await page.evaluate(() => window.__moneytrailUpdateDocument), "original-document");
    assert.equal(await page.evaluate(async () => Boolean((await navigator.serviceWorker.getRegistration()).waiting)), true);
    process.stdout.write("PASS declining the explicit update confirmation preserves the current document and draft\n");

    page.once("dialog", dialog => dialog.accept());
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle" }),
      page.getByRole("button", { name: "更新并重新打开", exact: true }).click(),
    ]);
    await page.locator(".hero-amount").waitFor();
    assert.equal(await page.evaluate(() => window.__moneytrailUpdateDocument), undefined);
    assert.deepEqual(await page.evaluate(key => JSON.parse(localStorage.getItem(key)), KEY), BOOK);
    assert.match(await page.locator(".hero-amount").innerText(), /12\.34/);
    await other.getByRole("heading", { name: "发现新版本", exact: true }).waitFor();
    assert.equal(await otherDraft.inputValue(), `${DRAFT}（另一标签页）`);
    assert.equal(await other.evaluate(() => window.__moneytrailUpdateDocument), "other-document");
    other.once("dialog", dialog => dialog.accept());
    await Promise.all([
      other.waitForNavigation({ waitUntil: "networkidle" }),
      other.getByRole("button", { name: "更新并重新打开", exact: true }).click(),
    ]);
    await other.locator(".hero-amount").waitFor();
    assert.equal(await other.evaluate(() => window.__moneytrailUpdateDocument), undefined);
    process.stdout.write("PASS accepting the update activates the worker and reloads while retaining saved records and budget\n");
    process.stdout.write("PASS activation in another tab preserves that tab's unsaved draft until its own explicit update\n");
    await other.close();

    await page.locator(".mobile-nav").getByRole("button", { name: "设置", exact: true }).click();
    await page.evaluate(async ({ cache, entry, content }) => {
      await (await caches.open(cache)).put(entry, new Response(content));
      window.__moneytrailUpdateDocument = "settings-document";
    }, { cache: CACHE, entry: CACHE_ENTRY, content: CACHE_CONTENT });
    const cacheNamesBeforeUpdate = await page.evaluate(async () => (await caches.keys()).sort());
    assert(cacheNamesBeforeUpdate.some(name => name.includes("precache")), "The production offline cache must already exist.");

    // Hold an actual worker in its install lifecycle. registration.update()
    // resolves before installation settles, so the UI must keep checking.
    installGate = new Promise(resolve => { releaseInstall = resolve; });
    await appendFile(path.join(stage, "sw.js"), `
self.addEventListener("install", event => event.waitUntil(fetch("/update-install-gate", { cache: "no-store" })));
self.addEventListener("message", event => {
  if (event.data === "moneytrail-update-smoke-version") event.ports[0]?.postMessage("settings-update-fixture");
});
`);
    await settings.getByRole("button", { name: "检查更新", exact: true }).click();
    await page.waitForFunction(async () => (await navigator.serviceWorker.getRegistration()).installing?.state === "installing");
    assert.equal(await settings.getByText("当前已是最新版本。", { exact: true }).count(), 0);
    assert.equal(await settings.getByRole("button", { name: /检查/ }).isDisabled(), true);
    releaseInstall();
    await page.waitForFunction(async () => Boolean((await navigator.serviceWorker.getRegistration()).waiting));
    await settings.getByRole("button", { name: "更新并重新打开", exact: true }).waitFor();
    await page.getByRole("heading", { name: "发现新版本", exact: true }).waitFor();
    await page.getByRole("button", { name: "本次稍后", exact: true }).click();
    assert.equal(await page.getByRole("heading", { name: "发现新版本", exact: true }).count(), 0);
    await settings.getByRole("button", { name: "检查更新", exact: true }).click();
    await settings.getByRole("button", { name: "更新并重新打开", exact: true }).waitFor();
    assert.equal(await settings.getByText("当前已是最新版本。", { exact: true }).count(), 0);
    assert.equal(await page.getByRole("heading", { name: "发现新版本", exact: true }).count(), 0);
    assert.equal(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length), 1);
    await settings.scrollIntoViewIfNeeded();
    const settingsDimensions = await page.evaluate(() => ({ actual: document.documentElement.scrollWidth, viewport: innerWidth }));
    assert(settingsDimensions.actual <= settingsDimensions.viewport + 1, "The settings update controls must not cause mobile horizontal overflow.");
    await page.screenshot({ path: path.join(ROOT, "test-results", "update", "settings-update-393.png"), animations: "disabled" });
    process.stdout.write("PASS settings waits for real worker installation and keeps updates available after dismissing the global notice\n");

    let settingsConfirmation;
    page.once("dialog", async dialog => { settingsConfirmation = dialog.message(); await dialog.dismiss(); });
    await settings.getByRole("button", { name: "更新并重新打开", exact: true }).click();
    assert.match(settingsConfirmation, /保存正在填写的记录/);
    assert.equal(settingsConfirmation, globalConfirmation);
    assert.equal(await page.evaluate(() => window.__moneytrailUpdateDocument), "settings-document");
    assert.equal(await page.evaluate(async () => Boolean((await navigator.serviceWorker.getRegistration()).waiting)), true);
    assert.deepEqual(await page.evaluate(key => JSON.parse(localStorage.getItem(key)), KEY), BOOK);
    assert.equal(await page.evaluate(async ({ cache, entry }) => (await (await caches.open(cache)).match(entry)).text(), { cache: CACHE, entry: CACHE_ENTRY }), CACHE_CONTENT);
    process.stdout.write("PASS declining the settings update confirmation retains the document, saved book and offline cache\n");

    page.once("dialog", dialog => dialog.accept());
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle" }),
      settings.getByRole("button", { name: "更新并重新打开", exact: true }).click(),
    ]);
    await page.locator(".hero-amount").waitFor();
    assert.equal(await page.evaluate(() => window.__moneytrailUpdateDocument), undefined);
    assert.deepEqual(await page.evaluate(key => JSON.parse(localStorage.getItem(key)), KEY), BOOK);
    assert.match(await page.locator(".hero-amount").innerText(), /12\.34/);
    assert.equal(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length), 1);
    assert.deepEqual(await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      return { waiting: Boolean(registration.waiting), active: registration.active?.state, controller: navigator.serviceWorker.controller?.state };
    }), { waiting: false, active: "activated", controller: "activated" });
    const activeWorkerVersion = await page.evaluate(() => new Promise((resolve, reject) => {
      const channel = new MessageChannel();
      const timeout = setTimeout(() => { channel.port1.close(); reject(new Error("The accepted update must control the reopened page.")); }, 5000);
      channel.port1.onmessage = event => { clearTimeout(timeout); channel.port1.close(); resolve(event.data); };
      navigator.serviceWorker.controller.postMessage("moneytrail-update-smoke-version", [channel.port2]);
    }));
    assert.equal(activeWorkerVersion, "settings-update-fixture");
    assert.equal(await page.evaluate(async ({ cache, entry }) => (await (await caches.open(cache)).match(entry)).text(), { cache: CACHE, entry: CACHE_ENTRY }), CACHE_CONTENT);
    const cacheNamesAfterUpdate = await page.evaluate(async () => await caches.keys());
    assert(cacheNamesBeforeUpdate.every(name => cacheNamesAfterUpdate.includes(name)), "Settings updates must retain existing offline caches.");
    assert.deepEqual(errors, []);
    process.stdout.write("PASS accepting the settings confirmation updates the shared worker and reopens without deleting saved records or caches\n\n9 production update browser checks passed. Chromium mobile emulation; real iPhone remains separate.\n");
    await context.close();
  } catch (error) { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; }
  finally {
    if (releaseInstall) releaseInstall();
    if (browser) await browser.close();
    if (server) await new Promise(resolve => server.close(resolve));
    if (stage) await rm(stage, { recursive: true, force: true });
  }
})();
