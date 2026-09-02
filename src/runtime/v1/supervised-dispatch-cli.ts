import { readFile } from "node:fs/promises";

import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { Pool } from "pg";
import { z } from "zod";

import { RepositoryAdapterConfigV1Schema } from "../../domain/sprint-delivery/v1/index.js";
import { PostgresSprintRunRepository } from "../../persistence/index.js";
import {
  CanonicalGitHubArtifactSource,
  CanonicalMutationPreflight,
  CanonicalMutationReconciler,
  GitHubAppMutationTransport,
  GitHubAppReadAdapter,
  GitHubMutationExecutor,
  GitHubMutationOutboxConsumer,
  OpenAiAnalysisAdapter,
  type GitHubHttpTransport,
  type GitHubMutationHttpTransport,
  type OpenAiHttpTransport,
} from "../../providers/v1/index.js";
import { createDispatchAcceptanceHandler, createLiveBindingWorkflowRuntime } from "../../workflows/index.js";
import { LiveDispatchWorker } from "./live-dispatch-worker.js";
import { RuntimeGenerationControl } from "./queue-consumer.js";
import { SupervisedDispatchCommandSchema, SupervisedDispatchOperator } from "./supervised-dispatch.js";
import { supervisedFailureDiagnostic, withinSupervisedStage, withinSupervisedStageSync } from "./supervised-diagnostics.js";

const EnvironmentSchema = z.object({
  SUPERVISED_DISPATCH_ENABLED: z.enum(["true", "false"]).default("false"),
  SUPERVISED_COMMAND_JSON: z.string().min(2).max(16_384),
  REPOSITORY_ADAPTER_JSON: z.string().min(2).max(32_768),
  GITHUB_REPOSITORY_ID: z.string().regex(/^[1-9][0-9]{0,19}$/),
  GITHUB_APP_ID: z.string().regex(/^[1-9][0-9]{0,19}$/),
  GITHUB_INSTALLATION_ID: z.string().regex(/^[1-9][0-9]{0,19}$/),
  GITHUB_INSTALLATION_ACCOUNT: z.string().regex(/^[A-Za-z0-9-]{1,39}$/),
  OPENAI_PROJECT_ID: z.string().regex(/^proj_[A-Za-z0-9_-]{8,100}$/),
  PGHOST: z.string().min(1).max(253),
  PGPORT: z.coerce.number().int().min(1).max(65535).default(5432),
  PGDATABASE: z.literal("orchestrator"),
  PGUSER: z.string().min(1).max(100),
  PGPASSWORD: z.string().min(1).max(1_000),
  AWS_REGION: z.literal("us-east-1").default("us-east-1"),
}).passthrough();

const githubKeyReference = "ai-delivery-orchestrator/pilot/github-app-builder-private-key";
const openAiKeyReference = "ai-delivery-orchestrator/pilot/portal-openai-builder-api-key";

class ExactSecretSource {
  constructor(private readonly client: SecretsManagerClient, private readonly allowed: ReadonlySet<string>) {}
  async load(reference: string): Promise<string> {
    return withinSupervisedStage("secret_access", async () => {
      if (!this.allowed.has(reference)) throw new Error("secret reference is outside the supervised allowlist");
      const result = await this.client.send(new GetSecretValueCommand({ SecretId: reference, VersionStage: "AWSCURRENT" }));
      if (!result.SecretString) throw new Error("supervised secret value is unavailable");
      return result.SecretString;
    });
  }
}

async function fetchText(input: { readonly method: string; readonly url: string; readonly headers: Readonly<Record<string, string>>; readonly body?: string; readonly timeoutMilliseconds: number }): Promise<{ status: number; headers: Readonly<Record<string, string | undefined>>; body: string }> {
  const response = await fetch(input.url, { method: input.method, headers: input.headers, ...(input.body === undefined ? {} : { body: input.body }), signal: AbortSignal.timeout(input.timeoutMilliseconds) });
  return { status: response.status, headers: { link: response.headers.get("link") ?? undefined, "x-ratelimit-remaining": response.headers.get("x-ratelimit-remaining") ?? undefined, "x-github-request-id": response.headers.get("x-github-request-id") ?? undefined }, body: await response.text() };
}

const githubHttp: GitHubHttpTransport = { request: (input) => fetchText(input) };
const mutationHttp: GitHubMutationHttpTransport = { request: (input) => fetchText(input) };
const openAiHttp: OpenAiHttpTransport = { request: async (input) => {
  const response = await fetchText({ method: "POST", ...input });
  return { status: response.status, body: response.body };
} };

async function main(): Promise<void> {
  const environment = withinSupervisedStageSync("configuration", () => EnvironmentSchema.parse(process.env));
  const command = withinSupervisedStageSync("configuration", () => SupervisedDispatchCommandSchema.parse(JSON.parse(environment.SUPERVISED_COMMAND_JSON) as unknown));
  const adapter = withinSupervisedStageSync("configuration", () => RepositoryAdapterConfigV1Schema.parse(JSON.parse(environment.REPOSITORY_ADAPTER_JSON) as unknown));
  withinSupervisedStageSync("policy", () => {
    if (command.repository !== adapter.repository) throw new Error("command repository is outside configured adapter");
  });
  const secrets = new ExactSecretSource(new SecretsManagerClient({ region: environment.AWS_REGION }), new Set([githubKeyReference, openAiKeyReference]));
  const githubRead = new GitHubAppReadAdapter({
    version: "github-read/v1", repository: adapter.repository, repositoryId: environment.GITHUB_REPOSITORY_ID,
    appId: environment.GITHUB_APP_ID, installationId: environment.GITHUB_INSTALLATION_ID,
    installationAccount: environment.GITHUB_INSTALLATION_ACCOUNT, apiBaseUrl: "https://api.github.com",
    apiVersion: "2022-11-28", maxPages: 10, maxItems: 100, maxResponseBytes: 1_000_000,
    timeoutMilliseconds: 10_000, tokenTtlSeconds: 600,
    requiredPermissions: { actions: "read", contents: "read", issues: "read", metadata: "read", pull_requests: "read" },
  }, githubKeyReference, secrets, githubHttp);
  const modelAnalysis = new OpenAiAnalysisAdapter({
    version: "openai-analysis/v1", projectId: environment.OPENAI_PROJECT_ID,
    credentialReference: openAiKeyReference, timeoutMilliseconds: 30_000, maxRetries: 1, maxOutputTokens: 4_096,
  }, secrets, new CanonicalGitHubArtifactSource(githubRead), openAiHttp);
  const certificate = await readFile(new URL("../../../certificates/us-east-1-bundle.pem", import.meta.url), "utf8");
  const pool = new Pool({ host: environment.PGHOST, port: environment.PGPORT, database: environment.PGDATABASE, user: environment.PGUSER, password: environment.PGPASSWORD, ssl: { ca: certificate, rejectUnauthorized: true }, max: 2 });
  try {
    const repository = new PostgresSprintRunRepository(pool);
    const preflight = new CanonicalMutationPreflight({
      version: "github-mutation-policy/v1", repository: adapter.repository, repositoryId: environment.GITHUB_REPOSITORY_ID,
      appId: environment.GITHUB_APP_ID, installationId: environment.GITHUB_INSTALLATION_ID,
      enabledOperations: ["dispatch_workflow"], workflowLabels: [], workflows: [adapter.workflows.implementation],
    }, githubRead);
    const transport = new GitHubAppMutationTransport({
      version: "github-mutation-transport/v1", repository: adapter.repository, appId: environment.GITHUB_APP_ID,
      installationId: environment.GITHUB_INSTALLATION_ID, actorRole: "builder", apiBaseUrl: "https://api.github.com",
      apiVersion: "2022-11-28", timeoutMilliseconds: 10_000, permissions: { actions: "write", issues: "write" },
    }, githubKeyReference, secrets, mutationHttp);
    const executor = new GitHubMutationExecutor(preflight, transport, new Set(["dispatch_workflow"]), () => new Date(), new CanonicalMutationReconciler(githubRead, ""));
    const acceptance = createDispatchAcceptanceHandler(repository, githubRead);
    const consumer = new GitHubMutationOutboxConsumer(repository, executor, "supervised-dispatch/v1", 60_000, () => new Date(), acceptance);
    const control = new RuntimeGenerationControl();
    if (environment.SUPERVISED_DISPATCH_ENABLED !== "true") control.drain(0);
    const operator = new SupervisedDispatchOperator({ executionEnabled: environment.SUPERVISED_DISPATCH_ENABLED === "true", adapter }, {
      repository, githubRead, modelAnalysis, canonicalControl: githubRead,
      workflow: createLiveBindingWorkflowRuntime(repository, { githubRead, modelAnalysis }),
      dispatchWorker: new LiveDispatchWorker(control, consumer),
    });
    const result = await operator.run(command);
    process.stdout.write(`${JSON.stringify({ event: "supervised_dispatch_result", result })}\n`);
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify(supervisedFailureDiagnostic(error))}\n`);
  process.exitCode = 1;
});
