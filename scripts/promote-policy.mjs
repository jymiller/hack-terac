/**
 * node --env-file=.env scripts/promote-policy.mjs <process_id> [threshold] [floor]
 *
 * The only path from "measured" to AUTO. It reads the process's real agreement counts,
 * opens a Band room, lets the risk officer try to block the promotion, waits for a named
 * human to APPROVE or BLOCK in that room, and only then writes the promotion.
 *
 * The promotion row carries the room id, the approving human, and the id of their message.
 * Those columns are NOT NULL, so a promotion literally cannot be recorded without a Band
 * room that contains a human approval. Take the room away and this process has no output.
 */

import { query } from "../app/db.mjs";
import { agreementByProcess } from "../app/db.mjs";
import { wilson } from "../app/readiness.mjs";
import {
  configured,
  openPromotionRoom,
  riskReview,
  requestDecision,
  approver,
  awaitDecision,
  assertPromotionApproved,
  transcript,
} from "../app/band.mjs";

const processId = process.argv[2];
const threshold = Number(process.argv[3] ?? 0.82);
const floor = Number(process.argv[4] ?? 0.95);
const coverageFloor = Number(process.env.COVERAGE_FLOOR ?? 0.6);
const waitMs = Number(process.env.BAND_DECISION_TIMEOUT_MS ?? 300000);

if (!processId) {
  console.error("usage: node --env-file=.env scripts/promote-policy.mjs <process_id> [threshold] [floor]");
  process.exit(2);
}
if (!configured()) {
  console.error(
    "Refusing to promote: BAND_API_KEY is empty. Promotion is a decision a named human takes in a Band room, " +
      "not a flag this script can set. Add the account key from https://app.band.ai to .env and re-run.",
  );
  process.exit(2);
}

await query(`create table if not exists policy_promotions (
  id                bigserial primary key,
  process_id        text not null,
  policy            text not null,
  threshold         double precision not null,
  wilson_lower      double precision not null,
  floor             double precision not null,
  band_room_id      text not null,
  approved_by       text not null,
  approval_message_id text not null,
  approved_at       timestamptz not null,
  recorded_at       timestamptz not null default now(),
  unique (band_room_id)
)`);

const row = (await agreementByProcess()).find((r) => r.process_id === processId);
if (!row) {
  console.error(`No TERAC attestations for process "${processId}" — nothing measured, nothing to promote.`);
  process.exit(1);
}

const x = row.agree;
const n = row.claims;
const wilsonLower = wilson(x, n)[0];
const evidence = {
  processId,
  threshold,
  floor,
  x,
  n,
  coverage: n > 0 ? (n - row.insufficient - row.recuse) / n : 0,
  coverageFloor,
  costPerTrusted: n > 0 ? Number(row.cost_usd) / n : 0,
  wilsonLower,
};

console.log(`${processId}: ${x}/${n} agreeing, Wilson 95% lower ${wilsonLower.toFixed(4)} vs floor ${floor}`);

const room = await openPromotionRoom(evidence);
console.log(`Band room open: ${room.url}`);

const review = await riskReview(room.roomId, evidence);
console.log(`Risk officer: ${review.verdict.toUpperCase()}${review.reason ? ` — ${review.reason}` : ""}`);

const person = await approver();
await requestDecision(room.roomId, {
  proposal: `Promote ${processId} to AUTO at threshold ${threshold} (Wilson 95% lower ${wilsonLower.toFixed(4)}, floor ${floor}).`,
  approvers: [person],
});
console.log(`Waiting up to ${Math.round(waitMs / 1000)}s for ${person.name} to APPROVE or BLOCK in the room...`);

const decision = await awaitDecision(room.roomId, { timeoutMs: waitMs });
console.log(`Verdict: ${decision.status}${decision.by ? ` by ${decision.by}` : ""}`);

let receipt;
try {
  receipt = await assertPromotionApproved(room.roomId);
} catch (e) {
  console.error(e.message);
  console.log("\nTranscript:");
  for (const m of await transcript(room.roomId)) {
    console.log(`  ${m.sender_name || m.sender_type}: ${String(m.content).replace(/\s+/g, " ").slice(0, 200)}`);
  }
  process.exit(1);
}

await query(
  `insert into policy_promotions
     (process_id, policy, threshold, wilson_lower, floor, band_room_id, approved_by, approval_message_id, approved_at)
   values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
   on conflict (band_room_id) do nothing`,
  [
    processId,
    `auto@${threshold}`,
    threshold,
    wilsonLower,
    floor,
    receipt.roomId,
    receipt.approvedBy,
    receipt.messageId,
    receipt.approvedAt,
  ],
);

console.log(`PROMOTED ${processId} to AUTO@${threshold} — approved by ${receipt.approvedBy} in ${receipt.url}`);
process.exit(0);
