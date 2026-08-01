import { z } from "zod";
import type { ProviderSet } from "./ports.js";
import { StubGitHubMutationAdapter, StubGitHubReadAdapter, StubModelAnalysisAdapter } from "./stubs.js";

export const EnabledProviderModeSchema = z.literal("stub");
export function createProviderSet(mode: unknown): ProviderSet { EnabledProviderModeSchema.parse(mode); return { githubRead: new StubGitHubReadAdapter(), githubMutation: new StubGitHubMutationAdapter(), modelAnalysis: new StubModelAnalysisAdapter() }; }
