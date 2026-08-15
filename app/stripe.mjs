import Stripe from "stripe";

const API_VERSION = "2026-07-29.dahlia";

// Tags every session we create so the Dashboard can compare checkout flows.
// The 8-letter suffix is fixed for this integration, not per-session.
const INTEGRATION_IDENTIFIER = "hackterac-qwzptmlv";

if (!process.env.STRIPE_SECRET_KEY) {
  throw new Error("STRIPE_SECRET_KEY is not set");
}

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: API_VERSION,
});

/**
 * The organizers track revenue through exactly one Payment Link, so we reuse it
 * for every sale and attribute buyers with client_reference_id, which Stripe
 * echoes back on the checkout.session.* events.
 */
export function paymentLinkFor(orderId, { email } = {}) {
  const base = process.env.STRIPE_PAYMENT_LINK;
  if (!base) throw new Error("STRIPE_PAYMENT_LINK is not set");
  const url = new URL(base);
  url.searchParams.set("client_reference_id", orderId);
  if (email) url.searchParams.set("prefilled_email", email);
  return url.toString();
}

/**
 * Alternative to the shared Payment Link for flows that need a server-controlled
 * amount or richer metadata. Revenue still lands on the same account, but the
 * organizers' tooling keys off the Payment Link, so prefer paymentLinkFor()
 * for anything that must show up in their revenue total.
 */
export async function createCheckoutSession({
  orderId,
  amountCents,
  productName,
  email,
  metadata = {},
}) {
  return stripe.checkout.sessions.create({
    mode: "payment",
    // payment_method_types is deliberately omitted so dynamic payment methods apply.
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: amountCents,
          product_data: { name: productName },
        },
      },
    ],
    client_reference_id: orderId,
    customer_email: email,
    metadata: { order_id: orderId, ...metadata },
    integration_identifier: INTEGRATION_IDENTIFIER,
    success_url: `${process.env.APP_URL}/thanks?order=${orderId}`,
    cancel_url: `${process.env.APP_URL}/?cancelled=${orderId}`,
  });
}

export function constructEvent(rawBody, signature) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error("STRIPE_WEBHOOK_SECRET is not set");
  return stripe.webhooks.constructEvent(rawBody, signature, secret);
}
