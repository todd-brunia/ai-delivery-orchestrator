import { z } from "zod";

const instant = z.iso.datetime({ offset: true });
const cluster = "ai-delivery-orchestrator-pilot-worker";
const family = "ai-delivery-orchestrator-pilot-supervised-dispatch";
export const RuntimeScopeSchema = z.object({
  clusterArn: z.string().regex(new RegExp(`^arn:aws:ecs:us-east-1:[0-9]{12}:cluster/${cluster}$`)),
  taskDefinitionArn: z.string().regex(new RegExp(`^arn:aws:ecs:us-east-1:[0-9]{12}:task-definition/${family}:[1-9][0-9]{0,8}$`)),
  imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
}).strict().refine(value => value.clusterArn.split(":")[4] === value.taskDefinitionArn.split(":")[4], "runtime account mismatch");
export const RuntimeConstraintsSchema = RuntimeScopeSchema.safeExtend({
  repository: z.literal("todd-brunia/ai-consulting-client-portal"),
  configurationFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  stopPolicy: z.literal("supervised-process-deadline/v1"),
  maximumDurationMilliseconds: z.literal(180_000),
});
export const RuntimeObservationSchema = z.object({
  version: z.literal("supervised-runtime-evidence/v1"),
  source: z.literal("ecs-task-local-metadata-v4_and_process_guard"),
  handoffPolicy: z.literal("exact_constraints_fresh_current_task/v1"),
  constraints: RuntimeConstraintsSchema,
  taskArn: z.string().regex(new RegExp(`^arn:aws:ecs:us-east-1:[0-9]{12}:task/${cluster}/[a-f0-9]{32}$`)),
  observedAt: instant, startedAt: instant, deadlineAt: instant,
  mode: z.enum(["preflight", "execute"]), executionEnabled: z.boolean(),
  deadlineInstalled: z.literal(true),
  otherRuntimeControls: z.literal("not_observed"),
}).strict().superRefine((value, context) => {
  const started = Date.parse(value.startedAt), observed = Date.parse(value.observedAt), deadline = Date.parse(value.deadlineAt);
  if (value.taskArn.split(":")[4] !== value.constraints.clusterArn.split(":")[4] ||
      started > observed || observed >= deadline || deadline - started !== value.constraints.maximumDurationMilliseconds ||
      (value.mode === "preflight" && value.executionEnabled)) context.addIssue({ code: "custom", message: "invalid runtime observation" });
});
export type RuntimeObservation = z.infer<typeof RuntimeObservationSchema>;
export interface RuntimeObservationPort { observe(): Promise<RuntimeObservation>; }

/** Old preflight tasks may have stopped; only the freshly observed task must be active now. */
export function validateCurrentRuntime(raw: unknown, repository: string, mode: "preflight" | "execute", executionEnabled: boolean, now: Date): RuntimeObservation {
  try {
    const value = RuntimeObservationSchema.parse(raw);
    const time = now.getTime();
    if (!Number.isFinite(time) || value.constraints.repository !== repository || value.mode !== mode || value.executionEnabled !== executionEnabled ||
        Date.parse(value.observedAt) > time || time - Date.parse(value.observedAt) > 5_000 || time >= Date.parse(value.deadlineAt)) throw new Error();
    return value;
  } catch { throw new Error("current runtime evidence is unavailable or invalid"); }
}

/** Compare reviewed constraints, never pretend the new task is the old task. */
export function revalidateRuntimeHandoff(rawPrior: unknown, fresh: RuntimeObservation, now: Date): RuntimeObservation {
  try {
    const prior = RuntimeObservationSchema.parse(rawPrior);
    const current = RuntimeObservationSchema.parse(fresh);
    if (prior.mode !== "preflight" || prior.executionEnabled || Date.parse(prior.observedAt) > now.getTime() ||
        now.getTime() - Date.parse(prior.observedAt) >= 300_000 ||
        JSON.stringify(prior.constraints) !== JSON.stringify(current.constraints)) throw new Error();
    validateCurrentRuntime(current, prior.constraints.repository, "execute", true, now);
    return prior;
  } catch { throw new Error("runtime handoff constraints changed or expired"); }
}
