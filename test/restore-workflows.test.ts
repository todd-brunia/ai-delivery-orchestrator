import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (name: string) => readFileSync(join(process.cwd(), ".github/workflows", name), "utf8");
const verify = read("verify-pilot-restore.yml");
const cleanup = read("cleanup-pilot-restore.yml");

describe("protected restore verification workflows", () => {
  it("requires a protected manual checkpoint at current main", () => {
    for (const workflow of [verify, cleanup]) {
      expect(workflow).toContain("workflow_dispatch:");
      expect(workflow).not.toMatch(/^\s*(push|pull_request|schedule):/m);
      expect(workflow).toContain("environment: pilot");
      expect(workflow).toContain("cancel-in-progress: false");
      expect(workflow).toContain('test "$(git rev-parse origin/main)" = "$SELECTED_SHA"');
      expect(workflow).toContain("ai-delivery-orchestrator-pilot-runtime-deploy");
      expect(workflow).not.toMatch(/access-key-id|secret-access-key/);
    }
  });

  it("restores to a private isolated cluster and verifies integrity without cleanup", () => {
    expect(verify).toContain('test "$source_cluster" = "ai-delivery-orchestrator-pilot"');
    expect(verify).toContain("ai-delivery-orchestrator-pilot-restore-$VERIFICATION_ID");
    expect(verify).toContain("--no-publicly-accessible");
    expect(verify).toContain("Purpose,Value=restore-verification");
    expect(verify).toContain("restore-verify-cli.js");
    expect(verify).toContain("Automatic cleanup performed: \\`false\\`");
    expect(verify).not.toMatch(/delete-db-(cluster|instance)/);
  });

  it("deletes only an exact separately confirmed and tagged temporary restore", () => {
    expect(cleanup).toContain('test "$CONFIRMATION" = "DELETE RESTORE VERIFY"');
    expect(cleanup).toContain('test "$cluster" != "ai-delivery-orchestrator-pilot"');
    expect(cleanup).toContain('select(.Key == "Purpose")');
    expect(cleanup).toContain('select(.Key == "VerificationId")');
    expect(cleanup).toContain("delete-db-instance");
    expect(cleanup).toContain("delete-db-cluster");
  });

  it("pins third-party actions to full commits", () => {
    for (const workflow of [verify, cleanup]) {
      const references = [...workflow.matchAll(/uses:\s+[^@\s]+@([^\s]+)/g)].map((match) => match[1]);
      expect(references.length).toBeGreaterThan(0);
      expect(references.every((reference) => reference && /^[0-9a-f]{40}$/.test(reference))).toBe(true);
    }
  });
});
