import express from "express";
import crypto from "node:crypto";
import { constructEvent, paymentLinkFor } from "./stripe.mjs";
import {
  claimEvent,
  createOrder,
  markOrderFailed,
  markOrderPaid,
  query,
  recordTeracResponse,
  revenueTotals,
} from "./db.mjs";

const app = express();

// The webhook needs the raw body for signature verification, so it is mounted
// before the JSON parser.
app.post(
  "/webhooks/stripe",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    let event;
    try {
      event = constructEvent(req.body, req.headers["stripe-signature"]);
    } catch (err) {
      console.error("stripe signature verification failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Acknowledge before doing work so Stripe does not time out and retry.
    res.json({ received: true });

    try {
      if (!(await claimEvent(event.id, event.type))) return;
      await handleStripeEvent(event);
    } catch (err) {
      console.error(`handling ${event.type} ${event.id} failed:`, err);
    }
  },
);

app.use(express.json());

async function handleStripeEvent(event) {
  const session = event.data.object;
  const orderId = session.client_reference_id ?? session.metadata?.order_id;

  switch (event.type) {
    // Both events must be handled. With delayed-notification payment methods
    // `completed` arrives while the session is still unpaid, so fulfilling on
    // it alone both grants access to payments that later fail and never
    // fulfills the ones that succeed.
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded": {
      if (session.payment_status === "unpaid") return;
      if (!orderId) {
        console.warn(`${event.type} ${session.id} has no order reference`);
        return;
      }
      const order = await markOrderPaid(orderId, session);
      if (!order) {
        console.warn(`no order row for ${orderId}`);
        return;
      }
      await fulfill(order);
      return;
    }
    case "checkout.session.async_payment_failed": {
      if (orderId) await markOrderFailed(orderId);
      return;
    }
    default:
      return;
  }
}

/** Post-payment side effects live here, never on the success page. */
async function fulfill(order) {
  console.log(`fulfilled order ${order.id} for ${order.amount_cents} cents`);
}

app.get("/healthz", async (_req, res) => {
  try {
    await query("select 1");
    res.json({ ok: true });
  } catch (err) {
    res.status(503).json({ ok: false, error: err.message });
  }
});

/** Creates an order and hands back the one tracked Payment Link, attributed. */
app.post("/api/orders", async (req, res) => {
  try {
    const { email, product, amountCents, metadata } = req.body ?? {};
    const id = `ord_${crypto.randomBytes(8).toString("hex")}`;
    await createOrder({ id, email, product, amountCents, metadata });
    res.status(201).json({ orderId: id, checkoutUrl: paymentLinkFor(id, { email }) });
  } catch (err) {
    console.error("create order failed:", err);
    res.status(500).json({ error: "could not create order" });
  }
});

/**
 * Terac appends ?teracSubmissionId=&taskId= to the task_url. The response body
 * is not retrievable from Terac's API afterwards, so this is the only place the
 * human input is ever captured. Losing it here loses it permanently.
 */
app.post("/api/terac/responses", async (req, res) => {
  try {
    const { teracSubmissionId, taskId, opportunityId, ...payload } = req.body ?? {};
    if (!teracSubmissionId) {
      return res.status(400).json({ error: "teracSubmissionId is required" });
    }
    await recordTeracResponse({ teracSubmissionId, taskId, opportunityId, payload });
    res.status(201).json({
      ok: true,
      // Marks the submission complete on Terac's side and triggers payout.
      redirect: `https://terac.com/api/external/callback?teracSubmissionId=${encodeURIComponent(
        teracSubmissionId,
      )}&taskId=${encodeURIComponent(taskId ?? "")}&result=completed`,
    });
  } catch (err) {
    console.error("capture failed:", err);
    res.status(500).json({ error: "could not record response" });
  }
});

app.get("/api/revenue", async (_req, res) => {
  res.json(await revenueTotals());
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`listening on ${port}`));
