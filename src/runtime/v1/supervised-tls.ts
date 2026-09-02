import { readFile } from "node:fs/promises";

import { withinSupervisedStage } from "./supervised-diagnostics.js";

export const SUPERVISED_TLS_CERTIFICATE_FILENAME = "aws-rds-us-east-1-rsa2048-g1.pem";
export const SUPERVISED_TLS_CERTIFICATE_URL = new URL(`../../../certificates/${SUPERVISED_TLS_CERTIFICATE_FILENAME}`, import.meta.url);

type CertificateReader = (path: URL, encoding: "utf8") => Promise<string>;

/** Loads only the reviewed certificate shipped in the immutable runtime image. */
export function loadSupervisedTlsCertificate(reader: CertificateReader = readFile): Promise<string> {
  return withinSupervisedStage("configuration", async () => {
    const certificate = await reader(SUPERVISED_TLS_CERTIFICATE_URL, "utf8");
    if (!certificate.startsWith("-----BEGIN CERTIFICATE-----") || certificate.length > 32_768) {
      throw new Error("supervised TLS certificate is invalid");
    }
    return certificate;
  });
}
