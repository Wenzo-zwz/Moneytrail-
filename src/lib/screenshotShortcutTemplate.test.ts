import { describe, expect, it } from "vitest";
import { getCompatibleScreenshotShortcutTemplate, type ScreenshotShortcutProfile } from "./screenshotShortcutTemplate";

const fixture: ScreenshotShortcutProfile = {
  name: "Fixture screenshot shortcut", version: 1,
  url: "https://www.icloud.com/shortcuts/0123456789abcdef0123456789abcdef",
  capturePrefix: "https://wenzo-zwz.github.io/Moneytrail-/#screenshot=",
};

describe("screenshot shortcut deployment binding", () => {
  it("offers an audited installer only for its exact capture destination", () => {
    expect(getCompatibleScreenshotShortcutTemplate(fixture.capturePrefix, fixture)?.url).toBe(fixture.url);
  });
  it.each([
    "http://wenzo-zwz.github.io/Moneytrail-/#screenshot=",
    "https://wenzo-zwz.github.io/moneytrail-/#screenshot=",
    "https://wenzo-zwz.github.io/Other/#screenshot=",
    "https://example.com/Moneytrail-/#screenshot=",
    "https://wenzo-zwz.github.io/Moneytrail-/?account=other#screenshot=",
    "https://user@wenzo-zwz.github.io/Moneytrail-/#screenshot=",
    "https://wenzo-zwz.github.io:443/Moneytrail-/#screenshot=",
    "https://wenzo-zwz.github.io/Moneytrail-/#alipay-screenshot=",
  ])("does not send another deployment to a fixed-site installer: %s", prefix => {
    expect(getCompatibleScreenshotShortcutTemplate(prefix, fixture)).toBeNull();
  });
  it.each([null, "", "javascript:alert(1)", "https://example.com/shortcuts/0123456789abcdef0123456789abcdef"])("has no install action for an unpublished or invalid template URL %#", url => {
    expect(getCompatibleScreenshotShortcutTemplate(fixture.capturePrefix, { ...fixture, url })).toBeNull();
  });
});
