import { describe, expect, it, vi } from "vitest";
import { handleBillingStatusHttp } from "../src/hosted/billing-status-http.js";

const origin = "https://openapplyagent.xyz";
const token = "a.b.c";
const request = (options: { origin?: string; token?: string; query?: string; method?: string } = {}) =>
  new Request(`${origin}/api/billing/status${options.query ?? ""}`, {
    method: options.method ?? "GET",
    headers: { origin: options.origin ?? origin, authorization: `Bearer ${options.token ?? token}` },
  });

describe("hosted billing status", () => {
  it("reads only the authenticated subject's durable paid entitlement", async () => {
    const loadEntitlements = vi.fn(async () => [{
      kind: "subscription" as const, subjectId: "candidate-1", subscriptionId: "sub_test",
      status: "active" as const, startsAt: "2026-01-01T00:00:00.000Z",
      endsAt: "2099-01-01T00:00:00.000Z", paidThrough: "2098-01-01T00:00:00.000Z",
      settledInvoiceId: "in_test",
    }]);
    const response = await handleBillingStatusHttp(request(), {
      appOrigin: origin, verifySubject: async () => "candidate-1", loadEntitlements,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ active: true, plan: "subscription",
      accessUntil: "2098-01-01T00:00:00.000Z" });
    expect(loadEntitlements).toHaveBeenCalledWith("candidate-1");
  });

  it("never grants from a success redirect or query session ID", async () => {
    const loadEntitlements = vi.fn(async () => []);
    const deps = { appOrigin: origin, verifySubject: async () => "candidate-1", loadEntitlements };
    const direct = await handleBillingStatusHttp(request(), deps);
    expect(await direct.json()).toEqual({ active: false });
    const forged = await handleBillingStatusHttp(request({ query: "?session_id=cs_test_fake" }), deps);
    expect(forged.status).toBe(400);
    expect(loadEntitlements).toHaveBeenCalledTimes(1);
  });

  it("requires origin and verified bearer token before querying records", async () => {
    const loadEntitlements = vi.fn(async () => []);
    const deps = { appOrigin: origin, verifySubject: async () => { throw Error("bad token"); }, loadEntitlements };
    expect((await handleBillingStatusHttp(request({ origin: "https://evil.example" }), deps)).status).toBe(403);
    expect((await handleBillingStatusHttp(request(), deps)).status).toBe(401);
    expect((await handleBillingStatusHttp(request({ method: "POST" }), deps)).status).toBe(405);
    expect(loadEntitlements).not.toHaveBeenCalled();
  });
});
