import { execFileSync } from "node:child_process";
import process from "node:process";
import { openSync, fstatSync, readFileSync, closeSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { SupervisedDecisionReportSchema, locateDecisionEvidence } from "../dist/runtime/v1/supervised-decision-report.js";

/** Only fixed GitHub GET routes; report-supplied URLs and source text are never printed. */
export function reviewDecision(report, id, getBody) {
  const safe = SupervisedDecisionReportSchema.parse(report);
  const evidence = safe.evidence.find(item => item.id === id);
  if (!evidence) throw new Error("unknown evidence reference");
  const p = safe.provenance;
  const route = evidence.source === "plan" ? `repos/${p.repository}/issues/comments/${p.planCommentId}` : `repos/${p.repository}/issues/${p.issueNumber}`;
  const body = getBody(route);
  const location = locateDecisionEvidence(safe, id, body);
  return { evidenceId: id, ...location, sourceHashVerified: true, url: `https://github.com/${p.repository}/issues/${p.issueNumber}${evidence.source === "plan" ? `#issuecomment-${p.planCommentId}` : ""}` };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 4) throw new Error();
    const descriptor = openSync(process.argv[2], "r");
    let report;
    try {
      const stat = fstatSync(descriptor);
      if (!stat.isFile() || stat.size > 32_768) throw new Error();
      report = JSON.parse(readFileSync(descriptor, "utf8"));
    } finally { closeSync(descriptor); }
    const result = reviewDecision(report, process.argv[3], route => {
      const raw = execFileSync("gh", ["api", "--method", "GET", route], { encoding: "utf8", maxBuffer: 1_000_000, timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] });
      const value = JSON.parse(raw);
      if (typeof value.body !== "string") throw new Error();
      return value.body;
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch {
    process.stderr.write("Decision evidence unavailable, invalid, or changed. No source text displayed.\n");
    process.exitCode = 1;
  }
}
