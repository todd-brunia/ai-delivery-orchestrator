import { createHash } from "node:crypto";

import { z } from "zod";

import {
  RepositoryAdapterConfigV1Schema,
  RepositoryNameSchema,
  WORKFLOW_VERSION,
  validateFeasibilityForRun,
  type RepositoryAdapterConfigV1,
} from "../../domain/sprint-delivery/v1/index.js";
import type { SprintRunRepository } from "../../persistence/index.js";
import type { GitHubReadPort, ModelAnalysisPort } from "../../providers/v1/index.js";
import {
  adapterFingerprint,
  authorizeLiveBuild,
  collectLiveWorkItemBinding,
  type LiveWorkflowRuntime,
} from "../../workflows/index.js";
import type { LiveDispatchWorker } from "./live-dispatch-worker.js";
import { withinSupervisedStage, withinSupervisedStageSync } from "./supervised-diagnostics.js";

const shaSchema = z.string().regex(/^[a-f0-9]{40}$/);
const fingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const SupervisedDispatchCommandSchema = z.discriminatedUnion("mode", [
  z.object({
    version: z.literal("supervised-dispatch-command/v1"),
    mode: z.literal("preflight"),
    repository: RepositoryNameSchema,
    issueNumber: z.number().int().positive(),
    occurredAt: z.iso.datetime({ offset: true }),
  }).strict(),
  z.object({
    version: z.literal("supervised-dispatch-command/v1"),
    mode: z.literal("execute"),
    repository: RepositoryNameSchema,
    issueNumber: z.number().int().positive(),
    occurredAt: z.iso.datetime({ offset: true }),
    authorization: z.object({
      id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/),
      preflightDigest: fingerprintSchema,
      authorizedAt: z.iso.datetime({ offset: true }),
      expiresAt: z.iso.datetime({ offset: true }),
    }).strict(),
  }).strict(),
]);
export type SupervisedDispatchCommand = z.infer<typeof SupervisedDispatchCommandSchema>;

export const SupervisedPreflightResultSchema = z.object({
  version: z.literal("supervised-dispatch-preflight/v1"),
  ready: z.boolean(),
  digest: fingerprintSchema,
  repository: RepositoryNameSchema,
  repositoryId: z.string().min(1).max(200),
  issueNumber: z.number().int().positive(),
  issueNodeId: z.string().min(1).max(200),
  planCommentId: z.string().min(1).max(200),
  planSha256: fingerprintSchema,
  defaultBranchSha: shaSchema,
  adapterFingerprint: fingerprintSchema,
  appId: z.string().min(1).max(200),
  installationId: z.string().min(1).max(200),
  workflow: z.string().regex(/^[A-Za-z0-9_.-]+\.ya?ml$/),
  authorized: z.boolean(),
  executionEnabled: z.boolean(),
  blockers: z.array(z.literal("human_approval_required")).max(1),
}).strict();
export type SupervisedPreflightResult = z.infer<typeof SupervisedPreflightResultSchema>;

export type SupervisedDispatchResult =
  | { readonly mode: "preflight"; readonly preflight: SupervisedPreflightResult }
  | {
      readonly mode: "execute";
      readonly preflight: SupervisedPreflightResult;
      readonly runId: string;
      readonly workItemId: string;
      readonly dispatchOutcome: "completed" | "retry" | "blocked" | "not_queued";
      readonly workItemState: string;
    };

/** Canonical ref/workflow reads intentionally omitted from the generic GitHub port. */
export interface SupervisedDispatchCanonicalControl {
  getDefaultBranchHead(repository: string, branch: string): Promise<{ readonly sha: string; readonly evidenceUri: string }>;
  assertWorkflowAtRef(repository: string, workflow: string, ref: string): Promise<{ readonly evidenceUri: string }>;
}

export interface SupervisedDispatchOperatorConfig {
  readonly executionEnabled: boolean;
  readonly adapter: RepositoryAdapterConfigV1;
  readonly authorizationMaximumAgeMilliseconds?: number;
}

interface OperatorDependencies {
  readonly repository: SprintRunRepository;
  readonly githubRead: GitHubReadPort;
  readonly modelAnalysis: ModelAnalysisPort;
  readonly canonicalControl: SupervisedDispatchCanonicalControl;
  readonly workflow: LiveWorkflowRuntime;
  readonly dispatchWorker: Pick<LiveDispatchWorker, "drainExact">;
}

const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
const deterministicUuid = (scope: string): string => {
  const value = digest(scope);
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-4${value.slice(13, 16)}-a${value.slice(17, 20)}-${value.slice(20, 32)}`;
};

/**
 * Two-phase, one-item operator boundary. Preflight is externally read-only. Execute
 * can only queue the exact preflighted intent and gives the mutation worker one claim.
 */
export class SupervisedDispatchOperator {
  private readonly adapter: RepositoryAdapterConfigV1;
  private readonly maximumAge: number;

  constructor(private readonly config: SupervisedDispatchOperatorConfig, private readonly dependencies: OperatorDependencies) {
    this.adapter = RepositoryAdapterConfigV1Schema.parse(config.adapter);
    this.maximumAge = config.authorizationMaximumAgeMilliseconds ?? 5 * 60_000;
    if (!Number.isSafeInteger(this.maximumAge) || this.maximumAge < 1_000 || this.maximumAge > 15 * 60_000) {
      throw new Error("supervised authorization maximum age must be from 1000 to 900000 milliseconds");
    }
  }

  async run(raw: unknown): Promise<SupervisedDispatchResult> {
    const command = withinSupervisedStageSync("configuration", () => SupervisedDispatchCommandSchema.parse(raw));
    withinSupervisedStageSync("policy", () => this.assertAudience(command.repository));
    const preflight = await this.preflight(command.issueNumber, command.occurredAt);
    if (command.mode === "preflight") return { mode: "preflight", preflight };
    withinSupervisedStageSync("execution_gate", () => this.assertAuthorization(command, preflight));

    const runId = deterministicUuid(`supervised-run:${command.authorization.id}`);
    let run = await withinSupervisedStage("database", () => this.dependencies.repository.getRun(runId));
    if (!run) {
      try {
        run = await withinSupervisedStage("database", () => this.dependencies.repository.createRun(runId, {
          workflowVersion: WORKFLOW_VERSION,
          repository: this.adapter.repository,
          issueNumbers: [command.issueNumber],
          mergePolicy: "human",
        }, new Date(command.occurredAt)));
      } catch (error) {
        run = await withinSupervisedStage("database", () => this.dependencies.repository.getRun(runId));
        if (!run) throw error;
      }
    }
    if (run.input.repository !== command.repository || run.input.issueNumbers.length !== 1 || run.input.issueNumbers[0] !== command.issueNumber) {
      throw new Error("supervised run identity collision");
    }

    const workItem = run.workItems[0];
    if (!workItem) throw new Error("supervised run has no work item");
    await withinSupervisedStage("database", () => this.recordAuthorization(workItem.id, command, preflight));
    const workflowResult = await this.dependencies.workflow.execute({
      workflowVersion: WORKFLOW_VERSION,
      providerMode: "live",
      runId,
      threadId: `supervised:${runId}`,
      defaultBranchSha: preflight.defaultBranchSha,
      adapter: this.adapter,
      occurredAt: command.occurredAt,
    });
    const outboxId = workflowResult.dispatchOutboxIds[String(command.issueNumber)];
    const outcomes = outboxId ? await this.dependencies.dispatchWorker.drainExact(outboxId) : [];
    run = await withinSupervisedStage("database", () => this.dependencies.repository.getRun(runId));
    const current = run?.workItems.find((candidate) => candidate.id === workItem.id);
    if (!current) throw new Error("supervised work item disappeared");
    return {
      mode: "execute",
      preflight,
      runId,
      workItemId: workItem.id,
      dispatchOutcome: outcomes[0]?.outcome ?? "not_queued",
      workItemState: current.state,
    };
  }

  private async preflight(issueNumber: number, occurredAt: string): Promise<SupervisedPreflightResult> {
    const branch = await withinSupervisedStage("canonical_read", () => this.dependencies.canonicalControl.getDefaultBranchHead(this.adapter.repository, this.adapter.defaultBranch));
    const defaultBranchSha = withinSupervisedStageSync("canonical_read", () => shaSchema.parse(branch.sha));
    await withinSupervisedStage("canonical_read", () => this.dependencies.canonicalControl.assertWorkflowAtRef(this.adapter.repository, this.adapter.workflows.implementation, defaultBranchSha));
    const previewRunId = deterministicUuid(`supervised-preflight:${this.adapter.repository}:${issueNumber}`);
    const previewWorkItemId = deterministicUuid(`supervised-preflight-item:${this.adapter.repository}:${issueNumber}`);
    const binding = await withinSupervisedStage("canonical_read", () => collectLiveWorkItemBinding({
      github: this.dependencies.githubRead,
      adapter: this.adapter,
      runId: previewRunId,
      workItemId: previewWorkItemId,
      issueNumber,
      defaultBranchSha,
      observedAt: occurredAt,
    }));
    const rawAnalysis = await withinSupervisedStage("model_analysis", () => this.dependencies.modelAnalysis.analyzeFeasibility({
      version: "providers/v1",
      repository: this.adapter.repository,
      issueNumbers: [issueNumber],
      planFingerprints: { [String(issueNumber)]: binding.plan.bodySha256 },
      defaultBranchSha,
    }));
    const analysis = withinSupervisedStageSync("model_analysis", () => validateFeasibilityForRun(rawAnalysis, [issueNumber]));
    const authorization = await withinSupervisedStage("policy", () => authorizeLiveBuild({ github: this.dependencies.githubRead, repository: this.adapter.repository, issueNumber, plan: binding.plan, analysis }));
    const stableEvidence = {
      repository: this.adapter.repository,
      repositoryId: binding.repositoryConfiguration.repositoryId,
      repositoryConfigurationSha256: binding.repositoryConfiguration.configurationSha256,
      issueNumber,
      issueNodeId: binding.issue.nodeId,
      issueState: binding.issue.state,
      issueUpdatedAt: binding.issue.updatedAt,
      planCommentId: binding.plan.commentId,
      planSha256: binding.plan.bodySha256,
      planUpdatedAt: binding.plan.updatedAt,
      defaultBranchSha,
      adapterFingerprint: adapterFingerprint(this.adapter),
      appId: binding.installation.appId,
      installationId: binding.installation.installationId,
      installationPermissions: binding.installation.permissions,
      workflow: this.adapter.workflows.implementation,
      analysisArtifactSha256: analysis.provenance.artifactSha256,
      authorized: authorization.authorized,
    };
    const blockers: SupervisedPreflightResult["blockers"] = [];
    if (!authorization.authorized) blockers.push("human_approval_required");
    return SupervisedPreflightResultSchema.parse({
      version: "supervised-dispatch-preflight/v1",
      ready: blockers.length === 0,
      digest: digest(stableEvidence),
      repository: this.adapter.repository,
      repositoryId: binding.repositoryConfiguration.repositoryId,
      issueNumber,
      issueNodeId: binding.issue.nodeId,
      planCommentId: binding.plan.commentId,
      planSha256: binding.plan.bodySha256,
      defaultBranchSha,
      adapterFingerprint: stableEvidence.adapterFingerprint,
      appId: binding.installation.appId,
      installationId: binding.installation.installationId,
      workflow: this.adapter.workflows.implementation,
      authorized: authorization.authorized,
      executionEnabled: this.config.executionEnabled,
      blockers,
    });
  }

  private assertAudience(repository: string): void {
    if (repository !== this.adapter.repository) throw new Error("repository is outside supervised adapter audience");
    if (!this.adapter.enabled) throw new Error("repository automation is disabled");
  }

  private assertAuthorization(command: Extract<SupervisedDispatchCommand, { mode: "execute" }>, preflight: SupervisedPreflightResult): void {
    if (!this.config.executionEnabled) throw new Error("supervised dispatch execution is disabled");
    if (!preflight.ready) throw new Error(`supervised preflight is blocked: ${preflight.blockers.join(",")}`);
    if (command.authorization.preflightDigest !== preflight.digest) throw new Error("supervised authorization does not bind the current preflight");
    const occurredAt = Date.parse(command.occurredAt);
    const authorizedAt = Date.parse(command.authorization.authorizedAt);
    const expiresAt = Date.parse(command.authorization.expiresAt);
    if (authorizedAt > occurredAt || expiresAt <= occurredAt || expiresAt - authorizedAt > this.maximumAge) {
      throw new Error("supervised authorization is stale or invalid");
    }
  }

  private async recordAuthorization(workItemId: string, command: Extract<SupervisedDispatchCommand, { mode: "execute" }>, preflight: SupervisedPreflightResult): Promise<void> {
    if (!this.dependencies.repository.recordWorkflowNodeResult) throw new Error("supervised dispatch requires durable workflow-node evidence");
    const idempotencyKey = `supervised:${command.authorization.id}`;
    const prior = await this.dependencies.repository.getWorkflowNodeResult?.(workItemId, "supervised_authorization", idempotencyKey);
    if (prior) {
      if (prior.inputFingerprint !== preflight.digest) throw new Error("supervised authorization was already used for different evidence");
      return;
    }
    await this.dependencies.repository.recordWorkflowNodeResult({
      workItemId,
      node: "supervised_authorization",
      idempotencyKey,
      inputFingerprint: preflight.digest,
      output: { authorizationId: command.authorization.id, authorizedAt: command.authorization.authorizedAt, expiresAt: command.authorization.expiresAt },
      recordedAt: command.occurredAt,
    });
  }
}
