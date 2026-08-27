import type { GitHubExecutionIntent } from "./contracts.js";
import type { MutationReconciler } from "./github-mutation.js";
import type { GitHubReadPort } from "./ports.js";

const equal = (left: readonly string[], right: readonly string[]) => [...left].sort().join("\u0000") === [...right].sort().join("\u0000");

/** Uses fresh canonical observations; uncertain effects deliberately remain blocked. */
export class CanonicalMutationReconciler implements MutationReconciler {
  constructor(private readonly github: GitHubReadPort, private readonly reviewerLogin: string) {}

  async reconcile(intent: GitHubExecutionIntent): Promise<"confirmed" | "absent" | "ambiguous"> {
    switch (intent.type) {
      case "set_labels": {
        const issue = await this.github.getIssue(intent.repository, intent.issueNumber);
        return equal(issue.labels, intent.labels) ? "confirmed" : "absent";
      }
      case "mark_ready_for_review": {
        const pullRequest = await this.github.getPullRequest(intent.repository, intent.pullRequestNumber);
        return pullRequest.state === "open" && pullRequest.headSha === intent.expectedHeadSha && !pullRequest.draft ? "confirmed" : "absent";
      }
      case "submit_review": {
        const expectedState = intent.event === "COMMENT" ? "COMMENTED" : "CHANGES_REQUESTED";
        const matches = (await this.github.getReviews(intent.repository, intent.pullRequestNumber)).filter((review) => review.headSha === intent.expectedHeadSha && review.authorLogin === this.reviewerLogin && review.state === expectedState);
        return matches.length === 1 ? "confirmed" : "ambiguous";
      }
      case "dispatch_workflow":
        // GitHub does not give this intent a durable idempotency key; a same-ref run is not proof of this dispatch.
        await this.github.getWorkflowRuns(intent.repository, intent.ref);
        return "ambiguous";
    }
  }
}
