import { createHash } from "node:crypto";

import { GitHubMutationPolicyV1Schema, type GitHubExecutionIntent, type GitHubMutationPolicyV1 } from "./contracts.js";
import type { GitHubReadPort } from "./ports.js";
import type { MutationPreflight, MutationReconciler } from "./github-mutation.js";

const fingerprint = (value: unknown): string => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
const sorted = (values: readonly string[]) => [...values].sort();
const sortedRecord = (value: Readonly<Record<string, string>>) => Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));

export function fingerprintCanonicalDispatchState(input: {
  readonly installation: { readonly appId: string; readonly installationId: string; readonly permissions: Readonly<Record<string, string>> };
  readonly configurationSha256: string;
  readonly issue: { readonly number: number; readonly state: string; readonly labels: readonly string[]; readonly updatedAt: string };
  readonly planSha256: string;
}): string {
  return fingerprint({
    installation: { appId: input.installation.appId, installationId: input.installation.installationId, permissions: sortedRecord(input.installation.permissions) },
    configuration: input.configurationSha256,
    issue: { number: input.issue.number, state: input.issue.state, labels: sorted(input.issue.labels), updatedAt: input.issue.updatedAt, plan: input.planSha256 },
  });
}

/** Read-only policy and freshness check. It does not load a credential or perform a mutation. */
export class CanonicalMutationPreflight implements MutationPreflight {
  private readonly policy: GitHubMutationPolicyV1;

  constructor(rawPolicy: unknown, private readonly github: GitHubReadPort) {
    this.policy = GitHubMutationPolicyV1Schema.parse(rawPolicy);
  }

  async assertCurrent(intent: GitHubExecutionIntent): Promise<void> {
    if (intent.repository !== this.policy.repository || intent.repositoryId !== this.policy.repositoryId || !this.policy.enabledOperations.includes(intent.type)) throw new Error("mutation policy rejected intent");
    if ((intent.actorRole === "reviewer") !== (intent.type === "submit_review")) throw new Error("mutation actor does not match operation");
    if (intent.type === "set_labels" && intent.labels.some((label) => !this.policy.workflowLabels.includes(label))) throw new Error("mutation label is not allowlisted");
    if (intent.type === "dispatch_workflow" && !this.policy.workflows.includes(intent.workflow)) throw new Error("mutation workflow is not allowlisted");

    const [installation, configuration] = await Promise.all([
      this.github.getInstallation(intent.repository),
      this.github.getRepositoryConfiguration(intent.repository),
    ]);
    if (installation.appId !== this.policy.appId || installation.installationId !== this.policy.installationId || installation.repositoryId !== intent.repositoryId || configuration.repositoryId !== intent.repositoryId) throw new Error("GitHub installation or repository drifted");

    let expectedState: string | undefined;
    if (intent.type === "set_labels" || intent.type === "dispatch_workflow") {
      const [issue, plan] = await Promise.all([this.github.getIssue(intent.repository, intent.issueNumber), this.github.getMarkedPlan(intent.repository, intent.issueNumber)]);
      if (issue.state !== "open") throw new Error("GitHub issue is closed");
      expectedState = fingerprintCanonicalDispatchState({ installation, configurationSha256: configuration.configurationSha256, issue, planSha256: plan.bodySha256 });
    }
    if (intent.type === "submit_review" || intent.type === "mark_ready_for_review") {
      const pullRequest = await this.github.getPullRequest(intent.repository, intent.pullRequestNumber);
      if (pullRequest.state !== "open" || pullRequest.headSha !== intent.expectedHeadSha || (intent.type === "mark_ready_for_review" && !pullRequest.draft)) throw new Error("GitHub pull request drifted");
      const checks = await this.github.getChecks(intent.repository, pullRequest.headSha);
      expectedState = fingerprint({ installation: { appId: installation.appId, installationId: installation.installationId, permissions: sortedRecord(installation.permissions) }, configuration: configuration.configurationSha256, pullRequest: { number: pullRequest.number, baseSha: pullRequest.baseSha, headSha: pullRequest.headSha, draft: pullRequest.draft, checks: checks.map((check) => ({ name: check.name, status: check.status, conclusion: check.conclusion })).sort((left, right) => left.name.localeCompare(right.name)) } });
    }
    if (expectedState !== intent.expectedStateSha256) throw new Error("canonical GitHub state fingerprint drifted");
  }
}

/** Until each operation has a dedicated proof of effect, ambiguous outcomes never authorize a resend. */
export class NoBlindRetryReconciler implements MutationReconciler {
  constructor(private readonly preflight: MutationPreflight) {}
  async reconcile(intent: GitHubExecutionIntent): Promise<"ambiguous"> {
    await this.preflight.assertCurrent(intent);
    return "ambiguous";
  }
}

export { fingerprint as fingerprintCanonicalMutationState };
