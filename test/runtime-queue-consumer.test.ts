import { describe, expect, it, vi } from "vitest";
import { BoundedQueueConsumer, RuntimeGenerationControl } from "../src/runtime/v1/index.js";

describe("bounded runtime queue consumer", () => {
  it("completes only after authoritative processing succeeds", async () => {
    const events: string[] = [];
    const disposition = { complete: () => { events.push("complete"); return Promise.resolve(); }, retry: () => Promise.resolve(), deadLetter: () => Promise.resolve() };
    const consumer = new BoundedQueueConsumer();
    await expect(consumer.consume({ deliveryId: "d1", body: {}, receiveCount: 1 }, () => { events.push("commit"); return Promise.resolve(); }, disposition)).resolves.toBe("completed");
    expect(events).toEqual(["commit", "complete"]);
  });
  it("retries bounded failures and retains sanitized DLQ evidence", async () => {
    const retry = vi.fn(() => Promise.resolve());
    const deadLetter = vi.fn(() => Promise.resolve());
    const disposition = { complete: () => Promise.resolve(), retry, deadLetter };
    const consumer = new BoundedQueueConsumer(2);
    await expect(consumer.consume({ deliveryId: "d1", body: {}, receiveCount: 1 }, () => Promise.reject(new Error("private detail")), disposition)).resolves.toBe("retry");
    await expect(consumer.consume({ deliveryId: "d1", body: {}, receiveCount: 2 }, () => Promise.reject(new Error("private detail")), disposition)).resolves.toBe("dead_letter");
    expect(retry).toHaveBeenCalledWith("d1", "processing_failed");
    expect(deadLetter).toHaveBeenCalledWith("d1", { category: "processing_failed", receiveCount: 2 });
    expect(JSON.stringify(deadLetter.mock.calls)).not.toContain("private detail");
  });
  it("uses compare-and-swap generations for wake and drain", () => {
    const control = new RuntimeGenerationControl();
    expect(control.wake(0)).toBe(1);
    expect(() => control.drain(0)).toThrow("stale drain generation");
    expect(control.drain(1)).toBe(1);
    expect(control.mayClaim).toBe(false);
    expect(control.wake(1)).toBe(2);
    expect(control.mayClaim).toBe(true);
  });
});
