/**
 * node --env-file=.env scripts/smoke-pioneer.mjs
 *
 * Runs proposeDisposition over 3 covenant-math claims and prints model vs expected,
 * side by side with the rule extractor from app/experiment.mjs.
 *
 * Claim 3 omits Total Funded Debt. The honest answer is `insufficient`. The rule
 * extractor answers `supported` at 0.91 confidence — high confidence on a claim it
 * cannot actually decide. That structural blind spot is the reason human attestation
 * exists in this system, so whether an open-weight model catches it is the whole point
 * of this smoke test.
 */
import { proposeDisposition, redactPII, listBaseModels, isConfigured, DEFAULT_MODEL } from "../app/pioneer.mjs";

const CLAIMS = [
  {
    id: "smoke_cov_001",
    process_id: "proc_covenant_math",
    evidence:
      "Borrower certificate p.18 — Adjusted EBITDA (TTM): $12.0m; Total Funded Debt: $30.0m. " +
      "Credit agreement §7.2 — Total Net Leverage may not exceed 3.00x.",
    proposition: "The borrower complied with the leverage covenant for the period shown.",
    expected: "supported",
    why: "30.0 / 12.0 = 2.50x, at or under the 3.00x cap",
  },
  {
    id: "smoke_cov_002",
    process_id: "proc_covenant_math",
    evidence:
      "Borrower certificate p.18 — Adjusted EBITDA (TTM): $8.0m; Total Funded Debt: $34.0m. " +
      "Credit agreement §7.2 — Total Net Leverage may not exceed 3.50x.",
    proposition: "The borrower complied with the leverage covenant for the period shown.",
    expected: "not_supported",
    why: "34.0 / 8.0 = 4.25x, over the 3.50x cap",
  },
  {
    id: "smoke_cov_003",
    process_id: "proc_covenant_math",
    evidence:
      "Borrower certificate p.18 — Adjusted EBITDA (TTM): $10.0m. " +
      "Credit agreement §7.2 — Total Net Leverage may not exceed 3.00x.",
    proposition: "The borrower complied with the leverage covenant for the period shown.",
    expected: "insufficient",
    why: "Total Funded Debt is absent — the ratio cannot be computed at all",
  },
];

const PII_SAMPLE =
  "Reviewer note from Dana Whitfield (dana.whitfield@northbridge-capital.com, +1-555-0164): " +
  "borrower contact confirmed the EBITDA figure by phone.";

async function ruleBaseline() {
  try {
    const { propose } = await import("../app/experiment.mjs");
    return (claim) => {
      try {
        return propose(claim);
      } catch {
        return null;
      }
    };
  } catch {
    return () => null;
  }
}

function line(label, value) {
  console.log(`  ${label.padEnd(18)} ${value}`);
}

async function main() {
  if (!isConfigured()) {
    console.log("SKIPPED — PIONEER_API_KEY is not set.");
    console.log("  Get a key at https://agent.pioneer.ai -> Settings -> API Keys");
    console.log("  Then add PIONEER_API_KEY=<key> to .env and re-run.");
    return 0;
  }

  console.log(`Pioneer smoke — model ${DEFAULT_MODEL}`);

  try {
    const { path, body } = await listBaseModels();
    const ids = (Array.isArray(body) ? body : (body?.data ?? body?.models ?? []))
      .map((m) => (typeof m === "string" ? m : (m?.id ?? m?.model_id ?? m?.name)))
      .filter(Boolean);
    console.log(`Base models via ${path}: ${ids.length ? ids.slice(0, 12).join(", ") : "(shape unrecognised)"}`);
  } catch (err) {
    console.log(`Base model listing unavailable: ${err.message}`);
  }
  console.log("");

  const baseline = await ruleBaseline();
  let matched = 0;
  let reachable = 0;
  let caughtTheGap = false;

  for (const claim of CLAIMS) {
    const got = await proposeDisposition(claim);
    const rule = baseline(claim);
    const ok = got.disposition === claim.expected;
    if (got.disposition !== null || !got.error) reachable++;
    if (ok) matched++;
    if (claim.expected === "insufficient" && ok) caughtTheGap = true;

    console.log(`${claim.id}  ${ok ? "MATCH" : "MISS "}  (${claim.why})`);
    line("expected", claim.expected);
    line("pioneer", `${got.disposition ?? "null"} @ ${got.confidence.toFixed(2)} (${got.latency_ms}ms)`);
    if (rule) line("rule-extractor", `${rule.disposition} @ ${Number(rule.confidence).toFixed(2)}`);
    if (got.error) line("error", got.error);
    if (got.disposition === null && got.raw) line("raw", JSON.stringify(got.raw).slice(0, 160));
    console.log("");
  }

  console.log(`Agreement with expected: ${matched}/${CLAIMS.length}`);
  console.log(
    caughtTheGap
      ? "The model CAUGHT the withheld Total Funded Debt — it beats the rule extractor on the case that matters."
      : "The model MISSED the withheld Total Funded Debt — same structural blind spot as the rule extractor.",
  );

  console.log("\nGLiNER2-PII redaction:");
  const pii = await redactPII(PII_SAMPLE);
  line("ok", String(pii.ok));
  line("entities", String(pii.entities.length));
  line("redacted", pii.redacted.slice(0, 200));
  if (pii.error) line("error", pii.error);

  if (reachable === 0) {
    console.log("\nFAIL — the API was unreachable or rejected every request.");
    return 1;
  }
  console.log(`\nPASS — API reachable, ${matched}/${CLAIMS.length} dispositions matched expected.`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.log(`FAIL — ${err.message}`);
    process.exit(1);
  });
