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
    ? `${licensed} of the ${s.fields.length} things are safe to leave to software, ${ruledOut} still need a person, and ${open} ${open === 1 ? "has" : "have"} too little evidence to call either way.`
    : `Nothing is safe to automate yet: nobody we paid has read anything, so all ${s.fields.length} are unread and every number below is demo data.`;

  const fieldRows = s.fields
    .map((f) => {
      const models = Object.entries(f.models)
        .map(([m, v]) => `<span class="chip">${m} ${v.n ? pct(v.ok / v.n) : "—"}</span>`)
        .join(" ");
      const cls = { LICENSED: "ok", "RULED OUT": "bad", UNMEASURED: "dim", "NOT YET DISTINGUISHED": "warn" }[f.verdict];
      const says = {
        LICENSED: "Safe to automate",
        "RULED OUT": "Keep a person on it",
        UNMEASURED: "Nobody has read it",
        "NOT YET DISTINGUISHED": "Not enough evidence yet",
      }[f.verdict];
      return `<tr>
      <td>${f.label}</td>
      <td class="num">${f.human.n ? `${f.human.ok}/${f.human.n}` : "—"}</td>
      <td class="num">${pct(f.human_rate)}</td>
      <td class="num mut">${f.human.n ? `${pct(f.human_lo)} – ${pct(f.human_hi)}` : "—"}</td>
      <td><span class="tag ${cls}">${says}</span></td>
      <td>${models || '<span class="mut">software has not read it</span>'}</td>
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
    ? `<b>These are the mistakes a checker cannot catch.</b> Every wrong value here is really printed on the page, usually
       left over from the period before, so it survives any check against the document — only a second reading finds it.
       Where software goes wrong more often than people, that field keeps a person whatever its rate says.`
    : `<b>An empty table is not a clean bill of health.</b> All it means is that nobody has picked up last period's number
       by mistake yet — not that nobody will.`;

  const gridSoWhat = s.human_n
    ? `<b>These are counts, not scores.</b> Nothing goes to software on fewer than ${s.n_min} perfect readings by people,
       so the gap between ${s.human_n} and that number is what the open questions still cost to settle. The software does
       the same work without the time or the fee.`
    : `<b>Nothing here is measured yet.</b> With no paid readings in, these tiles show only demo data. The first wave is
       what turns them into evidence — ${s.n_min} perfect readings each.`;

  const body = `
<h1>Which parts of the job still need a person?</h1>
<p class="lede">${headline}</p>
<p class="sub">Everyone who reads a certificate, person or software, is asked for the same eight things. Some are
easy and some are genuinely hard, so we score them <b>one at a time</b>: stop paying a person for the safe ones,
keep paying for the rest.</p>

<div class="banner ${s.evidence_mode === "live" ? "live" : "syn"}">
  ${
    s.evidence_mode === "live"
      ? `LIVE — every number below comes from people we paid through Terac today.`
      : `NOTHING MEASURED YET — nobody we paid has read anything, so none of this is a real finding.`
  }
</div>

<div class="grid">
  <div><label>Readings by people</label><div class="big">${s.human_n}</div></div>
  <div><label>Readings by software</label><div class="big">${s.model_n}</div></div>
  <div><label>How long a person takes</label><div class="big">${s.median_seconds ? s.median_seconds + "s" : "—"}</div></div>
  <div><label>Questions answered automatically</label><div class="big">${s.support.auto ?? 0}<small>/${s.support.total ?? 0}</small></div></div>
</div>
<p class="sowhat">${gridSoWhat}</p>

<h2>The eight things we ask for</h2>
<div class="card"><table>
<thead><tr><th>What we ask for</th><th class="num">People got it right</th><th class="num">Rate</th><th class="num">Range we can defend</th><th>Can it run without a person?</th><th>Software</th></tr></thead>
<tbody>${fieldRows}</tbody>
</table></div>
<p class="sowhat"><b>Read the range, not the rate.</b> Something is only safe to automate once the bottom of its range
(the Wilson 95% lower bound) clears ${(s.floor * 100).toFixed(0)}% — which takes at least ${s.n_min} perfectly correct
readings, so below that a wave can rule something out cheaply but can never turn one on. ${
    open
      ? `The ${open} still undecided ${open === 1 ? "is" : "are"} where the next wave's money belongs`
      : `With nothing undecided, another wave buys nothing new`
  }.</p>

<h2>Where readers go wrong, and why</h2>
<div class="card"><table>
<thead><tr><th>What we ask for</th><th class="num">People</th><th class="num">Software</th><th>The wrong value the page invites</th></tr></thead>
<tbody>${trapRows}</tbody>
</table></div>
<p class="sowhat">${trapSoWhat}</p>

<h2>Documents</h2>
<p class="sub">Made-up certificates. No real company, person, or account appears in any of them.</p>
<div class="card"><table>
<thead><tr><th>Certificate</th><th>Company</th><th>Main ratio</th><th class="num">Readings</th></tr></thead>
<tbody>${s.certs.map((c) => `<tr><td><a href="/docs/${c.id === "abpa" ? "abpa-demo-compliance-certificate-2026-06-30" : c.id === "hs1" ? "hs1-demo-compliance-certificate-2026-03-31" : "lgw-demo-compliance-certificate-2026-03-31"}.pdf">${c.id.toUpperCase()}</a></td><td>${c.entity}</td><td>${c.ratio}</td><td class="num">${c.answered}</td></tr>`).join("")}</tbody>
</table></div>
<p class="sowhat"><b>Readings per certificate is how far the claim reaches.</b> Everything above rests on
these ${s.certs.length} made-up documents and one instruction, so what is safe here is safe for this layout — a certificate that
prints its schedules differently starts the count again at zero. A row still on nought is a document this page says
nothing about.</p>`;

  return page({
    title: "Readiness",
    current: "/readiness",
    body,
    extraCss: `.tag{white-space:nowrap}td .chip{margin:0 4px 3px 0}`,
    script: `setInterval(()=>location.reload(),20000)`,
  });
}
