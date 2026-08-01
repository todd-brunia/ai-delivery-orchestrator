import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");
const allTerraform = (directory: string) => readdirSync(join(root, directory)).filter((name) => name.endsWith(".tf")).map((name) => read(join(directory, name))).join("\n");

describe("Terraform foundation policy", () => {
  const bootstrap = allTerraform("infra/bootstrap");
  const pilot = allTerraform("infra/environments/pilot");

  it("protects and versions native-locking remote state", () => {
    expect(read("infra/environments/pilot/backend.tf")).toContain("use_lockfile = true");
    expect(bootstrap).toContain("prevent_destroy = true");
    expect(bootstrap).toContain('status = "Enabled"');
    expect(bootstrap).toContain("aws_s3_bucket_public_access_block");
    expect(bootstrap).toContain('sse_algorithm = "AES256"');
    expect(bootstrap).toContain('variable = "aws:SecureTransport"');
  });

  it("restricts GitHub OIDC trust to this repository's pull requests", () => {
    expect(bootstrap).toMatch(/values\s*=\s*\["sts\.amazonaws\.com"\]/);
    expect(bootstrap).toMatch(/values\s*=\s*\["repo:\$\{var\.github_repository\}:pull_request"\]/);
    expect(bootstrap).not.toMatch(/repo:\$\{var\.github_repository\}:\*/);
  });

  it("uses immutable scanned ECR and two-tier networking without compute or NAT", () => {
    expect(pilot).toContain('image_tag_mutability = "IMMUTABLE"');
    expect(pilot).toContain("scan_on_push = true");
    expect(pilot).toContain('resource "aws_subnet" "public"');
    expect(pilot).toContain('resource "aws_subnet" "isolated"');
    expect(pilot).not.toMatch(/aws_nat_gateway|aws_ecs_|aws_rds_|aws_lambda_|aws_apigateway/);
  });

  it("requires common ownership tags", () => {
    for (const value of [bootstrap, pilot]) {
      expect(value).toMatch(/Project\s*=\s*"ai-delivery-orchestrator"/);
      expect(value).toMatch(/ManagedBy\s*=\s*"terraform"/);
    }
  });
});
