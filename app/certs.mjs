/**
 * The three synthetic compliance certificates, and the one instruction both sides answer.
 *
 * Ground truth is what the certificate PRINTS, and every ratio here was checked against its
 * own building blocks before being written down. The point of the experiment is that neither
 * side is told any of it: human and model each get the same pages and the same instruction.
 */

export const INSTRUCTION = `You are looking at a compliance certificate for a secured financing.

Read the document and report, using only what is printed in it:

1. The entity the certificate is given for.
2. The date the reporting period ENDED (YYYY-MM-DD).
3. The name of the primary financial ratio the certificate certifies.
4. The value of that ratio, exactly as printed.
5. The two figures the ratio is calculated from — the numerator and the denominator — as printed.
6. The threshold that would constitute a Trigger Event, as printed.
7. Whether the certificate states the entity is compliant: yes or no.

Report only what the document states. If something is not stated, write "not stated".
Do not estimate, infer, or calculate anything the document does not print.`;

export const FIELDS = [
  { key: "entity", label: "Entity", hint: "Whose certificate is this?" },
  { key: "period_end", label: "Period ended", hint: "YYYY-MM-DD" },
  { key: "ratio_name", label: "Primary ratio name", hint: "As the document names it" },
  { key: "ratio_value", label: "Ratio value", hint: "Exactly as printed" },
  { key: "numerator", label: "Numerator (£m)", hint: "The figure on top" },
  { key: "denominator", label: "Denominator (£m)", hint: "The figure underneath" },
  { key: "trigger_level", label: "Trigger Event level", hint: "As printed" },
  { key: "compliant", label: "States compliant?", hint: "yes / no" },
];

/**
 * `distractor` is the value a careless reader most plausibly reports instead — in every case
 * a real number printed on the same page. A citation check cannot tell these apart from the
 * right answer, because the digits genuinely appear in the document. That is the failure mode
 * worth measuring.
 */
export const CERTS = [
  {
    id: "abpa",
    file: "abpa-demo-compliance-certificate-2026-06-30",
    pages: 3,
    entity: "ABPA Holdings Limited",
    truth: {
      entity: "ABPA Holdings Limited",
      period_end: "2026-06-30",
      ratio_name: "Interest Cover",
      ratio_value: "2.91",
      numerator: "534.3",
      denominator: "183.4",
      trigger_level: "1.75",
      compliant: "yes",
    },
    check: { num: 534.3, den: 183.4, printed: 2.91 },
    distractors: {
      ratio_value: { value: "2.47", why: "Interest Cover at the previous Calculation Date, printed two rows below" },
      ratio_name: { value: "Leverage", why: "Schedule 2 prints a second ratio, 5.43" },
      period_end: { value: "2026-07-21", why: "Date of the Certificate, not the Accounting Date" },
    },
  },
  {
    id: "hs1",
    file: "hs1-demo-compliance-certificate-2026-03-31",
    pages: 2,
    entity: "HS1 Limited",
    truth: {
      entity: "HS1 Limited",
      period_end: "2026-03-31",
      ratio_name: "Historic DSCR",
      ratio_value: "1.45",
      numerator: "202.2",
      denominator: "139.9",
      trigger_level: "1.20",
      compliant: "yes",
    },
    check: { num: 202.2, den: 139.9, printed: 1.45 },
    distractors: {
      ratio_value: { value: "1.65", why: "Historic DSCR at the previous Test Date" },
      numerator: { value: "48.5", why: "Net cash inflow from operating activities — the first of four blocks that sum to 202.2" },
      denominator: { value: "84.7", why: "Interest paid on Senior Debt — one of two blocks summing to 139.9" },
    },
  },
  {
    id: "lgw",
    file: "lgw-demo-compliance-certificate-2026-03-31",
    pages: 3,
    entity: "Gatwick Airport Limited",
    truth: {
      entity: "Gatwick Airport Limited",
      period_end: "2026-03-31",
      ratio_name: "Senior Interest Cover Ratio",
      ratio_value: "2.51",
      numerator: "454.8",
      denominator: "181.2",
      trigger_level: "1.50",
      compliant: "yes",
    },
    check: { num: 454.8, den: 181.2, printed: 2.51 },
    distractors: {
      ratio_value: { value: "2.64", why: "Senior ICR at the previous Calculation Date" },
      numerator: { value: "621.9", why: "Cashflow from Operations, before three adjustments that net to 454.8" },
      ratio_name: { value: "Senior Regulatory Asset Ratio", why: "Schedule 2 certifies a second ratio" },
    },
  },
];

export const byId = (id) => CERTS.find((c) => c.id === id);

/** Recompute each printed ratio from its printed blocks. Guards against a bad fixture. */
export function verifyFixtures() {
  return CERTS.map((c) => {
    const computed = Math.round((c.check.num / c.check.den) * 100) / 100;
    return { id: c.id, printed: c.check.printed, computed, ok: computed === c.check.printed };
  });
}

/** Field-level scoring. Normalizes case, whitespace, currency and thousands separators. */
export function norm(v) {
  if (v == null) return "";
  return String(v).trim().toLowerCase().replace(/[£,\s]/g, "").replace(/:1$/, "");
}

export function scoreAnswer(certId, answer) {
  const cert = byId(certId);
  if (!cert) return null;
  const per = {};
  let right = 0;
  for (const f of FIELDS) {
    const ok = norm(answer?.[f.key]) === norm(cert.truth[f.key]);
    // Did they land on the specific wrong value the page invites?
    const d = cert.distractors?.[f.key];
    per[f.key] = {
      given: answer?.[f.key] ?? null,
      expected: cert.truth[f.key],
      correct: ok,
      distractor: !ok && d && norm(answer?.[f.key]) === norm(d.value) ? d.why : null,
    };
    if (ok) right++;
  }
  return { cert: certId, fields: per, correct: right, total: FIELDS.length };
}
