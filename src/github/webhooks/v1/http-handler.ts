import { InvalidWebhookError, verifyAndNormalizeGitHubWebhook } from "./verify-and-normalize.js";
import type { NormalizedGitHubEvent } from "./contracts.js";

export interface WebhookHttpRequest { readonly body?: string; readonly isBase64Encoded?: boolean; readonly headers: Readonly<Record<string, string | undefined>>; }
export interface WebhookHttpResponse { readonly statusCode: number; readonly body: string; readonly headers: Readonly<Record<string, string>>; }
export interface WebhookIngressDependencies {
  loadSecret(): Promise<string>;
  enqueue(event: NormalizedGitHubEvent): Promise<"accepted" | "duplicate">;
}

const response = (statusCode: number, result: string): WebhookHttpResponse => ({
  statusCode, body: JSON.stringify({ result }), headers: { "content-type": "application/json", "cache-control": "no-store" },
});

export async function handleWebhookHttp(request: WebhookHttpRequest, dependencies: WebhookIngressDependencies): Promise<WebhookHttpResponse> {
  if (request.body === undefined || Buffer.byteLength(request.body, request.isBase64Encoded ? "base64" : "utf8") > 1_048_576) return response(400, "invalid_request");
  const header = (name: string) => Object.entries(request.headers).find(([key]) => key.toLowerCase() === name)?.[1] ?? "";
  try {
    const raw = Buffer.from(request.body, request.isBase64Encoded ? "base64" : "utf8");
    const event = verifyAndNormalizeGitHubWebhook(raw, {
      deliveryId: header("x-github-delivery"), eventName: header("x-github-event"),
      hookId: header("x-github-hook-id"), signature256: header("x-hub-signature-256"),
    }, await dependencies.loadSecret());
    return response(202, await dependencies.enqueue(event));
  } catch (error) {
    if (error instanceof InvalidWebhookError) return response(401, "rejected");
    return response(503, "unavailable");
  }
}
