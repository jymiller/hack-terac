import crypto from "node:crypto";
import { query } from "./db.mjs";

/**
 * Three processes from deal onboarding, each a different kind of expert judgment.
 * Every claim is answerable from the snippet alone: ground truth is DERIVED from the
 * rendered text, never drawn before it. An "insufficient" claim is one where a needed
 * field is withheld — the proposition is worded identically, so the label cannot leak.
 */
export const PROCESSES = [
  {
    id: "proc_covenant_math",
    name: "Compliance certificate recomputation",
    expertise_area: "Accounting / covenant math",
    atomizable: true,
  },
  {
    id: "proc_period_match",
    name: "Reporting period attribution",
    expertise_area: "Financial reporting",
    atomizable: true,
  },
  {
    id: "proc_insurance_adequacy",
    name: "Insurance certificate adequacy",
    expertise_area: "Insurance / risk",
    atomizable: true,
  },
];

const TIERS = {
  economy: { cost: 0.02 },
  balanced: { cost: 0.08 },
  frontier: { cost: 0.28 },
};

export const PROPOSER = "rule-extractor-v1";

/** Deterministic PRNG so a corpus or arm can be re-run and reproduce exactly. */
function rng(seed) {
  let h = crypto.createHash("sha256").update(seed).digest().readUInt32BE(0);
  return () => {
    h = (h * 1664525 + 1013904223) >>> 0;
    return h / 4294967296;
  };
}

const pick = (r, xs) => xs[Math.floor(r() * xs.length)];
const iso = (d) => d.toISOString().slice(0, 10);

function covenantClaim(r) {
  const ebitda = 3 + Math.floor(r() * 120) / 10;
  const cap = 2 + Math.floor(r() * 30) / 10;
  const slack = r();
  const mult = slack < 0.45 ? cap * (0.6 + r() * 0.35) : cap * (1.02 + r() * 0.5);
  const debt = Math.round(ebitda * mult * 10) / 10;
  const withhold = r() < 0.18;
  const evidence = withhold
    ? `Borrower certificate p.18 — Adjusted EBITDA (TTM): $${ebitda.toFixed(1)}m. ` +
      `Credit agreement §7.2 — Total Net Leverage may not exceed ${cap.toFixed(2)}x.`
    : `Borrower certificate p.18 — Adjusted EBITDA (TTM): $${ebitda.toFixed(1)}m; ` +
      `Total Funded Debt: $${debt.toFixed(1)}m. ` +
      `Credit agreement §7.2 — Total Net Leverage may not exceed ${cap.toFixed(2)}x.`;
  const truth = withhold ? "insufficient" : debt / ebitda <= cap ? "supported" : "not_supported";
  return {
    evidence,
    proposition: "The borrower complied with the leverage covenant for the period shown.",
    ground_truth: truth,
  };
}

function periodClaim(r) {
  const start = new Date(Date.UTC(2025, Math.floor(r() * 9), 1));
  const end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + 3);
  end.setUTCDate(0);
  const inside = r() < 0.5;
  const test = new Date(start);
  test.setUTCDate(test.getUTCDate() + (inside ? Math.floor(r() * 80) : 120 + Math.floor(r() * 90)));
  const withhold = r() < 0.18;
  const evidence = withhold
    ? `Certificate cover — fiscal quarter beginning ${iso(start)}. ` +
      `Credit agreement §6.1 — compliance is tested as of ${iso(test)}.`
    : `Certificate cover — fiscal quarter ${iso(start)} through ${iso(end)}. ` +
      `Credit agreement §6.1 — compliance is tested as of ${iso(test)}.`;
  const truth = withhold
    ? "insufficient"
    : test >= start && test <= end
      ? "supported"
      : "not_supported";
  return {
    evidence,
    proposition: "The certificate covers the period the covenant is tested against.",
    ground_truth: truth,
  };
}

function insuranceClaim(r) {
  const required = pick(r, [1, 2, 5, 10]);
  const short = r() < 0.4;
  const carried = short ? required * pick(r, [0.25, 0.5, 0.8]) : required * pick(r, [1, 1.5, 2]);
  const status = pick(r, ["Lender's Loss Payee", "Certificate Holder only"]);
  const withhold = r() < 0.18;
  const evidence = withhold
    ? `ACORD 25 — General Liability each-occurrence limit: $${carried.toFixed(2)}m. ` +
      `Credit agreement §5.4 — required limit $${required.toFixed(2)}m and the lender must be named Lender's Loss Payee.`
    : `ACORD 25 — General Liability each-occurrence limit: $${carried.toFixed(2)}m; ` +
      `lender is shown as ${status}. ` +
      `Credit agreement §5.4 — required limit $${required.toFixed(2)}m and the lender must be named Lender's Loss Payee.`;
  const truth = withhold
    ? "insufficient"
    : carried >= required && status === "Lender's Loss Payee"
      ? "supported"
      : "not_supported";
  return {
    evidence,
    proposition: "The certificate satisfies the insurance covenant.",
    ground_truth: truth,
  };
}

const GENERATORS = {
  proc_covenant_math: covenantClaim,
  proc_period_match: periodClaim,
  proc_insurance_adequacy: insuranceClaim,
};

export function buildCorpus({ perProcess = 60, seed = "hack-terac-002" } = {}) {
  const r = rng(seed);
  const claims = [];
  for (const p of PROCESSES) {
    for (let i = 0; i < perProcess; i++) {
      const c = GENERATORS[p.id](r);
      claims.push({
        id: `clm_${p.id.slice(5, 12)}_${String(i).padStart(3, "0")}`,
        process_id: p.id,
        ...c,
        holdout: i >= perProcess * 0.5,
      });
    }
  }
  return claims;
}

const num = (re, text) => {
  const m = text.match(re);
  return m ? Number(m[1]) : null;
};

/**
 * The proposer is an extractor plus a rule, not a random number generator: it reads the
 * snippet and applies the covenant. Its failure mode is structural and is exactly what
 * human attestation exists to expose — when a required field is absent it does not
 * recognise the gap, it assumes the common case and reports high confidence.
 */
export function propose(claim, tier = "balanced") {
  const t = claim.evidence;
  let disposition = null;
  let complete = true;

  if (claim.process_id === "proc_covenant_math") {
    const ebitda = num(/EBITDA \(TTM\): \$([\d.]+)m/, t);
    const debt = num(/Funded Debt: \$([\d.]+)m/, t);
    const cap = num(/exceed ([\d.]+)x/, t);
    complete = debt !== null;
    disposition = complete && debt / ebitda <= cap ? "supported" : complete ? "not_supported" : "supported";
  } else if (claim.process_id === "proc_period_match") {
    const m = t.match(/quarter (\d{4}-\d{2}-\d{2}) through (\d{4}-\d{2}-\d{2})/);
    const test = t.match(/tested as of (\d{4}-\d{2}-\d{2})/)?.[1];
    complete = Boolean(m);
    disposition = complete ? (test >= m[1] && test <= m[2] ? "supported" : "not_supported") : "supported";
  } else {
    const carried = num(/each-occurrence limit: \$([\d.]+)m/, t);
    const required = num(/required limit \$([\d.]+)m/, t);
    const payee = /shown as Lender's Loss Payee/.test(t);
    complete = /lender is shown as/.test(t);
    disposition = complete && carried >= required && payee ? "supported" : complete ? "not_supported" : "supported";
  }

  // Economy tier reads the snippet less carefully: it drops the qualitative second
  // condition and decides on the number alone.
  if (tier === "economy" && claim.process_id === "proc_insurance_adequacy" && complete) {
    const carried = num(/each-occurrence limit: \$([\d.]+)m/, t);
    const required = num(/required limit \$([\d.]+)m/, t);
    disposition = carried >= required ? "supported" : "not_supported";
  }

  const confidence = complete ? (tier === "frontier" ? 0.94 : 0.88) : 0.91;
  return { disposition, confidence, cost_usd: TIERS[tier].cost };
}

export async function seed({ perProcess = 60, seed: s = "hack-terac-002" } = {}) {
  for (const p of PROCESSES) {
    await query(
      `insert into processes (id, name, expertise_area, atomizable, status)
       values ($1,$2,$3,$4,'designed')
       on conflict (id) do update set name = excluded.name`,
      [p.id, p.name, p.expertise_area, p.atomizable],
    );
  }
  const claims = buildCorpus({ perProcess, seed: s });
  for (const c of claims) {
    await query(
      `insert into claims (id, process_id, evidence, proposition, ground_truth, holdout)
       values ($1,$2,$3,$4,$5,$6)
       on conflict (id) do update set
         evidence = excluded.evidence,
         proposition = excluded.proposition,
         ground_truth = excluded.ground_truth,
         holdout = excluded.holdout`,
      [c.id, c.process_id, c.evidence, c.proposition, c.ground_truth, c.holdout],
    );
  }
  return claims.length;
}

export async function runArm({ arm, tier }) {
  const { rows: claims } = await query(`select * from claims order by id`);
  for (const c of claims) {
    const p = propose(c, tier);
    await query(
      `insert into machine_proposals (claim_id, arm, tier, disposition, confidence, cost_usd)
       values ($1,$2,$3,$4,$5,$6)
       on conflict (claim_id, arm) do update set
         disposition = excluded.disposition, confidence = excluded.confidence`,
      [c.id, arm, tier, p.disposition, p.confidence, p.cost_usd],
    );
  }
  return claims.length;
}

/**
 * At a given confidence threshold, claims above it run AUTO and everything else HOLDs.
 * Accuracy is measured only over what was delivered, and coverage is reported alongside
 * it — a policy that HOLDs everything scores perfect accuracy on zero delivered work,
 * which the service floor exists to reject.
 */
export async function scorePolicy({ arm, threshold, holdoutOnly = true }) {
  const { rows } = await query(
    `select p.process_id, m.disposition, m.confidence, m.cost_usd, p.ground_truth
       from machine_proposals m
       join claims p on p.id = m.claim_id
      where m.arm = $1 ${holdoutOnly ? "and p.holdout = true" : ""}`,
    [arm],
  );
  const byProcess = new Map();
  for (const row of rows) {
    const g = byProcess.get(row.process_id) ?? { n: 0, auto: 0, correct: 0, cost: 0 };
    g.n++;
    g.cost += Number(row.cost_usd);
    if (Number(row.confidence) >= threshold) {
      g.auto++;
      if (row.disposition === row.ground_truth) g.correct++;
    }
    byProcess.set(row.process_id, g);
  }
  return [...byProcess.entries()].map(([process_id, g]) => {
    const accuracy = g.auto ? g.correct / g.auto : null;
    const coverage = g.n ? g.auto / g.n : 0;
    const errors = g.auto - g.correct;
    return {
      process_id,
      threshold,
      n: g.n,
      auto: g.auto,
      accuracy,
      coverage,
      cost_per_trusted: g.correct ? g.cost / g.correct : null,
      expected_exceptions_per_1000: g.auto ? (errors / g.auto) * 1000 * coverage : 0,
    };
  });
}
