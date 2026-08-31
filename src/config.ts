const NODE_ENVIRONMENTS = new Set(["development", "test", "production"]);
const LOG_LEVELS = new Set(["debug", "info", "warn", "error"]);

export interface WorkerConfig {
  readonly nodeEnvironment: "development" | "test" | "production";
  readonly logLevel: "debug" | "info" | "warn" | "error";
  readonly heartbeatMilliseconds: number;
  readonly providerMode: "stub" | "openai-analysis";
  readonly supervisedDispatchEnabled: boolean;
}

export function loadWorkerConfig(
  environment: NodeJS.ProcessEnv = process.env,
): WorkerConfig {
  const nodeEnvironment = environment.NODE_ENV ?? "development";
  const logLevel = environment.LOG_LEVEL ?? "info";
  const heartbeatMilliseconds = Number(environment.WORKER_HEARTBEAT_MS ?? "30000");
  const providerMode = environment.PROVIDER_MODE ?? "stub";
  const supervisedDispatch = environment.SUPERVISED_DISPATCH_ENABLED ?? "false";

  if (!NODE_ENVIRONMENTS.has(nodeEnvironment)) {
    throw new Error(`NODE_ENV is invalid: ${nodeEnvironment}`);
  }
  if (!LOG_LEVELS.has(logLevel)) {
    throw new Error(`LOG_LEVEL is invalid: ${logLevel}`);
  }
  if (
    !Number.isSafeInteger(heartbeatMilliseconds) ||
    heartbeatMilliseconds < 1000 ||
    heartbeatMilliseconds > 300000
  ) {
    throw new Error("WORKER_HEARTBEAT_MS must be an integer from 1000 to 300000");
  }
  if (providerMode !== "stub" && providerMode !== "openai-analysis") {
    throw new Error("PROVIDER_MODE must be stub or openai-analysis");
  }
  if (supervisedDispatch !== "true" && supervisedDispatch !== "false") {
    throw new Error("SUPERVISED_DISPATCH_ENABLED must be true or false");
  }

  return {
    nodeEnvironment: nodeEnvironment as WorkerConfig["nodeEnvironment"],
    logLevel: logLevel as WorkerConfig["logLevel"],
    heartbeatMilliseconds,
    providerMode,
    supervisedDispatchEnabled: supervisedDispatch === "true",
  };
}
