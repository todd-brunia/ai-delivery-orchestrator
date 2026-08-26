import { z } from "zod";
import { CanonicalGitHubArtifactSource } from "./canonical-artifacts.js";
import { OpenAiAnalysisAdapter, type OpenAiApiKeySource, type OpenAiHttpTransport } from "./openai-analysis.js";
import { OpenAiAnalysisConfigV1Schema } from "./contracts.js";
import type { ProviderSet } from "./ports.js";
import { StubGitHubMutationAdapter, StubGitHubReadAdapter, StubModelAnalysisAdapter } from "./stubs.js";

export const EnabledProviderModeSchema = z.enum(["stub", "openai-analysis"]);
export interface OpenAiAnalysisDependencies { readonly githubRead: ProviderSet["githubRead"]; readonly apiKeys: OpenAiApiKeySource; readonly transport: OpenAiHttpTransport; readonly config: unknown; }
export function createProviderSet(mode: unknown, dependencies?: OpenAiAnalysisDependencies): ProviderSet {
  const enabled = EnabledProviderModeSchema.parse(mode);
  if (enabled === "stub") return { githubRead: new StubGitHubReadAdapter(), githubMutation: new StubGitHubMutationAdapter(), modelAnalysis: new StubModelAnalysisAdapter() };
  if (!dependencies) throw new Error("openai-analysis provider mode requires explicit dependencies");
  const config = OpenAiAnalysisConfigV1Schema.parse(dependencies.config);
  return { githubRead: dependencies.githubRead, githubMutation: new StubGitHubMutationAdapter(), modelAnalysis: new OpenAiAnalysisAdapter(config, dependencies.apiKeys, new CanonicalGitHubArtifactSource(dependencies.githubRead), dependencies.transport) };
}
