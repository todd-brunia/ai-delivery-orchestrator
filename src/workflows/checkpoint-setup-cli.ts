import { Pool } from "pg";

import { setupPostgresCheckpoints } from "./checkpoints.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");

const pool = new Pool({ connectionString });
try {
  await setupPostgresCheckpoints(pool);
  process.stdout.write(`${JSON.stringify({ event: "checkpoint_schema_ready" })}\n`);
} finally {
  await pool.end();
}
