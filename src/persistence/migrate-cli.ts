import { Pool } from "pg";

import { migrate } from "./migrations.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");

const pool = new Pool({ connectionString });
try {
  await migrate(pool);
  process.stdout.write("Database migrations are current.\n");
} finally {
  await pool.end();
}
