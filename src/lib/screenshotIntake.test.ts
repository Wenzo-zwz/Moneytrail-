import { describe, expect, it, vi } from "vitest";
import { createScreenshotIntake, MAX_SCREENSHOT_TEXT_LENGTH, parseScreenshotFragment } from "./screenshotIntake";

const screenshotKeys = ["screenshot", "alipay-screenshot"] as const;
type ScreenshotKey = typeof screenshotKeys[number];
const fragment = (text: string, key: ScreenshotKey = "screenshot") => `#${key}=${encodeURIComponent(text)}`;

describe.each(screenshotKeys)("%s fragment parsing", key => {
  const captured = (text: string) => fragment(text, key);
  const otherKey = key === "screenshot" ? "alipay-screenshot" : "screenshot";
  it("decodes OCR text once and preserves line breaks and literal URL characters", () => {
    const text = "支付宝\n交易成功\n实付金额：38.40元\n商户 A+B & C=1 #店\n付款时间：2026-11-15 12:34";
    expect(parseScreenshotFragment(captured(text))).toEqual({ text });
    expect(parseScreenshotFragment(`#${key}=A+B%2BC`)).toEqual({ text: "A B+C" });
    expect(parseScreenshotFragment(captured("%E0%A4%A"))).toEqual({ text: "%E0%A4%A" });
  });

  it.each(["", "#", "#settings", "#sms=bank", "#screenshots=hello", "#Screenshot=hello", `#other=1&${key}=hello`, `${key}=hello`])("leaves unrelated fragment %j untouched", hash => {
    expect(parseScreenshotFragment(hash)).toBeNull();
  });

  it.each([
    "#access_token=secret&refresh_token=refresh&type=recovery",
    `#type=recovery&${key}=hello`,
    `#${key}=hello&access_token=secret`,
    `#${key}=hello&%72efresh_token=secret`,
    `#${key}=hello&code=auth-code&state=auth-state`,
    `#${key}=hello&error_description=callback-error`,
    `#${key}=hello&bad%name=value&access_token=secret`,
    `#${key}=hello&${otherKey}=other&access_token=secret`,
  ])("does not consume login/recovery fragment %j", hash => {
    expect(parseScreenshotFragment(hash)).toBeNull();
  });

  it.each([
    `#${key}`, `#${key}=`, `#${key}=++%20%0A`,
    `#${key}=%`, `#${key}=%E0%A4%A`, `#${key}=%FF`,
    `#${key}=valid&${key}=other`, `#${key}=valid&${otherKey}=other`, `#${key}=valid&other=value`,
    `#${key}=valid&`, `#${key}=valid&bad%name=value`, captured("正文\u0000内容"),
  ])("rejects malformed/empty/ambiguous payload %j without exposing partial text", hash => {
    expect(parseScreenshotFragment(hash)).toEqual({ text: "", error: expect.any(String) });
  });

  it("accepts the length boundary and rejects oversized plain and encoded text", () => {
    const maximum = "支".repeat(MAX_SCREENSHOT_TEXT_LENGTH);
    expect(parseScreenshotFragment(captured(maximum))).toEqual({ text: maximum });
    expect(parseScreenshotFragment(captured(maximum + "出"))).toEqual({ text: "", error: expect.any(String) });
    expect(parseScreenshotFragment(`#${key}=` + "x".repeat(MAX_SCREENSHOT_TEXT_LENGTH * 12 + 1)))
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

describe.each(screenshotKeys)("%s memory-only screenshot handoff", key => {
  const captured = (text: string) => fragment(text, key);
  const otherKey = key === "screenshot" ? "alipay-screenshot" : "screenshot";
  it("strips the private fragment before notifying and preserves route and history state", () => {
    const current = browser(captured("支付宝\n实付：38.40元"));
    const intake = createScreenshotIntake(() => current.environment);
    const changed = vi.fn(() => { expect(current.url.hash).toBe(""); });
    intake.subscribe(changed); intake.initialize();
    expect(current.environment.history.replaceState).toHaveBeenCalledWith(current.environment.history.state, "", "/Moneytrail-/?view=ledger");
    expect(current.url.pathname + current.url.search).toBe("/Moneytrail-/?view=ledger");
    expect(intake.getSnapshot()).toEqual({ id: 1, text: "支付宝\n实付：38.40元" });
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("holds a stable snapshot for delayed login and StrictMode subscribe cycles", () => {
    const current = browser(captured("付款详情"));
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

  it("does not attach a source hint to text received through either key", () => {
    const text = "微信支付\n支付成功\n示例商户\n38.40元";
    const current = browser(captured(text));
    const intake = createScreenshotIntake(() => current.environment);
    intake.initialize();
    expect(intake.getSnapshot()).toEqual({ id: 1, text });
    expect(Object.keys(intake.getSnapshot()!).sort()).toEqual(["id", "text"]);
  });

  it("handles later identical captures as separate arrivals and ignores stale clears", () => {
    const current = browser(captured("相同商户与金额"));
    const intake = createScreenshotIntake(() => current.environment);
    intake.initialize(); const first = intake.getSnapshot()!;
    current.navigate(fragment("相同商户与金额", otherKey));
    const second = intake.getSnapshot()!;
    expect(second.text).toBe(first.text); expect(second.id).not.toBe(first.id);
    intake.clear(first.id); expect(intake.getSnapshot()).toBe(second);
    intake.clear(second.id); expect(intake.getSnapshot()).toBeNull();
    current.navigate(captured("相同商户与金额"));
    expect(intake.getSnapshot()?.id).toBeGreaterThan(second.id);
  });

  it.each([
    `#${key}=valid&${key}=other`, `#${key}=valid&${otherKey}=other`,
  ])("clears invalid owned fragment %j and stores only an explicit safe error", hash => {
    const current = browser(hash);
    const intake = createScreenshotIntake(() => current.environment);
    intake.initialize();
    expect(current.url.hash).toBe("");
    expect(intake.getSnapshot()).toEqual({ id: 1, text: "", error: expect.any(String) });
  });

  it("keeps unrelated hash changes and callbacks intact while a capture waits", () => {
    const current = browser(captured("付款详情"));
    const intake = createScreenshotIntake(() => current.environment);
    intake.initialize(); const waiting = intake.getSnapshot();
    for (const hash of ["#sms=bank", "#unknown", "#access_token=secret&type=recovery", `#${key}=hello&type=recovery`]) {
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
    current.navigate(captured("新截图")); expect(changed).toHaveBeenCalledTimes(1);
    intake.clear(100); expect(changed).toHaveBeenCalledTimes(1);
    intake.clear(intake.getSnapshot()!.id); expect(changed).toHaveBeenCalledTimes(2);
    stop(); current.navigate(captured("另一张截图")); expect(changed).toHaveBeenCalledTimes(2);
  });

  it("does not access a missing browser until initialize and can initialize later", () => {
    let available = false; const current = browser(captured("付款详情"));
    const getEnvironment = vi.fn(() => available ? current.environment : undefined);
    const intake = createScreenshotIntake(getEnvironment);
    expect(getEnvironment).not.toHaveBeenCalled(); expect(intake.getSnapshot()).toBeNull();
    intake.initialize(); expect(intake.getSnapshot()).toBeNull();
    available = true; intake.initialize();
    expect(intake.getSnapshot()).toMatchObject({ text: "付款详情" });
  });

  it("does not expose receipt text when the browser cannot remove its private fragment", () => {
    const current = browser(captured("私人付款详情"));
    current.environment.history.replaceState.mockImplementation(() => { throw new Error("history unavailable"); });
    const intake = createScreenshotIntake(() => current.environment);
    expect(() => intake.initialize()).not.toThrow();
    expect(intake.getSnapshot()).toEqual({ id: 1, text: "", error: expect.stringContaining("无法清除") });
  });
});
