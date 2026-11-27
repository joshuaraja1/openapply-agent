import { deleteCandidateAccount, type CandidateDeletionDeps } from "./candidate-deletion.js";
import type { VerifySubject } from "./checkout-http.js";

/** Deletion does not require a paid plan. A request writes the irreversible
 * tombstone before it attempts the retryable purge. */
export async function handleCandidateDeletionHttp(request: Request, deps: CandidateDeletionDeps & {
  appOrigin: string; verifySubject: VerifySubject;
}): Promise<Response> {
  const respond = (status: number, state: string) => new Response(JSON.stringify({ state }), {
    status, headers: { "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store", "referrer-policy": "no-referrer",
      "content-security-policy": "default-src 'none'" },
  });
  const path = new URL(request.url).pathname;
  if (path !== "/api/candidates/delete" && path !== "/api/candidates/deletion-status") {
    return respond(404, "unavailable");
  }
  if (request.method !== "POST") return respond(405, "unavailable");
  if (request.headers.get("origin") !== deps.appOrigin) return respond(403, "unavailable");
  const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(
    request.headers.get("authorization") ?? "");
  if (!match) return respond(401, "unavailable");
  let subjectId: string;
  try { subjectId = await deps.verifySubject(match[1]!); }
  catch { return respond(401, "unavailable"); }
  if (path === "/api/candidates/deletion-status") {
    try { return respond(200, await deps.store.status(deps.candidateIdForSubject(subjectId), subjectId)); }
    catch { return respond(503, "unavailable"); }
  }
  try {
    const result = await deleteCandidateAccount(subjectId, deps);
    return respond(result.state === "complete" ? 200 : 202, result.state);
  } catch {
    // Never report complete on a partial S3 or ledger purge. A later request
    // retries while the tombstone keeps application work disabled.
    return respond(503, "pending");
  }
}
