import { describe, expect, it, vi } from "vitest";
import { requireHostedAccess } from "../src/hosted/entitlement.js";
import { fourMonthsAfter, projectSemesterPayment, reconcileSemesterPayments,
  type TrustedSemesterPayment } from "../src/hosted/stripe-semester.js";
import type { HostedEntitlement } from "../src/hosted/entitlement.js";

const binding = { subjectId: "candidate-a", customerId: "cus_test_a" };
const plan = { priceId: "price_semester", amountCents: 12900, livemode: false };
const paid: TrustedSemesterPayment = {
  ...binding, checkoutSessionId: "cs_test_semester", paymentIntentId: "pi_test1",
  priceId: plan.priceId, amountCents: plan.amountCents, currency: "usd", livemode: false,
  checkoutStatus: "complete", paymentStatus: "paid", intentStatus: "succeeded",
  paidAt: "2026-10-31T12:00:00.000Z", amountRefunded: 0, disputed: false,
};

describe("four-month paid semester", () => {
  it("clamps calendar month ends and expires at the exact instant", () => {
    expect(fourMonthsAfter(paid.paidAt)).toBe("2027-02-28T12:00:00.000Z");
    const grant = projectSemesterPayment(binding, paid, plan)!;
    expect(requireHostedAccess(binding.subjectId, [grant],
      new Date("2027-02-28T11:59:59Z")).kind).toBe("semester");
    expect(() => requireHostedAccess(binding.subjectId, [grant],
      new Date("2027-02-28T12:00:00Z"))).toThrow("Hosted access unavailable");
  });

  it("rejects cross-candidate, wrong price, amount, currency, and mode", () => {
    expect(() => projectSemesterPayment({ ...binding, subjectId: "other" }, paid, plan))
      .toThrow("not bound");
    for (const wrong of [{ priceId: "price_other" }, { amountCents: 100 },
      { currency: "eur" }, { livemode: true }]) {
      expect(() => projectSemesterPayment(binding, { ...paid, ...wrong }, plan))
        .toThrow("configured plan");
    }
  });

  it("does not issue access on incomplete or unpaid Checkout", () => {
    expect(projectSemesterPayment(binding, { ...paid, checkoutStatus: "open" }, plan))
      .toBeUndefined();
    expect(projectSemesterPayment(binding, { ...paid, paymentStatus: "unpaid" }, plan))
      .toBeUndefined();
    expect(projectSemesterPayment(binding, { ...paid, intentStatus: "processing" }, plan))
      .toBeUndefined();
  });

  it("revokes access after refund or dispute", () => {
    for (const changed of [{ amountRefunded: 1 }, { disputed: true }]) {
      const grant = projectSemesterPayment(binding, { ...paid, ...changed }, plan)!;
      expect(() => requireHostedAccess(binding.subjectId, [grant],
        new Date("2026-11-01T00:00:00Z"))).toThrow("Hosted access unavailable");
    }
  });

  it("replaces semester grants from fresh provider state after an old event", async () => {
    const replaceSemesters = vi.fn(async (_subjectId: string,
      _records: readonly Extract<HostedEntitlement, { kind: "semester" }>[]) => {});
    let current: TrustedSemesterPayment[] = [paid];
    const ports = { loadBinding: async () => binding,
      loadCurrent: async () => current, replaceSemesters };
    await reconcileSemesterPayments(binding.customerId, ports, plan);
    expect(replaceSemesters.mock.calls[0]?.[1]).toHaveLength(1);
    current = [{ ...paid, amountRefunded: 12900 }];
    await reconcileSemesterPayments(binding.customerId, ports, plan);
    expect(replaceSemesters.mock.calls[1]?.[1]?.[0]).toMatchObject({ revokedAt: paid.paidAt });
  });
});
