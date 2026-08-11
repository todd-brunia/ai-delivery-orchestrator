import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(process.cwd(), "bruno/operator-api");
const requestFiles = [
  ...readdirSync(join(root, "runs")).map((name) => join(root, "runs", name)),
  ...readdirSync(join(root, "runtime")).map((name) => join(root, "runtime", name)),
].filter((name) => name.endsWith(".bru"));
const requests = requestFiles.map((name) => readFileSync(name, "utf8")).join("\n");

describe("operator Bruno collection", () => {
  it("covers every IAM-authorized operator route", () => {
    for (const path of ["/v1/runs", "/v1/runs/{{runId}}", "/events", "/pause", "/resume", "/cancel", "/reconcile", "/v1/runtime/wake", "/v1/runtime/drain"]) {
      expect(requests).toContain(path);
    }
    expect(requestFiles).toHaveLength(10);
    expect(requests.match(/auth: awsv4/g)).toHaveLength(10);
    expect(requests.match(/Idempotency-Key:/g)).toHaveLength(7);
  });
  it("uses process credentials and placeholder-only environment values", () => {
    expect(requests).toContain("$processEnv AWS_SESSION_TOKEN");
    expect(requests).not.toMatch(/AKIA[0-9A-Z]{16}|aws_secret_access_key\s*:/i);
    const environment = readFileSync(join(root, "environments/pilot.bru"), "utf8");
    expect(environment).toContain("replace-me.execute-api.us-east-1.amazonaws.com");
  });
});
