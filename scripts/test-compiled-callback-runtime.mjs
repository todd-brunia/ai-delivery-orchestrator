import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import process from "node:process";

const run = (extra = {}) => spawnSync(process.execPath, ["dist/index.js", "--check"], {
  encoding: "utf8", timeout: 10_000,
  env: { PATH: process.env.PATH, NODE_ENV: "test", PROVIDER_MODE: "stub", ...extra },
});
assert.equal(run().status, 0);
for (const settings of [
  { CALLBACK_PROCESSING_ENABLED: "true" },
  { CALLBACK_PROCESSING_ENABLED: "false", CALLBACK_RUNTIME_MODE: "processor" },
  { CALLBACK_PROCESSING_ENABLED: "sk-fake-secret hostile input" },
]) {
  const result = run(settings);
  if (settings.CALLBACK_PROCESSING_ENABLED === "false") { assert.equal(result.status, 0); continue; }
  assert.notEqual(result.status, 0);
  assert.ok(!`${result.stdout}${result.stderr}`.includes("sk-fake-secret"));
}
// Load the actual compiled dependency graph in Node, without TypeScript transforms.
const imported = spawnSync(process.execPath, ["--input-type=module", "-e",
  "await import('./dist/runtime/v1/canonical-callback-resolver.js'); await import('./dist/runtime/v1/callback-runtime.js'); await import('./dist/runtime/v1/callback-projection.js');"],
{ encoding: "utf8", timeout: 10_000, env: { PATH: process.env.PATH } });
assert.equal(imported.status, 0, "compiled callback modules must load");
process.stdout.write("Compiled callback startup and module checks passed.\n");
