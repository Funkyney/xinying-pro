import { describe, expect, it, vi } from "vitest";
import { guardClosedOutputPipe } from "../src/main/output-pipe";

describe("main-process output pipe guard", () => {
  it("attaches an error listener so an updater-owned pipe can close safely", () => {
    const on = vi.fn();

    guardClosedOutputPipe({ on });

    expect(on).toHaveBeenCalledOnce();
    expect(on).toHaveBeenCalledWith("error", expect.any(Function));
    expect(() => on.mock.calls[0][1](Object.assign(new Error("write EOF"), { code: "EOF" }))).not.toThrow();
  });
});
