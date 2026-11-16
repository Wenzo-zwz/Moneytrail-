import profile from "../../public/shortcuts/screenshot-profile.json";

export type ScreenshotShortcutProfile = {
  name: string;
  version: number;
  url: string | null;
  capturePrefix: string;
};

export const SCREENSHOT_SHORTCUT_TEMPLATE: ScreenshotShortcutProfile = profile;

/** A shared shortcut opens one exact deployment; never install it for another. */
export function getCompatibleScreenshotShortcutTemplate(
  capturePrefix: string,
  template: ScreenshotShortcutProfile = SCREENSHOT_SHORTCUT_TEMPLATE,
): (ScreenshotShortcutProfile & { url: string }) | null {
  if (capturePrefix !== template.capturePrefix || typeof template.url !== "string"
    || !/^https:\/\/www\.icloud\.com\/shortcuts\/[a-f0-9]{32}$/i.test(template.url)) return null;
  return { ...template, url: template.url };
}
