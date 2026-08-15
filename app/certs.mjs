/**
 * The three synthetic compliance certificates, and the one instruction both sides answer.
 *
 * Ground truth is what the certificate PRINTS, and every ratio here was checked against its
 * own building blocks before being written down. The point of the experiment is that neither
 * side is told any of it: human and model each get the same pages and the same instruction.
 */

export const INSTRUCTION = `You are looking at a compliance certificate for a secured financing.

Read the document and report, using only what is printed in it:

1. The entity named at the head of the certificate — the company giving it.
2. The date the reporting period ENDED, written as YYYY-MM-DD.
3. The name of the ratio set out in Schedule 1, exactly as the document names it. Some of these certificates also certify a second ratio in Schedule 2 — ignore it. Every item below is about the Schedule 1 ratio.
4. The value of that ratio for the period in item 2, exactly as printed.
5. The two figures that value is calculated from, for that same period — the numerator and the denominator, as printed.
6. The level the certificate gives as the Trigger Event level for that ratio, as printed.
7. Whether the certificate states the entity is compliant: yes or no.

Every one of these is printed somewhere in this document — none of them has to be worked out. Report exactly what is printed. If, after looking, you genuinely cannot find one, write "not stated" for that item rather than estimating it.
Do not estimate, infer, or calculate anything the document does not print.`;

export const FIELDS = [
  { key: "entity", label: "Entity", hint: "the company named at the head of the certificate" },
  { key: "period_end", label: "Period ended", hint: "the date the reporting period ended, as YYYY-MM-DD" },
  { key: "ratio_name", label: "Schedule 1 ratio — name", hint: "exactly as the document names it" },
  { key: "ratio_value", label: "Schedule 1 ratio — value", hint: "its value for the period above, exactly as printed" },
  { key: "numerator", label: "Numerator", hint: "the figure being divided — number only, no £ and no m" },
  { key: "denominator", label: "Denominator", hint: "the figure it is divided by — number only" },
  { key: "trigger_level", label: "Trigger Event level", hint: "for that same ratio, as printed" },
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
    accept: { entity: ["ABPA Holdings Ltd"] },
    distractors: {
      ratio_value: { value: "2.47", why: "Interest Cover at the previous Calculation Date, printed two rows below" },
      ratio_name: { value: "Leverage", alt: ["Leverage (Net Borrowings / EBITDA)"], why: "Schedule 2 prints a second ratio, 5.43" },
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
    accept: { entity: ["HS1 Ltd"], ratio_name: ["DSCR"] },
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
    accept: { entity: ["Gatwick Airport Ltd"], ratio_name: ["Senior ICR"] },
    distractors: {
      ratio_value: { value: "2.64", why: "Senior ICR at the previous Calculation Date" },
      numerator: { value: "621.9", why: "Cashflow from Operations, before three adjustments that net to 454.8" },
      ratio_name: { value: "Senior Regulatory Asset Ratio", alt: ["Senior RAR"], why: "Schedule 2 certifies a second ratio" },
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

const MONTHS = ["january","february","march","april","may","june","july","august","september","october","november","december"];
function asDate(v) {
  const t = String(v).trim().toLowerCase().replace(/(\d)(st|nd|rd|th)\b/, "$1");
  let m = t.match(/^(\d{1,2})\s+([a-z]{3,})\.?\s+(\d{4})$/);
  if (m) { const i = MONTHS.findIndex((x) => x.startsWith(m[2].slice(0, 3))); if (i >= 0) return `${m[3]}-${String(i + 1).padStart(2, "0")}-${m[1].padStart(2, "0")}`; }
  m = t.match(/^([a-z]{3,})\.?\s+(\d{1,2}),?\s+(\d{4})$/);
  if (m) { const i = MONTHS.findIndex((x) => x.startsWith(m[1].slice(0, 3))); if (i >= 0) return `${m[3]}-${String(i + 1).padStart(2, "0")}-${m[2].padStart(2, "0")}`; }
  m = t.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/);
  if (m) { let d = +m[1], mo = +m[2]; if (mo > 12 && d <= 12) [d, mo] = [mo, d];
    if (mo >= 1 && mo <= 12) return `${m[3]}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`; }
  m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  return m ? `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` : null;
}

/**
 * Field-level scoring. Case, whitespace, currency, thousands separators, a trailing
 * parenthetical the document itself prints, a "(less than)" qualifier, and date format
 * are all presentation, not reading. Rejecting a valid synonym does not just lose one
 * answer — a field that does it at any rate can never reach the licensing floor.
 */
export function norm(v) {
  if (v == null) return "";
  return String(v).trim().toLowerCase()
    .replace(/[‘’“”]/g, '"')
    .replace(/^(?:less than|greater than|more than|below|above|under|over)\s+|^[<>]\s*/, "")
    .replace(/\s*\([^)]*\)\s*$/, "")
    .replace(/[£$,\s]/g, "")
    .replace(/:1$/, "")
    .replace(/\.$/, "");
}

const asNumber = (s) => (/^-?\d+(?:\.\d+)?m?$/.test(s) ? Number(s.replace(/m$/, "")) : null);

export function same(a, b) {
  const x = norm(a), y = norm(b);
  if (x === y) return true;
  const da = asDate(a), db = asDate(b);
  if (da && db && da === db) return true;
  const nx = asNumber(x), ny = asNumber(y);
  return nx !== null && ny !== null && nx === ny;
}

export function scoreAnswer(certId, answer) {
  const cert = byId(certId);
  if (!cert) return null;
  const per = {};
  let right = 0;
  for (const f of FIELDS) {
    const ok = [cert.truth[f.key], ...(cert.accept?.[f.key] ?? [])].some((t) => same(answer?.[f.key], t));
    // Did they land on the specific wrong value the page invites?
    const d = cert.distractors?.[f.key];
    per[f.key] = {
      given: answer?.[f.key] ?? null,
      expected: cert.truth[f.key],
      correct: ok,
      distractor: !ok && d && [d.value, ...(d.alt ?? [])].some((v) => same(answer?.[f.key], v)) ? d.why : null,
    };
    if (ok) right++;
  }
  return { cert: certId, fields: per, correct: right, total: FIELDS.length };
}
