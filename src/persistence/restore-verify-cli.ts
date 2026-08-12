import { Pool } from "pg";

const pool = new Pool();
try {
  const result = await pool.query<{ migration_count: string; application_schema: boolean; checkpoint_schema: boolean }>(`
    SELECT
      (SELECT count(*)::text FROM public.schema_migrations) AS migration_count,
      EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'orchestrator') AS application_schema,
      EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'langgraph_checkpoints') AS checkpoint_schema
  `);
  const evidence = result.rows[0];
  if (!evidence?.application_schema || !evidence.checkpoint_schema || Number(evidence.migration_count) < 1) {
    throw new Error("restore schema integrity verification failed");
  }
  process.stdout.write(`${JSON.stringify({ status: "verified", migrationCount: Number(evidence.migration_count), applicationSchema: true, checkpointSchema: true })}\n`);
} finally {
  await pool.end();
}
