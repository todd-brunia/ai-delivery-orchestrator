import type { CanonicalCheck, CanonicalDiff, CanonicalInstallation, CanonicalIssue, CanonicalPlan, CanonicalPullRequest, CanonicalRepositoryConfiguration, CanonicalReview, CanonicalWorkflowRun, FeasibilityRequest, FeasibilityResult, GitHubMutationIntent, PullRequestReviewRequest, PullRequestReviewResult } from "./contracts.js";

export interface GitHubReadPort {
  getIssue(repository: string, number: number): Promise<CanonicalIssue>;
  getPullRequest(repository: string, number: number): Promise<CanonicalPullRequest>;
  getMarkedPlan(repository: string, number: number): Promise<CanonicalPlan>;
  getChecks(repository: string, headSha: string): Promise<readonly CanonicalCheck[]>;
  getExactDiff(repository: string, baseSha: string, headSha: string): Promise<CanonicalDiff>;
  getReviews(repository: string, pullRequestNumber: number): Promise<readonly CanonicalReview[]>;
  getWorkflowRuns(repository: string, headSha: string): Promise<readonly CanonicalWorkflowRun[]>;
  getRepositoryConfiguration(repository: string): Promise<CanonicalRepositoryConfiguration>;
  getInstallation(repository: string): Promise<CanonicalInstallation>;
}
export interface GitHubMutationPort { propose(intent: GitHubMutationIntent): Promise<{ readonly accepted: true; readonly intentId: string }>; }
export interface ModelAnalysisPort { analyzeFeasibility(request: FeasibilityRequest): Promise<FeasibilityResult>; reviewPullRequest(request: PullRequestReviewRequest): Promise<PullRequestReviewResult>; }
export interface ProviderSet { readonly githubRead: GitHubReadPort; readonly githubMutation: GitHubMutationPort; readonly modelAnalysis: ModelAnalysisPort; }
