export interface HttpApiEvent {
  version: string;
  rawPath: string;
  rawQueryString?: string;
  headers?: Record<string, string | undefined>;
  body?: string | null;
  isBase64Encoded?: boolean;
  requestContext: { http: { method: string } };
}

export interface HttpApiResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  isBase64Encoded: true;
}

type Runtime = { handleRequest(request: Request): Promise<Response>;
  processReady(limit?: number): Promise<{ processed: number; deferred: number }> };

/** API Gateway HTTP API payload v2 adapter. The Stripe body stays byte-for-byte
 * intact, including when API Gateway marks it base64 encoded. */
export async function handleHttpApiEvent(event: HttpApiEvent, runtime: Runtime,
  appOrigin: string): Promise<HttpApiResult> {
  if (event.version !== "2.0" || !event.rawPath?.startsWith("/")
    || event.rawPath.startsWith("//") || event.rawPath.includes("#")
    || /[\u0000-\u001f\u007f]/u.test(event.rawPath)) {
    throw new Error("Unsupported HTTP API event");
  }
  const raw = event.body === undefined || event.body === null ? undefined
    : Buffer.from(event.body, event.isBase64Encoded ? "base64" : "utf8");
  if (raw && raw.byteLength > 1024 * 1024) throw new Error("HTTP API body is too large");
  const method = event.requestContext?.http?.method;
  if (!method || !/^[A-Z]+$/.test(method)) throw new Error("Invalid HTTP method");
  const origin = new URL(appOrigin);
  if (origin.protocol !== "https:" || origin.pathname !== "/" || origin.search || origin.hash) {
    throw new Error("Invalid app origin");
  }
  const header = (name: string) => Object.entries(event.headers ?? {})
    .find(([key]) => key.toLowerCase() === name)?.[1];
  if (event.rawPath === "/api/billing/checkout" && method === "OPTIONS") {
    const requestedHeaders = (header("access-control-request-headers") ?? "")
      .split(",").map(value => value.trim().toLowerCase()).filter(Boolean);
    const allowed = header("origin") === origin.origin
      && header("access-control-request-method") === "POST"
      && requestedHeaders.every(value => value === "authorization" || value === "content-type");
    return { statusCode: allowed ? 204 : 403,
      headers: allowed ? {
        "access-control-allow-origin": origin.origin,
        "access-control-allow-methods": "POST",
        "access-control-allow-headers": "authorization, content-type",
        "access-control-max-age": "300",
        vary: "Origin",
      } : { "cache-control": "no-store" },
      body: "", isBase64Encoded: true };
  }
  const request = new Request(`${origin.origin}${event.rawPath}${event.rawQueryString ? `?${event.rawQueryString}` : ""}`, {
    method, headers: event.headers as HeadersInit,
    ...(raw && method !== "GET" && method !== "HEAD" ? { body: raw } : {}),
  });
  const response = await runtime.handleRequest(request);
  const bytes = Buffer.from(await response.arrayBuffer());
  const headers = Object.fromEntries(response.headers.entries());
  if (event.rawPath === "/api/billing/checkout" && header("origin") === origin.origin) {
    headers["access-control-allow-origin"] = origin.origin;
    headers.vary = "Origin";
  }
  return { statusCode: response.status,
    headers,
    body: bytes.toString("base64"), isBase64Encoded: true };
}

/** EventBridge invokes a separate handler; this is not an HTTP route. */
export async function handleBillingSchedule(runtime: Runtime): Promise<{
  processed: number; deferred: number }> {
  return runtime.processReady(25);
}
