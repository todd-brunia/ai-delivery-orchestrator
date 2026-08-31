import { z } from "zod";

import { RepositoryNameSchema } from "../../../domain/sprint-delivery/v1/index.js";

export const GITHUB_WEBHOOK_VERSION = "github-webhook/v1" as const;
/**
 * Callback processing deliberately has its own version boundary.  The ingress
 * envelope only proves receipt; this contract carries the small, sanitized set
 * of untrusted routing hints that a later canonical resolver may consider.
 */
export const GITHUB_CALLBACK_VERSION = "github-callback/v1" as const;

export const GitHubEventNameSchema = z.enum([
  "issues", "pull_request", "pull_request_review", "check_run", "check_suite",
  "workflow_run", "installation", "installation_repositories",
]);

export const NormalizedGitHubEventSchema = z.object({
  version: z.literal(GITHUB_WEBHOOK_VERSION),
  deliveryId: z.uuid(),
  eventName: GitHubEventNameSchema,
  action: z.string().trim().min(1).max(100),
  hookId: z.number().int().positive(),
  installationId: z.number().int().positive(),
  repository: RepositoryNameSchema.optional(),
  senderLogin: z.string().trim().min(1).max(200),
  issueNumber: z.number().int().positive().optional(),
  pullRequestNumber: z.number().int().positive().optional(),
  checkRunId: z.number().int().positive().optional(),
  checkSuiteId: z.number().int().positive().optional(),
  workflowRunId: z.number().int().positive().optional(),
  payloadSha256: z.string().regex(/^[a-f0-9]{64}$/),
  receivedAt: z.iso.datetime({ offset: true }),
}).strict().superRefine((event, context) => {
  const required: Partial<Record<typeof event.eventName, keyof typeof event>> = {
    issues: "issueNumber",
    pull_request: "pullRequestNumber",
    pull_request_review: "pullRequestNumber",
    check_run: "checkRunId",
    check_suite: "checkSuiteId",
    workflow_run: "workflowRunId",
  };
  const correlation = required[event.eventName];
  if (correlation && event[correlation] === undefined) {
    context.addIssue({ code: "custom", path: [correlation], message: `${correlation} is required for ${event.eventName}` });
  }
  if (!event.eventName.startsWith("installation") && !event.repository) {
    context.addIssue({ code: "custom", path: ["repository"], message: "repository is required for repository events" });
  }
});

export type NormalizedGitHubEvent = z.infer<typeof NormalizedGitHubEventSchema>;

export const CallbackRoutingMetadataSchema = z.object({
  version: z.literal(GITHUB_CALLBACK_VERSION),
  deliveryId: z.uuid(),
  eventName: GitHubEventNameSchema,
  action: z.string().trim().min(1).max(100),
  hookId: z.number().int().positive(),
  installationId: z.number().int().positive(),
  repository: RepositoryNameSchema.optional(),
  payloadSha256: z.string().regex(/^[a-f0-9]{64}$/),
  receivedAt: z.iso.datetime({ offset: true }),
  configurationVersion: z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9._:/-]+$/),
  issueNumber: z.number().int().positive().optional(),
  pullRequestNumber: z.number().int().positive().optional(),
  checkRunId: z.number().int().positive().optional(),
  checkSuiteId: z.number().int().positive().optional(),
  workflowRunId: z.number().int().positive().optional(),
}).strict();

export type CallbackRoutingMetadata = z.infer<typeof CallbackRoutingMetadataSchema>;

export function toCallbackRoutingMetadata(
  event: NormalizedGitHubEvent,
  configurationVersion: string,
): CallbackRoutingMetadata {
  return CallbackRoutingMetadataSchema.parse({
    version: GITHUB_CALLBACK_VERSION,
    deliveryId: event.deliveryId,
    eventName: event.eventName,
    action: event.action,
    hookId: event.hookId,
    installationId: event.installationId,
    repository: event.repository,
    payloadSha256: event.payloadSha256,
    receivedAt: event.receivedAt,
    configurationVersion,
    issueNumber: event.issueNumber,
    pullRequestNumber: event.pullRequestNumber,
    checkRunId: event.checkRunId,
    checkSuiteId: event.checkSuiteId,
    workflowRunId: event.workflowRunId,
  });
}

export interface GitHubWebhookHeaders {
  readonly deliveryId: string;
  readonly eventName: string;
  readonly hookId: string;
  readonly signature256: string;
}
