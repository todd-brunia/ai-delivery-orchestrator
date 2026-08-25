import type { CanonicalCheck, CanonicalIssue, CanonicalPlan, CanonicalPullRequest, FeasibilityRequest, FeasibilityResult, GitHubMutationIntent, PullRequestReviewRequest, PullRequestReviewResult } from "./contracts.js";

export interface GitHubReadPort {
  getIssue(repository: string, number: number): Promise<CanonicalIssue>;
  getPullRequest(repository: string, number: number): Promise<CanonicalPullRequest>;
  getMarkedPlan(repository: string, number: number): Promise<CanonicalPlan>;
  getChecks(repository: string, headSha: string): Promise<readonly CanonicalCheck[]>;
}
export interface GitHubMutationPort { propose(intent: GitHubMutationIntent): Promise<{ readonly accepted: true; readonly intentId: string }>; }
export interface ModelAnalysisPort { analyzeFeasibility(request: FeasibilityRequest): Promise<FeasibilityResult>; reviewPullRequest(request: PullRequestReviewRequest): Promise<PullRequestReviewResult>; }
export interface ProviderSet { readonly githubRead: GitHubReadPort; readonly githubMutation: GitHubMutationPort; readonly modelAnalysis: ModelAnalysisPort; }
