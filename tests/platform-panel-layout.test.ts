import { describe, expect, it } from "vitest";
import { fitPlatformPanelBounds, PLATFORM_BOTTOM_SAFE_AREA } from "../src/renderer/components/PlatformPanel";

describe("fitPlatformPanelBounds", () => {
  it("keeps the native platform view above the floating navigation safe area", () => {
    const viewport = { width: 1424, height: 826 };
    const result = fitPlatformPanelBounds(
      { x: 25, y: 219, width: 1366, height: 635 },
      viewport,
    );

    expect(result).toEqual({ x: 25, y: 219, width: 1366, height: 511 });
    expect(result.y + result.height).toBe(viewport.height - PLATFORM_BOTTOM_SAFE_AREA);
  });

  it("adapts width and preserves Electron's minimum usable viewport", () => {
    expect(fitPlatformPanelBounds(
      { x: -2, y: 300, width: 1600, height: 40 },
      { width: 1120, height: 720 },
    )).toEqual({ x: 0, y: 300, width: 1120, height: 240 });
  });
});
