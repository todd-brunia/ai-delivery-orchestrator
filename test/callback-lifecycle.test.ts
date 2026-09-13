import { describe, expect, it } from "vitest";
import { callbackTaskMayWork, finishCallbackTask, initialCallbackLifecycle, setCallbackLifecycleEnabled,
  signalCallbackWork, tickCallbackMode, type CallbackLifecycleState, type CallbackLifecycleStore,
  type CallbackSlot, type CallbackTaskLauncher } from "../src/runtime/v1/callback-lifecycle.js";

const configuration = "a".repeat(64);
const taskArn = "arn:aws:ecs:us-east-1:123456789012:task/ai-delivery-orchestrator-pilot-worker/" + "b".repeat(32);
class Store implements CallbackLifecycleStore {
  value: CallbackLifecycleState | undefined = initialCallbackLifecycle(configuration);
  read() { return Promise.resolve(structuredClone(this.value)); }
  compareAndSet(revision: number | undefined, next: CallbackLifecycleState) {
    if (this.value?.revision !== revision) return Promise.resolve(false);
    this.value = structuredClone(next); return Promise.resolve(true);
  }
}
class Launcher implements CallbackTaskLauncher {
  calls: CallbackSlot[] = [];
  status: "active" | "stopped" | "unknown" = "active";
  fail = false;
  launch(_mode: "ingress" | "processor", slot: CallbackSlot) {
    this.calls.push(structuredClone(slot));
    if (this.fail) return Promise.reject(new Error("private transport body must not escape"));
    return Promise.resolve(taskArn);
  }
  describe() { return Promise.resolve(this.status); }
}
async function enabled() {
  const store = new Store(); const launcher = new Launcher();
  await setCallbackLifecycleEnabled(store, configuration, 0, true);
  return { store, launcher, tick: (now = 1_000) => tickCallbackMode(store, launcher, configuration, "processor", false, () => now) };
}

describe("bounded callback lifecycle", () => {
  it("defaults disabled and treats missing state as disabled, not empty", async () => {
    const store = new Store(); const launcher = new Launcher();
    expect(store.value?.processor.wake).toBeGreaterThan(store.value!.processor.acknowledged);
    expect(await tickCallbackMode(store, launcher, configuration, "ingress", true)).toBe("disabled");
    store.value = undefined;
    expect(await tickCallbackMode(store, launcher, configuration, "ingress", true)).toBe("disabled");
    expect(launcher.calls).toHaveLength(0);
  });
  it("concurrent ticks reserve one token and never create a second slot", async () => {
    const { store, launcher, tick } = await enabled();
    await Promise.all(Array.from({ length: 12 }, () => tick()));
    expect(new Set(launcher.calls.map((call) => call.token)).size).toBe(1);
    expect(store.value?.processor.sequence).toBe(1);
    expect(await tick(500_000)).toBe("active");
    expect(store.value?.processor.sequence).toBe(1);
  });
  it("replays an ambiguous launch with identical input, then fails closed before token expiry", async () => {
    const { launcher, tick } = await enabled();
    launcher.fail = true;
    expect(await tick()).toBe("uncertain");
    expect(await tick(200_000)).toBe("uncertain");
    expect(launcher.calls[1]).toEqual(launcher.calls[0]);
    expect(await tick(601_000)).toBe("uncertain");
    expect(launcher.calls).toHaveLength(2);
  });
  it("retains unknown and running tasks after their deadline", async () => {
    const { store, launcher, tick } = await enabled();
    await tick(); launcher.status = "unknown";
    expect(await tick(900_000)).toBe("uncertain");
    expect(store.value?.processor.slot?.taskArn).toBe(taskArn);
    launcher.status = "stopped";
    expect(await tick(900_000)).toBe("recovered");
    expect(store.value?.processor.failures).toBe(1);
    expect(await tick(901_000)).toBe("launched");
    expect(launcher.calls[1]?.token).not.toBe(launcher.calls[0]?.token);
  });
  it("resolves an ambiguous pre-drain launch without allowing the old generation to work", async () => {
    const { store, launcher, tick } = await enabled(); launcher.fail = true;
    await tick(); const original = structuredClone(store.value!.processor.slot!);
    await setCallbackLifecycleEnabled(store, configuration, 1, false);
    await setCallbackLifecycleEnabled(store, configuration, 2, true);
    launcher.fail = false;
    expect(await tick(2_000)).toBe("launched");
    expect(launcher.calls[1]).toEqual(original);
    expect(callbackTaskMayWork(store.value!, configuration, "processor", original.token, 3_000)).toBe(false);
  });
  it("never clears a wake published while the worker was finishing", async () => {
    const { store, launcher, tick } = await enabled();
    await tick(); const token = store.value!.processor.slot!.token;
    await signalCallbackWork(store, configuration, "processor");
    expect(await finishCallbackTask(store, configuration, "processor", token, true, 2_000)).toBe(true);
    expect(store.value!.processor.wake).toBeGreaterThan(store.value!.processor.acknowledged);
    launcher.status = "stopped"; await tick(3_000);
    expect(await tick(4_000)).toBe("launched");
  });
  it("allows idle only after explicit empty progress, and wakes ingress from queue metadata", async () => {
    const { store, launcher } = await enabled();
    const tick = () => tickCallbackMode(store, launcher, configuration, "ingress", false, () => 1_000);
    await tick();
    await finishCallbackTask(store, configuration, "ingress", store.value!.ingress.slot!.token, true, 2_000);
    launcher.status = "stopped"; await tick();
    expect(await tick()).toBe("idle");
    expect(await tickCallbackMode(store, launcher, configuration, "ingress", true, () => 3_000)).toBe("launched");
  });
  it("checks drain, generation, configuration, deadline and completion before work", async () => {
    const { store, tick } = await enabled(); await tick();
    const token = store.value!.processor.slot!.token;
    expect(callbackTaskMayWork(store.value!, configuration, "processor", token, 2_000)).toBe(true);
    expect(callbackTaskMayWork(store.value!, configuration, "processor", token, 181_000)).toBe(false);
    expect(callbackTaskMayWork(store.value!, "c".repeat(64), "processor", token, 2_000)).toBe(false);
    expect(await setCallbackLifecycleEnabled(store, configuration, 0, false)).toBe(false);
    expect(await setCallbackLifecycleEnabled(store, configuration, 1, false)).toBe(true);
    expect(callbackTaskMayWork(store.value!, configuration, "processor", token, 2_000)).toBe(false);
    expect(await finishCallbackTask(store, configuration, "processor", token, true, 2_000)).toBe(false);
    expect(store.value!.processor.acknowledged).toBe(0);
  });
  it("bounds crash retries instead of keeping failed Fargate tasks churning", async () => {
    const { launcher, tick } = await enabled(); launcher.status = "stopped";
    for (let index = 0; index < 5; index++) { expect(await tick()).toBe("launched"); expect(await tick()).toBe("recovered"); }
    expect(await tick()).toBe("exhausted");
    expect(launcher.calls).toHaveLength(5);
  });
  it("does not publish signals under an obsolete configuration", async () => {
    const { store } = await enabled(); const revision = store.value!.revision;
    await expect(signalCallbackWork(store, "c".repeat(64), "processor")).rejects.toThrow("callback_lifecycle_configuration_changed");
    expect(store.value!.revision).toBe(revision);
  });
});
