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

/**
 * Guarded upsert. An arrival receipt is written on GET and the answers on POST, so
 * `opened -> completed` must be allowed while `completed -> anything` must not: a
 * duplicate or partial POST would otherwise overwrite paid human input that Terac
 * will not return to us again.
 */
export async function recordTeracResponse({
  teracSubmissionId,
  taskId,
  opportunityId,
  payload,
}) {
  const { rows } = await query(
    `insert into terac_responses (terac_submission_id, task_id, opportunity_id, payload)
     values ($1, $2, $3, $4)
     on conflict (terac_submission_id) do update
       set payload = excluded.payload,
           task_id = coalesce(excluded.task_id, terac_responses.task_id),
           opportunity_id = coalesce(excluded.opportunity_id, terac_responses.opportunity_id),
           captured_at = now()
     where terac_responses.payload->>'status' is distinct from 'completed'
     returning *`,
    [teracSubmissionId, taskId ?? null, opportunityId ?? null, payload],
  );
  return rows[0] ?? null;
}

/** Human answers, one row per claim. Idempotent on replay of the same submission. */
export async function recordAttestations({ teracSubmissionId, items, costUsd = 0 }) {
  const per = items.length ? costUsd / items.length : 0;
  for (const it of items) {
    await query(
      `insert into attestations (claim_id, source, answer, terac_submission_id, cost_usd)
       values ($1, 'terac', $2, $3, $4)
       on conflict (claim_id, terac_submission_id) do update set answer = excluded.answer`,
      [it.claimId, it.answer, teracSubmissionId, per],
    );
  }
  return items.length;
}

export async function writeEval({ phase, subjectId, metric, value, n, evidenceMode }) {
  await query(
    `insert into evals (phase, subject_id, metric, value, n, evidence_mode)
     values ($1,$2,$3,$4,$5,$6)`,
    [phase, subjectId, metric, value, n, evidenceMode],
  );
}

/**
 * Machine-human agreement per process, over TERAC attestations only. The source filter
 * is not optional: synthetic_oracle rows share this table and must never be counted as
 * paid human input.
 */
export async function agreementByProcess() {
  const { rows } = await query(
    `select c.process_id,
            count(*)::int as judgments,
            count(distinct a.claim_id)::int as claims,
            sum(case when a.answer = 'AGREE' then 1 else 0 end)::int as agree,
            sum(case when a.answer = 'INSUFFICIENT' then 1 else 0 end)::int as insufficient,
            sum(case when a.answer = 'RECUSE' then 1 else 0 end)::int as recuse,
            coalesce(sum(a.cost_usd), 0) as cost_usd
       from attestations a
       join claims c on c.id = a.claim_id
      where a.source = 'terac'
      group by c.process_id`,
  );
  return rows;
}

/** Per-claim majority verdict, used to score claims rather than judgments. */
export async function claimVerdicts() {
  const { rows } = await query(
    `select a.claim_id, c.process_id, c.ground_truth,
            count(*)::int as raters,
            mode() within group (order by a.answer) as majority
       from attestations a
       join claims c on c.id = a.claim_id
      where a.source = 'terac'
      group by a.claim_id, c.process_id, c.ground_truth`,
  );
  return rows;
}

export async function revenueTotals() {
  const { rows } = await query(
    `select count(*)::int as orders,
            coalesce(sum(amount_cents), 0)::int as gross_cents
       from orders where status = 'paid'`,
  );
  return rows[0];
}
