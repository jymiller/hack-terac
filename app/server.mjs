import express from "express";
import crypto from "node:crypto";
import { constructEvent, paymentLinkFor } from "./stripe.mjs";
import {
  agreementByProcess,
  claimEvent,
  claimVerdicts,
  createOrder,
  markOrderFailed,
  markOrderPaid,
  query,
  recordAttestations,
  recordTeracResponse,
  revenueTotals,
} from "./db.mjs";
import { thetaLicensed, label as readinessLabel } from "./readiness.mjs";
import { coveragePage, donePage, taskPage } from "./views.mjs";
import { registerLinqRoutes } from "./linq-routes.mjs";
import { registerOpsRoutes } from "./ops.mjs";
import { registerDesignRoutes } from "./design.mjs";
import { registerExtractRoutes } from "./extract.mjs";
import { registerSupportRoutes } from "./support.mjs";
import { boardPage, boardState } from "./board.mjs";

const FLOOR = 0.9;
// Fallback only. The real value is per-wave: the participant costs the same whether they
// answer 4 claims or 40, so claims-per-task is the main lever on cost per judgment.
const CLAIMS_PER_TASK = 4;
const MAPPED = [
  { name: "Corporate authority and entity existence", expertise_area: "Corporate legal" },
  { name: "Lien perfection — debtor-name sufficiency", expertise_area: "Secured lending" },
  { name: "Collateral eligibility screening", expertise_area: "Asset-based lending" },
  { name: "Beneficial-ownership completeness", expertise_area: "Financial crime" },
  { name: "Legal opinion coverage checklist", expertise_area: "Counsel opinions" },
  { name: "Contract construction — defined terms", expertise_area: "Credit legal" },
];

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

// Before the global JSON parser: the Linq webhook verifies a signature over raw bytes.
const { webhookPath: linqWebhookPath } = registerLinqRoutes(app);

// Operator console. Its routes carry their own JSON parser for the same reason.
registerOpsRoutes(app);
registerDesignRoutes(app);
registerExtractRoutes(app);
registerSupportRoutes(app);
// Certificate pages the worker and the models both read.
app.use("/docs", express.static("public/docs", { maxAge: "1h" }));

app.use(express.json());
// The worker task page is a plain HTML form, so it posts urlencoded, not JSON.
// Without this the body is empty and every real submission is lost permanently.
app.use(express.urlencoded({ extended: false }));

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

/** Deterministic claim block from the submission id, stratified across processes. */
async function claimsFor(submissionId, wave) {
  const h = crypto.createHash("sha256").update(submissionId).digest();
  let n = CLAIMS_PER_TASK;
  if (wave) {
    const { rows: w } = await query(
      `select claims_per_task from terac_opportunities where wave = $1 limit 1`,
      [wave],
    ).catch(() => ({ rows: [] }));
    if (w?.[0]?.claims_per_task) n = w[0].claims_per_task;
  }
  const { rows } = await query(
    `select id, process_id, evidence, proposition
       from claims where holdout = false order by process_id, id`,
  );
  const byProcess = new Map();
  for (const r of rows) {
    if (!byProcess.has(r.process_id)) byProcess.set(r.process_id, []);
    byProcess.get(r.process_id).push(r);
  }
  const groups = [...byProcess.values()];
  const out = [];
  const seen = new Set();
  for (let i = 0; i < n && groups.length; i++) {
    const g = groups[i % groups.length];
    // Walk forward on collision so a big block does not repeat the same claim.
    let idx = (h.readUInt32BE((i * 4) % 28) + Math.floor(i / groups.length)) % g.length;
    for (let tries = 0; tries < g.length && seen.has(g[idx].id); tries++) idx = (idx + 1) % g.length;
    seen.add(g[idx].id);
    out.push(g[idx]);
  }
  return out;
}

/**
 * The worker lands here. Terac appends ?teracSubmissionId=&taskId= to task_url, and the
 * response body is not retrievable from Terac's API afterwards, so an arrival receipt is
 * written before anything renders — that makes an abandon measurable instead of invisible.
 */
app.get("/t/:wave", async (req, res) => {
  const { teracSubmissionId, taskId, opportunityId } = req.query;
  if (!teracSubmissionId) {
    return res.status(400).send("This link is missing its Terac submission id.");
  }
  try {
    await recordTeracResponse({
      teracSubmissionId,
      taskId,
      opportunityId,
      payload: { status: "opened", wave: req.params.wave, opened_at: new Date().toISOString() },
    });
    const claims = await claimsFor(teracSubmissionId, req.params.wave);
    res.type("html").send(taskPage({ submissionId: teracSubmissionId, taskId, opportunityId, claims }));
  } catch (err) {
    console.error("task render failed:", err);
    res.status(500).send("Sorry — this task could not be loaded.");
  }
});

/**
 * The only durable record of the human input. The write happens BEFORE the redirect
 * that marks the submission complete on Terac's side: redirecting on a failed insert
 * would pay a worker for data we no longer hold.
 */
app.post("/api/terac/responses", async (req, res) => {
  const body = req.body ?? {};
  const { teracSubmissionId, taskId, opportunityId } = body;
  const form = req.is("application/x-www-form-urlencoded");
  if (!teracSubmissionId) {
    return res.status(400).json({ error: "teracSubmissionId is required" });
  }
  try {
    const items = Object.entries(body)
      .filter(([k]) => k.startsWith("item_"))
      .map(([k, v]) => ({ claimId: k.slice(5), answer: v }));
    const payload = {
      status: "completed",
      submitted_at: new Date().toISOString(),
      items,
      ...(form ? {} : body),
    };
    await recordTeracResponse({ teracSubmissionId, taskId, opportunityId, payload });

    // Normalization sits OUTSIDE the capture failure boundary. The raw payload is the
    // durable record; if deriving attestations fails we still complete and still pay the
    // worker, and scripts/backfill-attestations.mjs re-derives from the stored payload.
    try {
      if (items.length) await recordAttestations({ teracSubmissionId, items });
    } catch (err) {
      console.error(`normalize failed for ${teracSubmissionId} (raw payload is safe):`, err.message);
    }

    const redirect =
      `https://terac.com/api/external/callback?teracSubmissionId=${encodeURIComponent(teracSubmissionId)}` +
      `&taskId=${encodeURIComponent(taskId ?? "")}&result=completed`;
    // A server-side 303 so a worker with JS disabled still completes and still gets paid.
    if (form) return res.redirect(303, redirect);
    res.status(201).json({ ok: true, redirect });
  } catch (err) {
    console.error("capture failed:", err);
    res.status(500).json({ error: "could not record response" });
  }
});

app.get("/done", (_req, res) => res.type("html").send(donePage()));

async function coverage() {
  const { rows: processes } = await query(`select * from processes order by id`);
  const measured = new Map((await agreementByProcess()).map((r) => [r.process_id, r]));

  // Judgments are nested inside workers and inside claims, so they are not independent
  // trials. The bound is computed over CLAIMS, using each claim's majority verdict.
  const verdicts = await claimVerdicts();
  const perProcess = new Map();
  for (const v of verdicts) {
    const g = perProcess.get(v.process_id) ?? { n: 0, x: 0 };
    g.n++;
    if (v.majority === "AGREE") g.x++;
    perProcess.set(v.process_id, g);
  }

  const rows = processes.map((p) => {
    const m = measured.get(p.id);
    const g = perProcess.get(p.id) ?? { n: 0, x: 0 };
    return {
      process_id: p.id,
      name: p.name,
      expertise_area: p.expertise_area,
      claims: g.n,
      judgments: m?.judgments ?? 0,
      agreement: g.n ? g.x / g.n : null,
      lower: g.n ? thetaLicensed(g.x, g.n) : null,
      label: readinessLabel({ x: g.x, n: g.n, floor: FLOOR }),
      evidence_mode: g.n ? "live" : "synthetic",
      cost: Number(m?.cost_usd ?? 0),
    };
  });
  const totals = rows.reduce(
    (a, r) => ({
      judgments: a.judgments + r.judgments,
      claims: a.claims + r.claims,
      cost: a.cost + r.cost,
    }),
    { judgments: 0, claims: 0, cost: 0 },
  );
  totals.perJudgment = totals.judgments ? (totals.cost / totals.judgments).toFixed(2) : "0.00";
  return { rows, mapped: MAPPED, totals, floor: FLOOR };
}

app.get("/api/coverage", async (_req, res) => res.json(await coverage()));

app.get("/", async (_req, res) => {
  try {
    res.type("html").send(boardPage(await boardState()));
  } catch (err) {
    console.error("board failed:", err);
    res.status(500).send(`<pre>${err.message}</pre>`);
  }
});

app.get("/api/revenue", async (_req, res) => {
  res.json(await revenueTotals());
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`listening on ${port}`));
