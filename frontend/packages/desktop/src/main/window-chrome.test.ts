import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The native window chrome reads lib/windowChrome (MC1): measured on a 2x Mac
 * screenshot, three 14px circles with 9px gaps form a 60px group, so the 96px
 * native rail leaves equal 18px margins and y19 centres the circles in the
 * 52px header. The browser rail stays 84px.
 */
describe("native window chrome geometry", () => {

  it("builds the window from the shared metrics, not hardcoded offsets", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(source).toContain("@agent-desktop/app/window-chrome");
    expect(source).toContain("TRAFFIC_LIGHT_POSITION");
    expect(source).toContain("SHELL_HEADER_HEIGHT_PX");
    expect(source).not.toContain("x: 16, y: 15");
  });
});
