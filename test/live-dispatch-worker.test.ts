import { describe, expect, it } from "vitest";

import { LiveDispatchWorker, RuntimeGenerationControl } from "../src/runtime/v1/index.js";

describe("live dispatch worker", () => {
  it("does not claim mutations after the runtime begins draining", async () => {
    const control = new RuntimeGenerationControl();
    let calls = 0;
    const worker = new LiveDispatchWorker(control, { consume: async () => { await Promise.resolve(); calls += 1; return []; } } as never);
    await expect(worker.drainOnce()).resolves.toEqual([]);
    control.drain(0);
    await expect(worker.drainOnce()).resolves.toEqual([]);
    expect(calls).toBe(1);
  });
});
