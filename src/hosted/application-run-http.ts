import { ZodError } from "zod";
import { createTrustedApplicationRun, RunConflictError, RunInputsUnavailableError,
  type VerifiedCandidateProfile, type VerifiedOfficialLead, type TrustedRunRecord } from "../cloud/hosted-run-creator.js";
import type { VerifySubject } from "./checkout-http.js";

type RunPorts = Parameters<typeof createTrustedApplicationRun>[3];
export interface ApplicationRunDeps {
  appOrigin: string;
  issuer: string;
  verifySubject: VerifySubject;
  ports: RunPorts;
}

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status, headers: {
    "content-type": "application/json; charset=utf-8", "cache-control": "no-store",
    "referrer-policy": "no-referrer", "content-security-policy": "default-src 'none'",
  } });
}

export async function handleApplicationRunHttp(request: Request, deps: ApplicationRunDeps): Promise<Response> {
  if (new URL(request.url).pathname !== "/api/applications/runs") return json(404, { error: "Not found" });
  if (request.method !== "POST") return json(405, { error: "Method not allowed" });
  if (request.headers.get("origin") !== deps.appOrigin) return json(403, { error: "Origin not allowed" });
  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(authorization);
  if (!match) return json(401, { error: "Authentication required" });
  let subjectId: string;
  try { subjectId = await deps.verifySubject(match[1]!); }
  catch { return json(401, { error: "Authentication required" }); }
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "")) {
    return json(415, { error: "JSON request required" });
  }
  const declaredSize = Number(request.headers.get("content-length"));
  if (declaredSize > 2048) return json(413, { error: "Request too large" });
  let body: unknown;
  try {
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength > 2048) return json(413, { error: "Request too large" });
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch { return json(400, { error: "Invalid request" }); }
  try {
    const result = await createTrustedApplicationRun(deps.issuer, subjectId, body, deps.ports);
    return json(result.created ? 201 : 200, { runId: result.record.runId,
      candidateId: result.record.candidateId, consentVersion: 1 });
  } catch (error) {
    if (error instanceof ZodError) return json(400, { error: "Invalid request" });
    if (error instanceof RunConflictError) return json(409, { error: "Run ID already used" });
    if (error instanceof RunInputsUnavailableError
      || error instanceof Error && error.message === "Hosted access unavailable") {
      return json(403, { error: "Application unavailable" });
    }
    return json(503, { error: "Application temporarily unavailable" });
  }
}
