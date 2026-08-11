import { describe, expect, it } from "vitest";
import { handleOperatorHttp, type OperatorApiPort, type OperatorCommand } from "../src/operator-api/v1/index.js";

const principal = "arn:aws:iam::123456789012:role/pilot-operator";
const runId = "019ff2eb-9ebc-7933-9d88-1f897bc79562";
const commands: OperatorCommand[] = [];
const port: OperatorApiPort = {
  submit: (command) => { commands.push(command); return Promise.resolve({ commandId: command.commandId, duplicate: false }); },
  read: () => Promise.resolve({ source: "projection", projectionAsOf: "2026-08-11T00:00:00Z", value: [] }),
};

describe("operator API v1", () => {
  it("denies a non-allowlisted SigV4 principal", async () => {
    const result = await handleOperatorHttp({ method: "GET", path: "/v1/runs", headers: {}, principalArn: "arn:wrong" }, port, principal);
    expect(result.statusCode).toBe(403);
  });
  it("requires idempotency for mutations", async () => {
    const result = await handleOperatorHttp({ method: "POST", path: `/v1/runs/${runId}/pause`, headers: {}, principalArn: principal, body: "{}" }, port, principal);
    expect(result).toMatchObject({ statusCode: 400, body: '{"error":"idempotency_key_required"}' });
  });
  it("accepts bounded controls asynchronously with attribution", async () => {
    const result = await handleOperatorHttp({ method: "POST", path: `/v1/runs/${runId}/pause`, headers: { "Idempotency-Key": "pause:run-x" }, principalArn: principal, body: JSON.stringify({ apiVersion: "operator-api/v1", expectedRevision: 2, reason: "operator request" }) }, port, principal);
    expect(result.statusCode).toBe(202);
    expect(result.headers.location).toMatch(/^\/v1\/commands\//);
    expect(commands.at(-1)).toMatchObject({ principalArn: principal, route: `POST /v1/runs/${runId}/pause`, idempotencyKey: "pause:run-x" });
  });
  it("labels bounded reads with their source and freshness", async () => {
    const result = await handleOperatorHttp({ method: "GET", path: "/v1/runs", headers: {}, principalArn: principal, query: { limit: "100" } }, port, principal);
    expect(result).toMatchObject({ statusCode: 200 });
    const body = JSON.parse(result.body) as { source: string; projectionAsOf: string };
    expect(body).toMatchObject({ source: "projection", projectionAsOf: "2026-08-11T00:00:00Z" });
  });
});
