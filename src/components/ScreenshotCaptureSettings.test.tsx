import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import ScreenshotCaptureSettings from "./ScreenshotCaptureSettings";

const installer = "https://www.icloud.com/shortcuts/aea10170903740c4b268f105169711cf";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("published screenshot setup", () => {
  it("offers the reviewed installer and actual imported name on the official site", () => {
    vi.stubGlobal("location", { protocol: "https:", origin: "https://wenzo-zwz.github.io" });
    vi.stubEnv("BASE_URL", "/Moneytrail-/");
    const html = renderToStaticMarkup(<ScreenshotCaptureSettings onOpenCapture={() => {}} />);
    expect(html).toContain(`href="${installer}"`);
    expect(html).toContain('target="_blank" rel="noopener noreferrer"');
    expect(html).toContain("安装截图记账快捷指令");
    expect(html).toContain("MoneyTrail截图记账");
    expect(html).toContain("无需填写接入令牌");
    expect(html).not.toContain("配置 iPhone 截图快捷指令");
    expect(html).not.toContain("复制地址前缀");
  });
  it("keeps another deployment on its own manual capture address", () => {
    vi.stubGlobal("location", { protocol: "https:", origin: "https://example.test" });
    vi.stubEnv("BASE_URL", "/personal-book/");
    const html = renderToStaticMarkup(<ScreenshotCaptureSettings onOpenCapture={() => {}} />);
    expect(html).not.toContain(installer);
    expect(html).not.toContain("安装截图记账快捷指令");
    expect(html).toContain("https://example.test/personal-book/#screenshot=");
    expect(html).toContain("配置 iPhone 截图快捷指令");
  });
});
