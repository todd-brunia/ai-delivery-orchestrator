import { createHash } from "node:crypto";

import type { FeasibilityRequest, ModelArtifact, PullRequestReviewRequest } from "./contracts.js";
import { ModelArtifactSchema } from "./contracts.js";
import type { GitHubReadPort } from "./ports.js";
import type { ModelArtifactSource } from "./openai-analysis.js";

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

/** Builds model input only from fresh, canonical GitHub observations. */
export class CanonicalGitHubArtifactSource implements ModelArtifactSource {
  constructor(private readonly github: GitHubReadPort) {}

  async load(request: FeasibilityRequest | PullRequestReviewRequest): Promise<ModelArtifact> {
    if ("issueNumbers" in request) {
      const numbers = [...request.issueNumbers].sort((left, right) => left - right);
      const observations = await Promise.all(numbers.map(async (number) => {
        const [issue, plan] = await Promise.all([this.github.getIssue(request.repository, number), this.github.getMarkedPlan(request.repository, number)]);
        if (issue.state !== "open" || request.planFingerprints[String(number)] !== plan.bodySha256) throw new Error("canonical issue or plan drifted");
        return { number, title: issue.title, body: issue.body, labels: [...issue.labels].sort(), updatedAt: issue.updatedAt, plan: { commentId: plan.commentId, bodySha256: plan.bodySha256, updatedAt: plan.updatedAt } };
      }));
      const bytes = JSON.stringify({ version: "model-artifact/v1", kind: "issue_bundle", repository: request.repository, defaultBranchSha: request.defaultBranchSha, issues: observations });
      return ModelArtifactSchema.parse({ kind: "issue_bundle", sha256: digest(bytes), bytes });
    }

    const [pullRequest, diff] = await Promise.all([
      this.github.getPullRequest(request.repository, request.pullRequestNumber),
      this.github.getExactDiff(request.repository, request.baseSha, request.headSha),
    ]);
    if (pullRequest.state !== "open" || pullRequest.baseSha !== request.baseSha || pullRequest.headSha !== request.headSha || diff.sha256 !== request.diffSha256) throw new Error("canonical pull request or diff drifted");
    return ModelArtifactSchema.parse({ kind: "exact_pull_request_diff", sha256: diff.sha256, bytes: JSON.stringify({ version: "model-artifact/v1", repository: request.repository, pullRequestNumber: request.pullRequestNumber, baseSha: request.baseSha, headSha: request.headSha, files: diff.files }) });
  }
}
