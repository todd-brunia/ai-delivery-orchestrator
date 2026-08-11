import { createHash, randomUUID } from "node:crypto";

import { CreateRunRequestSchema, ControlRequestSchema, IdempotencyKeySchema, type OperatorApiPort, WakeDrainRequestSchema } from "./contracts.js";

export interface OperatorHttpRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body?: string;
  readonly principalArn?: string;
  readonly query?: Readonly<Record<string, string | undefined>>;
}
export interface OperatorHttpResponse { readonly statusCode: number; readonly headers: Readonly<Record<string, string>>; readonly body: string; }

const json = (statusCode: number, body: unknown, location?: string): OperatorHttpResponse => ({
  statusCode,
  headers: { "content-type": "application/json", "cache-control": "no-store", ...(location ? { location } : {}) },
  body: JSON.stringify(body),
});
const header = (request: OperatorHttpRequest, name: string) => Object.entries(request.headers).find(([key]) => key.toLowerCase() === name)?.[1];
const parseBody = (request: OperatorHttpRequest): unknown => {
  if (!request.body || Buffer.byteLength(request.body, "utf8") > 65_536) throw new Error("invalid_body");
  return JSON.parse(request.body) as unknown;
};
const readRoute = /^(?:GET \/v1\/runs|GET \/v1\/runs\/[0-9a-f-]{36}|GET \/v1\/runs\/[0-9a-f-]{36}\/events)$/;
const mutationRoute = /^(?:POST \/v1\/runs|POST \/v1\/runs\/[0-9a-f-]{36}\/(?:pause|resume|cancel|reconcile)|POST \/v1\/runtime\/(?:wake|drain))$/;

export async function handleOperatorHttp(request: OperatorHttpRequest, port: OperatorApiPort, allowedPrincipalArn: string): Promise<OperatorHttpResponse> {
  if (!request.principalArn || request.principalArn !== allowedPrincipalArn) return json(403, { error: "forbidden" });
  const route = `${request.method.toUpperCase()} ${request.path}`;
  if (!readRoute.test(route) && !mutationRoute.test(route)) return json(404, { error: "not_found" });
  if (request.method.toUpperCase() === "GET") {
    const limit = Number(request.query?.limit ?? "50");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) return json(400, { error: "invalid_pagination" });
    const cursor = request.query?.cursor;
    const result = await port.read({ route, limit, ...(cursor === undefined ? {} : { cursor }) });
    return json(200, result);
  }

  const idempotency = IdempotencyKeySchema.safeParse(header(request, "idempotency-key"));
  if (!idempotency.success) return json(400, { error: "idempotency_key_required" });
  try {
    const raw = parseBody(request);
    const schema = route === "POST /v1/runs" ? CreateRunRequestSchema
      : route === "POST /v1/runtime/wake" || route === "POST /v1/runtime/drain" ? WakeDrainRequestSchema
      : ControlRequestSchema;
    const payload = schema.parse(raw);
    const payloadSha256 = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    const result = await port.submit({ commandId: randomUUID(), principalArn: request.principalArn, route, idempotencyKey: idempotency.data, payloadSha256, payload });
    return json(202, { commandId: result.commandId, duplicate: result.duplicate }, `/v1/commands/${result.commandId}`);
  } catch {
    return json(400, { error: "invalid_request" });
  }
}
