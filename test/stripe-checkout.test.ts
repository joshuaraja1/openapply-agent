import { describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import { createHostedCheckout, type CheckoutPorts } from "../src/hosted/stripe-checkout.js";

const config = {
  prices: { monthly: { id: "price_1UgCyzCVueFkF7gPR8i44Jgx", amountCents: 3900 },
    semester: { id: "price_1UgCzICVueFkF7gPnVdBZI4q", amountCents: 12900 } },
  livemode: false,
  appOrigin: "https://openapplyagent.xyz",
};

function harness(overrides: Record<string, unknown> = {}) {
  const price = { active: true, livemode: false, type: "recurring", currency: "usd", unit_amount: 3900,
    recurring: { interval: "month", interval_count: 1 }, ...overrides };
  const retrieve = vi.fn(async () => price);
  const create = vi.fn(async (_params: unknown, _opts: unknown) => ({ id: "cs_test_123", url: "https://checkout.stripe.com/c/pay/cs_test_123",
    expires_at: Date.parse("2026-11-27T12:00:00Z") / 1000 }));
  const stripe = { prices: { retrieve }, checkout: { sessions: { create } } } as unknown as
    Pick<Stripe, "prices" | "checkout">;
  const ports: CheckoutPorts = {
    reserve: vi.fn(async (subjectId) => ({ subjectId, customerId: "cus_123", requestId: "request123",
      createdAt: "2026-11-26T12:00:00Z" })),
    recordSession: vi.fn(async () => {}),
  };
  return { stripe, ports, retrieve, create };
}

describe("Stripe hosted checkout", () => {
  it("uses a trusted customer binding, an approved recurring price, and a stable retry key", async () => {
    const h = harness();
    const result = await createHostedCheckout("candidate123", "monthly", config, h.stripe, h.ports,
      new Date("2026-11-26T12:00:00Z"));
    expect(result.url).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    expect(h.create).toHaveBeenCalledWith(expect.objectContaining({
      mode: "subscription", customer: "cus_123", client_reference_id: "candidate123",
      line_items: [{ price: config.prices.monthly.id, quantity: 1 }],
      success_url: "https://openapplyagent.xyz/billing/success?session_id={CHECKOUT_SESSION_ID}",
    }), { idempotencyKey: "openapply-checkout-request123" });
    expect(h.ports.recordSession).toHaveBeenCalledWith("request123", result);
  });

  it("uses one-time payment mode for a semester that does not auto-renew", async () => {
    const h = harness({ type: "one_time", recurring: null, unit_amount: 12900 });
    await createHostedCheckout("candidate123", "semester", config, h.stripe, h.ports,
      new Date("2026-11-26T12:00:00Z"));
    expect(h.retrieve).toHaveBeenCalledWith(config.prices.semester.id);
    expect(h.create).toHaveBeenCalledWith(expect.objectContaining({ mode: "payment" }), expect.anything());
    expect(h.create.mock.calls[0]?.[0]).not.toHaveProperty("subscription_data");
  });

  it.each([
    { active: false }, { livemode: true }, { currency: "eur" },
    { recurring: { interval: "month", interval_count: 4 } },
    { recurring: null }, { unit_amount: 0 }, { unit_amount: 4000 },
  ])("rejects a mismatched price before reserving checkout: %o", async (bad) => {
    const h = harness(bad);
    await expect(createHostedCheckout("candidate123", "monthly", config, h.stripe, h.ports,
      new Date("2026-11-26T12:00:00Z")))
      .rejects.toThrow(/price does not match/);
    expect(h.ports.reserve).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
  });

  it("rejects a customer binding for another candidate", async () => {
    const h = harness();
    h.ports.reserve = vi.fn(async () => ({ subjectId: "other", customerId: "cus_123", requestId: "request123",
      createdAt: "2026-11-26T12:00:00Z" }));
    await expect(createHostedCheckout("candidate123", "monthly", config, h.stripe, h.ports,
      new Date("2026-11-26T12:00:00Z")))
      .rejects.toThrow(/not bound/);
    expect(h.create).not.toHaveBeenCalled();
  });

  it("rejects an untrusted application origin and a non-Stripe checkout URL", async () => {
    const h = harness();
    await expect(createHostedCheckout("candidate123", "monthly",
      { ...config, appOrigin: "http://example.com" }, h.stripe, h.ports,
      new Date("2026-11-26T12:00:00Z")))
      .rejects.toThrow(/origin/);
    expect(h.retrieve).not.toHaveBeenCalled();
    h.create.mockResolvedValue({ id: "cs_test_123", url: "https://example.com/redirect",
      expires_at: Date.parse("2026-11-27T12:00:00Z") / 1000 });
    await expect(createHostedCheckout("candidate123", "monthly", config, h.stripe, h.ports,
      new Date("2026-11-26T12:00:00Z")))
      .rejects.toThrow(/session/);
    expect(h.ports.recordSession).not.toHaveBeenCalled();
  });

  it("does not grant access from a successful redirect", async () => {
    const h = harness();
    await createHostedCheckout("candidate123", "monthly", config, h.stripe, h.ports,
      new Date("2026-11-26T12:00:00Z"));
    expect(h.ports).not.toHaveProperty("grantAccess");
  });

  it("reuses a recorded session and never creates a second one", async () => {
    const h = harness();
    h.ports.reserve = vi.fn(async (subjectId) => ({ subjectId, customerId: "cus_123",
      requestId: "request123", createdAt: "2026-11-26T12:00:00Z",
      session: { sessionId: "cs_test_123", url: "https://checkout.stripe.com/c/pay/cs_test_123",
        expiresAt: "2026-11-27T12:00:00Z" } }));
    await createHostedCheckout("candidate123", "monthly", config, h.stripe, h.ports,
      new Date("2026-11-27T07:00:00Z"));
    expect(h.create).not.toHaveBeenCalled();
  });

  it("fails closed after Stripe can prune a lost idempotency key", async () => {
    const h = harness();
    await expect(createHostedCheckout("candidate123", "monthly", config, h.stripe, h.ports,
      new Date("2026-11-27T13:00:00Z")))
      .rejects.toThrow(/reconciliation/);
    expect(h.create).not.toHaveBeenCalled();
  });

  it("bounds the idempotency key and rejects an expired recorded session", async () => {
    const h = harness();
    h.ports.reserve = vi.fn(async (subjectId) => ({ subjectId, customerId: "cus_123",
      requestId: "x".repeat(161), createdAt: "2026-11-26T12:00:00Z" }));
    await expect(createHostedCheckout("candidate123", "monthly", config, h.stripe, h.ports,
      new Date("2026-11-26T12:00:00Z"))).rejects.toThrow(/not bound/);
    h.ports.reserve = vi.fn(async (subjectId) => ({ subjectId, customerId: "cus_123",
      requestId: "request123", createdAt: "2026-11-26T12:00:00Z",
      session: { sessionId: "cs_test_123", url: "https://checkout.stripe.com/c/pay/cs_test_123",
        expiresAt: "2026-11-27T12:00:00Z" } }));
    await expect(createHostedCheckout("candidate123", "monthly", config, h.stripe, h.ports,
      new Date("2026-11-27T13:00:00Z"))).rejects.toThrow(/expired/);
    expect(h.create).not.toHaveBeenCalled();
  });
});
