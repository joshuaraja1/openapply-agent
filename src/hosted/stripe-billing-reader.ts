import type Stripe from "stripe";
import type { TrustedStripeBillingSnapshot, TrustedChargeResolution }
  from "./stripe-webhook.js";
import type { SemesterPlan, TrustedSemesterPayment } from "./stripe-semester.js";

type StripeRead = Pick<Stripe, "subscriptions" | "invoices" | "invoicePayments" |
  "paymentIntents" | "charges" | "checkout">;
const idOf = (value: string | { id: string } | null | undefined): string | undefined =>
  typeof value === "string" ? value : value?.id;
const instant = (epoch: number) => new Date(epoch * 1000).toISOString();

async function allPages<T extends { id: string }>(
  getPage: (cursor?: string) => Promise<{ data: T[]; has_more: boolean }>,
): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await getPage(cursor);
    items.push(...page.data);
    if (items.length > 2_000) throw new Error("Stripe billing read exceeds safety bound");
    cursor = page.has_more ? page.data.at(-1)?.id : undefined;
    if (page.has_more && !cursor) throw new Error("Stripe billing pagination is incomplete");
  } while (cursor);
  return items;
}

/** Fresh Stripe reads; caller serializes reconciliation per customer. */
export class StripeBillingReader {
  constructor(private readonly stripe: StripeRead,
    private readonly monthlyPriceId: string,
    private readonly semester: SemesterPlan,
    private readonly monthlyAmountCents: number) {
    if (!Number.isSafeInteger(monthlyAmountCents) || monthlyAmountCents <= 0) {
      throw new Error("Invalid monthly plan amount");
    }
  }

  async loadCurrent(customerId: string): Promise<TrustedStripeBillingSnapshot[]> {
    const subscriptions = await allPages(cursor => this.stripe.subscriptions.list({
      customer: customerId, status: "all", limit: 100,
      ...(cursor ? { starting_after: cursor } : {}),
    }));
    const result: TrustedStripeBillingSnapshot[] = [];
    for (const subscription of subscriptions) {
      const item = subscription.items.data[0];
      if (subscription.items.has_more || subscription.items.data.length !== 1
        || item?.price.id !== this.monthlyPriceId) continue;
      if (idOf(subscription.customer) !== customerId) {
        throw new Error("Stripe subscription Customer mismatch");
      }
      if (subscription.livemode !== this.semester.livemode) {
        throw new Error("Stripe subscription mode mismatch");
      }
      const invoiceId = idOf(subscription.latest_invoice);
      let settledInvoiceId: string | undefined;
      let paymentReversed = false;
      if (invoiceId) {
        const invoice = await this.stripe.invoices.retrieve(invoiceId);
        if (idOf(invoice.customer) !== customerId
          || idOf(invoice.parent?.subscription_details?.subscription) !== subscription.id) {
          throw new Error("Stripe invoice binding mismatch");
        }
        if (invoice.status === "paid" && invoice.currency === "usd"
          && invoice.livemode === this.semester.livemode
          && invoice.amount_paid >= this.monthlyAmountCents) {
          const payments = await allPages(cursor => this.stripe.invoicePayments.list({
            invoice: invoiceId, status: "paid", limit: 100,
            ...(cursor ? { starting_after: cursor } : {}),
          }));
          if (payments.length === 0) paymentReversed = true;
          for (const payment of payments) {
            const intentId = idOf(payment.payment.payment_intent);
            const chargeId = idOf(payment.payment.charge);
            let charge: Stripe.Charge | undefined;
            if (intentId) {
              const intent = await this.stripe.paymentIntents.retrieve(intentId);
              if (idOf(intent.customer) !== customerId || intent.status !== "succeeded") {
                paymentReversed = true; continue;
              }
              const linked = idOf(intent.latest_charge);
              if (linked) charge = await this.stripe.charges.retrieve(linked);
            } else if (chargeId) charge = await this.stripe.charges.retrieve(chargeId);
            if (!charge || idOf(charge.customer) !== customerId || !charge.paid
              || charge.amount_refunded > 0 || charge.disputed) paymentReversed = true;
          }
          if (!paymentReversed) settledInvoiceId = invoiceId;
        }
      }
      const status = subscription.status === "incomplete_expired" ? "incomplete"
        : subscription.status;
      result.push({ customerId, subjectId: subscription.metadata?.subjectId ?? "",
        subscriptionId: subscription.id,
        status: status as TrustedStripeBillingSnapshot["status"],
        startsAt: instant(item.current_period_start),
        endsAt: instant(item.current_period_end),
        ...(settledInvoiceId ? { settledInvoiceId,
          paidThrough: instant(item.current_period_end) } : {}),
        paymentReversed });
    }
    return result;
  }

  async loadSemesters(customerId: string): Promise<TrustedSemesterPayment[]> {
    const sessions = await allPages(cursor => this.stripe.checkout.sessions.list({
      customer: customerId, limit: 100, ...(cursor ? { starting_after: cursor } : {}),
    }));
    const result: TrustedSemesterPayment[] = [];
    for (const session of sessions) {
      if (session.mode !== "payment" || session.metadata?.plan !== "semester") continue;
      if (idOf(session.customer) !== customerId) throw new Error("Stripe Checkout Customer mismatch");
      if (session.status !== "complete" || session.payment_status !== "paid") continue;
      const lines = await this.stripe.checkout.sessions.listLineItems(session.id, { limit: 100 });
      if (lines.has_more || lines.data.length !== 1 || lines.data[0]?.quantity !== 1
        || lines.data[0]?.price?.id !== this.semester.priceId) {
        throw new Error("Stripe semester Checkout line items do not match plan");
      }
      const intentId = idOf(session.payment_intent);
      if (!intentId) throw new Error("Paid Stripe Checkout has no PaymentIntent");
      const intent = await this.stripe.paymentIntents.retrieve(intentId);
      const chargeId = idOf(intent.latest_charge);
      if (!chargeId) throw new Error("Paid Stripe Checkout has no Charge");
      const charge = await this.stripe.charges.retrieve(chargeId);
      if (idOf(intent.customer) !== customerId || idOf(charge.customer) !== customerId
        || idOf(charge.payment_intent) !== intent.id || !charge.paid
        || charge.currency !== "usd" || charge.amount < this.semester.amountCents
        || intent.livemode !== this.semester.livemode
        || charge.livemode !== this.semester.livemode) {
        throw new Error("Stripe semester payment binding mismatch");
      }
      result.push({ customerId, subjectId: session.metadata?.subjectId ?? "",
        checkoutSessionId: session.id, paymentIntentId: intent.id,
        priceId: lines.data[0].price.id, amountCents: session.amount_total ?? 0,
        currency: session.currency ?? "", livemode: session.livemode,
        checkoutStatus: "complete", paymentStatus: "paid", intentStatus: intent.status,
        paidAt: instant(charge.created), amountRefunded: charge.amount_refunded,
        disputed: charge.disputed });
    }
    return result;
  }

  /** Do not classify a missing Customer as guest without inspecting linked funds. */
  async resolveCharge(chargeId: string): Promise<TrustedChargeResolution | undefined> {
    const charge = await this.stripe.charges.retrieve(chargeId);
    const customerId = idOf(charge.customer);
    if (customerId) return { kind: "customer", customerId };
    const intentId = idOf(charge.payment_intent);
    if (!intentId) return { kind: "verified-unaffiliated-guest" };
    const intent = await this.stripe.paymentIntents.retrieve(intentId);
    const linkedCustomer = idOf(intent.customer);
    if (linkedCustomer) return { kind: "customer", customerId: linkedCustomer };
    // A legacy invoice can own a PaymentIntent whose Customer field is absent.
    // Never acknowledge that refund as an unrelated guest without checking
    // invoice payments linked to the exact PaymentIntent.
    const payments = await allPages(cursor => this.stripe.invoicePayments.list({
      payment: { type: "payment_intent", payment_intent: intentId }, limit: 100,
      ...(cursor ? { starting_after: cursor } : {}),
    }));
    const invoiceCustomers = new Set<string>();
    for (const payment of payments) {
      const invoice = await this.stripe.invoices.retrieve(idOf(payment.invoice)!);
      const invoiceCustomer = idOf(invoice.customer);
      if (!invoiceCustomer) throw new Error("Stripe invoice payment has no Customer");
      invoiceCustomers.add(invoiceCustomer);
    }
    if (invoiceCustomers.size > 1) throw new Error("Refund charge links conflicting Customers");
    const invoiceCustomer = [...invoiceCustomers][0];
    if (invoiceCustomer) return { kind: "customer", customerId: invoiceCustomer };
    return { kind: "verified-unaffiliated-guest" };
  }
}
