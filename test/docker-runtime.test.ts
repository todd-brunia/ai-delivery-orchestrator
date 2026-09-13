import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("deployable Lambda image", () => {
  it("builds and verifies the RIC addon without enabling unrelated dependency scripts", () => {
    const dockerfile = readFileSync("Dockerfile", "utf8");
    expect(dockerfile).toContain("AS lambda-native");
    expect(dockerfile).toContain("npm ci --omit=dev --ignore-scripts");
    expect(dockerfile).toContain("npm rebuild aws-lambda-ric --foreground-scripts");
    expect(dockerfile).toContain("COPY --from=lambda-native /app/node_modules/aws-lambda-ric/rapid-client.node");
    expect(dockerfile).toContain("require('./node_modules/aws-lambda-ric/rapid-client.node')");
    const runtimeStage = dockerfile.split("AS runtime")[1]!;
    expect(runtimeStage).not.toMatch(/apt-get|g\+\+|cmake|npm rebuild/);
    expect(runtimeStage).toContain("USER node");
    const lifecycle = readFileSync("infra/environments/pilot/callback-lifecycle.tf", "utf8");
    expect(lifecycle).toContain('command     = ["/app/dist/runtime/v1/callback-lifecycle-handler.handler"]');
  });
});
