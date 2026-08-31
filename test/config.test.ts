import { describe, expect, it } from "vitest";

import { loadWorkerConfig } from "../src/config.js";

describe("loadWorkerConfig", () => {
  it("provides safe development defaults", () => {
    expect(loadWorkerConfig({})).toEqual({
      nodeEnvironment: "development",
      logLevel: "info",
      heartbeatMilliseconds: 30000,
      providerMode: "stub",
      supervisedDispatchEnabled: false,
    });
  });

  it("accepts explicit supported settings", () => {
    expect(
      loadWorkerConfig({
        NODE_ENV: "production",
        LOG_LEVEL: "warn",
        WORKER_HEARTBEAT_MS: "5000",
        PROVIDER_MODE: "stub",
        SUPERVISED_DISPATCH_ENABLED: "true",
      }),
    ).toEqual({
      nodeEnvironment: "production",
      logLevel: "warn",
      heartbeatMilliseconds: 5000,
      providerMode: "stub",
      supervisedDispatchEnabled: true,
    });
  });

  it("permits the explicitly named analysis-only mode", () => {
    expect(loadWorkerConfig({ PROVIDER_MODE: "openai-analysis" }).providerMode).toBe("openai-analysis");
  });

  it.each([
    [{ NODE_ENV: "staging" }, "NODE_ENV is invalid"],
    [{ LOG_LEVEL: "trace" }, "LOG_LEVEL is invalid"],
    [{ WORKER_HEARTBEAT_MS: "999" }, "WORKER_HEARTBEAT_MS"],
    [{ WORKER_HEARTBEAT_MS: "not-a-number" }, "WORKER_HEARTBEAT_MS"],
    [{ PROVIDER_MODE: "github" }, "PROVIDER_MODE must be stub or openai-analysis"],
    [{ SUPERVISED_DISPATCH_ENABLED: "yes" }, "SUPERVISED_DISPATCH_ENABLED must be true or false"],
  ])("rejects invalid configuration", (environment, message) => {
    expect(() => loadWorkerConfig(environment)).toThrow(message);
  });
});
