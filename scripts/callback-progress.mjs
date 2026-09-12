import { execFileSync } from "node:child_process";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { z } from "zod";

const region = "us-east-1";
const pilotAccount = "025540956479";
const cluster = "ai-delivery-orchestrator-pilot-worker";
const taskArnSchema = (account) => z.string().regex(new RegExp(`^arn:aws:ecs:${region}:${account}:task/${cluster}/[a-f0-9]{32}$`));
const count = z.number().int().nonnegative();
const status = z.enum(["PROVISIONING", "PENDING", "ACTIVATING", "RUNNING", "DEACTIVATING", "STOPPING", "DEPROVISIONING", "STOPPED", "DELETED"]);
const taskSchema = (account) => z.object({
  taskArn: taskArnSchema(account), taskDefinitionArn: z.string().regex(new RegExp(`^arn:aws:ecs:${region}:${account}:task-definition/ai-delivery-orchestrator-pilot-(worker|supervised-dispatch):[0-9]+$`)),
  lastStatus: status, desiredStatus: status,
  containers: z.array(z.object({
    name: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/), lastStatus: status,
    imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(), exitCode: z.number().int().optional(),
  })).max(10),
});

function aws(args) {
  return JSON.parse(execFileSync("aws", ["--profile", "ai-orchestrator-pilot", "--region", region,
    "--no-cli-pager", "--output", "json", ...args], { encoding: "utf8", timeout: 30_000, maxBuffer: 1_000_000, stdio: ["ignore", "pipe", "pipe"] }));
}

/** Only reads metadata. Never receives messages, retrieves secrets, or fetches log bodies. */
export function collectCallbackProgress(taskArns = [], read = aws, account = pilotAccount) {
  // Synthetic accounts are allowed only with an injected reader, never the live CLI.
  z.string().regex(/^[0-9]{12}$/).parse(account);
  if (read === aws && account !== pilotAccount) throw new Error("account_override_forbidden");
  const queue = `https://sqs.${region}.amazonaws.com/${account}/ai-delivery-orchestrator-pilot-callbacks.fifo`;
  z.array(taskArnSchema(account)).max(3).parse(taskArns);
  if (read(["sts", "get-caller-identity", "--query", "{Account:Account}"]).Account !== account) throw new Error("wrong_account");
  const services = read(["ecs", "describe-services", "--cluster", cluster, "--services", cluster,
    "--query", "{services:services[].{serviceName:serviceName,status:status,desiredCount:desiredCount,runningCount:runningCount,pendingCount:pendingCount},failures:failures}"]);
  const service = z.object({ services: z.array(z.object({ serviceName: z.literal(cluster), status: z.literal("ACTIVE"),
    desiredCount: count, runningCount: count, pendingCount: count })).length(1), failures: z.array(z.unknown()).length(0) }).parse(services).services[0];
  const attributes = read(["sqs", "get-queue-attributes", "--queue-url", queue, "--attribute-names",
    "ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible", "ApproximateNumberOfMessagesDelayed"]);
  const queueCounts = z.object({ Attributes: z.object({ ApproximateNumberOfMessages: z.string().regex(/^\d+$/),
    ApproximateNumberOfMessagesNotVisible: z.string().regex(/^\d+$/), ApproximateNumberOfMessagesDelayed: z.string().regex(/^\d+$/) }) }).parse(attributes).Attributes;
  let tasks = [];
  if (taskArns.length) {
    const response = read(["ecs", "describe-tasks", "--cluster", cluster, "--tasks", ...taskArns,
      "--query", "{tasks:tasks[].{taskArn:taskArn,taskDefinitionArn:taskDefinitionArn,lastStatus:lastStatus,desiredStatus:desiredStatus,containers:containers[].{name:name,lastStatus:lastStatus,imageDigest:imageDigest,exitCode:exitCode}},failures:failures}"]);
    // AWS CLI projections return null for fields absent on pending/running tasks.
    const normalized = JSON.parse(JSON.stringify(response), (_key, value) => value === null ? undefined : value);
    tasks = z.object({ tasks: z.array(taskSchema(account)), failures: z.array(z.unknown()).length(0) }).parse(normalized).tasks;
    if (tasks.length !== new Set(taskArns).size || new Set(tasks.map((item) => item.taskArn)).size !== tasks.length || tasks.some((item) => !taskArns.includes(item.taskArn))) throw new Error("task_identity_mismatch");
  }
  return {
    observedAt: new Date().toISOString(), account, region, service, queueCounts, tasks,
    interpretation: "Queue counts are approximate; an empty queue or exit code zero does not prove a callback transition. Match exact delivery evidence in the operator run events.",
    console: {
      tasks: `https://${region}.console.aws.amazon.com/ecs/v2/clusters/${cluster}/tasks?region=${region}`,
      logs: `https://${region}.console.aws.amazon.com/cloudwatch/home?region=${region}#logsV2:log-groups`,
      queue: `https://${region}.console.aws.amazon.com/sqs/v3/home?region=${region}#/queues/${encodeURIComponent(queue)}`,
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.stdout.write(`${JSON.stringify(collectCallbackProgress(process.argv.slice(2)), null, 2)}\n`); }
  catch { process.stderr.write("callback_progress_unavailable: verify pilot SSO session, account, permissions, and exact task ARNs; no AWS mutations were attempted.\n"); process.exitCode = 1; }
}
