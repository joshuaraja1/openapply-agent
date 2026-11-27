import type { DynamoBillingStore } from "./stripe-billing-store.js";
import type { StripeBillingReader } from "./stripe-billing-reader.js";
import { projectSemesterSet, type SemesterPlan } from "./stripe-semester.js";
import { projectSubscriptionSet } from "./stripe-webhook.js";

type Store = Pick<DynamoBillingStore, "listReady" | "claim" | "claimCustomer" |
  "loadBinding" | "replacePaid" | "complete" | "retry" | "releaseCustomer" |
  "claimedEventCreatedAt" | "quarantineUnbound">;
type Reader = Pick<StripeBillingReader, "loadCurrent" | "loadSemesters">;
const BINDING_GRACE_MS = 5 * 60_000;

/** One bounded scheduled batch. Failed provider reads leave events retryable. */
export async function processReadyBillingEvents(store: Store, reader: Reader,
  semesterPlan: SemesterPlan, limit = 25,
  now: () => Date = () => new Date()): Promise<{ processed: number; deferred: number;
    quarantined: number }> {
  const ready = await store.listReady(limit);
  let processed = 0;
  let deferred = 0;
  let quarantined = 0;
  for (const request of ready) {
    const eventToken = await store.claim(request);
    if (!eventToken) { deferred++; continue; }
    let customerToken: string | undefined;
    try {
      customerToken = await store.claimCustomer(request.customerId);
      if (!customerToken) {
        await store.retry(request.eventId, eventToken, 10_000);
        deferred++;
        continue;
      }
      let binding: Awaited<ReturnType<Store["loadBinding"]>>;
      try { binding = await store.loadBinding(request.customerId); }
      catch (error) {
        if (!(error instanceof Error) || !(error.message.startsWith("Stripe customer ")
          || error.message === "Invalid subject ID")) throw error;
        // A damaged forward/reverse binding is never trusted for access.
        binding = undefined;
      }
      if (!binding || binding.customerId !== request.customerId) {
        const createdAt = await store.claimedEventCreatedAt(request.eventId,
          eventToken, request.customerId);
        const age = now().getTime() - Date.parse(createdAt);
        if (!Number.isFinite(age) || age < -BINDING_GRACE_MS) {
          throw new Error("Stripe event creation time is invalid");
        }
        if (age >= BINDING_GRACE_MS) {
          await store.quarantineUnbound(request.eventId, eventToken, request.customerId);
          quarantined++;
        } else {
          // Checkout can deliver a signed event before its Customer binding
          // transaction commits. A bounded grace window permits recovery.
          await store.retry(request.eventId, eventToken, 30_000);
          deferred++;
        }
        continue;
      }
      // Both provider reads precede a single atomic paid-grant replacement.
      const [subscriptions, semesters] = await Promise.all([
        reader.loadCurrent(request.customerId), reader.loadSemesters(request.customerId),
      ]);
      const paid = [
        ...projectSubscriptionSet(binding, subscriptions),
        ...projectSemesterSet(binding, semesters, semesterPlan),
      ];
      await store.replacePaid(binding.subjectId, paid,
        { customerId: request.customerId, token: customerToken });
      await store.complete(request.eventId, eventToken);
      processed++;
    } catch {
      await store.retry(request.eventId, eventToken);
      deferred++;
    } finally {
      if (customerToken) await store.releaseCustomer(request.customerId, customerToken);
    }
  }
  return { processed, deferred, quarantined };
}
