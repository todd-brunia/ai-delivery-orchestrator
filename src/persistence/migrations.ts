import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { Pool, PoolClient } from "pg";

export interface MigrationOptions {
  readonly directory?: string;
  readonly maxConnectionAttempts?: number;
  readonly initialRetryMilliseconds?: number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

const wait = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

export async function migrate(pool: Pool, options: MigrationOptions | string = {}): Promise<void> {
  const normalized = typeof options === "string" ? { directory: options } : options;
  const directory = normalized.directory ?? "migrations";
  const attempts = normalized.maxConnectionAttempts ?? 6;
  const initialDelay = normalized.initialRetryMilliseconds ?? 1_000;
  const sleep = normalized.sleep ?? wait;
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 10) {
    throw new Error("maxConnectionAttempts must be an integer from 1 to 10");
  }

  let client: PoolClient | undefined;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      client = await pool.connect();
      break;
    } catch (error) {
      if (attempt === attempts) throw error;
      await sleep(Math.min(initialDelay * 2 ** (attempt - 1), 15_000));
    }
  }
  if (!client) throw new Error("database connection retry exhausted");
  try {
    await client.query("SELECT pg_advisory_lock($1)", [7_324_991]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.schema_migrations (
        name text PRIMARY KEY,
        sha256 text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const files = (await readdir(directory))
      .filter((file) => /^\d+_[a-z0-9_]+\.sql$/.test(file))
      .sort();

    for (const file of files) {
      const sql = await readFile(join(directory, file), "utf8");
      const sha256 = createHash("sha256").update(sql).digest("hex");
      const existing = await client.query<{ sha256: string }>(
        "SELECT sha256 FROM public.schema_migrations WHERE name = $1",
        [file],
      );
      if (existing.rowCount === 1) {
        if (existing.rows[0]?.sha256 !== sha256) {
          throw new Error(`applied migration checksum changed: ${file}`);
        }
        continue;
      }

      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO public.schema_migrations (name, sha256) VALUES ($1, $2)",
          [file, sha256],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [7_324_991]).catch(() => undefined);
    client.release();
  }
}
