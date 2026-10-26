/* Production-browser smoke checks. Build first: npm run build && npm run test:e2e. */
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { readFile, readdir, mkdir } = require("node:fs/promises");
const path = require("node:path");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..");
const PORT = Number(process.env.MONEYTRAIL_SMOKE_PORT || 4183);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const baseSegments = (process.env.MONEYTRAIL_BASE_PATH || "/")
  .split("/")
  .filter(Boolean);
const BASE_PATH = baseSegments.length ? `/${baseSegments.join("/")}/` : "/";
const BASE = new URL(BASE_PATH, ORIGIN).href;
const KEY = "moneytrail:v1";
const ARTIFACTS = path.join(ROOT, "test-results");
let checks = 0;
const passed = (name) => {
  checks++;
  process.stdout.write(`PASS ${name}\n`);
};

async function ready(server, output) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null)
      throw new Error(`Preview process exited: ${output()}`);
    try {
      const response = await fetch(BASE);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Preview server did not become ready: ${output()}`);
}

async function data(page) {
  return page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key) || '{"transactions":[]}'),
    KEY,
  );
}

async function countIs(page, expected) {
  await page.waitForFunction(
    ({ key, count }) => {
      try {
        return (
          JSON.parse(localStorage.getItem(key) || '{"transactions":[]}')
            .transactions.length === count
        );
      } catch {
        return false;
      }
    },
    { key: KEY, count: expected },
  );
}

async function go(page, label, mobile = false) {
  const nav = page.locator(mobile ? ".mobile-nav" : ".sidebar-nav");
  await nav.getByRole("button", { name: new RegExp(`^${label}`) }).click();
}

async function noOverflow(page, where) {
  const dimensions = await page.evaluate(() => ({
    body: document.documentElement.scrollWidth,
    viewport: innerWidth,
  }));
  assert(
    dimensions.body <= dimensions.viewport + 1,
    `${where}: horizontal overflow ${JSON.stringify(dimensions)}`,
  );
}

async function money(page, selector, expected) {
  const value = await page.locator(selector).textContent();
  const parsed = Number(
    value
      .replaceAll(",", "")
      .replaceAll("−", "-")
      .replace(/[^\d.-]/g, ""),
  );
  assert.equal(parsed, expected, `${selector}: ${value}`);
}

async function addManual(page, values = {}) {
  await page.getByRole("button", { name: "记一笔", exact: true }).click();
  const modal = page.getByRole("dialog");
  await modal
    .getByLabel("类型", { exact: true })
    .selectOption(values.kind || "expense");
  await modal
    .getByLabel("金额（元）", { exact: true })
    .fill(values.amount || "38.50");
  await modal
    .getByLabel("商户 / 对方", { exact: true })
    .fill(values.merchant || "测试餐厅");
  await modal
    .getByLabel("发生时间", { exact: true })
    .fill(values.date || "2026-10-22T12:30");
  await modal
    .getByLabel("分类", { exact: true })
    .selectOption(values.category || "本地生活");
  if (values.linkedTransactionId)
    await modal
      .getByLabel("关联原消费（可选）")
      .selectOption(values.linkedTransactionId);
  await modal.getByRole("button", { name: "确认保存", exact: true }).click();
  await modal.waitFor({ state: "detached" });
}

async function fixture(browser, mobile = false) {
  const context = await browser.newContext({
    viewport: mobile
      ? { width: 390, height: 844 }
      : { width: 1440, height: 1000 },
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    ...(mobile ? { isMobile: true, hasTouch: true, deviceScaleFactor: 1 } : {}),
    acceptDownloads: true,
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.setDefaultTimeout(10000);
  await page.clock.setFixedTime(new Date("2026-10-22T04:30:00Z"));
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.getByRole("heading", { level: 1 }).waitFor();
  await page.locator("#month").fill("2026-10");
  return { page, context, errors };
}

async function fullWorkflow(browser) {
  const { page, context, errors } = await fixture(browser);
  try {
    assert.equal((await data(page)).transactions.length, 0);
    await money(page, ".hero-amount", 0);
    await noOverflow(page, "desktop initial dashboard");
    passed("desktop initial empty state without fake transactions");

    await addManual(page);
    await countIs(page, 1);
    const original = (await data(page)).transactions[0];
    await addManual(page, {
      kind: "refund",
      amount: "8.50",
      merchant: "测试餐厅退款",
      date: "2026-10-22T13:00",
      linkedTransactionId: original.id,
    });
    await addManual(page, {
      kind: "transfer",
      amount: "100",
      merchant: "测试信用卡还款",
      category: "其他",
      date: "2026-10-22T13:10",
    });
    await countIs(page, 3);
    await money(page, ".hero-amount", 30);
    assert.equal(
      (await data(page)).transactions.find((t) => t.kind === "refund")
        .linkedTransactionId,
      original.id,
    );
    passed(
      "manual expense, linked refund, and repayment produce net spending 30.00",
    );

    await page.getByRole("button", { name: "设置月预算", exact: true }).click();
    await page.getByLabel("每月计划花费（元）").fill("1000");
    await page.getByRole("button", { name: "保存预算", exact: true }).click();
    await page.waitForFunction(
      (key) => JSON.parse(localStorage.getItem(key)).budgetCents === 100000,
      KEY,
    );
    assert.match(await page.locator(".budget-note").textContent(), /970\.00/);
    await page.reload({ waitUntil: "networkidle" });
    await countIs(page, 3);
    await money(page, ".hero-amount", 30);
    passed("budget remaining amount and reload persistence");

    await go(page, "录入");
    const sms =
      "【测试银行】您尾号1234的账户于2026年10月22日13:30在测试咖啡店消费人民币19.90元，余额999.99元。";
    await page.getByLabel("银行消费短信", { exact: true }).fill(sms);
    await page.getByRole("button", { name: "识别短信", exact: true }).click();
    await page.locator(".preview-card").waitFor();
    assert.match(
      await page.locator(".preview-card-header").textContent(),
      /19\.90/,
    );
    assert.doesNotMatch(
      await page.locator(".preview-card-header").textContent(),
      /999\.99/,
    );
    assert.equal(
      (await data(page)).transactions.length,
      3,
      "parsing alone must not write",
    );
    await page
      .getByRole("button", { name: "确认保存 1 笔", exact: true })
      .click();
    await countIs(page, 4);
    await page.getByLabel("银行消费短信", { exact: true }).fill(sms);
    await page.getByRole("button", { name: "识别短信", exact: true }).click();
    await page.locator(".preview-card").waitFor();
    assert.equal(
      await page.locator('.preview-card input[type="checkbox"]').isChecked(),
      false,
    );
    assert.match(await page.locator(".preview-card").textContent(), /疑似重复/);
    assert.equal(
      await page
        .getByRole("button", { name: "确认保存 0 笔", exact: true })
        .isDisabled(),
      true,
    );
    await page
      .getByRole("button", { name: "清空待确认记录", exact: true })
      .click();
    passed(
      "SMS extracts transaction amount, requires confirmation, and warns on duplicate",
    );

    const csv =
      "\uFEFF日期,类型,金额,商户,分类,备注,交易编号\r\n2026-10-22 15:30,支出,88.80,测试超市,购物,家庭日用品,smoke-001\r\n";
    await page.getByRole("tab", { name: "导入账单", exact: true }).click();
    const upload = {
      name: "smoke.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(csv),
    };
    await page
      .getByLabel("选择 CSV 账单文件", { exact: true })
      .setInputFiles(upload);
    await page.locator(".preview-card").waitFor();
    assert.match(
      await page.locator(".preview-card-header").textContent(),
      /88\.80/,
    );
    await page
      .getByRole("button", { name: "确认保存 1 笔", exact: true })
      .click();
    await countIs(page, 5);
    await page
      .getByLabel("选择 CSV 账单文件", { exact: true })
      .setInputFiles(upload);
    await page
      .getByText("已跳过 1 条具有相同来源交易编号的记录。", { exact: true })
      .waitFor();
    assert.equal(await page.locator(".preview-card").count(), 0);
    await countIs(page, 5);
    passed("CSV confirmation and stable-ID repeat-import protection");

    await go(page, "设置");
    const downloadPromise = page.waitForEvent("download");
    await page
      .getByRole("button", { name: "导出完整备份", exact: true })
      .click();
    const backup = await downloadPromise;
    const backupText = await readFile(await backup.path(), "utf8");
    const parsedBackup = JSON.parse(backupText);
    assert.equal(parsedBackup.transactions.length, 5);
    assert.equal(parsedBackup.budgetCents, 100000);
    await page
      .getByLabel("选择 JSON 备份文件", { exact: true })
      .setInputFiles({
        name: "broken.json",
        mimeType: "application/json",
        buffer: Buffer.from("{broken"),
      });
    await page.getByText(/无法读取 JSON 备份/).waitFor();
    assert.deepEqual(
      (await data(page)).transactions,
      parsedBackup.transactions,
    );
    passed(
      "downloaded complete JSON backup and invalid restore preserves original data",
    );

    await addManual(page, {
      amount: "12.34",
      merchant: "恢复前临时记录",
      date: "2026-10-22T16:45",
    });
    await countIs(page, 6);
    page.once("dialog", (dialog) => dialog.accept());
    await page
      .getByLabel("选择 JSON 备份文件", { exact: true })
      .setInputFiles({
        name: "backup.json",
        mimeType: "application/json",
        buffer: Buffer.from(backupText),
      });
    await countIs(page, 5);
    assert.deepEqual(await data(page), parsedBackup);
    passed(
      "confirmed backup restore round-trip preserves records, budget and refund link",
    );

    await go(page, "账目");
    page.once("dialog", (dialog) => dialog.dismiss());
    await page
      .getByRole("button", { name: "删除测试咖啡店", exact: true })
      .click();
    await countIs(page, 5);
    page.once("dialog", (dialog) => dialog.accept());
    await page
      .getByRole("button", { name: "删除测试咖啡店", exact: true })
      .click();
    await countIs(page, 4);
    await noOverflow(page, "desktop populated transactions");
    passed(
      "deletion requires confirmation and canceled deletion preserves record",
    );

    await go(page, "总览");
    await page.screenshot({
      path: path.join(ARTIFACTS, "desktop-dashboard.png"),
      fullPage: true,
      animations: "disabled",
    });
    const registration = await page.evaluate(async () => {
      const worker = await navigator.serviceWorker.ready;
      return {
        scope: new URL(worker.scope).pathname,
        script: new URL(worker.active.scriptURL).pathname,
      };
    });
    assert.equal(registration.scope, BASE_PATH, "service worker scope must match hosting prefix");
    assert.equal(registration.script, `${BASE_PATH}sw.js`, "service worker script must remain under hosting prefix");
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForFunction(() =>
      Boolean(navigator.serviceWorker.controller),
    );
    await context.setOffline(true);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { level: 1 }).waitFor();
    assert.equal(await page.evaluate(() => location.pathname), BASE_PATH, "offline reload must preserve hosting prefix");
    await countIs(page, 4);
    await addManual(page, {
      amount: "6.50",
      merchant: "离线早餐",
      date: "2026-10-22T17:30",
    });
    await countIs(page, 5);
    await page.reload({ waitUntil: "domcontentloaded" });
    await countIs(page, 5);
    assert(
      (await data(page)).transactions.some((t) => t.merchant === "离线早餐"),
    );
    await context.setOffline(false);
    passed(
      "production service worker supports offline reload, editing and persistence",
    );
    assert.deepEqual(errors, [], "browser must not throw uncaught page errors");
  } finally {
    await context.close();
  }
}

async function mobileWorkflow(browser) {
  const { page, context, errors } = await fixture(browser, true);
  try {
    await noOverflow(page, "mobile initial dashboard");
    await page.screenshot({
      path: path.join(ARTIFACTS, "mobile-dashboard.png"),
      fullPage: true,
      animations: "disabled",
    });
    for (const label of ["录入", "账目", "设置", "总览"]) {
      await go(page, label, true);
      await noOverflow(page, `mobile ${label}`);
    }
    await addManual(page, { merchant: "手机端午餐" });
    await countIs(page, 1);
    await money(page, ".hero-amount", 38.5);
    await go(page, "账目", true);
    await noOverflow(page, "mobile populated transactions");
    assert.equal(
      await page
        .getByRole("button", { name: "编辑手机端午餐", exact: true })
        .isVisible(),
      true,
    );
    await page.screenshot({
      path: path.join(ARTIFACTS, "mobile-transactions.png"),
      fullPage: true,
      animations: "disabled",
    });
    assert.deepEqual(errors, []);
    passed(
      "390px mobile navigation, manual entry, visible edit controls and no overflow",
    );
  } finally {
    await context.close();
  }
}

async function localLifeDetailsAndEvidence(browser) {
  for (const mobile of [false, true]) {
    const { page, context, errors } = await fixture(browser, mobile);
    try {
      await go(page, "录入", mobile);
      await page.getByLabel("银行消费短信", { exact: true }).fill("尾号7890卡10月22日19:27支出(消费美团支付-美团北京三快在线科技有限公司)30.90元，余额12,345.94元。【工商银行】");
      await page.getByRole("button", { name: "识别短信", exact: true }).click();
      await page.getByRole("button", { name: "修改信息", exact: true }).click();
      let editor = page.getByRole("dialog");
      await editor.getByLabel("细类（可选）", { exact: true }).fill("堂食");
      await editor.getByRole("button", { name: "确认保存", exact: true }).click();
      await page.getByRole("button", { name: "确认保存 1 笔", exact: true }).click();
      await countIs(page, 1);
      const captured = (await data(page)).transactions[0];
      assert.equal(captured.category, "本地生活"); assert.equal(captured.subcategory, "堂食"); assert.equal(captured.platform, "美团");
      assert(captured.smsEvidence?.text); assert(!captured.smsEvidence.text.includes("7890")); assert(!captured.smsEvidence.text.includes("12,345.94"));
      await addManual(page, { merchant: "用途未细分", amount: "10.00" });
      await addManual(page, { kind: "refund", merchant: "本次退款", amount: "5.00", linkedTransactionId: captured.id });
      await go(page, "总览", mobile);
      const group = page.locator(".category-group").filter({ has: page.getByText("本地生活", { exact: true }) });
      await group.locator("summary").click();
      assert.match(await group.textContent(), /堂食/); assert.match(await group.textContent(), /未细分/);
      const parent = Number(await group.locator("summary").getAttribute("data-amount-cents"));
      const details = await group.locator(".subcategory-row").evaluateAll(rows => rows.reduce((sum, row) => sum + Number(row.dataset.amountCents), 0));
      assert.equal(details, parent); assert.equal(parent, 3590);
      await go(page, "账目", mobile);
      await page.getByPlaceholder("搜索商户、备注…").fill("堂食");
      assert.equal(await page.locator(".transaction-row").count(), 2);
      await page.getByPlaceholder("搜索商户、备注…").fill("美团");
      await page.getByRole("button", { name: `编辑${captured.merchant}`, exact: true }).click();
      editor = page.getByRole("dialog");
      await editor.getByText("查看脱敏短信凭据", { exact: true }).click();
      const evidence = await editor.locator(".sms-evidence").textContent();
      assert.match(evidence, /工商银行/); assert(!evidence.includes("7890")); assert(!evidence.includes("12,345.94"));
      await page.screenshot({ path: path.join(ARTIFACTS, `local-life-evidence-${mobile ? 390 : 1440}.png`), fullPage: true, animations: "disabled" });
      await editor.getByLabel("备注（可选）", { exact: true }).fill("保留凭据");
      await editor.getByRole("button", { name: "确认保存", exact: true }).click();
      await page.reload({ waitUntil: "networkidle" });
      const saved = (await data(page)).transactions.find(t => t.id === captured.id);
      assert.deepEqual(saved.smsEvidence, captured.smsEvidence); assert.equal(saved.subcategory, "堂食");
      assert.equal((await data(page)).transactions.find(t => t.merchant === "本次退款").smsEvidence, undefined, "refund must not copy original evidence");
      await go(page, "设置", mobile);
      const backupDownload = page.waitForEvent("download");
      await page.getByRole("button", { name: "导出完整备份", exact: true }).click();
      const downloaded = await backupDownload;
      const backup = JSON.parse(await readFile(await downloaded.path(), "utf8"));
      assert.deepEqual(backup.transactions.find(t => t.id === captured.id).smsEvidence, captured.smsEvidence);
      await noOverflow(page, `${mobile ? 390 : 1440}px local life details`);
      assert.deepEqual(errors, []);
      passed(`${mobile ? 390 : 1440}px detail edit/search/stat sums, masked evidence and refund metadata survive refresh`);
    } finally { await context.close(); }
  }
}

async function refundRelinkDatabaseRegression(browser) {
  const { PGlite } = require("@electric-sql/pglite");
  const db = new PGlite();
  const owner = "11111111-1111-4111-8111-111111111111";
  let context;
  try {
    await db.exec(`create role anon nologin; create role authenticated nologin; create schema auth;
      create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz,deleted_at timestamptz);
      create function auth.uid() returns uuid language sql stable as $$select (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid$$;
      grant usage on schema public,auth to anon,authenticated;`);
    const migrations = path.join(ROOT, "supabase", "migrations");
    for (const name of (await readdir(migrations)).filter(name => name.endsWith(".sql")).sort()) {
      await db.exec(await readFile(path.join(migrations, name), "utf8"));
    }
    await db.query("insert into auth.users values ($1,'fixture@invalid',now(),null,null)", [owner]);
    await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ sub: owner })]);
    for (const mobile of [false, true]) {
      const fixtureResult = await fixture(browser, mobile);
      const { page, errors } = fixtureResult;
      context = fixtureResult.context;
      const original = { id: "unknown-original", kind: "expense", amountCents: 2000, date: "2026-10-22T12:30", merchant: "无细类原消费", category: "购物", source: "manual", note: "", smsEvidence: { text: "原消费自己的凭据" } };
      const refund = { ...original, id: "relinked-refund", kind: "refund", amountCents: 500, merchant: "已有退款", category: "本地生活", subcategory: "按摩足疗", platform: "美团", smsEvidence: { text: "退款自己的凭据" } };
      const initial = { version: 1, budgetCents: 0, billCheckedMonths: [], transactions: [refund, original] };
      await db.exec("delete from public.moneytrail_ledgers");
      await db.query("select public.save_moneytrail_ledger($1::jsonb,0)", [initial]);
      await page.evaluate(({ key, initial }) => localStorage.setItem(key, JSON.stringify(initial)), { key: KEY, initial });
      await page.reload({ waitUntil: "networkidle" });
      await go(page, "账目", mobile);
      await page.getByRole("button", { name: "编辑已有退款", exact: true }).click();
      let editor = page.getByRole("dialog");
      await editor.getByLabel("关联原消费（可选）").selectOption(original.id);
      await editor.getByRole("button", { name: "确认保存", exact: true }).click();
      await editor.waitFor({ state: "detached" });
      const incoming = await data(page);
      const incomingRefund = incoming.transactions.find(entry => entry.id === refund.id);
      assert.equal(incomingRefund.category, "购物");
      assert.equal(incomingRefund.subcategory, undefined);
      assert.equal(incomingRefund.platform, undefined);
      // Run the exact serialized UI snapshot through the production SQL save, including old-client preservation.
      const saved = (await db.query("select row_to_json(saved) saved from public.save_moneytrail_ledger($1::jsonb,1) saved", [incoming])).rows[0].saved;
      assert.deepEqual(saved.data.transactions.find(entry => entry.id === refund.id), incomingRefund, "SQL must retain the editor's deliberate inheritance of missing original metadata");
      assert.deepEqual(saved.data.transactions.find(entry => entry.id === refund.id).smsEvidence, refund.smsEvidence, "refund keeps only its own receipt");
      await page.evaluate(({ key, saved }) => localStorage.setItem(key, JSON.stringify(saved)), { key: KEY, saved: saved.data });
      await page.reload({ waitUntil: "networkidle" });
      await go(page, "账目", mobile);
      await page.getByRole("button", { name: "编辑已有退款", exact: true }).click();
      editor = page.getByRole("dialog");
      assert.equal(await editor.getByLabel("细类（可选）", { exact: true }).inputValue(), "");
      assert.equal(await editor.getByText("消费平台", { exact: true }).count(), 0);
      await editor.getByText("查看脱敏短信凭据", { exact: true }).click();
      assert.match(await editor.locator(".sms-evidence").textContent(), /退款自己的凭据/);
      assert.deepEqual(errors, []);
      await context.close(); context = undefined;
      passed(`${mobile ? 390 : 1440}px refund relink clears stale detail/platform through the real SQL save and retains its own receipt`);
    }
  } finally {
    if (context) await context.close();
    await db.close();
  }
}

async function recoveryAndFragment(browser) {
  const { page, context, errors } = await fixture(browser);
  try {
    const damaged = '{"version":1,"transactions":"damaged"}';
    await page.evaluate(({ key, value }) => localStorage.setItem(key, value), {
      key: KEY,
      value: damaged,
    });
    await page.reload({ waitUntil: "networkidle" });
    await page
      .getByRole("heading", { name: "先保护你的原始账目", exact: true })
      .waitFor();
    assert.equal(
      await page
        .getByRole("button", { name: "记一笔", exact: true })
        .isDisabled(),
      true,
    );
    assert.equal(
      await page.evaluate((key) => localStorage.getItem(key), KEY),
      damaged,
    );
    const pendingDownload = page.waitForEvent("download");
    await page
      .getByRole("button", { name: "下载原始数据", exact: true })
      .click();
    const raw = await pendingDownload;
    assert.equal(await readFile(await raw.path(), "utf8"), damaged);
    passed("corrupt local data remains intact and raw recovery download works");
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }

  const fragmentContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
  });
  const fragmentPage = await fragmentContext.newPage();
  try {
    const sms =
      "【测试银行】2026年10月22日18:00在测试商店消费人民币20.00元，余额1000.00元。";
    await fragmentPage.goto(`${BASE}#sms=${encodeURIComponent(sms)}`, {
      waitUntil: "networkidle",
    });
    assert.equal(
      await fragmentPage
        .getByLabel("银行消费短信", { exact: true })
        .inputValue(),
      sms,
    );
    assert.equal(await fragmentPage.evaluate(() => location.hash), "");
    assert.equal(await fragmentPage.evaluate(() => location.pathname), BASE_PATH, "SMS intake must retain hosting prefix when clearing fragment");
    assert.equal((await data(fragmentPage)).transactions.length, 0);
    passed(
      "SMS fragment intake fills capture screen, clears URL and does not auto-save",
    );
  } finally {
    await fragmentContext.close();
  }
}

async function ledgerRegressions(browser) {
  const { page, context, errors } = await fixture(browser);
  try {
    await addManual(page, { merchant: "关联原消费" });
    const original = (await data(page)).transactions[0];
    await addManual(page, {
      kind: "refund",
      amount: "8.50",
      merchant: "关联退款",
      date: "2026-10-22T13:00",
      linkedTransactionId: original.id,
    });
    await go(page, "账目");
    await page
      .getByRole("button", { name: "编辑关联原消费", exact: true })
      .click();
    const editor = page.getByRole("dialog");
    await editor.getByLabel("类型", { exact: true }).selectOption("transfer");
    await editor.getByRole("button", { name: "确认保存", exact: true }).click();
    await editor.waitFor({ state: "detached" });
    await page.waitForFunction(
      (key) =>
        JSON.parse(localStorage.getItem(key)).transactions.find(
          (t) => t.merchant === "关联原消费",
        ).kind === "transfer",
      KEY,
    );
    assert.equal(
      (await data(page)).transactions.find((t) => t.kind === "refund")
        .linkedTransactionId,
      undefined,
    );
    await page.reload({ waitUntil: "networkidle" });
    assert.equal((await data(page)).transactions.length, 2);
    assert.equal(
      await page
        .getByRole("heading", { name: "先保护你的原始账目", exact: true })
        .count(),
      0,
    );
    passed(
      "changing linked expense into transfer clears refund link and survives reload",
    );

    await page
      .getByRole("button", { name: "我已核对本月账单", exact: true })
      .click();
    await page.waitForFunction(
      (key) =>
        JSON.parse(localStorage.getItem(key)).billCheckedMonths.includes(
          "2026-10",
        ),
      KEY,
    );
    await addManual(page, {
      merchant: "核对后新增消费",
      amount: "12.30",
      date: "2026-10-22T14:10",
    });
    await countIs(page, 3);
    assert.equal(
      (await data(page)).billCheckedMonths.includes("2026-10"),
      false,
    );
    assert.match(await page.locator(".hero-footer").textContent(), /待核对/);
    passed("adding a transaction invalidates manually reconciled month");

    await go(page, "录入");
    await page.getByRole("tab", { name: "导入账单", exact: true }).click();
    const sameIdCsv =
      "日期,类型,金额,商户,分类,备注,交易编号,来源\r\n2026-10-22 18:00,支出,42.50,同单消费,购物,,same-order,wechat\r\n2026-10-22 19:00,退款,7.50,同单退款,购物,,same-order,wechat\r\n";
    const sameIdFile = {
      name: "expense-refund.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(sameIdCsv),
    };
    await page
      .getByLabel("选择 CSV 账单文件", { exact: true })
      .setInputFiles(sameIdFile);
    await page
      .getByRole("button", { name: "确认保存 2 笔", exact: true })
      .waitFor();
    assert.equal(await page.locator(".preview-card").count(), 2);
    await page
      .getByRole("button", { name: "确认保存 2 笔", exact: true })
      .click();
    await countIs(page, 5);
    const pair = (await data(page)).transactions.filter(
      (t) => t.sourceRef === "same-order",
    );
    assert.deepEqual(pair.map((t) => t.kind).sort(), ["expense", "refund"]);
    await page
      .getByLabel("选择 CSV 账单文件", { exact: true })
      .setInputFiles(sameIdFile);
    await page
      .getByText("已跳过 2 条具有相同来源交易编号的记录。", { exact: true })
      .waitFor();
    assert.equal(await page.locator(".preview-card").count(), 0);
    passed(
      "same-provider expense and refund sharing an order ID both import and reimport safely",
    );

    const editedCsv =
      "日期,类型,金额,商户,分类,备注,交易编号\r\n2026-10-22 20:00,支出,25.00,待确认甲,其他,,pending-a\r\n2026-10-22 20:30,支出,35.00,待确认乙,其他,,pending-b\r\n";
    await page
      .getByLabel("选择 CSV 账单文件", { exact: true })
      .setInputFiles({
        name: "pending-edits.csv",
        mimeType: "text/csv",
        buffer: Buffer.from(editedCsv),
      });
    await page
      .getByRole("button", { name: "确认保存 2 笔", exact: true })
      .waitFor();
    const second = page
      .locator(".preview-card")
      .filter({ has: page.getByText("待确认乙", { exact: true }) });
    await second.getByRole("button", { name: "修改信息", exact: true }).click();
    const previewEditor = page.getByRole("dialog");
    await previewEditor.getByLabel("金额（元）", { exact: true }).fill("25.00");
    await previewEditor
      .getByLabel("发生时间", { exact: true })
      .fill("2026-10-22T20:00");
    await previewEditor
      .getByRole("button", { name: "确认保存", exact: true })
      .click();
    await previewEditor.waitFor({ state: "detached" });
    assert.equal(
      await second.getByRole("checkbox").isChecked(),
      false,
      "edited duplicate must be deselected",
    );
    assert.match(await second.textContent(), /疑似重复/);
    await page
      .getByRole("button", { name: "确认保存 1 笔", exact: true })
      .click();
    await page
      .getByText("发现新的疑似重复记录，已取消对应勾选。请核对后再选择保存。", {
        exact: true,
      })
      .waitFor();
    assert.equal((await data(page)).transactions.length, 5);
    assert.equal(
      await page
        .getByRole("button", { name: "确认保存 0 笔", exact: true })
        .isDisabled(),
      true,
    );
    await second.getByRole("button", { name: "跳过", exact: true }).click();
    await page.locator(".preview-card").getByRole("checkbox").check();
    await page
      .getByRole("button", { name: "确认保存 1 笔", exact: true })
      .click();
    await countIs(page, 6);
    passed(
      "editing pending import rechecks other pending duplicates before any save",
    );
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
}

async function staleEditorRegression(browser) {
  const { page, context, errors } = await fixture(browser);
  const otherPage = await context.newPage();
  try {
    await addManual(page, { merchant: "跨页原记录" });
    await go(page, "账目");
    await page
      .getByRole("button", { name: "编辑跨页原记录", exact: true })
      .click();
    let editor = page.getByRole("dialog");
    await editor.getByLabel("金额（元）", { exact: true }).fill("49.99");

    await otherPage.goto(BASE, { waitUntil: "networkidle" });
    const latest = await otherPage.evaluate((key) => {
      const value = JSON.parse(localStorage.getItem(key));
      value.transactions[0] = {
        ...value.transactions[0],
        merchant: "另页更新记录",
        amountCents: 5050,
        note: "其他页面已修改",
      };
      localStorage.setItem(key, JSON.stringify(value));
      return value;
    }, KEY);
    await editor.getByText(/另一个页面同步/).waitFor();
    await editor
      .getByRole("button", { name: "确认保存", exact: true })
      .click();
    await editor.getByText(/这笔记录已在其他页面修改或删除/).waitFor();
    assert.equal(await editor.isVisible(), true);
    assert.deepEqual(await data(page), latest, "stale dialog must preserve the other page's newer record");
    assert.equal(await editor.getByLabel("金额（元）", { exact: true }).inputValue(), "49.99", "unsaved local edit remains available for review");

    await editor.getByRole("button", { name: "关闭弹窗", exact: true }).click();
    await go(page, "账目");
    await page.getByRole("button", { name: "编辑另页更新记录", exact: true }).click();
    editor = page.getByRole("dialog");
    const evidenceChanged = await otherPage.evaluate((key) => {
      const value = JSON.parse(localStorage.getItem(key));
      value.transactions[0].smsEvidence = { text: "脱敏凭据", classificationReason: "另一页补充的分类依据" };
      localStorage.setItem(key, JSON.stringify(value)); return value;
    }, KEY);
    await editor.getByText(/另一个页面同步/).waitFor();
    await editor.getByRole("button", { name: "确认保存", exact: true }).click();
    await editor.getByText(/这笔记录已在其他页面修改或删除/).waitFor();
    assert.deepEqual(await data(page), evidenceChanged, "metadata-only updates must also invalidate a stale editor");
    await editor.getByRole("button", { name: "关闭弹窗", exact: true }).click();
    await page
      .getByRole("button", { name: "编辑另页更新记录", exact: true })
      .click();
    editor = page.getByRole("dialog");
    await editor.getByLabel("金额（元）", { exact: true }).fill("59.99");
    const deleted = await otherPage.evaluate((key) => {
      const value = JSON.parse(localStorage.getItem(key));
      value.transactions = [];
      localStorage.setItem(key, JSON.stringify(value));
      return value;
    }, KEY);
    await editor.getByText(/另一个页面同步/).waitFor();
    await editor
      .getByRole("button", { name: "确认保存", exact: true })
      .click();
    await editor.getByText(/这笔记录已在其他页面修改或删除/).waitFor();
    assert.equal(await editor.isVisible(), true);
    assert.deepEqual(await data(page), deleted, "stale dialog must not recreate a deleted record");
    assert.deepEqual(errors, []);
    passed("stale editor rejects other-page updates and deletions, preserves latest data and shows inline warning");
  } finally {
    await context.close();
  }
}

(async () => {
  await mkdir(ARTIFACTS, { recursive: true });
  let output = "";
  const server = spawn(
    process.execPath,
    [path.join(ROOT, "node_modules", "vite", "bin", "vite.js"), "preview", "--host", "127.0.0.1", "--port", String(PORT)],
    { cwd: ROOT, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  server.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  server.stderr.on("data", (chunk) => {
    output += chunk.toString();
  });
  let browser;
  try {
    await ready(server, () => output);
    const manifestResponse = await fetch(new URL("manifest.webmanifest", BASE));
    assert(manifestResponse.ok, "production manifest exists");
    const manifest = await manifestResponse.json();
    assert.equal(manifest.display, "standalone");
    assert.equal(manifest.start_url, BASE_PATH, "manifest start_url must match hosting prefix");
    assert.equal(manifest.scope, BASE_PATH, "manifest scope must match hosting prefix");
    for (const icon of manifest.icons) {
      const iconUrl = new URL(icon.src, BASE);
      assert.equal(iconUrl.origin, ORIGIN, "PWA icon must be hosted with this app");
      assert(iconUrl.pathname.startsWith(BASE_PATH), `PWA icon must remain under hosting prefix: ${icon.src}`);
      const response = await fetch(iconUrl);
      assert(response.ok, `manifest icon unavailable: ${icon.src}`);
      if (icon.type === "image/png") {
        const bytes = Buffer.from(await response.arrayBuffer());
        assert.equal(
          bytes.subarray(1, 4).toString(),
          "PNG",
          `manifest PNG must be an image: ${icon.src}`,
        );
      }
    }
    passed("production PWA manifest and icon assets");
    browser = await chromium.launch({
      headless: true,
      ...(process.env.MONEYTRAIL_CHROMIUM_PATH
        ? { executablePath: process.env.MONEYTRAIL_CHROMIUM_PATH }
        : {}),
      args: ["--no-sandbox"],
    });
    await fullWorkflow(browser);
    await mobileWorkflow(browser);
    await localLifeDetailsAndEvidence(browser);
    await refundRelinkDatabaseRegression(browser);
    await recoveryAndFragment(browser);
    await ledgerRegressions(browser);
    await staleEditorRegression(browser);
    process.stdout.write(
      `\n${checks} browser checks passed. Chromium mobile emulation; real iPhone validation remains separate.\n`,
    );
  } catch (error) {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    if (server.pid) {
      try {
        server.kill();
      } catch {}
    }
  }
})();
