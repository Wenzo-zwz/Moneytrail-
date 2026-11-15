import { describe, expect, it, vi } from "vitest";
import { createScreenshotIntake, MAX_SCREENSHOT_TEXT_LENGTH, parseScreenshotFragment } from "./screenshotIntake";

const fragment = (text: string) => `#alipay-screenshot=${encodeURIComponent(text)}`;

describe("screenshot fragment parsing", () => {
  it("decodes OCR text once and preserves line breaks and literal URL characters", () => {
    const text = "支付宝\n交易成功\n实付金额：38.40元\n商户 A+B & C=1 #店\n付款时间：2026-11-15 12:34";
    expect(parseScreenshotFragment(fragment(text))).toEqual({ text });
    expect(parseScreenshotFragment("#alipay-screenshot=A+B%2BC")).toEqual({ text: "A B+C" });
    expect(parseScreenshotFragment(fragment("%E0%A4%A"))).toEqual({ text: "%E0%A4%A" });
  });

  it.each(["", "#", "#settings", "#sms=bank", "#other=1&alipay-screenshot=hello", "alipay-screenshot=hello"])("leaves unrelated fragment %j untouched", hash => {
    expect(parseScreenshotFragment(hash)).toBeNull();
  });

  it.each([
    "#access_token=secret&refresh_token=refresh&type=recovery",
    "#type=recovery&alipay-screenshot=hello",
    "#alipay-screenshot=hello&access_token=secret",
    "#alipay-screenshot=hello&%72efresh_token=secret",
    "#alipay-screenshot=hello&code=auth-code&state=auth-state",
    "#alipay-screenshot=hello&error_description=callback-error",
    "#alipay-screenshot=hello&bad%name=value&access_token=secret",
  ])("does not consume login/recovery fragment %j", hash => {
    expect(parseScreenshotFragment(hash)).toBeNull();
  });

  it.each([
    "#alipay-screenshot", "#alipay-screenshot=", "#alipay-screenshot=++%20%0A",
    "#alipay-screenshot=%", "#alipay-screenshot=%E0%A4%A", "#alipay-screenshot=%FF",
    "#alipay-screenshot=valid&alipay-screenshot=other", "#alipay-screenshot=valid&other=value",
    "#alipay-screenshot=valid&", "#alipay-screenshot=valid&bad%name=value", fragment("正文\u0000内容"),
  ])("rejects malformed/empty/ambiguous payload %j without exposing partial text", hash => {
    expect(parseScreenshotFragment(hash)).toEqual({ text: "", error: expect.any(String) });
  });

  it("accepts the length boundary and rejects oversized plain and encoded text", () => {
    const maximum = "支".repeat(MAX_SCREENSHOT_TEXT_LENGTH);
    expect(parseScreenshotFragment(fragment(maximum))).toEqual({ text: maximum });
    expect(parseScreenshotFragment(fragment(maximum + "出"))).toEqual({ text: "", error: expect.any(String) });
    expect(parseScreenshotFragment("#alipay-screenshot=" + "x".repeat(MAX_SCREENSHOT_TEXT_LENGTH * 12 + 1)))
      .toEqual({ text: "", error: expect.any(String) });
  });
});

function browser(hash = "") {
  let url = new URL(`https://example.test/Moneytrail-/?view=ledger${hash}`);
  const listeners = new Set<() => void>();
  const state = { navigation: "kept" };
  const history = {
    state,
    replaceState: vi.fn((_state: unknown, _unused: string, next?: string | URL | null) => {
      if (next !== undefined && next !== null) url = new URL(next, url);
    }),
  };
  const environment = {
    get location() { return url; }, history,
    addEventListener: vi.fn((_type: "hashchange", listener: () => void) => { listeners.add(listener); }),
  };
  return {
    environment, get url() { return url; },
    navigate(nextHash: string) {
      url.hash = nextHash;
      for (const listener of [...listeners]) listener();
    },
  };
}

describe("memory-only screenshot handoff", () => {
  it("strips the private fragment before notifying and preserves route and history state", () => {
    const current = browser(fragment("支付宝\n实付：38.40元"));
    const intake = createScreenshotIntake(() => current.environment);
    const changed = vi.fn(() => { expect(current.url.hash).toBe(""); });
    intake.subscribe(changed); intake.initialize();
    expect(current.environment.history.replaceState).toHaveBeenCalledWith(current.environment.history.state, "", "/Moneytrail-/?view=ledger");
    expect(current.url.pathname + current.url.search).toBe("/Moneytrail-/?view=ledger");
    expect(intake.getSnapshot()).toEqual({ id: 1, text: "支付宝\n实付：38.40元" });
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("holds a stable snapshot for delayed login and StrictMode subscribe cycles", () => {
    const current = browser(fragment("付款详情"));
    const intake = createScreenshotIntake(() => current.environment);
    intake.initialize();
    const first = intake.getSnapshot();
    const initialListener = vi.fn(); const unsubscribe = intake.subscribe(initialListener);
    unsubscribe();
    const nextListener = vi.fn(); intake.subscribe(nextListener);
    intake.initialize(); intake.initialize();
    expect(intake.getSnapshot()).toBe(first);
    expect(current.environment.addEventListener).toHaveBeenCalledTimes(1);
    expect(current.environment.history.replaceState).toHaveBeenCalledTimes(1);
    expect(initialListener).not.toHaveBeenCalled();
    expect(nextListener).not.toHaveBeenCalled();
  });

  it("handles later identical captures as separate arrivals and ignores stale clears", () => {
    const current = browser(fragment("相同商户与金额"));
    const intake = createScreenshotIntake(() => current.environment);
    intake.initialize(); const first = intake.getSnapshot()!;
    current.navigate(fragment("相同商户与金额"));
    const second = intake.getSnapshot()!;
    expect(second.text).toBe(first.text); expect(second.id).not.toBe(first.id);
    intake.clear(first.id); expect(intake.getSnapshot()).toBe(second);
    intake.clear(second.id); expect(intake.getSnapshot()).toBeNull();
    current.navigate(fragment("相同商户与金额"));
    expect(intake.getSnapshot()?.id).toBeGreaterThan(second.id);
  });

  it("clears invalid owned fragments and stores only an explicit safe error", () => {
    const current = browser("#alipay-screenshot=valid&alipay-screenshot=other");
    const intake = createScreenshotIntake(() => current.environment);
    intake.initialize();
    expect(current.url.hash).toBe("");
    expect(intake.getSnapshot()).toEqual({ id: 1, text: "", error: expect.any(String) });
  });

  it("keeps unrelated hash changes and callbacks intact while a capture waits", () => {
    const current = browser(fragment("付款详情"));
    const intake = createScreenshotIntake(() => current.environment);
    intake.initialize(); const waiting = intake.getSnapshot();
    for (const hash of ["#sms=bank", "#unknown", "#access_token=secret&type=recovery", "#alipay-screenshot=hello&type=recovery"]) {
      current.navigate(hash);
      expect(current.url.hash).toBe(hash);
      expect(intake.getSnapshot()).toBe(waiting);
    }
    expect(current.environment.history.replaceState).toHaveBeenCalledTimes(1);
  });

  it("supports unsubscribe and only announces a matching clear", () => {
    const current = browser(); const intake = createScreenshotIntake(() => current.environment);
    const changed = vi.fn(); const stop = intake.subscribe(changed);
    intake.initialize(); expect(changed).not.toHaveBeenCalled();
    current.navigate(fragment("新截图")); expect(changed).toHaveBeenCalledTimes(1);
    intake.clear(100); expect(changed).toHaveBeenCalledTimes(1);
    intake.clear(intake.getSnapshot()!.id); expect(changed).toHaveBeenCalledTimes(2);
    stop(); current.navigate(fragment("另一张截图")); expect(changed).toHaveBeenCalledTimes(2);
  });

  it("does not access a missing browser until initialize and can initialize later", () => {
    let available = false; const current = browser(fragment("付款详情"));
    const getEnvironment = vi.fn(() => available ? current.environment : undefined);
    const intake = createScreenshotIntake(getEnvironment);
    expect(getEnvironment).not.toHaveBeenCalled(); expect(intake.getSnapshot()).toBeNull();
    intake.initialize(); expect(intake.getSnapshot()).toBeNull();
    available = true; intake.initialize();
    expect(intake.getSnapshot()).toMatchObject({ text: "付款详情" });
  });

  it("does not expose receipt text when the browser cannot remove its private fragment", () => {
    const current = browser(fragment("私人付款详情"));
    current.environment.history.replaceState.mockImplementation(() => { throw new Error("history unavailable"); });
    const intake = createScreenshotIntake(() => current.environment);
    expect(() => intake.initialize()).not.toThrow();
    expect(intake.getSnapshot()).toEqual({ id: 1, text: "", error: expect.stringContaining("无法清除") });
  });
});
