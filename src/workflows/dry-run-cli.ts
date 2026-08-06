import { readFile } from "node:fs/promises";

import { Pool } from "pg";
import { z } from "zod";

import { SprintRunInputSchema } from "../domain/sprint-delivery/v1/index.js";
import { migrate, PostgresSprintRunRepository } from "../persistence/index.js";
import { CanonicalIssueSchema, FeasibilityResultSchema, StubGitHubMutationAdapter, StubGitHubReadAdapter, StubModelAnalysisAdapter } from "../providers/v1/index.js";
import { setupPostgresCheckpoints } from "./checkpoints.js";
import { DryRunWorkflowRequestSchema } from "./contracts.js";
import { createSprintDeliveryV1Runtime } from "./sprint-delivery-v1.js";

const FixtureSchema = z.object({
  run: SprintRunInputSchema,
  request: DryRunWorkflowRequestSchema,
  issues: z.array(CanonicalIssueSchema).min(1),
  feasibility: FeasibilityResultSchema,
}).strict();

const fixturePath = process.argv[2];
if (!fixturePath) throw new Error("usage: npm run dry-run:schedule -- <fixture.json>");
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for local PostgreSQL");
const databaseUrl = new URL(connectionString);
if (!new Set(["localhost", "127.0.0.1", "::1"]).has(databaseUrl.hostname)) {
  throw new Error("dry-run scheduling only permits a local PostgreSQL host");
}

const fixture = FixtureSchema.parse(JSON.parse(await readFile(fixturePath, "utf8")));
if (fixture.run.repository !== fixture.issues[0]?.repository) throw new Error("fixture repositories must match");
const pool = new Pool({ connectionString });
try {
  await migrate(pool);
  const repository = new PostgresSprintRunRepository(pool);
  if (!await repository.getRun(fixture.request.runId)) await repository.createRun(fixture.request.runId, fixture.run, new Date(fixture.request.occurredAt));
  const githubRead = new StubGitHubReadAdapter();
  for (const issue of fixture.issues) githubRead.registerIssue(issue);
  const modelAnalysis = new StubModelAnalysisAdapter();
  modelAnalysis.registerFeasibility(Object.values(fixture.request.planFingerprints).sort().join(":"), fixture.feasibility);
  const githubMutation = new StubGitHubMutationAdapter();
  const runtime = createSprintDeliveryV1Runtime(repository, { githubRead, githubMutation, modelAnalysis }, await setupPostgresCheckpoints(pool));
  const report = await runtime.execute(fixture.request);
  if (githubMutation.invocations().length !== 0) throw new Error("dry run attempted a provider mutation");
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  await pool.end();
}
