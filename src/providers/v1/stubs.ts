import { CanonicalIssueSchema, CanonicalPullRequestSchema, FeasibilityRequestSchema, FeasibilityResultSchema, GitHubMutationIntentSchema, PullRequestReviewRequestSchema, PullRequestReviewResultSchema, type CanonicalIssue, type CanonicalPullRequest, type FeasibilityResult, type GitHubMutationIntent, type PullRequestReviewResult } from "./contracts.js";
import type { GitHubMutationPort, GitHubReadPort, ModelAnalysisPort } from "./ports.js";

const clone = <T>(value: T): T => structuredClone(value);
const key = (repository: string, number: number) => `${repository}#${number}`;

export class StubGitHubReadAdapter implements GitHubReadPort {
  private readonly issues = new Map<string, CanonicalIssue>(); private readonly pullRequests = new Map<string, CanonicalPullRequest>();
  registerIssue(value: unknown): void { const issue = CanonicalIssueSchema.parse(value); this.issues.set(key(issue.repository, issue.number), clone(issue)); }
  registerPullRequest(value: unknown): void { const pullRequest = CanonicalPullRequestSchema.parse(value); this.pullRequests.set(key(pullRequest.repository, pullRequest.number), clone(pullRequest)); }
  async getIssue(repository: string, number: number): Promise<CanonicalIssue> { await Promise.resolve(); const value = this.issues.get(key(repository, number)); if (!value) throw new Error("missing stub issue fixture"); return clone(value); }
  async getPullRequest(repository: string, number: number): Promise<CanonicalPullRequest> { await Promise.resolve(); const value = this.pullRequests.get(key(repository, number)); if (!value) throw new Error("missing stub pull request fixture"); return clone(value); }
}

export class StubGitHubMutationAdapter implements GitHubMutationPort {
  private readonly captured: GitHubMutationIntent[] = [];
  async propose(raw: GitHubMutationIntent) { await Promise.resolve(); const intent = GitHubMutationIntentSchema.parse(raw); this.captured.push(clone(intent)); return { accepted: true as const, intentId: intent.idempotencyKey }; }
  invocations(): readonly GitHubMutationIntent[] { return clone(this.captured); }
}

export class StubModelAnalysisAdapter implements ModelAnalysisPort {
  private readonly feasibility = new Map<string, FeasibilityResult>(); private readonly reviews = new Map<string, PullRequestReviewResult>(); private readonly captured: unknown[] = [];
  registerFeasibility(fingerprint: string, value: unknown): void { this.feasibility.set(fingerprint, FeasibilityResultSchema.parse(value)); }
  registerReview(diffSha256: string, value: unknown): void { this.reviews.set(diffSha256, PullRequestReviewResultSchema.parse(value)); }
  async analyzeFeasibility(raw: Parameters<ModelAnalysisPort["analyzeFeasibility"]>[0]): Promise<FeasibilityResult> { await Promise.resolve(); const request = FeasibilityRequestSchema.parse(raw); this.captured.push(clone(request)); const fingerprint = Object.values(request.planFingerprints).sort().join(":"); const result = this.feasibility.get(fingerprint); if (!result) throw new Error("missing stub feasibility fixture"); return clone(result); }
  async reviewPullRequest(raw: Parameters<ModelAnalysisPort["reviewPullRequest"]>[0]): Promise<PullRequestReviewResult> { await Promise.resolve(); const request = PullRequestReviewRequestSchema.parse(raw); this.captured.push(clone(request)); const result = this.reviews.get(request.diffSha256); if (!result) throw new Error("missing stub review fixture"); return clone(result); }
  invocations(): readonly unknown[] { return clone(this.captured); }
}
