import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const dockerfile = readFileSync("Dockerfile", "utf8");
const rdsCa = readFileSync("certificates/aws-rds-us-east-1-rsa2048-g1.pem", "utf8");

describe("runtime image trust", () => {
  it("trusts only the declared us-east-1 RDS root CA without disabling TLS verification", () => {
    expect(dockerfile).toContain("COPY certificates ./certificates");
    expect(dockerfile).toContain("NODE_EXTRA_CA_CERTS=/app/certificates/aws-rds-us-east-1-rsa2048-g1.pem");
    expect(dockerfile).not.toContain("NODE_TLS_REJECT_UNAUTHORIZED=0");
    expect(rdsCa).toMatch(/^-----BEGIN CERTIFICATE-----/);
    expect(new X509Certificate(rdsCa).fingerprint256).toBe("E4:CE:41:D0:69:F4:BD:CD:B7:14:25:90:58:96:1E:E4:2E:D1:8C:F2:BF:62:7A:3D:64:7A:FF:25:43:7D:4B:68");
  });
});
