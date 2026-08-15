import { query, pool } from "../app/db.mjs";
import { seed, runArm, scorePolicy, PROCESSES } from "../app/experiment.mjs";

const RISK_PER_EXCEPTION = 38.0; // synthetic; the priced cost of one escaped error

const n = await seed({ perProcess: 60 });
console.log(`corpus: ${n} synthetic claims across ${PROCESSES.length} processes`);

for (const [arm, tier] of [["balanced-v1", "balanced"], ["economy-v1", "economy"]]) {
  await runArm({ arm, tier, seed: arm });
}
console.log("arms proposed: balanced-v1, economy-v1");

console.log("\nthreshold sweep on held-out claims (arm=balanced-v1)");
console.log("thresh  coverage  accuracy  $/trusted  exc/1000");
const sweep = [];
for (const t of [0.5, 0.6, 0.7, 0.8, 0.9, 0.95]) {
  const rows = await scorePolicy({ arm: "balanced-v1", threshold: t });
  const cov = rows.reduce((a, r) => a + r.coverage, 0) / rows.length;
  const withAcc = rows.filter((r) => r.accuracy !== null);
  const acc = withAcc.length ? withAcc.reduce((a, r) => a + r.accuracy, 0) / withAcc.length : null;
  const cpt = withAcc.length
    ? withAcc.reduce((a, r) => a + (r.cost_per_trusted ?? 0), 0) / withAcc.length
    : null;
  const exc = rows.reduce((a, r) => a + r.expected_exceptions_per_1000, 0) / rows.length;
  sweep.push({ t, cov, acc, cpt, exc });
  console.log(
    `${t.toFixed(2)}    ${(cov * 100).toFixed(1)}%     ` +
      `${acc === null ? "  n/a " : (acc * 100).toFixed(1) + "%"}    ` +
      `${cpt === null ? " n/a  " : "$" + cpt.toFixed(3)}     ${exc.toFixed(1)}`,
  );
}

// Service floor: quality AND coverage AND turnaround must all hold.
const FLOOR = { quality: 0.93, coverage: 0.6 };
const passing = sweep.filter((s) => s.acc !== null && s.acc >= FLOOR.quality && s.cov >= FLOOR.coverage);
const best = passing.sort((a, b) => a.cpt - b.cpt)[0] ?? null;

console.log(
  `\nservice floor: quality >= ${FLOOR.quality * 100}%, coverage >= ${FLOOR.coverage * 100}%`,
);
if (!best) {
  console.log("NO UNCALIBRATED THRESHOLD CLEARS THE FLOOR.");
  console.log("This is the finding: machine self-confidence alone cannot site the threshold.");
} else {
  console.log(`best uncalibrated threshold ${best.t} -> $${best.cpt.toFixed(3)}/trusted`);
}

for (const t of [0.5, 0.6, 0.7, 0.8, 0.9, 0.95]) {
  for (const r of await scorePolicy({ arm: "balanced-v1", threshold: t })) {
    await query(
      `insert into policy_results
         (process_id, policy, threshold, n, accuracy, coverage, cost_per_trusted,
          expected_exceptions_per_1000, risk_reserve_usd, evidence_mode)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'synthetic')`,
      [
        r.process_id,
        "uncalibrated-machine-confidence",
        r.threshold,
        r.n,
        r.accuracy,
        r.coverage,
        r.cost_per_trusted,
        r.expected_exceptions_per_1000,
        (r.expected_exceptions_per_1000 / 1000) * 1000 * RISK_PER_EXCEPTION,
      ],
    );
  }
}

const { rows: saved } = await query(`select count(*)::int as c from policy_results`);
console.log(`\npolicy_results rows written: ${saved[0].c}  (evidence_mode=synthetic)`);
console.log("BEFORE arm recorded. AFTER arm needs real Terac attestations.");
await pool.end();
