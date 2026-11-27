import type Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";
import { StripeBillingReader } from "../src/hosted/stripe-billing-reader.js";

const plan = { priceId: "price_semester", amountCents: 12900, livemode: false };
const customer = "cus_test";
const list = <T>(data: T[]) => ({ data, has_more: false });

function harness() {
  const session = { id: "cs_test_1", customer, mode: "payment", metadata: {
    plan: "semester", subjectId: "candidate-a" }, status: "complete",
    payment_status: "paid", payment_intent: "pi_test", amount_total: 12900,
    currency: "usd", livemode: false };
  const intent = { id: "pi_test", customer, status: "succeeded", latest_charge: "ch_test",
    livemode: false };
  const charge = { id: "ch_test", customer, payment_intent: "pi_test", paid: true,
    currency: "usd", amount: 12900, amount_refunded: 0, disputed: false,
    livemode: false, created: 1_762_000_000 };
  const stripe = { subscriptions: { list: vi.fn(async () => list([])) },
    invoices: { retrieve: vi.fn() }, invoicePayments: { list: vi.fn() },
    checkout: { sessions: { list: vi.fn(async () => list([session])),
      listLineItems: vi.fn(async () => list([{ quantity: 1, price: { id: plan.priceId } }])) } },
    paymentIntents: { retrieve: vi.fn(async () => intent) },
    charges: { retrieve: vi.fn(async () => charge) } };
  const reader = new StripeBillingReader(stripe as unknown as Stripe,
    "price_monthly", plan, 3900);
  return { session, intent, charge, stripe, reader };
}

describe("fresh Stripe billing reader", () => {
  it("only derives a semester payment from linked, paid provider objects", async () => {
    const { reader } = harness();
    expect(await reader.loadSemesters(customer)).toEqual([
      expect.objectContaining({ customerId: customer, subjectId: "candidate-a",
        amountCents: 12900, amountRefunded: 0, disputed: false }),
    ]);
  });

  it("refuses an unpaid or unrelated charge instead of granting access", async () => {
    const { reader, stripe, charge } = harness();
    stripe.charges.retrieve.mockResolvedValue({ ...charge, paid: false });
    await expect(reader.loadSemesters(customer)).rejects.toThrow("binding mismatch");
    stripe.charges.retrieve.mockResolvedValue({ ...charge, customer: "cus_other" });
    await expect(reader.loadSemesters(customer)).rejects.toThrow("binding mismatch");
  });

  it("carries a refund from current Stripe state for entitlement revocation", async () => {
    const { reader, stripe, charge } = harness();
    stripe.charges.retrieve.mockResolvedValue({ ...charge, amount_refunded: 12900 });
    expect((await reader.loadSemesters(customer))[0]?.amountRefunded).toBe(12900);
  });

  it("fails closed on incomplete pagination", async () => {
    const { reader, stripe } = harness();
    stripe.checkout.sessions.list.mockResolvedValue({ data: [], has_more: true });
    await expect(reader.loadSemesters(customer)).rejects.toThrow("pagination is incomplete");
  });

  it("resolves a refunded charge through invoice payments when direct Customer is absent", async () => {
    const { reader, stripe, charge, intent } = harness();
    stripe.charges.retrieve.mockResolvedValue({ ...charge, customer: null as unknown as string });
    stripe.paymentIntents.retrieve.mockResolvedValue({ ...intent, customer: null as unknown as string });
    stripe.invoicePayments.list.mockResolvedValue(list([{ id: "inpay_1", invoice: "in_1" }]));
    stripe.invoices.retrieve.mockResolvedValue({ id: "in_1", customer });
    expect(await reader.resolveCharge("ch_test")).toEqual({ kind: "customer", customerId: customer });
    expect(stripe.invoicePayments.list).toHaveBeenCalledWith(expect.objectContaining({
      payment: { type: "payment_intent", payment_intent: "pi_test" },
    }));
  });
});
