import { query } from "./db.mjs";
import { CERTS, FIELDS } from "./certs.mjs";
import { wilson, nMin } from "./readiness.mjs";

const FLOOR = 0.9;

/**
 * The result surface.
 *
 * Every number is computed from rows in Neon and carries its own n. A field nobody has
 * answered reports nothing rather than inheriting a rate from its neighbours, and the
 * evidence mode says plainly whether a figure came from paid humans or from the fixtures.
 */
export async function boardState() {
  const [rowsRes, certRes, waveRes, supportRes] = await Promise.all([
    query(`select source, coalesce(model_id,'human') as who, cert_id, answers, detail, correct, total, duration_ms
             from extractions`),
    query(`select cert_id, count(*)::int as n from extractions group by 1`),
    // Delivery is per wave: what we committed, who reached the work, and what came back usable.
    query(`select o.wave, o.status, o.participants, o.cost_cents, o.launched_at,
             (select count(*)::int from terac_responses r where r.payload->>'wave' = o.wave) as arrived,
             (select count(*)::int from extractions e where e.wave = o.wave and e.source = 'human') as delivered
             from terac_opportunities o where o.status in ('active','stopped')
             order by o.launched_at desc nulls last limit 5`),
    query(`select count(*)::int as total, sum(answered::int)::int as auto, sum(escalated::int)::int as esc
             from support_messages`).catch(() => ({ rows: [{ total: 0, auto: 0, esc: 0 }] })),
  ]);

  // Per-field accuracy, split by who answered.
  const byField = {};
  for (const f of FIELDS) byField[f.key] = { label: f.label, human: { n: 0, ok: 0 }, model: {} };
  const distractors = {};
  let humanN = 0;
  let modelN = 0;
  const durations = [];

  for (const r of rowsRes.rows) {
    const isHuman = r.source === "human";
    if (isHuman) {
      humanN++;
      if (r.duration_ms) durations.push(Number(r.duration_ms));
    } else modelN++;
    for (const f of FIELDS) {
      const d = r.detail?.[f.key];
      if (!d) continue;
      const bucket = isHuman
        ? byField[f.key].human
        : (byField[f.key].model[r.who] ??= { n: 0, ok: 0 });
      bucket.n++;
      if (d.correct) bucket.ok++;
      if (d.distractor) {
        const k = `${f.key}::${d.distractor}`;
        distractors[k] ??= { field: f.key, label: byField[f.key].label, why: d.distractor, human: 0, model: 0 };
        distractors[k][isHuman ? "human" : "model"]++;
      }
    }
  }

  const fields = FIELDS.map((f) => {
    const h = byField[f.key].human;
    const [lo, hi] = wilson(h.ok, h.n);
    return {
      key: f.key,
      label: f.label,
      human: h,
      human_rate: h.n ? h.ok / h.n : null,
      human_lo: h.n ? lo : null,
      human_hi: h.n ? hi : null,
      verdict: h.n === 0 ? "UNMEASURED" : hi < FLOOR ? "RULED OUT" : lo >= FLOOR ? "LICENSED" : "NOT YET DISTINGUISHED",
      models: byField[f.key].model,
    };
  });

  const seen = new Map(certRes.rows.map((r) => [r.cert_id, r.n]));
  return {
    floor: FLOOR,
    n_min: nMin(FLOOR),
    certs: CERTS.map((c) => ({ id: c.id, entity: c.entity, ratio: c.truth.ratio_name, answered: seen.get(c.id) ?? 0 })),
    fields,
    distractors: Object.values(distractors).sort((a, b) => b.human + b.model - (a.human + a.model)),
    human_n: humanN,
    model_n: modelN,
    median_seconds: durations.length
      ? Math.round(durations.sort((a, b) => a - b)[Math.floor(durations.length / 2)] / 1000)
      : null,
    waves: waveRes.rows,
    support: supportRes.rows[0] ?? { total: 0, auto: 0, esc: 0 },
    evidence_mode: humanN > 0 ? "live" : "synthetic",
  };
}

const pct = (x) => (x == null ? "—" : (x * 100).toFixed(1) + "%");

export function boardPage(s) {
  const nav = `<nav><a href="/">Coverage board</a><a href="/ops">Operator</a><a href="/design">Designer</a><a href="/funnel">Funnel</a><a href="/results">Results</a><a href="/support">Support</a></nav>`;

  const headline = s.human_n
    ? `${s.human_n} paid human extraction${s.human_n === 1 ? "" : "s"} against ${s.model_n} model run${s.model_n === 1 ? "" : "s"} on the same certificates.`
    : `No human extractions yet. Every figure below is a fixture, and says so.`;

  const fieldRows = s.fields
    .map((f) => {
      const models = Object.entries(f.models)
        .map(([m, v]) => `<span class="chip">${m} ${v.n ? pct(v.ok / v.n) : "—"}</span>`)
        .join(" ");
      const cls = { LICENSED: "ok", "RULED OUT": "bad", UNMEASURED: "mut", "NOT YET DISTINGUISHED": "warn" }[f.verdict];
      return `<tr>
      <td>${f.label}</td>
      <td class="num">${f.human.n ? `${f.human.ok}/${f.human.n}` : "—"}</td>
      <td class="num">${pct(f.human_rate)}</td>
      <td class="num mut">${f.human.n ? `${pct(f.human_lo)} – ${pct(f.human_hi)}` : "—"}</td>
      <td><span class="tag ${cls}">${f.verdict}</span></td>
      <td>${models || '<span class="mut">no model runs</span>'}</td>
    </tr>`;
    })
    .join("");

  const trapRows = s.distractors.length
    ? s.distractors
        .map(
          (d) => `<tr><td>${d.label}</td><td class="num">${d.human}</td><td class="num">${d.model}</td>
        <td class="mut">${d.why}</td></tr>`,
        )
        .join("")
    : `<tr><td colspan="4" class="mut">No wrong answers recorded yet.</td></tr>`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Coverage Engine</title><style>
:root{color-scheme:light dark;--bg:#0c0c0d;--fg:#f4f4f5;--mut:#a1a1aa;--line:#27272a;--card:#161617;--ok:#4ade80;--warn:#fbbf24;--bad:#f87171;--acc:#60a5fa}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
.wrap{max-width:1080px;margin:0 auto;padding:26px 20px 90px}
nav{display:flex;gap:18px;margin:0 0 24px;padding-bottom:12px;border-bottom:1px solid var(--line);font-size:13px}
nav a{color:var(--mut);text-decoration:none}nav a:first-child{color:var(--fg)}
h1{font-size:27px;margin:0 0 6px;letter-spacing:-.01em}
h2{font-size:12px;text-transform:uppercase;letter-spacing:.1em;color:var(--mut);margin:34px 0 10px}
.lede{font-size:17px;color:var(--fg);margin:0 0 4px}
.sub{color:var(--mut);font-size:13.5px;margin:0 0 20px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px}
.big{font-size:27px;font-variant-numeric:tabular-nums}
label{font-size:11px;color:var(--mut);display:block;text-transform:uppercase;letter-spacing:.06em}
table{width:100%;border-collapse:collapse;font-size:14px}
th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--mut);padding:7px 8px;border-bottom:1px solid var(--line);font-weight:500}
td{padding:9px 8px;border-bottom:1px solid var(--line)}tr:last-child td{border-bottom:0}
.num{font-variant-numeric:tabular-nums;text-align:right}
.tag{font-size:10px;letter-spacing:.06em;padding:2px 8px;border-radius:99px;border:1px solid currentColor}
.chip{font-size:11px;border:1px solid var(--line);border-radius:99px;padding:2px 8px;color:var(--mut);white-space:nowrap}
.ok{color:var(--ok)}.warn{color:var(--warn)}.bad{color:var(--bad)}.mut{color:var(--mut)}
.banner{border-radius:10px;padding:12px 14px;font-size:13.5px;margin:0 0 20px;border:1px solid}
.live{border-color:var(--ok);color:var(--ok)}.syn{border-color:var(--warn);color:var(--warn)}
</style></head><body><div class="wrap">${nav}
<h1>Cost of Trust — Coverage Engine</h1>
<p class="lede">${headline}</p>
<p class="sub">Which steps of a compliance-certificate review can run with no human in the loop, and what the evidence actually licenses us to claim.</p>

<div class="banner ${s.evidence_mode === "live" ? "live" : "syn"}">
  ${
    s.evidence_mode === "live"
      ? `LIVE — figures below come from paid human extractions collected through Terac today.`
      : `SYNTHETIC — no paid human input has arrived yet. Nothing here is a measured claim.`
  }
</div>

<div class="card grid">
  <div><label>Human extractions</label><div class="big">${s.human_n}</div></div>
  <div><label>Model runs</label><div class="big">${s.model_n}</div></div>
  <div><label>Median human time</label><div class="big">${s.median_seconds ? s.median_seconds + "s" : "—"}</div></div>
  <div><label>Support auto-answered</label><div class="big">${s.support.auto ?? 0}<span style="font-size:14px;color:var(--mut)">/${s.support.total ?? 0}</span></div></div>
</div>

<h2>Per-field readiness · floor ${(s.floor * 100).toFixed(0)}%</h2>
<div class="card"><table>
<tr><th>Field extracted</th><th class="num">Correct</th><th class="num">Rate</th><th class="num">95% interval</th><th>Verdict</th><th>Models</th></tr>
${fieldRows}
</table>
<p class="sub" style="margin:12px 0 0">Readiness is the Wilson lower bound over independent extractions, never the observed rate.
A field needs <strong>${s.n_min}</strong> perfectly-correct answers before even flawless agreement can reach the floor —
below that a wave can rule a field out but can never license one.</p>
</div>

<h2>The traps · which specific wrong value was taken</h2>
<div class="card"><table>
<tr><th>Field</th><th class="num">Humans</th><th class="num">Models</th><th>Why it is the plausible wrong answer</th></tr>
${trapRows}
</table>
<p class="sub" style="margin:12px 0 0">Each certificate prints its prior-period ratio beside the current one. A citation check
cannot separate them — the digits are genuinely on the page — so this is the failure that
automated verification structurally cannot catch, and the reason to buy human judgment at all.</p>
</div>

<h2>Documents</h2>
<div class="card"><table>
<tr><th>Certificate</th><th>Entity</th><th>Primary ratio</th><th class="num">Extractions</th></tr>
${s.certs.map((c) => `<tr><td><a href="/docs/${c.id === "abpa" ? "abpa-demo-compliance-certificate-2026-06-30" : c.id === "hs1" ? "hs1-demo-compliance-certificate-2026-03-31" : "lgw-demo-compliance-certificate-2026-03-31"}.pdf" style="color:var(--acc)">${c.id.toUpperCase()}</a></td><td>${c.entity}</td><td>${c.ratio}</td><td class="num">${c.answered}</td></tr>`).join("")}
</table>
<p class="sub" style="margin:12px 0 0">Synthetic demonstration documents. No real company, person, or account appears in any of them.</p>
</div>

<script>setInterval(()=>location.reload(),20000)</script>
</div></body></html>`;
}
