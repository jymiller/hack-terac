import pg from "pg";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set");
}

// Render runs a long-lived Node process, so a normal pooled client is correct
// here. Use Neon's POOLED connection string.
export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: true },
  max: 5,
});

export const query = (text, params) => pool.query(text, params);

export async function createOrder({ id, email, product, amountCents, metadata }) {
  const { rows } = await query(
    `insert into orders (id, email, product, amount_cents, metadata)
     values ($1, $2, $3, $4, $5)
     returning *`,
    [id, email ?? null, product ?? null, amountCents ?? null, metadata ?? {}],
  );
  return rows[0];
}

/** Returns false when the event has already been handled. */
export async function claimEvent(eventId, type) {
  const { rowCount } = await query(
    `insert into stripe_events (id, type) values ($1, $2)
     on conflict (id) do nothing`,
    [eventId, type],
  );
  return rowCount === 1;
}

export async function markOrderPaid(orderId, session) {
  const { rows } = await query(
    `update orders
        set status = 'paid',
            paid_at = now(),
            stripe_session_id = $2,
            stripe_payment_intent = $3,
            amount_cents = coalesce($4, amount_cents),
            email = coalesce(email, $5)
      where id = $1
      returning *`,
    [
      orderId,
      session.id,
      typeof session.payment_intent === "string" ? session.payment_intent : null,
      session.amount_total ?? null,
      session.customer_details?.email ?? null,
    ],
  );
  return rows[0] ?? null;
}

export async function markOrderFailed(orderId) {
  await query(`update orders set status = 'failed' where id = $1`, [orderId]);
}

export async function recordTeracResponse({
  teracSubmissionId,
  taskId,
  opportunityId,
  payload,
}) {
  const { rows } = await query(
    `insert into terac_responses (terac_submission_id, task_id, opportunity_id, payload)
     values ($1, $2, $3, $4)
     on conflict (terac_submission_id) do update set payload = excluded.payload
     returning *`,
    [teracSubmissionId, taskId ?? null, opportunityId ?? null, payload],
  );
  return rows[0];
}

export async function revenueTotals() {
  const { rows } = await query(
    `select count(*)::int as orders,
            coalesce(sum(amount_cents), 0)::int as gross_cents
       from orders where status = 'paid'`,
  );
  return rows[0];
}
