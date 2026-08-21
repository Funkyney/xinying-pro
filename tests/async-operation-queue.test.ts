import { describe, expect, it } from "vitest";
import { AsyncOperationQueue } from "../src/main/async-operation-queue";

describe("AsyncOperationQueue", () => {
  it("serializes operations that share the platform page", async () => {
    const queue = new AsyncOperationQueue();
    const events: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const first = queue.run(async () => {
      events.push("first:start");
      await firstGate;
      events.push("first:end");
    });
    const second = queue.run(async () => {
      events.push("second:start");
      events.push("second:end");
    });

    await Promise.resolve();
    expect(events).toEqual(["first:start"]);
    releaseFirst?.();
    await Promise.all([first, second]);
    expect(events).toEqual(["first:start", "first:end", "second:start", "second:end"]);
  });

  it("continues after a failed operation", async () => {
    const queue = new AsyncOperationQueue();
    const failed = queue.run(async () => { throw new Error("expected"); });
    const succeeded = queue.run(async () => "synced");

    await expect(failed).rejects.toThrow("expected");
    await expect(succeeded).resolves.toBe("synced");
  });
});
