import { PutItemCommand } from "@aws-sdk/client-dynamodb";

import type { PersistedSprintRun } from "../../persistence/index.js";
import type { ProjectionWriter } from "./command-processing.js";

export interface DynamoProjectionClient {
  send(command: PutItemCommand): Promise<unknown>;
}

export class DynamoProjectionWriter implements ProjectionWriter {
  constructor(private readonly client: DynamoProjectionClient, private readonly tableName: string) {
    if (!tableName) throw new Error("projection table name is required");
  }
  async putRun(run: PersistedSprintRun, sourceEventId: string, projectionAsOf: Date): Promise<"updated" | "stale"> {
    try {
      await this.client.send(new PutItemCommand({
        TableName: this.tableName,
        ConditionExpression: "attribute_not_exists(sourceRevision) OR sourceRevision < :revision",
        ExpressionAttributeValues: { ":revision": { N: String(run.revision) } },
        Item: {
          purposeKey: { S: "operator-read:GET /v1/runs" },
          entityKey: { S: run.id },
          sourceRevision: { N: String(run.revision) },
          sourceEventId: { S: sourceEventId },
          projectionAsOf: { S: projectionAsOf.toISOString() },
          valueJson: { S: JSON.stringify(run) },
        },
      }));
      return "updated";
    } catch (error) {
      if ((error as { name?: string }).name === "ConditionalCheckFailedException") return "stale";
      throw error;
    }
  }
}
