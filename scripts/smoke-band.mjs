/**
 * node --env-file=.env scripts/smoke-band.mjs
 *
 * Opens a real Band room, puts the Coverage Proposer and the Coverage Risk Officer in it,
 * proposes a promotion that does NOT clear the Wilson floor, watches the risk agent block
 * it, asks the named human to decide, and prints the transcript.
 *
 * PASS    — the room blocked the promotion and assertPromotionApproved() refused.
 * SKIPPED — BAND_API_KEY is empty (exit 0, so a keyless run stays green).
 * FAIL    — anything else.
 */

import {
  ROLES,
  configured,
  agentCredentials,
  approver,
  openPromotionRoom,
  riskReview,
  requestDecision,
  readDecision,
  assertPromotionApproved,
  transcript,
} from "../app/band.mjs";
import { wilson } from "../app/readiness.mjs";

// A process with real but thin evidence: 22/25 agreeing claims looks like 88%, but the
// licensed rate is the 95% lower bound, which is well under a 0.95 floor. This is exactly
// the promotion a risk officer exists to stop.
const CASE = {
  processId: "kyc-beneficial-owner",
  threshold: 0.82,
  floor: 0.95,
  x: 22,
  n: 25,
  coverage: 0.71,
  coverageFloor: 0.6,
  costPerTrusted: 0.0412,
};
CASE.wilsonLower = wilson(CASE.x, CASE.n)[0];

const line = (m) => {
  const who = m.sender_name || m.sender_type || "?";
  const kind = m.message_type === "text" ? "" : ` (${m.message_type})`;
  return `  [${(m.inserted_at || "").slice(11, 19)}] ${who}${kind}: ${String(m.content || "").replace(/\s+/g, " ").slice(0, 220)}`;
};

async function main() {
  if (!configured()) {
    console.log("SKIPPED: BAND_API_KEY is empty in .env — no Band account key, nothing to smoke.");
    console.log("         Get one at https://app.band.ai (free tier covers multi-agent rooms), then re-run.");
    return 0;
  }

  const base = process.env.BAND_BASE_URL || "https://app.band.ai";
  const health = await fetch(`${base}/api/v1/health`).then((r) => r.json());
  console.log(`Band: ${base} (${health.status || "?"}, v${health.version || "?"})`);

  const person = await approver();
  console.log(`Named human approver: ${person.name} (@${person.handle})`);

  for (const role of Object.keys(ROLES)) {
    const c = await agentCredentials(role);
    console.log(`Agent ${role}: ${c.name} ${c.id} [${c.source}]`);
  }

  console.log(
    `\nCase: ${CASE.processId} — ${CASE.x}/${CASE.n} agreeing, observed ${(CASE.x / CASE.n).toFixed(4)}, ` +
      `Wilson 95% lower ${CASE.wilsonLower.toFixed(4)}, floor ${CASE.floor}`,
  );

  const room = await openPromotionRoom(CASE);
  console.log(`Room: ${room.url}`);
  console.log(`  participants: ${room.risk.name}, ${room.human.name} (human), ${ROLES.proposer.name} (owner)`);

  const review = await riskReview(room.roomId, CASE);
  console.log(`Risk officer: ${review.verdict.toUpperCase()}${review.reason ? ` — ${review.reason}` : ""}`);

  const ask = await requestDecision(room.roomId, {
    proposal: `Promote ${CASE.processId} to AUTO at threshold ${CASE.threshold}.`,
    approvers: [person],
  });
  console.log(`Decision requested (attention event ${ask.decisionId}) from ${ask.approvers.map((a) => a.name).join(", ")}`);

  const decision = await readDecision(room.roomId);
  console.log(`Verdict now: ${decision.status}${decision.by ? ` by ${decision.by}` : ""}`);

  let refused = null;
  try {
    await assertPromotionApproved(room.roomId);
  } catch (e) {
    refused = e;
  }

  console.log("\nTranscript:");
  for (const m of await transcript(room.roomId)) console.log(line(m));

  console.log("");
  if (decision.status !== "blocked") {
    console.log(`FAIL: expected the risk officer's block to stand, got "${decision.status}".`);
    return 1;
  }
  if (!refused) {
    console.log("FAIL: assertPromotionApproved() let a blocked promotion through.");
    return 1;
  }
  console.log(`Gate held: ${refused.message}`);
  console.log(`PASS: two agents coordinated in Band room ${room.roomId}, the risk officer blocked the promotion,`);
  console.log(`      and ${person.name} still has to APPROVE in ${room.url} for anything to ship.`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`FAIL: ${err.message}`);
    if (err.requestId) console.error(`      band request_id: ${err.requestId}`);
    process.exit(1);
  },
);
