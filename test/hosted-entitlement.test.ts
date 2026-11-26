import { describe, expect, it } from "vitest";
import { requireHostedAccess } from "../src/hosted/entitlement.js";

const now = new Date("2026-11-26T16:00:00Z");
const paid = { kind: "subscription", subjectId: "candidate-a", subscriptionId: "sub_test_1",
  status: "active", startsAt: "2026-11-01T00:00:00Z", endsAt: "2026-12-01T00:00:00Z" };
const friend = { kind: "free-grant", subjectId: "candidate-a", grantId: "grant-1",
  approvedBy: "admin-1", startsAt: "2026-11-20T00:00:00Z",
  endsAt: "2026-12-20T00:00:00Z", revokedAt: null };

describe("hosted entitlement gate", () => {
  it("admits a current paid subscription or explicit free grant", () => {
    expect(requireHostedAccess("candidate-a", [paid], now)).toMatchObject({
      kind: "subscription", sourceId: "sub_test_1" });
    expect(requireHostedAccess("candidate-a", [friend], now)).toMatchObject({
      kind: "free-grant", sourceId: "grant-1" });
  });

  it("denies a missing, wrong-tenant, future, or expired record", () => {
    expect(() => requireHostedAccess("candidate-a", [], now)).toThrow("Hosted access unavailable");
    expect(() => requireHostedAccess("candidate-b", [paid], now)).toThrow("Hosted access unavailable");
    expect(() => requireHostedAccess("candidate-a", [{ ...paid, startsAt: "2026-11-27T00:00:00Z" }], now))
      .toThrow("Hosted access unavailable");
    expect(() => requireHostedAccess("candidate-a", [paid], new Date(paid.endsAt)))
      .toThrow("Hosted access unavailable");
  });

  it.each(["trialing", "past_due", "unpaid", "paused", "canceled", "incomplete"])(
    "denies a subscription in %s state", (status) => {
      expect(() => requireHostedAccess("candidate-a", [{ ...paid, status }], now))
        .toThrow("Hosted access unavailable");
    });

  it("denies a revoked free grant", () => {
    for (const revokedAt of ["2026-11-26T15:59:59Z", "2026-11-27T00:00:00Z"]) {
      expect(() => requireHostedAccess("candidate-a", [{ ...friend, revokedAt }], now))
        .toThrow("Hosted access unavailable");
    }
  });

  it("fails closed on damaged dates and unrecognized record fields", () => {
    for (const record of [{ ...paid, endsAt: "not-a-date" },
      { ...paid, endsAt: "2026-10-01T00:00:00Z" }, { ...paid, paidByUser: true }]) {
      expect(() => requireHostedAccess("candidate-a", [record], now)).toThrow();
    }
    expect(() => requireHostedAccess("candidate-a", [paid], new Date("bad"))).toThrow();
  });
});
