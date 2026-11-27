import { saveCandidateOnboarding, type OnboardingDeps } from "./candidate-onboarding.js";
import type { VerifySubject } from "./checkout-http.js";
import { requireHostedAccess } from "./entitlement.js";

const MAX_BODY_BYTES = 7_500_000;

async function boundedJson(request: Request): Promise<unknown> {
  if (!request.body) throw new Error("Missing body");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) throw new RangeError("Onboarding request is too large");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size)));
}

/** Same-origin, authenticated candidate intake. This handler never grants paid
 * access, enqueues an application, or tries to extract facts from the uploads. */
export async function handleCandidateOnboardingHttp(request: Request, deps: OnboardingDeps & {
  appOrigin: string; verifySubject: VerifySubject;
  loadEntitlements(subjectId: string): Promise<readonly unknown[]>;
}): Promise<Response> {
  const respond = (status: number, body: Record<string, unknown>) => new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store", "referrer-policy": "no-referrer",
      "content-security-policy": "default-src 'none'" },
  });
  const path = new URL(request.url).pathname;
  const planRequest = path === "/api/candidates/plan";
  if (!planRequest && path !== "/api/candidates/onboarding") return respond(404, { error: "Not found" });
  if (request.method !== "POST") return respond(405, { error: "Method not allowed" });
  if (request.headers.get("origin") !== deps.appOrigin) return respond(403, { error: "Origin not allowed" });
  const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(
    request.headers.get("authorization") ?? "");
  if (!match) return respond(401, { error: "Authentication required" });
  let subjectId: string;
  try { subjectId = await deps.verifySubject(match[1]!); }
  catch { return respond(401, { error: "Authentication required" }); }
  if (planRequest) {
    try {
      const records = await deps.loadEntitlements(subjectId);
      try {
        const access = requireHostedAccess(subjectId, records);
        return respond(200, { status: "active", plan: access.kind, accessUntil: access.accessUntil });
      } catch (error) {
        if (error instanceof Error && error.message === "Hosted access unavailable") {
          return respond(200, { status: "inactive" });
        }
        throw error;
      }
    } catch { return respond(503, { error: "Plan status is temporarily unavailable" }); }
  }
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "")) {
    return respond(415, { error: "JSON request required" });
  }
  let body: unknown;
  try { body = await boundedJson(request); }
  catch (error) { return respond(error instanceof RangeError ? 413 : 400, { error: "Invalid onboarding request" }); }
  try {
    const saved = await saveCandidateOnboarding(subjectId, body, deps);
    return respond(201, { status: "saved", ...saved });
  } catch (error) {
    if (error instanceof Error && (error.name === "ZodError" || error.message === "Invalid PDF upload"
      || error.message === "PDF uploads exceed the combined size limit")) {
      return respond(400, { error: "Review the form and PDF uploads" });
    }
    if (error instanceof Error && error.message === "Submission ID was already used for different content") {
      return respond(409, { error: "This form was already submitted with different content" });
    }
    // Do not reveal candidate existence, stored facts, AWS errors, or token details.
    return respond(503, { error: "Candidate setup is temporarily unavailable" });
  }
}
