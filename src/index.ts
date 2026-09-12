import { loadWorkerConfig } from "./config.js";
import { createProviderSet } from "./providers/v1/index.js";

const config = loadWorkerConfig();
createProviderSet(config.providerMode);
const callbacks = process.env.CALLBACK_PROCESSING_ENABLED ?? "false";
if (!["true", "false"].includes(callbacks)) throw new Error("invalid_callback_enablement");
if (callbacks === "true") {
  try {
    const { validateCallbackEnvironment, runCallbackRuntime } = await import("./runtime/v1/callback-runtime.js");
    validateCallbackEnvironment(process.env);
    if (!process.argv.includes("--check")) await runCallbackRuntime();
    process.exit(0);
  } catch {
    process.stderr.write('{"event":"callback_runtime_failed","reason":"callback_runtime_unavailable"}\n');
    process.exit(1);
  }
}

function log(event: string, details: Record<string, unknown> = {}): void {
  process.stdout.write(
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      level: config.logLevel,
      service: "ai-delivery-orchestrator",
      event,
      ...details,
    })}\n`,
  );
}

if (process.argv.includes("--check")) {
  log("configuration_valid", { nodeEnvironment: config.nodeEnvironment });
  process.exit(0);
}

log("worker_started", {
  nodeEnvironment: config.nodeEnvironment,
  heartbeatMilliseconds: config.heartbeatMilliseconds,
  providerMode: config.providerMode,
});

const heartbeat = setInterval(() => {
  log("worker_heartbeat");
}, config.heartbeatMilliseconds);

function shutdown(signal: NodeJS.Signals): void {
  clearInterval(heartbeat);
  log("worker_stopped", { signal });
  process.exit(0);
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
