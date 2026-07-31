import { loadWorkerConfig } from "./config.js";

const config = loadWorkerConfig();

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
