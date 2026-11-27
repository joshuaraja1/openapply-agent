import { requireHostedAccess } from "./entitlement.js";
import type { VerifySubject } from "./checkout-http.js";
import type { HostedEntitlement } from "./entitlement.js";

type StatusDeps = {
  appOrigin: string;
  verifySubject: VerifySubject;
  loadEntitlements(subjectId: string): Promise<HostedEntitlement[]>;
};

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status, headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'none'",
  } });
}

/** The candidate's current access comes only from durable reconciled records.
 * A Checkout redirect or session ID cannot grant access through this route. */
export async function handleBillingStatusHttp(request: Request, deps: StatusDeps): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== "/api/billing/status") return json(404, { error: "Not found" });
  if (request.method !== "GET") return json(405, { error: "Method not allowed" });
  if (url.search) return json(400, { error: "Unexpected query" });
  if (request.headers.get("origin") !== deps.appOrigin) return json(403, { error: "Origin not allowed" });
  const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(
    request.headers.get("authorization") ?? "");
  if (!match) return json(401, { error: "Authentication required" });
  let subjectId: string;
  try { subjectId = await deps.verifySubject(match[1]!); }
  catch { return json(401, { error: "Authentication required" }); }
  try {
    const records = await deps.loadEntitlements(subjectId);
    try {
      const access = requireHostedAccess(subjectId, records);
      return json(200, { active: true, plan: access.kind, accessUntil: access.accessUntil });
    } catch { return json(200, { active: false }); }
  } catch { return json(503, { error: "Status temporarily unavailable" }); }
}
