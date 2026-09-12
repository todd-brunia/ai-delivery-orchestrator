import type { Pool, PoolClient } from "pg";
import { expect, it } from "vitest";
import { PostgresCheckpointReceiptReader } from "../src/persistence/checkpoint-receipts.js";

it.each(["success", "missing_schema", "partial", "connect"])("uses bounded read-only SQL and fails closed: %s", async mode => {
  const queries: string[] = [];
  const released: boolean[] = [];
  const counts = { work_items: "0", bindings: "0", dispatch_attempts: "0", accepted_dispatches: "0", outbox_intents: "0", mutation_receipts: "0" };
  const client = { query: (sql: string, parameters?: unknown[]) => {
    queries.push(sql);
    if (sql.startsWith("WITH")) {
      expect(parameters).toEqual(["owner/repo", 142]);
      if (mode === "missing_schema") throw new Error("private-sentinel");
      return Promise.resolve({ rows: [mode === "partial" ? { work_items: "0" } : counts] });
    }
    return Promise.resolve({ rows: [] });
  }, release: (destroy: boolean) => released.push(destroy) };
  const pool = { connect: () => {
    if (mode === "connect") throw new Error("private-sentinel");
    return Promise.resolve(client as unknown as PoolClient);
  } } as Pick<Pool, "connect">;
  const reader = new PostgresCheckpointReceiptReader(pool);
  if (mode === "success") {
    expect(await reader.observe("owner/repo", 142)).toMatchObject({ status: "clear_at_observation", counts });
    expect(queries[0]).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(queries[1]).toBe("SET LOCAL statement_timeout = '10000ms'");
    expect(queries.at(-1)).toBe("ROLLBACK");
    expect(released).toEqual([false]);
  } else {
    await expect(reader.observe("owner/repo", 142)).rejects.toThrow(/^checkpoint receipt observation unavailable$/);
    expect(released).toEqual(mode === "connect" ? [] : [true]);
  }
});
