import { Pool } from "pg";

import { migrate } from "./migrations.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString && !process.env.PGHOST) throw new Error("DATABASE_URL or PGHOST is required");

const pool = connectionString ? new Pool({ connectionString }) : new Pool();
try {
  await migrate(pool);
  process.stdout.write("Database migrations are current.\n");
} finally {
  await pool.end();
}
