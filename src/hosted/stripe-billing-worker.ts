import type { DynamoBillingStore } from "./stripe-billing-store.js";
import type { StripeBillingReader } from "./stripe-billing-reader.js";
import { projectSemesterSet, type SemesterPlan } from "./stripe-semester.js";
import { projectSubscriptionSet } from "./stripe-webhook.js";

type Store = Pick<DynamoBillingStore, "listReady" | "claim" | "claimCustomer" |
  "loadBinding" | "replacePaid" | "complete" | "retry" | "releaseCustomer">;
type Reader = Pick<StripeBillingReader, "loadCurrent" | "loadSemesters">;

/** One bounded scheduled batch. Failed provider reads leave events retryable. */
export async function processReadyBillingEvents(store: Store, reader: Reader,
  semesterPlan: SemesterPlan, limit = 25): Promise<{ processed: number; deferred: number }> {
  const ready = await store.listReady(limit);
  let processed = 0;
  let deferred = 0;
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
      const binding = await store.loadBinding(request.customerId);
      if (!binding || binding.customerId !== request.customerId) {
        throw new Error("Stripe customer is not bound to the candidate");
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
    } catch (error) {
      await store.retry(request.eventId, eventToken);
      deferred++;
      if (error instanceof Error && error.message.includes("not bound")) throw error;
    } finally {
      if (customerToken) await store.releaseCustomer(request.customerId, customerToken);
    }
  }
  return { processed, deferred };
}
