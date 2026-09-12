import { z } from "zod";

const id = z.string().regex(/^[1-9][0-9]{0,19}$/);
const sha = z.string().regex(/^[a-f0-9]{40}$/);
export const CallbackPullRequestSchema = z.object({
  number: z.number().int().positive(), nodeId: z.string().regex(/^[A-Za-z0-9_=-]{1,200}$/),
  repositoryId: id, headRepositoryId: id, branch: z.string().min(1).max(255),
  baseBranch: z.string().min(1).max(255), baseSha: sha, headSha: sha,
  open: z.boolean(), marker: z.string().regex(/^orchestrator:[a-f0-9-]{36}:[a-f0-9-]{36}:[a-f0-9]{64}$/),
}).strict();
export type CallbackPullRequest = z.infer<typeof CallbackPullRequestSchema>;
export const CallbackWorkflowSchema = z.object({
  id, workflowId: id, attempt: z.number().int().positive(), path: z.string().min(1).max(255),
  repositoryId: id, headSha: sha, event: z.literal("workflow_dispatch"),
  marker: z.string().min(1).max(500),
  status: z.enum(["queued", "requested", "waiting", "pending", "in_progress", "completed"]),
  conclusion: z.enum(["success", "failure", "cancelled", "skipped", "neutral", "timed_out", "action_required", "stale", "startup_failure"]).nullable(),
}).strict();
export type CallbackWorkflow = z.infer<typeof CallbackWorkflowSchema>;
export interface CallbackReadPort {
  getCallbackWorkflow(repository: string, runId: string): Promise<CallbackWorkflow>;
  getCallbackPullRequest(repository: string, number: number): Promise<CallbackPullRequest>;
  findCallbackPullRequests(repository: string, branch: string): Promise<readonly CallbackPullRequest[]>;
  getCallbackCheckPullRequests(repository: string, kind: "check_run" | "check_suite", id: number): Promise<{ readonly pullRequestNumbers: readonly number[]; readonly headSha: string }>;
  getDefaultBranchHead(repository: string, branch: string): Promise<{ readonly sha: string }>;
}
