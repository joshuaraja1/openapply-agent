import { describe, expect, it, vi } from "vitest";
import { processReadyBillingEvents } from "../src/hosted/stripe-billing-worker.js";
import type { HostedEntitlement } from "../src/hosted/entitlement.js";

const request = { eventId: "evt_1", customerId: "cus_1" };
const binding = { subjectId: "candidate-a", customerId: "cus_1" };
const plan = { priceId: "price_semester", amountCents: 12900, livemode: false };
const semester = { ...binding, checkoutSessionId: "cs_test_1", paymentIntentId: "pi_1",
  priceId: plan.priceId, amountCents: plan.amountCents, currency: "usd", livemode: false,
  checkoutStatus: "complete" as const, paymentStatus: "paid" as const,
  intentStatus: "succeeded", paidAt: "2026-11-01T00:00:00.000Z",
  amountRefunded: 0, disputed: false };

function harness() {
  const store = {
    listReady: vi.fn(async () => [request]), claim: vi.fn(async () => "event-lease"),
    claimCustomer: vi.fn(async (): Promise<string | undefined> => "customer-lease"),
    loadBinding: vi.fn(async (_customerId: string): Promise<typeof binding | undefined> => binding),
    claimedEventCreatedAt: vi.fn(async () => "2026-11-26T19:00:00.000Z"),
    quarantineUnbound: vi.fn(async () => {}),
    replacePaid: vi.fn(async (_subjectId: string,
      _records: readonly Extract<HostedEntitlement, { kind: "subscription" | "semester" }>[],
      _guard: { customerId: string; token: string }) => {}),
    complete: vi.fn(async () => {}), retry: vi.fn(async () => {}),
    releaseCustomer: vi.fn(async () => {}),
  };
  const reader = { loadCurrent: vi.fn(async () => []),
    loadSemesters: vi.fn(async () => [semester]) };
  return { store, reader };
}

describe("durable billing replay", () => {
  it("reads current Stripe state, atomically replaces paid records, then completes event", async () => {
    const { store, reader } = harness();
    expect(await processReadyBillingEvents(store, reader, plan)).toEqual({ processed: 1, deferred: 0,
      quarantined: 0 });
    expect(store.replacePaid).toHaveBeenCalledWith(binding.subjectId,
      [expect.objectContaining({ kind: "semester", checkoutSessionId: "cs_test_1" })],
      { customerId: request.customerId, token: "customer-lease" });
    expect(store.complete).toHaveBeenCalledWith(request.eventId, "event-lease");
    expect(store.releaseCustomer).toHaveBeenCalledWith(request.customerId, "customer-lease");
  });

  it("replays an old event from current refunded state", async () => {
    const { store, reader } = harness();
    reader.loadSemesters.mockResolvedValue([{ ...semester, amountRefunded: 12900 }]);
    await processReadyBillingEvents(store, reader, plan);
    expect(store.replacePaid.mock.calls[0]?.[1]?.[0]).toMatchObject({
      kind: "semester", revokedAt: semester.paidAt,
    });
  });

  it("does not mutate grants or acknowledge when Stripe is unavailable", async () => {
    const { store, reader } = harness();
    reader.loadCurrent.mockRejectedValue(new Error("Stripe unavailable"));
    expect(await processReadyBillingEvents(store, reader, plan))
      .toEqual({ processed: 0, deferred: 1, quarantined: 0 });
    expect(store.replacePaid).not.toHaveBeenCalled();
    expect(store.complete).not.toHaveBeenCalled();
    expect(store.retry).toHaveBeenCalledWith(request.eventId, "event-lease");
  });

  it("defers if another worker owns the customer lock", async () => {
    const { store, reader } = harness();
    store.claimCustomer.mockResolvedValue(undefined);
    expect(await processReadyBillingEvents(store, reader, plan))
      .toEqual({ processed: 0, deferred: 1, quarantined: 0 });
    expect(reader.loadCurrent).not.toHaveBeenCalled();
    expect(store.retry).toHaveBeenCalledWith(request.eventId, "event-lease", 10_000);
  });

  it("quarantines an old unbound event and still processes the next valid customer", async () => {
    const { store, reader } = harness();
    const poison = { eventId: "evt_poison", customerId: "cus_unbound" };
    store.listReady.mockResolvedValue([poison, request]);
    store.loadBinding.mockImplementation(async customerId => customerId === poison.customerId
      ? undefined as never : binding);
    const outcome = await processReadyBillingEvents(store, reader, plan, 25,
      () => new Date("2026-11-26T20:00:00.000Z"));
    expect(outcome).toEqual({ processed: 1, deferred: 0, quarantined: 1 });
    expect(store.quarantineUnbound).toHaveBeenCalledWith(poison.eventId, "event-lease",
      poison.customerId);
    expect(store.complete).toHaveBeenCalledWith(request.eventId, "event-lease");
    expect(store.retry).not.toHaveBeenCalled();
  });

  it("retries a new event until a late Customer binding commits", async () => {
    const { store, reader } = harness();
    store.claimedEventCreatedAt.mockResolvedValue("2026-11-26T19:59:00.000Z");
    store.loadBinding.mockResolvedValueOnce(undefined as never).mockResolvedValueOnce(binding);
    const clock = () => new Date("2026-11-26T20:00:00.000Z");
    expect(await processReadyBillingEvents(store, reader, plan, 25, clock))
      .toEqual({ processed: 0, deferred: 1, quarantined: 0 });
    expect(store.retry).toHaveBeenCalledWith(request.eventId, "event-lease", 30_000);
    expect(store.quarantineUnbound).not.toHaveBeenCalled();
    expect(await processReadyBillingEvents(store, reader, plan, 25, clock))
      .toEqual({ processed: 1, deferred: 0, quarantined: 0 });
    expect(store.complete).toHaveBeenCalledWith(request.eventId, "event-lease");
  });
});
