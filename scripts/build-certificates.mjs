/**
 * Renders the synthetic compliance certificates from their specs.
 *
 * The certificates are the measurement instrument: every value a reader is asked for has to
 * be printed, and every registered distractor has to be printed too, or the trap it stands
 * for cannot be taken. Keeping them generated rather than checked in as opaque PDFs means
 * that property is auditable — and that a certificate can be regenerated without anyone
 * having to reproduce a layout by hand.
 *
 *   node scripts/build-certificates.mjs           # html + pdf + png
 *   node scripts/build-certificates.mjs --html    # html only, no browser needed
 *
 * Chrome renders the PDF and pdftoppm rasterises at 200 DPI (1653x2339 for A4), which is
 * the resolution both arms of the experiment are shown.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SPECS = JSON.parse(readFileSync(join(ROOT, "fixtures/certificates.json"), "utf8"));
const OUT_PDF = join(ROOT, "public/docs");
const OUT_PNG = join(OUT_PDF, "png");
const WORK = join(ROOT, ".certbuild");

const CHROME =
  process.env.CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A deduction prints in parentheses and counts as negative when the column is summed. */
const numeric = (v) => {
  const s = String(v).replace(/,/g, "").trim();
  const neg = /^\(.*\)$/.test(s);
  const n = Number(s.replace(/[()£m%+]/g, ""));
  return Number.isFinite(n) ? (neg ? -n : n) : null;
};

const ROW_CLASS = {
  num_total: "total",
  den_total: "total",
  ratio: "ratio",
  threshold: "thresh",
  prior: "prior",
  memo: "memo",
};

function rows(list) {
  return list
    .map((r) => {
      const cls = ROW_CLASS[r.role] ?? "";
      return `<tr class="${cls}"><td>${esc(r.label)}</td><td class="n">${esc(r.value)}</td></tr>`;
    })
    .join("\n");
}

function schedule1(s) {
  return `
<h2 class="sched">${esc(s.heading)}</h2>
<table class="fig">
  <thead><tr><th></th><th class="n">£m</th></tr></thead>
  <tbody>
${rows(s.components)}
  </tbody>
</table>
<p class="concl">${esc(s.conclusion)}</p>`;
}

function schedule2(s) {
  if (!s) return "";
  return `
<h2 class="sched brk">${esc(s.heading)}</h2>
<table class="fig">
  <thead><tr><th></th><th class="n">£m</th></tr></thead>
  <tbody>
${s.rows.map((r) => `<tr class="${r.role ? (ROW_CLASS[r.role] ?? "") : ""}"><td>${esc(r.label)}</td><td class="n">${esc(r.value)}</td></tr>`).join("\n")}
  </tbody>
</table>
<p class="concl">${esc(s.conclusion)}</p>`;
}

function html(spec) {
  const p = spec.parties;
  const copy = [p.issuer ? `${esc(p.issuer)} (as Issuer)` : null, p.bond_trustee ? `${esc(p.bond_trustee)} (as Bond Trustee)` : null, p.copy_to ? esc(p.copy_to) : null]
    .filter(Boolean)
    .join("; ");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(spec.entity)}</title>
<style>
@page { size: A4; margin: 16mm 15mm 14mm; }
* { box-sizing: border-box; }
body { font: 10.5pt/1.45 Georgia, "Times New Roman", serif; color: #111; margin: 0; position: relative; }
.mast { text-align: center; font: 7.5pt/1.35 Arial, Helvetica, sans-serif; letter-spacing: .06em;
        text-transform: uppercase; color: #555; border-bottom: .5pt solid #bbb; padding-bottom: 5pt; margin-bottom: 20pt; }
h1.ent { text-align: center; font-size: 17pt; margin: 22pt 0 3pt; font-weight: normal; }
.sub { text-align: center; font-size: 9pt; color: #333; margin: 0 0 2pt; font-style: italic; }
h2.title { text-align: center; font-size: 13pt; letter-spacing: .08em; margin: 20pt 0 4pt; font-weight: normal; text-transform: uppercase; }
.pursuant { text-align: center; font-size: 8.5pt; color: #333; margin: 0 auto 18pt; max-width: 86%; line-height: 1.4; }
.addr { font-size: 9.5pt; margin: 0 0 2pt; }
.dates { margin: 12pt 0 16pt; font-size: 10pt; }
.dates div { margin: 1pt 0; }
.dates b { font-weight: normal; display: inline-block; min-width: 200pt; }
ol.rec { padding-left: 16pt; margin: 0 0 14pt; }
ol.rec li { margin: 0 0 8pt; text-align: justify; }
h2.sched { font-size: 10.5pt; text-transform: uppercase; letter-spacing: .04em; margin: 20pt 0 8pt;
           border-bottom: .75pt solid #333; padding-bottom: 3pt; font-weight: bold; }
h2.sched.brk { page-break-before: always; margin-top: 4pt; }
table.fig { width: 100%; border-collapse: collapse; font-size: 10pt; }
table.fig th { font-size: 8pt; font-weight: normal; color: #444; text-align: left; padding: 0 4pt 3pt; border-bottom: .5pt solid #333; }
table.fig td { padding: 4.5pt 4pt; border-bottom: .25pt solid #d4d4d4; vertical-align: top; }
td.n, th.n { text-align: right; white-space: nowrap; width: 88pt; font-variant-numeric: tabular-nums; }
tr.total td { border-top: .5pt solid #555; border-bottom: .5pt solid #555; font-weight: bold; }
tr.ratio td { font-weight: bold; border-bottom: 1.5pt double #333; }
tr.thresh td, tr.prior td, tr.memo td { color: #333; }
tr.memo td { font-size: 9pt; font-style: italic; }
.concl { font-size: 9.5pt; margin: 9pt 0 0; }
.sig { margin-top: 26pt; font-size: 10pt; page-break-inside: avoid; }
.sig .line { border-top: .5pt solid #333; width: 190pt; margin: 30pt 0 4pt; }
.foot { margin-top: 24pt; padding-top: 8pt; border-top: .5pt solid #bbb;
        font: 7.5pt/1.4 Arial, Helvetica, sans-serif; color: #555; text-align: justify; }
.wm { position: fixed; top: 44%; left: 50%; transform: translate(-50%,-50%) rotate(-28deg);
      font: bold 42pt Arial, Helvetica, sans-serif; color: rgba(0,0,0,.055); letter-spacing: .18em;
      white-space: nowrap; z-index: 0; pointer-events: none; }
.body { position: relative; z-index: 1; }
</style></head><body>
<div class="wm">SYNTHETIC ILLUSTRATIVE DOCUMENT</div>
<div class="body">
<div class="mast">Synthetic demonstration document — created for document-reading research — not issued by any real entity</div>

<h1 class="ent">${esc(spec.entity)}</h1>
<p class="sub">${esc(spec.group_descriptor ?? "")}</p>

<h2 class="title">Compliance Certificate</h2>
<p class="pursuant">given pursuant to the Information Covenants under the ${esc(spec.agreement.name)} dated ${esc(spec.agreement.date_human)} (as amended from time to time)</p>

<p class="addr">To: ${esc(p.security_trustee)}</p>
${copy ? `<p class="addr">Copy: ${copy}</p>` : ""}

<div class="dates">
  <div><b>Date of this Certificate:</b> ${esc(spec.cert_date_human)}</div>
  <div><b>${esc(spec.period_label ?? "Calculation Date")}:</b> ${esc(spec.period_end_human)}</div>
  <div><b>Relevant Period (${esc(spec.schedule1.ratio_name)}):</b> the twelve months ended ${esc(spec.period_end_human)}</div>
</div>

<p>Dear Sirs,</p>
<ol class="rec">
${(spec.recitals ?? []).map((r) => `  <li>${esc(r)}</li>`).join("\n")}
</ol>

${schedule1(spec.schedule1)}
${schedule2(spec.schedule2)}

<div class="sig">
  <p>${esc(spec.signature_block ?? "This Certificate is given in accordance with the agreement referred to above.")}</p>
  <div class="line"></div>
  <div>Director</div>
  <div>for and on behalf of ${esc(spec.entity)}</div>
</div>

<p class="foot">${esc(spec.footer_note)}</p>
</div>
</body></html>`;
}

/** Fails loudly rather than shipping a certificate whose own arithmetic does not hold. */
function audit(spec) {
  const problems = [];
  const s = spec.schedule1;
  const printed = new Set();
  for (const r of s.components) printed.add(String(r.value).replace(/[(),£m]/g, "").trim());
  if (spec.schedule2) for (const r of spec.schedule2.rows) printed.add(String(r.value).replace(/[(),£m]/g, "").trim());

  const sum = (role) =>
    s.components.filter((r) => r.role === role).reduce((a, r) => a + (numeric(r.value) ?? 0), 0);
  const totalOf = (role) => s.components.find((r) => r.role === role);

  // Only cross-foot where the document actually shows a build-up. One certificate prints its
  // numerator as a single line on purpose — that is what makes it the easy one, and the
  // difficulty gradient across the three is the instrument, not an oversight.
  const numTotal = totalOf("num_total");
  const denTotal = totalOf("den_total");
  const hasNumParts = s.components.some((r) => r.role === "num_component");
  const hasDenParts = s.components.some((r) => r.role === "den_component");
  if (numTotal && hasNumParts) {
    const built = Math.round(sum("num_component") * 10) / 10;
    if (Math.abs(built - numeric(numTotal.value)) > 0.051)
      problems.push(`numerator components sum to ${built}, printed total is ${numTotal.value}`);
  }
  if (denTotal && hasDenParts) {
    const built = Math.round(sum("den_component") * 10) / 10;
    if (Math.abs(built - numeric(denTotal.value)) > 0.051)
      problems.push(`denominator components sum to ${built}, printed total is ${denTotal.value}`);
  }
  const computed = Math.round((numeric(s.numerator) / numeric(s.denominator)) * 100) / 100;
  if (computed !== Number(s.ratio_value))
    problems.push(`${s.numerator} / ${s.denominator} = ${computed}, but ratio_value prints ${s.ratio_value}`);

  for (const [field, d] of Object.entries(spec.distractors ?? {})) {
    const v = String(d.value).replace(/[(),£m]/g, "").trim();
    const isDate = /^\d{4}-\d{2}-\d{2}$/.test(v);
    const isText = Number.isNaN(Number(v));
    if (!isDate && !isText && !printed.has(v))
      problems.push(`distractor ${field}=${d.value} is not printed anywhere in the document`);
  }
  return problems;
}

const htmlOnly = process.argv.includes("--html");
mkdirSync(WORK, { recursive: true });
mkdirSync(OUT_PNG, { recursive: true });

let failed = false;
for (const spec of SPECS) {
  const problems = audit(spec);
  if (problems.length) {
    failed = true;
    console.error(`\n✗ ${spec.id}`);
    for (const p of problems) console.error(`    ${p}`);
    continue;
  }
  const htmlPath = join(WORK, `${spec.file_slug}.html`);
  writeFileSync(htmlPath, html(spec));
  console.log(`✓ ${spec.id}  ${spec.entity}`);
  if (htmlOnly) continue;

  const pdfPath = join(OUT_PDF, `${spec.file_slug}.pdf`);
  execFileSync(CHROME, [
    "--headless",
    "--disable-gpu",
    "--no-pdf-header-footer",
    `--print-to-pdf=${pdfPath}`,
    `file://${htmlPath}`,
  ], { stdio: "ignore" });

  execFileSync("pdftoppm", ["-r", "200", "-png", pdfPath, join(OUT_PNG, spec.file_slug)]);

  // The task page builds its image list from `pages`. If a certificate quietly gains a page,
  // that page is never shown — while its figures are still scored, so readers get marked
  // wrong for not finding something they were never given.
  const rendered = Number(
    execFileSync("pdfinfo", [pdfPath], { encoding: "utf8" }).match(/^Pages:\s*(\d+)/m)?.[1],
  );
  if (rendered !== spec.pages) {
    failed = true;
    console.error(`    ✗ renders ${rendered} pages, spec says ${spec.pages} — fix one or the other`);
  }
  console.log(`    ${pdfPath.replace(ROOT + "/", "")}  ${rendered}pp`);
}

if (failed) {
  console.error("\nNo certificate is written while any of them fails its own audit.");
  process.exit(1);
}
if (!htmlOnly && existsSync(OUT_PNG)) console.log("\nRendered at 200 DPI.");
