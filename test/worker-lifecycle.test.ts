import { describe, expect, it } from "vitest";
import { DrainController, mayScaleToZero } from "../src/runtime/v1/index.js";

const idle = (generation: number, at: string) => ({
  observedAt: new Date(at), wakeGeneration: generation, commandDepth: 0,
  callbackDepth: 0, pendingOutbox: 0, activeLeases: 0, runnableWork: 0,
});

describe("worker lifecycle", () => {
  it("requires two ordered idle observations at the same wake generation", () => {
    expect(mayScaleToZero(idle(2, "2026-08-11T00:00:00Z"), idle(2, "2026-08-11T00:01:00Z"))).toBe(true);
    expect(mayScaleToZero(idle(2, "2026-08-11T00:00:00Z"), idle(3, "2026-08-11T00:01:00Z"))).toBe(false);
    expect(mayScaleToZero(idle(2, "2026-08-11T00:00:00Z"), { ...idle(2, "2026-08-11T00:01:00Z"), activeLeases: 1 })).toBe(false);
  });

  it("stops new claims after drain begins", () => {
    const controller = new DrainController();
    expect(controller.mayClaim()).toBe(true);
    controller.begin();
    expect(controller.draining).toBe(true);
    expect(controller.mayClaim()).toBe(false);
  });
});
