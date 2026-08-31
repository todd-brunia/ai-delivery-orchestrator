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

  it("delegates only the exact supervised outbox identifier", async () => {
    const control = new RuntimeGenerationControl();
    const ids: string[] = [];
    const worker = new LiveDispatchWorker(control, { consumeExact: (id: string) => { ids.push(id); return Promise.resolve([{ id, outcome: "completed" as const }]); } } as never);
    const id = "00000000-0000-4000-8000-000000000999";
    await expect(worker.drainExact(id)).resolves.toEqual([{ id, outcome: "completed" }]);
    expect(ids).toEqual([id]);
    control.drain(0);
    await expect(worker.drainExact(id)).resolves.toEqual([]);
    expect(ids).toEqual([id]);
  });
});
