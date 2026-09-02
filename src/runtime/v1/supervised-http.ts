import { GitHubReadError, type GitHubHttpTransport } from "../../providers/v1/index.js";

type GitHubReadRequest = Parameters<GitHubHttpTransport["request"]>[0];
type GitHubReadResponse = Awaited<ReturnType<GitHubHttpTransport["request"]>>;

/** Maps only rejected supervised GitHub fetches to a static provider category. */
export function createSupervisedGitHubReadTransport(
  request: (input: GitHubReadRequest) => Promise<GitHubReadResponse>,
): GitHubHttpTransport {
  return {
    async request(input) {
      try {
        return await request(input);
      } catch {
        throw new GitHubReadError("transport", "GitHub request transport failed");
      }
    },
  };
}
