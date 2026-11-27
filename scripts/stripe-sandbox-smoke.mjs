import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Stripe from "stripe";

const prices = {
  monthly: { id: "price_1UgCyzCVueFkF7gPR8i44Jgx", amountCents: 3900 },
  semester: { id: "price_1UgCzICVueFkF7gPnVdBZI4q", amountCents: 12900 },
};

/** Sweep Stripe state by disposable Customer, including sessions created just
 * before a local journal write or response fails. Never claim success if a
 * test session remains open or Customer cleanup is uncertain. */
export async function cleanupSandboxCustomer(stripe, customerId) {
  const open = [];
  let cursor;
  do {
    const page = await stripe.checkout.sessions.list({ customer: customerId, limit: 100,
      ...(cursor ? { starting_after: cursor } : {}) });
    open.push(...page.data.filter(session => session.status === "open"));
    cursor = page.has_more ? page.data.at(-1)?.id : undefined;
    if (page.has_more && !cursor) throw new Error(`Could not page test sessions for ${customerId}`);
  } while (cursor);

  const failures = [];
  for (const session of open) {
    try { await stripe.checkout.sessions.expire(session.id); }
    catch { failures.push(`expire ${session.id}`); }
  }
  try {
    const remaining = await stripe.checkout.sessions.list({ customer: customerId,
      status: "open", limit: 100 });
    if (remaining.data.length || remaining.has_more) {
      failures.push(`open sessions ${remaining.data.map(s => s.id).join(",")}`);
    }
  } catch { failures.push(`verify sessions for ${customerId}`); }
  if (failures.length) throw new Error(`Stripe sandbox cleanup incomplete: ${failures.join("; ")}; customer ${customerId}`);

  try {
    const deleted = await stripe.customers.del(customerId);
    if (deleted.id !== customerId || !deleted.deleted) throw new Error("deletion not confirmed");
  } catch {
    throw new Error(`Stripe sandbox Customer cleanup incomplete: ${customerId}`);
  }
}

async function main() {
  // Pass a restricted test key on stdin. Never put it in args, logs, or the repo.
  const key = readFileSync(0, "utf8").trim();
  if (!/^rk_test_[A-Za-z0-9]+$/.test(key)) {
    throw new Error("A restricted Stripe test key is required on stdin");
  }
  const { createHostedCheckout } = await import("../dist/src/hosted/stripe-checkout.js");
  const stripe = new Stripe(key);
  const config = { prices, livemode: false, appOrigin: "https://openapplyagent.xyz" };
  const subjectId = `sandbox-smoke-${randomUUID()}`;
  let customer;

  try {
    // A wrong account's key cannot retrieve either OpenApply-only Price ID.
    for (const [plan, expected] of Object.entries(prices)) {
      const price = await stripe.prices.retrieve(expected.id);
      if (price.livemode || price.unit_amount !== expected.amountCents || price.currency !== "usd"
        || (plan === "monthly" ? price.recurring?.interval !== "month"
          : price.type !== "one_time" || price.recurring !== null)) {
        throw new Error(`${plan} sandbox Price does not match the reviewed plan`);
      }
    }
    customer = await stripe.customers.create({ metadata: { purpose: "openapply-sandbox-smoke" } });
    for (const plan of ["monthly", "semester"]) {
      const reservation = { requestId: randomUUID(), subjectId, customerId: customer.id,
        plan, createdAt: new Date().toISOString() };
      const ports = {
        reserve: async () => reservation,
        recordSession: async (_requestId, session) => { reservation.session = session; },
      };
      const first = await createHostedCheckout(subjectId, plan, config, stripe, ports);
      const retry = await createHostedCheckout(subjectId, plan, config, stripe, ports);
      const remote = await stripe.checkout.sessions.retrieve(first.sessionId);
      const expectedMode = plan === "monthly" ? "subscription" : "payment";
      if (retry.sessionId !== first.sessionId || remote.mode !== expectedMode
        || remote.customer !== customer.id || remote.amount_total !== prices[plan].amountCents
        || remote.livemode || remote.metadata?.subjectId !== subjectId) {
        throw new Error(`${plan} Checkout verification failed`);
      }
      console.log(`${plan}: test Checkout created, retrieved, and reused`);
    }
  } finally {
    if (customer) await cleanupSandboxCustomer(stripe, customer.id);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
