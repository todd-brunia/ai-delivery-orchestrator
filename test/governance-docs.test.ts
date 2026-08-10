import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("automatic merge governance documentation", () => {
  it("defines all separated roles and keeps sensitive authority human-only", async () => {
    const authority = await readFile("docs/automatic-merge-authority.md", "utf8");
    for (const role of ["Builder", "Reviewer", "Merger", "Operator", "Human owner"]) {
      expect(authority).toContain(role);
    }
    for (const capability of [
      "Release or production deployment",
      "Change policy, protection, rulesets, repository settings, visibility, or App installation",
      "Create, grant, revoke, or rotate credentials/permissions",
      "Target another repository or expand cross-repository access",
    ]) {
      const row = authority.split("\n").find((line) => line.includes(capability));
      expect(row).toBeDefined();
      expect(row).toContain("Deny | Deny | Deny | Deny | Allow");
    }
  });

  it("documents priority threats and the fail-closed boundary", async () => {
    const threat = await readFile("docs/threat-model.md", "utf8");
    for (const scenario of [
      "Compromised builder",
      "Compromised merger or kill bypass",
      "Stale plan, policy, base, review, check, head, or artifact substitution",
      "Duplicate/concurrent merge request",
      "Branch protection or ruleset drift",
      "GitHub, provider, database, or canonical-read outage",
    ]) {
      expect(threat).toContain(scenario);
    }
    expect(threat).toContain("Automatic merge is **not operational**");
  });

  it("defines distinct recovery procedures and human-only restoration", async () => {
    const runbook = await readFile("docs/operating-runbook.md", "utf8");
    for (const heading of [
      "### Pause",
      "### Drain",
      "### Cancel",
      "### Kill automatic authority",
      "### Reconcile canonical state",
      "### Credential compromise, revocation, and rotation",
      "### Duplicate or ambiguous merge request",
      "### Protection drift, stale approval, or artifact substitution",
      "### Incident evidence and restoration",
    ]) {
      expect(runbook).toContain(heading);
    }
    expect(runbook).toContain("Human owner only");
    expect(runbook).toContain("Never");
  });
});
