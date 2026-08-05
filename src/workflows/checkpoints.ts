import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import type { Pool } from "pg";

export const CHECKPOINT_SCHEMA = "langgraph_checkpoints";

export function createPostgresCheckpointer(pool: Pool): PostgresSaver {
  return new PostgresSaver(pool, undefined, { schema: CHECKPOINT_SCHEMA });
}

export async function setupPostgresCheckpoints(pool: Pool): Promise<PostgresSaver> {
  const checkpointer = createPostgresCheckpointer(pool);
  await checkpointer.setup();
  return checkpointer;
}
