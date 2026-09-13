import { createHash } from "node:crypto";
import { z } from "zod";

export const callbackModes = ["ingress", "processor"] as const;
export type CallbackMode = typeof callbackModes[number];
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1);
const slotSchema = z.strictObject({
  token: z.string().regex(/^[a-f0-9]{64}$/),
  generation: counter,
  wake: counter,
  reservedAt: counter,
  deadline: counter,
  taskArn: z.string().regex(/^arn:aws:ecs:us-east-1:[0-9]{12}:task\/ai-delivery-orchestrator-pilot-worker\/[a-f0-9]{32}$/).nullable(),
  finished: z.boolean(),
});
const modeSchema = z.strictObject({
  wake: counter, acknowledged: counter, sequence: counter, failures: counter,
  slot: slotSchema.nullable(),
});
export const CallbackLifecycleStateSchema = z.strictObject({
  version: z.literal("callback-lifecycle/v1"),
  revision: counter,
  configuration: z.string().regex(/^[a-f0-9]{64}$/),
  generation: counter,
  enabled: z.boolean(), draining: z.boolean(),
  ingress: modeSchema, processor: modeSchema,
}).superRefine((state, context) => {
  for (const mode of callbackModes) {
    const value = state[mode];
    if (value.acknowledged > value.wake || (value.slot &&
      (value.slot.wake > value.wake || value.slot.generation > state.generation ||
       value.slot.deadline !== value.slot.reservedAt + CALLBACK_TASK_LIFETIME_MS))) {
      context.addIssue({ code: "custom", message: "invalid lifecycle ordering" });
    }
  }
});
export type CallbackLifecycleState = z.infer<typeof CallbackLifecycleStateSchema>;
export type CallbackSlot = z.infer<typeof slotSchema>;
export const CALLBACK_TASK_LIFETIME_MS = 180_000;
// RunTask tokens expire no sooner than one hour after STOPPED. Never replay an
// ambiguous request beyond ten minutes; a lost response then requires inspection.
export const CALLBACK_LAUNCH_RECOVERY_MS = 600_000;
export const CALLBACK_FAILURE_LIMIT = 5;

export interface CallbackLifecycleStore {
  read(): Promise<CallbackLifecycleState | undefined>;
  compareAndSet(expectedRevision: number | undefined, next: CallbackLifecycleState): Promise<boolean>;
}
export interface CallbackTaskLauncher {
  launch(mode: CallbackMode, slot: CallbackSlot): Promise<string>;
  describe(taskArn: string): Promise<"active" | "stopped" | "unknown">;
}

/** Missing state is not evidence that the durable PostgreSQL inbox is empty. */
export function initialCallbackLifecycle(configuration: string): CallbackLifecycleState {
  const mode = () => ({ wake: 1, acknowledged: 0, sequence: 0, failures: 0, slot: null });
  return CallbackLifecycleStateSchema.parse({ version: "callback-lifecycle/v1", revision: 0,
    configuration, generation: 0, enabled: false, draining: true, ingress: mode(), processor: mode() });
}

export async function mutateCallbackLifecycle(store: CallbackLifecycleStore,
  change: (current: CallbackLifecycleState) => CallbackLifecycleState | undefined): Promise<boolean> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const value = await store.read();
    if (!value) throw new Error("callback_lifecycle_missing");
    const current = CallbackLifecycleStateSchema.parse(value);
    const next = change(structuredClone(current));
    if (!next) return false;
    next.revision = current.revision + 1;
    if (await store.compareAndSet(current.revision, CallbackLifecycleStateSchema.parse(next))) return true;
  }
  throw new Error("callback_lifecycle_contention");
}

/** Administrative drain/wake is generation-fenced and preserves occupied slots. */
export async function setCallbackLifecycleEnabled(store: CallbackLifecycleStore, configuration: string,
  expectedGeneration: number, enabled: boolean): Promise<boolean> {
  return mutateCallbackLifecycle(store, (state) => {
    if (state.configuration !== configuration || state.generation !== expectedGeneration) return undefined;
    state.generation++;
    state.enabled = enabled; state.draining = !enabled;
    if (enabled) for (const mode of callbackModes) { state[mode].wake++; state[mode].failures = 0; }
    return state;
  });
}

export function callbackTaskMayWork(state: CallbackLifecycleState, configuration: string,
  mode: CallbackMode, token: string, now: number): boolean {
  const slot = state[mode].slot;
  return state.configuration === configuration && state.enabled && !state.draining &&
    slot !== null && slot.token === token && slot.generation === state.generation &&
    !slot.finished && now >= slot.reservedAt && now < slot.deadline;
}

/** Called after inbox persistence, before SQS ACK. Duplicates may add safe wakes. */
export async function signalCallbackWork(store: CallbackLifecycleStore, configuration: string,
  mode: CallbackMode): Promise<void> {
  const changed = await mutateCallbackLifecycle(store, (state) => {
    if (state.configuration !== configuration) return undefined;
    state[mode].wake++;
    return state;
  });
  if (!changed) throw new Error("callback_lifecycle_configuration_changed");
}

/** The empty observation covers only the launch's captured wake generation. */
export async function finishCallbackTask(store: CallbackLifecycleStore, configuration: string,
  mode: CallbackMode, token: string, empty: boolean, now: number): Promise<boolean> {
  return mutateCallbackLifecycle(store, (state) => {
    if (!callbackTaskMayWork(state, configuration, mode, token, now)) return undefined;
    const slot = state[mode].slot!;
    if (empty) state[mode].acknowledged = Math.max(state[mode].acknowledged, slot.wake);
    slot.finished = true;
    return state;
  });
}

export type CallbackTickResult = "disabled" | "idle" | "active" | "launched" | "recovered" | "uncertain" | "exhausted" | "contended";

/** No database/provider ports. An occupied slot is never expired into a duplicate. */
export async function tickCallbackMode(store: CallbackLifecycleStore, launcher: CallbackTaskLauncher,
  configuration: string, mode: CallbackMode, queueHasWork: boolean,
  clock: () => number = Date.now): Promise<CallbackTickResult> {
  let current = await store.read();
  if (!current) return "disabled";
  current = CallbackLifecycleStateSchema.parse(current);
  if (current.configuration !== configuration) return "disabled";
  let slot = current[mode].slot;
  if (slot?.taskArn) {
    const status = await launcher.describe(slot.taskArn);
    if (status !== "stopped") return status === "active" ? "active" : "uncertain";
    const stoppedToken = slot.token;
    await mutateCallbackLifecycle(store, (state) => {
      const occupied = state[mode].slot;
      if (state.configuration !== configuration || occupied?.token !== stoppedToken) return undefined;
      state[mode].failures = occupied.finished ? 0 : state[mode].failures + 1;
      state[mode].slot = null;
      return state;
    });
    return "recovered";
  }
  if (!current.enabled || current.draining) return "disabled";
  if (!slot) {
    if (current[mode].failures >= CALLBACK_FAILURE_LIMIT) return "exhausted";
    if (current[mode].wake <= current[mode].acknowledged && !(mode === "ingress" && queueHasWork)) return "idle";
    const now = clock();
    const next = structuredClone(current);
    next.revision++; next[mode].sequence++;
    slot = { token: createHash("sha256").update(JSON.stringify([configuration, mode, next[mode].sequence])).digest("hex"),
      generation: current.generation, wake: current[mode].wake, reservedAt: now,
      deadline: now + CALLBACK_TASK_LIFETIME_MS, taskArn: null, finished: false };
    next[mode].slot = slot;
    if (!await store.compareAndSet(current.revision, CallbackLifecycleStateSchema.parse(next))) return "contended";
  }
  // Re-read immediately before launching: a drain/configuration change invalidates
  // this invocation. Same-token concurrent retries use identical persisted inputs.
  const latest = await store.read();
  if (!latest || latest.configuration !== configuration || !latest.enabled || latest.draining ||
    latest[mode].slot?.token !== slot.token) return "disabled";
  // After a drain/wake, resolve an old ambiguous launch with its original token.
  // Its task is generation-fenced before touching the inbox; discarding its slot
  // without resolving it could create a second running task.
  if (clock() - slot.reservedAt >= CALLBACK_LAUNCH_RECOVERY_MS || clock() < slot.reservedAt) return "uncertain";
  let taskArn: string;
  try { taskArn = await launcher.launch(mode, slot); } catch { return "uncertain"; }
  await mutateCallbackLifecycle(store, (state) => {
    if (state.configuration !== configuration || state[mode].slot?.token !== slot.token) return undefined;
    state[mode].slot.taskArn = taskArn;
    return state;
  });
  return "launched";
}
