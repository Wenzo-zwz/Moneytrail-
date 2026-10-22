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
const BOOK = {
  version: 1, budgetCents: 50000, billCheckedMonths: ["2026-09"],
  transactions: [{ id: "update-preserved", kind: "expense", amountCents: 1234, date: "2026-10-22T12:30", merchant: "更新前已保存的消费", category: "餐饮", source: "manual", note: "保留预算及原账目" }],
};
const types = { ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".css": "text/css", ".json": "application/json", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png" };

(async () => {
  let stage; let server; let browser;
  try {
    const html = await readFile(path.join(ROOT, "dist", "index.html"), "utf8");
    assert(html.includes('src="/assets/'), "Build the root-path device-only production site before running this check.");
    stage = await mkdtemp(path.join(os.tmpdir(), "moneytrail-update-"));
    await cp(path.join(ROOT, "dist"), stage, { recursive: true });
    server = http.createServer(async (request, response) => {
      try {
        const pathname = decodeURIComponent(new URL(request.url, ORIGIN).pathname);
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

    page.once("dialog", async dialog => { assert.match(dialog.message(), /保存正在填写的记录/); await dialog.dismiss(); });
    await page.getByRole("button", { name: "更新并重新打开", exact: true }).click();
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
    assert.deepEqual(errors, []);
    process.stdout.write("PASS accepting the update activates the worker and reloads while retaining saved records and budget\n");
    process.stdout.write("PASS activation in another tab preserves that tab's unsaved draft until its own explicit update\n\n4 production update browser checks passed. Chromium mobile emulation; real iPhone remains separate.\n");
    await context.close();
  } catch (error) { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; }
  finally {
    if (browser) await browser.close();
    if (server) await new Promise(resolve => server.close(resolve));
    if (stage) await rm(stage, { recursive: true, force: true });
  }
})();
