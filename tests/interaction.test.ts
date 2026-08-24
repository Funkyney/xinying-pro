import { describe, expect, it } from "vitest";
import { InteractionGate, userFacingError } from "../src/renderer/interaction";

describe("InteractionGate", () => {
  it("rejects a repeated entry until the first operation leaves", () => {
    const gate = new InteractionGate();
    expect(gate.tryEnter()).toBe(true);
    expect(gate.tryEnter()).toBe(false);
    gate.leave();
    expect(gate.tryEnter()).toBe(true);
  });
});

describe("userFacingError", () => {
  it("removes Electron IPC implementation details", () => {
    expect(userFacingError(new Error("Error invoking remote method 'platform-projects:sync': Error: 同步失败"))).toBe("同步失败");
  });

  it("keeps a regular application error intact", () => {
    expect(userFacingError(new Error("请先登录心影"))).toBe("请先登录心影");
  });
});
