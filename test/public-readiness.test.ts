import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const trackedFiles = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
const textFiles = trackedFiles.filter((file) => !file.endsWith("package-lock.json"));
const trackedText = textFiles.map((file) => `${file}\n${readFileSync(file, "utf8")}`).join("\n");

describe("public repository readiness", () => {
  it("does not track live AWS account or generated secret identifiers", () => {
    const awsArns = [...trackedText.matchAll(/arn:aws:[^:\s]+:[^:\s]*:([0-9]{12}):[^\s`"']+/g)];
    expect(awsArns.filter((match) => match[1] !== "123456789012").map((match) => match[0])).toEqual([]);
  });

  it("keeps publication and evidence deletion as explicit owner checkpoints", () => {
    const runbook = readFileSync("docs/public-release-runbook.md", "utf8");
    const record = readFileSync("docs/public-release-go-no-go.md", "utf8");
    for (const phrase of ["Git history", "Actions runs and artifacts", "Select a license", "required reviewer", "fork pull requests"]) {
      expect(`${runbook}\n${record}`).toContain(phrase);
    }
    expect(record).toContain("Status: **NO-GO**");
    expect(record).toContain("Owner sign-off: pending");
  });

  it("does not claim private-only status or an unselected open-source license", () => {
    const readme = readFileSync("README.md", "utf8");
    const contributing = readFileSync("CONTRIBUTING.md", "utf8");
    expect(`${readme}\n${contributing}`).not.toMatch(/This private repository|private implementation project/);
    expect(readme).toContain("No open-source license has been selected yet");
  });

  it("pins every third-party workflow action to a full commit", () => {
    const workflows = trackedFiles.filter((file) => file.startsWith(".github/workflows/") && file.endsWith(".yml"));
    for (const workflow of workflows) {
      const source = readFileSync(workflow, "utf8");
      const references = [...source.matchAll(/uses:\s+[^@\s]+@([^\s]+)/g)].map((match) => match[1]);
      expect(references.every((reference) => /^[0-9a-f]{40}$/.test(reference ?? "")), workflow).toBe(true);
    }
  });
});
