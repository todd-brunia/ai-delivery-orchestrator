import { request as httpRequest } from "node:http";
import { z } from "zod";
import { RuntimeConstraintsSchema, RuntimeObservationSchema, type RuntimeObservationPort } from "../../domain/sprint-delivery/v1/runtime-evidence.js";

export function installSupervisedDeadline(now: () => Date = () => new Date(), terminate: () => void = () => {
  process.stderr.write('{"event":"supervised_deadline_exceeded"}\n');
  process.exit(1);
}) {
  const startedAt = now();
  if (!Number.isFinite(startedAt.getTime())) throw new Error("invalid process clock");
  const deadlineAt = new Date(startedAt.getTime() + 180_000);
  let active = true;
  const timer = setTimeout(() => { active = false; terminate(); }, 180_000);
  return {
    observe: () => {
      const time = now();
      if (!active || !Number.isFinite(time.getTime()) || time < startedAt || time >= deadlineAt) throw new Error("process deadline is not active");
      return { startedAt: startedAt.toISOString(), deadlineAt: deadlineAt.toISOString(), deadlineInstalled: true as const };
    },
    close: () => { active = false; clearTimeout(timer); },
  };
}

/** No DNS, proxies, redirects, credentials, tags or caller-selected hosts. */
export async function readSupervisedTaskMetadata(uri: string, request: typeof httpRequest = httpRequest): Promise<unknown> {
  try {
    if (!/^http:\/\/169\.254\.170\.2\/v4\/[A-Za-z0-9-]{1,100}$/.test(uri)) throw new Error();
    return await new Promise<unknown>((resolve, reject) => {
      const failure = () => reject(new Error("task metadata unavailable"));
      const req = request(`${uri}/task`, { method: "GET", agent: false, signal: AbortSignal.timeout(5_000), headers: { accept: "application/json" } }, response => {
        if (response.statusCode !== 200) { response.destroy(); failure(); return; }
        let size = 0;
        const chunks: Buffer[] = [];
        response.on("error", failure);
        response.on("aborted", failure);
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 65_536) { response.destroy(); req.destroy(); failure(); return; }
          chunks.push(chunk);
        });
        response.on("end", () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown); }
          catch { failure(); }
        });
      });
      req.on("error", failure);
      req.end();
    });
  } catch { throw new Error("task metadata unavailable"); }
}

// AWS may add metadata fields. Strip them at the adapter boundary; never copy
// them into the strict versioned evidence or include a response in an error.
const metadataSchema = z.object({
  Cluster: z.string(), TaskARN: z.string(), Family: z.string(), Revision: z.string(),
  DesiredStatus: z.literal("RUNNING"), KnownStatus: z.literal("RUNNING"), LaunchType: z.literal("FARGATE"),
  Containers: z.array(z.object({ Name: z.string(), Image: z.string(), ImageID: z.string(), KnownStatus: z.string() })).min(1).max(10),
});

export function createSupervisedRuntimeObserver(input: {
  readonly constraints: z.infer<typeof RuntimeConstraintsSchema>;
  readonly mode: "preflight" | "execute"; readonly executionEnabled: boolean;
  readonly metadataUri: string; readonly deadline: ReturnType<typeof installSupervisedDeadline>;
  readonly now?: () => Date; readonly readMetadata?: (uri: string) => Promise<unknown>;
}): RuntimeObservationPort {
  const constraints = RuntimeConstraintsSchema.parse(input.constraints);
  const now = input.now ?? (() => new Date());
  return { observe: async () => {
    try {
      input.deadline.observe();
      const metadata = metadataSchema.parse(await (input.readMetadata ?? readSupervisedTaskMetadata)(input.metadataUri));
      const account = constraints.clusterArn.split(":")[4]!;
      const container = metadata.Containers.filter(value => value.Name === "supervised-dispatch");
      if (metadata.Containers.length !== 1 || container.length !== 1 || container[0]!.KnownStatus !== "RUNNING" ||
          (metadata.Cluster !== constraints.clusterArn && metadata.Cluster !== constraints.clusterArn.split("/")[1]) ||
          `arn:aws:ecs:us-east-1:${account}:task-definition/${metadata.Family}:${metadata.Revision}` !== constraints.taskDefinitionArn ||
          container[0]!.ImageID !== constraints.imageDigest ||
          container[0]!.Image !== `${account}.dkr.ecr.us-east-1.amazonaws.com/ai-delivery-orchestrator-worker@${constraints.imageDigest}`) throw new Error();
      return RuntimeObservationSchema.parse({ version: "supervised-runtime-evidence/v1", source: "ecs-task-local-metadata-v4_and_process_guard", handoffPolicy: "exact_constraints_fresh_current_task/v1", constraints,
        taskArn: metadata.TaskARN, observedAt: now().toISOString(), ...input.deadline.observe(), mode: input.mode, executionEnabled: input.executionEnabled,
        otherRuntimeControls: "not_observed",
      });
    } catch { throw new Error("runtime observation unavailable or invalid"); }
  } };
}
