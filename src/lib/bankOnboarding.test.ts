import { describe, expect, it } from "vitest";
import { THREE_BANK_IPHONE_STEPS, THREE_BANK_SIGN_COMMAND, THREE_BANK_TEMPLATE } from "./bankOnboarding";

describe("shareable three-bank setup instructions", () => {
  it("signs the shipped source into the same shortcut name used by the automation guide", () => {
    const input = THREE_BANK_TEMPLATE.sourcePath.split("/").at(-1);
    expect(THREE_BANK_SIGN_COMMAND).toContain(`--input "$HOME/Downloads/${input}"`);
    expect(THREE_BANK_SIGN_COMMAND).toContain(`--output "$HOME/Downloads/${THREE_BANK_TEMPLATE.name}.shortcut"`);
    expect(THREE_BANK_SIGN_COMMAND).toContain("--mode anyone");
  });

  it("keeps the iPhone conversion recipe tied to the actual rule and blank public token", () => {
    expect(THREE_BANK_IPHONE_STEPS).toContain(THREE_BANK_TEMPLATE.matchPattern);
    expect(THREE_BANK_IPHONE_STEPS).toContain(THREE_BANK_TEMPLATE.name);
    expect(THREE_BANK_IPHONE_STEPS).toContain("默认答案也留空");
    expect(THREE_BANK_IPHONE_STEPS).not.toMatch(/mt_sms_|7044156f|1329/);
  });
});
