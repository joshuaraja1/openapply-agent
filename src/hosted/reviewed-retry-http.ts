import { ZodError } from "zod";
import { createReviewedApplicationRetry } from "../cloud/reviewed-application-retry.js";
import type { VerifySubject } from "./checkout-http.js";

type RetryPorts = Parameters<typeof createReviewedApplicationRetry>[3];

function response(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status, headers: {
    "content-type": "application/json; charset=utf-8", "cache-control": "no-store",
    "referrer-policy": "no-referrer", "content-security-policy": "default-src 'none'",
  } });
}

/** Explicit signed-in action. It creates a new consented run; the normal
 * enqueue endpoint still controls Fargate launch and capacity. */
export async function handleReviewedRetryHttp(request: Request, deps: {
  appOrigin: string; issuer: string; verifySubject: VerifySubject; ports: RetryPorts;
  now?: Date;
}): Promise<Response> {
  if (new URL(request.url).pathname !== "/api/applications/reviewed-retry") {
    return response(404, { error: "Not found" });
  }
  if (request.method !== "POST") return response(405, { error: "Method not allowed" });
  if (request.headers.get("origin") !== deps.appOrigin) {
    return response(403, { error: "Origin not allowed" });
  }
  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(authorization);
  if (!match) return response(401, { error: "Authentication required" });
  let subjectId: string;
  try { subjectId = await deps.verifySubject(match[1]!); }
  catch { return response(401, { error: "Authentication required" }); }
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "")) {
    return response(415, { error: "JSON request required" });
  }
  if (Number(request.headers.get("content-length")) > 2048) {
    return response(413, { error: "Request too large" });
  }
  let input: unknown;
  try {
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength > 2048) return response(413, { error: "Request too large" });
    input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch { return response(400, { error: "Invalid request" }); }
  try {
    const result = await createReviewedApplicationRetry(deps.issuer, subjectId,
      input, deps.ports, deps.now);
    return response(result.created ? 201 : 200, { runId: result.record.runId,
      candidateId: result.record.candidateId, consentVersion: 1 });
  } catch (error) {
    if (error instanceof ZodError) return response(400, { error: "Invalid request" });
    if (error instanceof Error && (error.message === "Reviewed retry is unavailable"
      || error.message === "Official job changed" || error.message === "Hosted access unavailable")) {
      return response(403, { error: "Reviewed retry unavailable" });
    }
    return response(503, { error: "Reviewed retry temporarily unavailable" });
  }
}
