import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import Stripe from "stripe";
import { createHostedCheckout } from "../dist/src/hosted/stripe-checkout.js";

// Pass a restricted test key on stdin. Never place it in command arguments,
// logs, or a file in this repository.
const key = readFileSync(0, "utf8").trim();
if (!/^rk_test_[A-Za-z0-9]+$/.test(key)) {
  throw new Error("A restricted Stripe test key is required on stdin");
}

const stripe = new Stripe(key);
const prices = {
  monthly: { id: "price_1UgCyzCVueFkF7gPR8i44Jgx", amountCents: 3900 },
  semester: { id: "price_1UgCzICVueFkF7gPnVdBZI4q", amountCents: 12900 },
};
const config = { prices, livemode: false, appOrigin: "https://openapplyagent.xyz" };
const subjectId = `sandbox-smoke-${randomUUID()}`;
const sessions = [];
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
    const reservation = {
      requestId: randomUUID(), subjectId, customerId: customer.id, plan,
      createdAt: new Date().toISOString(),
    };
    const ports = {
      reserve: async () => reservation,
      recordSession: async (_requestId, session) => { reservation.session = session; },
    };
    const first = await createHostedCheckout(subjectId, plan, config, stripe, ports);
    sessions.push(first.sessionId);
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
  for (const id of sessions) {
    try { await stripe.checkout.sessions.expire(id); }
    catch { console.error("A test Checkout session may need manual expiration"); }
  }
  if (customer) {
    try { await stripe.customers.del(customer.id); }
    catch { console.error("A test Customer may need manual deletion"); }
  }
}
