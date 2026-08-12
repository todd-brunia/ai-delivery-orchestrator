import type { PutItemCommand } from "@aws-sdk/client-dynamodb";
import { describe, expect, it } from "vitest";
import type { PersistedSprintRun } from "../src/persistence/index.js";
import { DynamoProjectionWriter } from "../src/runtime/v1/index.js";

const run: PersistedSprintRun = { id: "019ff2eb-9ebc-7933-9d88-1f897bc79562", input: { workflowVersion: "sprint-delivery/v1", repository: "owner/repo", issueNumbers: [1], mergePolicy: "human" }, state: "active", revision: 4, createdAt: "2026-08-11T00:00:00Z", updatedAt: "2026-08-11T00:01:00Z", workItems: [] };

describe("Dynamo projection writer", () => {
  it("conditionally advances source revision with explicit freshness", async () => {
    let sent: PutItemCommand | undefined;
    const writer = new DynamoProjectionWriter({ send: (command) => { sent = command; return Promise.resolve({}); } }, "coordination");
    await expect(writer.putRun(run, "event-1", new Date("2026-08-11T00:02:00Z"))).resolves.toBe("updated");
    expect(sent?.input.ConditionExpression).toContain("sourceRevision < :revision");
    expect(sent?.input.Item?.projectionAsOf).toEqual({ S: "2026-08-11T00:02:00.000Z" });
  });
  it("reports regression without replacing authoritative state", async () => {
    const error = Object.assign(new Error("conditional"), { name: "ConditionalCheckFailedException" });
    const writer = new DynamoProjectionWriter({ send: () => Promise.reject(error) }, "coordination");
    await expect(writer.putRun(run, "event-1", new Date())).resolves.toBe("stale");
  });
});
