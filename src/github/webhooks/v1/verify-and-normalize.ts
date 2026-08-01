import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import {
  GITHUB_WEBHOOK_VERSION,
  GitHubEventNameSchema,
  type GitHubWebhookHeaders,
  type NormalizedGitHubEvent,
  NormalizedGitHubEventSchema,
} from "./contracts.js";

const payloadSchema = z.object({
  action: z.string().min(1),
  installation: z.object({ id: z.number().int().positive() }),
  sender: z.object({ login: z.string().min(1) }),
  repository: z.object({ full_name: z.string() }).optional(),
  issue: z.object({ number: z.number().int().positive() }).optional(),
  pull_request: z.object({ number: z.number().int().positive() }).optional(),
  check_run: z.object({ id: z.number().int().positive() }).optional(),
  check_suite: z.object({ id: z.number().int().positive() }).optional(),
  workflow_run: z.object({ id: z.number().int().positive() }).optional(),
}).passthrough();

export class InvalidWebhookError extends Error {
  constructor(message: string) { super(message); this.name = "InvalidWebhookError"; }
}

export function verifyAndNormalizeGitHubWebhook(
  rawBody: Uint8Array,
  headers: GitHubWebhookHeaders,
  secret: string,
  receivedAt = new Date(),
): NormalizedGitHubEvent {
  if (!secret) throw new InvalidWebhookError("webhook secret is required");
  const supplied = /^sha256=([a-f0-9]{64})$/.exec(headers.signature256)?.[1];
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  if (!supplied || !timingSafeEqual(Buffer.from(supplied, "hex"), Buffer.from(expected, "hex"))) {
    throw new InvalidWebhookError("invalid webhook signature");
  }

  const eventName = GitHubEventNameSchema.safeParse(headers.eventName);
  if (!eventName.success) throw new InvalidWebhookError("unsupported webhook event");
  const hookId = Number(headers.hookId);
  let decoded: unknown;
  try { decoded = JSON.parse(Buffer.from(rawBody).toString("utf8")); }
  catch { throw new InvalidWebhookError("invalid webhook JSON"); }
  const payload = payloadSchema.safeParse(decoded);
  if (!payload.success) throw new InvalidWebhookError("malformed webhook payload");

  const data = payload.data;
  return NormalizedGitHubEventSchema.parse({
    version: GITHUB_WEBHOOK_VERSION,
    deliveryId: headers.deliveryId,
    eventName: eventName.data,
    action: data.action,
    hookId,
    installationId: data.installation.id,
    repository: data.repository?.full_name,
    senderLogin: data.sender.login,
    issueNumber: data.issue?.number,
    pullRequestNumber: data.pull_request?.number,
    checkRunId: data.check_run?.id,
    checkSuiteId: data.check_suite?.id,
    workflowRunId: data.workflow_run?.id,
    payloadSha256: createHash("sha256").update(rawBody).digest("hex"),
    receivedAt: receivedAt.toISOString(),
  });
}
