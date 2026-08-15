import { pool, query, recordAttestations } from "../app/db.mjs";

// Re-derives attestations from the raw captured payloads. Safe to run repeatedly.
const { rows } = await query(
  `select terac_submission_id, payload from terac_responses
    where payload->>'status' = 'completed'`,
);

let claims = 0;
for (const r of rows) {
  const items = (r.payload.items ?? []).filter((i) => i.claimId && i.answer);
  if (!items.length) continue;
  claims += await recordAttestations({ teracSubmissionId: r.terac_submission_id, items });
}
console.log(`backfilled ${claims} attestations from ${rows.length} responses`);
await pool.end();
