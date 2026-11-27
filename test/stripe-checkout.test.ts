import { describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import { createHostedCheckout, type CheckoutPorts } from "../src/hosted/stripe-checkout.js";

const config = {
  prices: { monthly: { id: "price_monthly123", amountCents: 3900 },
    semester: { id: "price_semester123", amountCents: 12900 } },
  livemode: false,
  appOrigin: "https://openapplyagent.xyz",
};

function harness(overrides: Record<string, unknown> = {}) {
  const price = { active: true, livemode: false, currency: "usd", unit_amount: 3900,
    recurring: { interval: "month", interval_count: 1 }, ...overrides };
  const retrieve = vi.fn(async () => price);
  const create = vi.fn(async () => ({ id: "cs_test_123", url: "https://checkout.stripe.com/c/pay/cs_test_123" }));
  const stripe = { prices: { retrieve }, checkout: { sessions: { create } } } as unknown as
    Pick<Stripe, "prices" | "checkout">;
  const ports: CheckoutPorts = {
    reserve: vi.fn(async (subjectId) => ({ subjectId, customerId: "cus_123", requestId: "request123" })),
    recordSession: vi.fn(async () => {}),
  };
  return { stripe, ports, retrieve, create };
}

describe("Stripe hosted checkout", () => {
  it("uses a trusted customer binding, an approved recurring price, and a stable retry key", async () => {
    const h = harness();
    const result = await createHostedCheckout("candidate123", "monthly", config, h.stripe, h.ports);
    expect(result.url).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    expect(h.create).toHaveBeenCalledWith(expect.objectContaining({
      mode: "subscription", customer: "cus_123", client_reference_id: "candidate123",
      line_items: [{ price: "price_monthly123", quantity: 1 }],
      success_url: "https://openapplyagent.xyz/billing/success?session_id={CHECKOUT_SESSION_ID}",
    }), { idempotencyKey: "openapply-checkout-request123" });
    expect(h.ports.recordSession).toHaveBeenCalledWith("request123", "cs_test_123");
  });

  it("accepts only a four-month recurring price for the semester plan", async () => {
    const h = harness({ recurring: { interval: "month", interval_count: 4 }, unit_amount: 12900 });
    await createHostedCheckout("candidate123", "semester", config, h.stripe, h.ports);
    expect(h.retrieve).toHaveBeenCalledWith("price_semester123");
  });

  it.each([
    { active: false }, { livemode: true }, { currency: "eur" },
    { recurring: { interval: "month", interval_count: 4 } },
    { recurring: null }, { unit_amount: 0 }, { unit_amount: 4000 },
  ])("rejects a mismatched price before reserving checkout: %o", async (bad) => {
    const h = harness(bad);
    await expect(createHostedCheckout("candidate123", "monthly", config, h.stripe, h.ports))
      .rejects.toThrow(/price does not match/);
    expect(h.ports.reserve).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
  });

  it("rejects a customer binding for another candidate", async () => {
    const h = harness();
    h.ports.reserve = vi.fn(async () => ({ subjectId: "other", customerId: "cus_123", requestId: "request123" }));
    await expect(createHostedCheckout("candidate123", "monthly", config, h.stripe, h.ports))
      .rejects.toThrow(/not bound/);
    expect(h.create).not.toHaveBeenCalled();
  });

  it("rejects an untrusted application origin and a non-Stripe checkout URL", async () => {
    const h = harness();
    await expect(createHostedCheckout("candidate123", "monthly",
      { ...config, appOrigin: "http://example.com" }, h.stripe, h.ports))
      .rejects.toThrow(/origin/);
    expect(h.retrieve).not.toHaveBeenCalled();
    h.create.mockResolvedValue({ id: "cs_test_123", url: "https://example.com/redirect" });
    await expect(createHostedCheckout("candidate123", "monthly", config, h.stripe, h.ports))
      .rejects.toThrow(/hosted checkout/);
    expect(h.ports.recordSession).not.toHaveBeenCalled();
  });

  it("does not grant access from a successful redirect", async () => {
    const h = harness();
    await createHostedCheckout("candidate123", "monthly", config, h.stripe, h.ports);
    expect(h.ports).not.toHaveProperty("grantAccess");
  });
});
