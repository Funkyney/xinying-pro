import { describe, expect, it } from "vitest";
import { backgroundAutomationBounds } from "../src/main/platform-layout";

describe("backgroundAutomationBounds", () => {
  it("keeps one pixel intersecting the parent without shrinking the page viewport", () => {
    const result = backgroundAutomationBounds({ x: 272, y: 84, width: 900, height: 650 });
    expect(result).toEqual({ x: -899, y: 84, width: 900, height: 650 });
    expect(result.x + result.width).toBe(1);
  });
});
