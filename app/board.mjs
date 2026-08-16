import { query } from "./db.mjs";
import { CERTS, FIELDS } from "./certs.mjs";
import { wilson, nMin } from "./readiness.mjs";
import { page } from "./ui.mjs";

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
  let walkupN = 0;
  const durations = [];

  for (const r of rowsRes.rows) {
    const isHuman = r.source === "human";
    // A walk-up is neither. It is real reading, but it was not recruited or paid, so it
    // cannot enter the licensing bound; and `else` alone would file it under models —
    // where model_id is null, so it surfaced as a phantom model literally named "human".
    if (r.source !== "human" && r.source !== "model") {
      walkupN++;
      continue;
    }
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
    walkup_n: walkupN,
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
  const count = (v) => s.fields.filter((f) => f.verdict === v).length;
  const licensed = count("LICENSED");
  const ruledOut = count("RULED OUT");
  const open = s.fields.length - licensed - ruledOut;

  const headline = s.human_n
    ? `${licensed} of ${s.fields.length} fields are licensed to run with no human in the loop, ${ruledOut} are ruled out, and ${open} still ${open === 1 ? "lacks" : "lack"} the evidence to decide either way.`
    : `Nothing is licensed yet: no paid human reading has arrived, so all ${s.fields.length} fields sit unmeasured and every figure below is a fixture.`;

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

  const trapSoWhat = s.distractors.length
    ? `<b>These are the errors a checker cannot catch.</b> Every wrong value here is a real figure printed on the same
       page — usually the prior period's — so a citation check passes on it and only a second reading finds it. Where the
       Models column runs ahead of the Humans column, that field stays manual whatever its headline rate says.`
    : `<b>An empty trap table is not a clean bill of health.</b> With no wrong answers recorded it cannot tell you whether
       the prior-period figures printed alongside the current ones are being taken by mistake — only that nobody has
       taken one yet. This table earns its keep on the first wrong reading, not before.`;

  const gridSoWhat = s.human_n
    ? `<b>These counts are sample size, not score.</b> No field can be licensed on fewer than ${s.n_min} clean human
       readings, so at roughly $1.69 a reading the gap between ${s.human_n} and that threshold is the price of deciding
       the fields still open. Median time is how long one paid reading takes; the model runs are the same work with that
       time and that fee removed.`
    : `<b>Nothing here is a measurement yet.</b> With no paid human readings on the board these tiles show only what the
       fixtures contain, and the first real wave is what turns them into evidence — ${s.n_min} clean readings per field
       before any of them can license anything.`;

  const body = `
<h1>Cost of Trust — Coverage Engine</h1>
<p class="lede">${headline}</p>
<p class="sub">Which steps of a compliance-certificate review can run with no human in the loop, and what the evidence
actually licenses us to claim.</p>

<div class="banner ${s.evidence_mode === "live" ? "live" : "syn"}">
  ${
    s.evidence_mode === "live"
      ? `LIVE — figures below come from paid human extractions collected through Terac today.`
      : `SYNTHETIC — no paid human input has arrived yet. Nothing here is a measured claim.`
  }
</div>

<div class="grid">
  <div><label>Human extractions</label><div class="big">${s.human_n}</div></div>
  <div><label>Model runs</label><div class="big">${s.model_n}</div></div>
  <div><label>Median human time</label><div class="big">${s.median_seconds ? s.median_seconds + "s" : "—"}</div></div>
  <div><label>Support auto-answered</label><div class="big">${s.support.auto ?? 0}<small>/${s.support.total ?? 0}</small></div></div>
</div>
<p class="sowhat">${gridSoWhat}</p>

<h2>Per-field readiness · floor ${(s.floor * 100).toFixed(0)}%</h2>
<div class="card"><table>
<thead><tr><th>Field extracted</th><th class="num">Correct</th><th class="num">Rate</th><th class="num">95% interval</th><th>Verdict</th><th>Models</th></tr></thead>
<tbody>${fieldRows}</tbody>
</table></div>
<p class="sowhat"><b>The verdict column is the buy decision, and the interval is what earns it.</b> A field is licensed only
when the Wilson lower bound clears ${(s.floor * 100).toFixed(0)}% — which takes at least ${s.n_min} perfectly correct
readings, so below that a wave can rule a field out cheaply but can never turn one on. Read the interval, not the rate:
LICENSED fields come off the human queue, RULED OUT fields stay on it, and ${
    open
      ? `the ${open} still open ${open === 1 ? "is" : "are"} where the next wave's budget belongs`
      : `with none left undecided another wave buys no new licences`
  }.</p>

<h2>The traps · which specific wrong value was taken</h2>
<div class="card"><table>
<thead><tr><th>Field</th><th class="num">Humans</th><th class="num">Models</th><th>Why it is the plausible wrong answer</th></tr></thead>
<tbody>${trapRows}</tbody>
</table></div>
<p class="sowhat">${trapSoWhat}</p>

<h2>Documents</h2>
<p class="sub">Synthetic demonstration certificates. No real company, person, or account appears in any of them.</p>
<div class="card"><table>
<thead><tr><th>Certificate</th><th>Entity</th><th>Primary ratio</th><th class="num">Extractions</th></tr></thead>
<tbody>${s.certs.map((c) => `<tr><td><a href="/docs/${c.id === "abpa" ? "abpa-demo-compliance-certificate-2026-06-30" : c.id === "hs1" ? "hs1-demo-compliance-certificate-2026-03-31" : "lgw-demo-compliance-certificate-2026-03-31"}.pdf">${c.id.toUpperCase()}</a></td><td>${c.entity}</td><td>${c.ratio}</td><td class="num">${c.answered}</td></tr>`).join("")}</tbody>
</table></div>
<p class="sowhat"><b>Extractions per certificate is the reach of the claim, not a corpus size.</b> Every verdict above rests on
these ${s.certs.length} synthetic documents and one instruction, so a licence here is a licence for this layout — a certificate that
prints its schedules differently starts the count again at zero. A row still on nought is a document the board says
nothing about.</p>`;

  return page({
    title: "Coverage Engine",
    current: "/",
    body,
    extraCss: `.tag{white-space:nowrap}td .chip{margin:0 4px 3px 0}`,
    script: `setInterval(()=>location.reload(),20000)`,
  });
}
