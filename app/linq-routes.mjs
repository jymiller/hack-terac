import express from "express";
import { query } from "./db.mjs";
import { decisionFromReaction, notifySupervisor, parseInboundEvent, verifyWebhook } from "./linq.mjs";
import { handleInbound } from "./support.mjs";

/**
 * The iMessage approval channel for the one decision in this system that a named human
 * must make: promoting a cheaper policy to production.
 *
 * requestPromotion sends the supervisor a message and parks a `pending` row keyed by the
 * Linq message id. The supervisor's TAPBACK on that exact message is the authorization —
 * reaction.added arrives with `message_id`, which is what joins the gesture back to the
 * specific policy being promoted. Nothing else flips the row, so a policy cannot ship
 * without a real human gesture against a real request.
 *
 * Mount BEFORE `app.use(express.json())` in app/server.mjs:
 *     registerLinqRoutes(app);
 * The webhook signature is computed over raw bytes; a global JSON parser consumes them
 * first and verification then fails permanently.
 */

const WEBHOOK_PATH = "/webhooks/linq";

let schemaReady = null;
function ensureSchema() {
  schemaReady ??= (async () => {
    await query(`
      create table if not exists linq_promotions (
        id                bigserial primary key,
        process_id        text not null,
        policy            text not null,
        threshold         double precision,
        supervisor_handle text not null,
        linq_message_id   text unique,
        linq_chat_id      text,
        status            text not null default 'pending'
                          check (status in ('pending', 'approved', 'blocked')),
        decided_by        text,
        decided_reaction  text,
        requested_at      timestamptz not null default now(),
        decided_at        timestamptz
      )`);
    // Linq delivers at-least-once (10 retries over ~25 min); event_id is the dedupe key.
    await query(`
      create table if not exists linq_events (
        event_id    text primary key,
        event_type  text,
        received_at timestamptz not null default now()
      )`);
  })().catch((err) => {
    schemaReady = null;
    throw err;
  });
  return schemaReady;
}

/** Returns false when this event has already been processed. */
async function claimEvent(eventId, eventType) {
  if (!eventId) return true;
  const { rowCount } = await query(
    `insert into linq_events (event_id, event_type) values ($1, $2)
     on conflict (event_id) do nothing`,
    [eventId, eventType],
  );
  return rowCount === 1;
}

export async function requestPromotion({ processId, policy, threshold, to, detail } = {}) {
  if (!processId || !policy) throw new Error("requestPromotion: processId and policy are required");
  await ensureSchema();

  const supervisor = to ?? process.env.LINQ_SUPERVISOR_NUMBER;
  const sent = await notifySupervisor({
    to: supervisor,
    event: "promotion-requested",
    detail: { process: processId, policy, threshold: threshold ?? "n/a", ...(detail ?? {}) },
  });

  const { rows } = await query(
    `insert into linq_promotions
       (process_id, policy, threshold, supervisor_handle, linq_message_id, linq_chat_id)
     values ($1, $2, $3, $4, $5, $6)
     returning *`,
    [processId, policy, threshold ?? null, supervisor, sent.messageId, sent.chatId],
  );
  return rows[0];
}

async function applyReaction(evt) {
  const decision = decisionFromReaction(evt.reactionType);
  if (!evt.messageId) return null;

  // A tapback we placed ourselves is not authorization.
  if (evt.isFromMe) return null;

  if (evt.removed) {
    const { rows } = await query(
      `update linq_promotions
          set status = 'pending', decided_by = null, decided_reaction = null, decided_at = null
        where linq_message_id = $1
        returning *`,
      [evt.messageId],
    );
    return rows[0] ?? null;
  }

  if (!decision) return null;

  // Only a pending request can be decided: a second tapback must not silently
  // overturn a recorded decision.
  const { rows } = await query(
    `update linq_promotions
        set status = $2, decided_by = $3, decided_reaction = $4, decided_at = now()
      where linq_message_id = $1 and status = 'pending'
      returning *`,
    [evt.messageId, decision, evt.from ?? null, evt.reaction ?? null],
  );
  return rows[0] ?? null;
}

export function registerLinqRoutes(app) {
  // Route-level raw parser. `type: "*/*"` so a delivery with an unexpected
  // Content-Type still yields bytes rather than an empty body.
  app.post(WEBHOOK_PATH, express.raw({ type: "*/*" }), async (req, res) => {
    if (!Buffer.isBuffer(req.body)) {
      console.error(
        `linq webhook: body is not raw bytes — registerLinqRoutes(app) must be called BEFORE app.use(express.json()) in app/server.mjs`,
      );
      return res.status(500).json({ error: "raw body unavailable" });
    }

    let check;
    try {
      check = verifyWebhook(req.body, req.headers);
    } catch (err) {
      console.error("linq webhook:", err.message);
      return res.status(500).json({ error: err.message });
    }
    if (!check.valid) {
      console.warn(`linq webhook rejected: ${check.reason}`);
      return res.status(400).json({ error: check.reason });
    }

    // Answer inside Linq's 10s budget, then do the work.
    res.json({ received: true });

    let evt;
    try {
      evt = parseInboundEvent(JSON.parse(req.body.toString("utf8")));
    } catch (err) {
      console.error("linq webhook: unparseable body:", err.message);
      return;
    }

    try {
      await ensureSchema();
      if (!(await claimEvent(evt.eventId, evt.eventType))) return;

      if (evt.kind === "reaction") {
        const row = await applyReaction(evt);
        if (row) {
          console.log(
            `linq: promotion ${row.process_id}/${row.policy} -> ${row.status} by ${row.decided_by ?? "unknown"} (${evt.reaction})`,
          );
        } else {
          console.log(`linq: tapback "${evt.reaction}" on ${evt.messageId} matched no pending promotion`);
        }
      } else if (evt.kind === "message") {
        // A worker stuck on the task. Answer it if we have a written answer, escalate if not.
        const out = await handleInbound({ from: evt.from, text: evt.text });
        console.log(`linq: message from ${evt.from}: ${evt.text} -> ${out.action}${out.matched ? ` (${out.matched})` : ""}`);
      }
    } catch (err) {
      console.error(`linq webhook: handling ${evt.eventType} failed:`, err.message);
    }
  });

  /** Ask a named human to authorize a cheaper policy. Body: { processId, policy, threshold, to } */
  // These carry their own JSON parser: registerLinqRoutes runs before the global
  // express.json() so the webhook can see raw bytes, which leaves these unparsed.
  app.post("/api/linq/promotions", express.json(), async (req, res) => {
    try {
      const row = await requestPromotion(req.body ?? {});
      res.status(201).json(row);
    } catch (err) {
      console.error("linq promotion request failed:", err.message);
      res.status(502).json({ error: err.message });
    }
  });

  /** The decision record. A policy is production-eligible only if a row here says approved. */
  app.get("/api/linq/promotions", async (_req, res) => {
    try {
      await ensureSchema();
      const { rows } = await query(
        `select * from linq_promotions order by requested_at desc limit 50`,
      );
      res.json({ promotions: rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return { webhookPath: WEBHOOK_PATH };
}
