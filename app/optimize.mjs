import express from "express";
import { query } from "./db.mjs";
import { FIELDS } from "./certs.mjs";
import { wilson, nMin } from "./readiness.mjs";
import { page } from "./ui.mjs";
import { readCostCents, money, priceFor, PRICES_AS_OF, PRICE_SOURCE } from "./economics.mjs";

/**
 * What a trusted read costs.
 *
 * An agent reads every document either way, so "human versus model" is not the decision. The
 * decisions are: which is the CHEAPEST agent that reads well enough, and what does the human
 * attestation on top of it cost. This page answers those two and nothing else.
 *
 * The human is not here to beat the models. On this evidence it does not, and saying so
 * plainly is the point — an attestation is bought for trust, not for accuracy, and pretending
 * otherwise would misprice the whole operation.
 */

const FLOOR = 0.9;
const short = (m) => String(m).replace(/^novita\//, "").split("/").pop();

export async function optimizeState(floor = FLOOR) {
  const [runsRes, humanRes, cpiRes] = await Promise.all([
    query(`select model_id, usage, duration_ms, correct, total
             from experiment_runs where source = 'model' and usage is not null`),
    query(`select count(*)::int n, sum(correct)::int correct, sum(total)::int total,
                  percentile_cont(0.5) within group (order by duration_ms) med_ms
             from extractions where source = 'human'`),
    query(`select cpi_cents from terac_opportunities
            where cpi_cents > 0 and launched_at is not null
            order by launched_at desc limit 1`).catch(() => ({ rows: [] })),
  ]);

  const by = new Map();
  for (const r of runsRes.rows) {
    const m = by.get(r.model_id) ?? { id: r.model_id, runs: 0, correct: 0, total: 0, cents: 0, ms: [], priced: true };
    m.runs++;
    m.correct += Number(r.correct ?? 0);
    m.total += Number(r.total ?? 0);
    const c = readCostCents(r.model_id, r.usage);
    if (c == null) m.priced = false;
    else m.cents += c;
    if (r.duration_ms) m.ms.push(Number(r.duration_ms));
    by.set(r.model_id, m);
  }

  const readers = [...by.values()].map((m) => {
    const [lo, hi] = wilson(m.correct, m.total);
    const perDoc = m.priced && m.runs ? m.cents / m.runs : null;
    return {
      id: m.id,
      name: short(m.id),
      runs: m.runs,
      correct: m.correct,
      total: m.total,
      rate: m.total ? m.correct / m.total : null,
      lo,
      hi,
      clears: lo >= floor,
      cost_cents: perDoc,
      per_1000: perDoc == null ? null : (perDoc * 1000) / 100,
      median_s: m.ms.length ? m.ms.sort((a, b) => a - b)[Math.floor(m.ms.length / 2)] / 1000 : null,
    };
  });

  // Rank on the 95% lower bound, not the observed rate. A reader that happened to score
  // perfectly on three documents has earned more measurement, not the title of "good enough".
  const eligible = readers.filter((r) => r.clears && r.cost_cents != null);
  const licensed = eligible.length ? eligible.slice().sort((a, b) => a.cost_cents - b.cost_cents)[0] : null;

  // Nothing can clear a 90% LOWER bound on 24 trials -- that needs 35 clean reads, and we have
  // three documents. Reporting only a licensed winner would leave the page blank and answer
  // nothing, so the headline is the cheapest reader at the best OBSERVED accuracy, labelled as
  // provisional. The discipline is kept by saying which it is, not by refusing to say anything.
  const priced = readers.filter((r) => r.cost_cents != null && r.total > 0);
  const best = priced.length ? Math.max(...priced.map((r) => r.rate)) : null;
  const cheapest =
    licensed ??
    (priced.length
      ? priced.filter((r) => r.rate === best).sort((a, b) => a.cost_cents - b.cost_cents)[0]
      : null);
  const cheapestAny = priced.slice().sort((a, b) => a.cost_cents - b.cost_cents)[0] ?? null;

  const h = humanRes.rows[0] ?? { n: 0, correct: 0, total: 0, med_ms: null };
  const [hlo, hhi] = wilson(Number(h.correct ?? 0), Number(h.total ?? 0));
  const cpi = cpiRes.rows[0]?.cpi_cents ?? null;

  return {
    floor,
    n_min: nMin(floor),
    fields: FIELDS.length,
    readers: readers.sort((a, b) => (a.cost_cents ?? Infinity) - (b.cost_cents ?? Infinity)),
    cheapest,
    licensed,
    provisional: licensed == null && cheapest != null,
    cheapestAny,
    human: {
      n: Number(h.n ?? 0),
      correct: Number(h.correct ?? 0),
      total: Number(h.total ?? 0),
      rate: h.total ? Number(h.correct) / Number(h.total) : null,
      lo: hlo,
      hi: hhi,
      clears: h.total ? hlo >= floor : false,
      median_s: h.med_ms ? Math.round(Number(h.med_ms) / 1000) : null,
      cost_cents: cpi,
    },
    prices_as_of: PRICES_AS_OF,
    price_source: PRICE_SOURCE,
  };
}

const pct = (x) => (x == null ? "—" : (x * 100).toFixed(1) + "%");
const secs = (s) => (s == null ? "—" : s < 60 ? `${s.toFixed(1)}s` : `${Math.round(s / 60)}m ${Math.round(s % 60)}s`);

const EXTRA_CSS = `
.hero{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:1px;background:var(--line);
  border:1px solid var(--line);border-radius:var(--r);overflow:hidden;margin-bottom:6px}
.hero > div{background:var(--card);padding:18px}
.hero .big{font-size:30px}
.hero .k{font-size:12px;color:var(--mut);margin-top:6px}
.win{outline:1px solid var(--ok);outline-offset:-1px}
.bar{height:6px;background:#0a0a0b;border:1px solid var(--line);border-radius:99px;overflow:hidden;min-width:90px}
.bar i{display:block;height:100%;background:var(--agent)}
.bar.h i{background:var(--acc)}
.rt{font-size:11.5px;margin-top:4px;font-variant-numeric:tabular-nums;color:var(--mut)}
tr.human td{background:#101820}
.src{font-size:11.5px;color:var(--dim);margin-top:10px}
`;

export function optimizePage(s) {
  const h = s.human;
  const ratio =
    s.cheapest && h.cost_cents ? Math.round(h.cost_cents / s.cheapest.cost_cents) : null;

  const row = (r, isHuman = false) => `
    <tr class="${isHuman ? "human" : ""}">
      <td><strong>${isHuman ? "A person, via Terac" : r.name}</strong>${
        !isHuman && s.cheapest && r.id === s.cheapest.id
          ? ` <span class="tag ok">${s.provisional ? "cheapest at this accuracy" : "cheapest that clears"}</span>`
          : ""
      }${isHuman ? ' <span class="tag dim">attestation</span>' : ""}</td>
      <td class="num">${r.correct}/${r.total}</td>
      <td style="min-width:150px">
        <div class="bar ${isHuman ? "h" : ""}"><i style="width:${(r.rate ?? 0) * 100}%"></i></div>
        <div class="rt">${pct(r.rate)} · ${pct(r.lo)}–${pct(r.hi)}</div>
      </td>
      <td class="num">${r.cost_cents == null ? '<span class="dim">unpriced</span>' : money(r.cost_cents)}</td>
      <td class="num">${r.per_1000 == null ? "—" : "$" + r.per_1000.toFixed(2)}</td>
      <td class="num">${secs(r.median_s)}</td>
    </tr>`;

  const humanRow = {
    name: "human",
    correct: h.correct,
    total: h.total,
    rate: h.rate,
    lo: h.lo,
    hi: h.hi,
    cost_cents: h.cost_cents,
    per_1000: h.cost_cents == null ? null : (h.cost_cents * 1000) / 100,
    median_s: h.median_s,
  };

  const body = `
<h1>What a trusted read costs</h1>
<p class="sub">An agent reads every document either way, so this is not a contest between a person and a
machine. Two separate questions: <b>which is the cheapest agent that reads well enough</b>, and
<b>what does the human attestation on top of it cost</b>.</p>

<div class="hero">
  <div class="${s.cheapest ? "win" : ""}">
    <label>${s.provisional ? "Cheapest at the best accuracy seen" : `Cheapest agent clearing ${(s.floor * 100).toFixed(0)}%`}</label>
    <div class="big">${s.cheapest ? money(s.cheapest.cost_cents) : "—"}</div>
    <div class="k">${
      s.cheapest
        ? `${s.cheapest.name} · ${pct(s.cheapest.rate)} on ${s.cheapest.total} fields${
            s.provisional ? " · not yet licensed" : ""
          }`
        : "no agent measured yet"
    }</div>
  </div>
  <div>
    <label>One human attestation</label>
    <div class="big">${h.cost_cents == null ? "—" : "$" + (h.cost_cents / 100).toFixed(2)}</div>
    <div class="k">${h.n} reading${h.n === 1 ? "" : "s"} so far, median ${secs(h.median_s)}</div>
  </div>
  <div>
    <label>The human multiple</label>
    <div class="big">${ratio ? ratio.toLocaleString() + "×" : "—"}</div>
    <div class="k">what one attestation costs, in units of the cheapest sufficient agent</div>
  </div>
  <div>
    <label>Per 1,000 documents</label>
    <div class="big">${s.cheapest ? "$" + s.cheapest.per_1000.toFixed(2) : "—"}</div>
    <div class="k">${h.cost_cents ? "against $" + ((h.cost_cents * 1000) / 100).toLocaleString() + " to have people read them" : ""}</div>
  </div>
</div>

${
  s.provisional
    ? `<p class="sowhat" style="margin-bottom:22px"><b>No agent is licensed yet, and none can be on this
       much evidence.</b> Three documents is ${s.readers[0]?.total ?? 24} field readings, and a 95% lower
       bound cannot reach ${(s.floor * 100).toFixed(0)}% on fewer than ${s.n_min} clean ones however
       perfect the run. The costs below are measured and final; the accuracy column is provisional and
       the ranking above is <b>cheapest at the best observed accuracy</b>, not a licence.</p>`
    : ""
}

<h2>Every reader, on the same ${s.fields} fields of the same documents</h2>
<div class="card">
<table>
<thead><tr><th>Reader</th><th class="num">Correct</th><th>Accuracy · 95% interval</th>
<th class="num">Per document</th><th class="num">Per 1,000</th><th class="num">Median</th></tr></thead>
<tbody>
${s.readers.map((r) => row(r)).join("")}
${h.total ? row(humanRow, true) : ""}
</tbody></table>
<p class="sowhat">${
    s.cheapest && h.rate != null && s.cheapest.rate != null && h.rate <= s.cheapest.rate
      ? `<b>The person is not the accurate one here.</b> ${s.cheapest.name} reads at ${pct(s.cheapest.rate)}
         against ${pct(h.rate)} for a human, for ${money(s.cheapest.cost_cents)} instead of
         $${(h.cost_cents / 100).toFixed(2)} and ${secs(s.cheapest.median_s)} instead of ${secs(h.median_s)}.
         That is the finding, and it does not remove the human — an attestation is bought because a
         counterparty will not accept a machine's word, which is a trust cost, not a quality one.
         Price it as trust and it is honest; price it as accuracy and it is indefensible.`
      : `Ranked by the bottom of the interval, not the observed rate — a reader that scored perfectly
         on a handful of documents has earned <b>more measurement, not the title of good enough</b>.`
  }</p>
<p class="sowhat">Above the floor, extra spend buys nothing. ${
    s.readers.filter((r) => r.clears).length > 1 && s.cheapest
      ? `${s.readers.filter((r) => r.clears).length} agents clear ${(s.floor * 100).toFixed(0)}%, and the
         dearest of them costs ${Math.round(
           (s.readers.filter((r) => r.clears).sort((a, b) => b.cost_cents - a.cost_cents)[0].cost_cents /
             s.cheapest.cost_cents) * 10,
         ) / 10}× the cheapest for the same measured accuracy. <b>Model choice is a cost decision long
         before it is a quality one.</b>`
      : `Once two agents both clear it, the only thing separating them is price and latency.`
  }</p>
<p class="src">Token prices: ${s.price_source}, read ${s.prices_as_of}. Cost per document is measured
token usage at those list rates, not an estimate. A reader shows <span class="dim">unpriced</span>
rather than free when either its price or its usage is unknown.</p>
</div>

<h2>How much evidence would it take to trust one of them?</h2>
<div class="card">
  <p class="sub">A reader is licensed when the <em>bottom</em> of its 95% interval clears the floor, which
  is why perfect scores on a handful of documents still read as undecided.</p>
  <div class="row">
    <div><label>Floor (%)</label><input id="floor" type="number" value="${(s.floor * 100).toFixed(0)}" min="50" max="99.5" step="0.5"></div>
    <div><label>Human cost ($/reading)</label><input id="cpi" type="number" value="${h.cost_cents ? (h.cost_cents / 100).toFixed(2) : "12.00"}" step="0.25"></div>
    <button class="ghost" onclick="target()">What would it take?</button>
  </div>
  <div id="tgt"></div>
</div>`;

  const script = `
async function target(){
  const r=await fetch("/api/optimize/target",{method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({floor:+floor.value/100,cpiCents:Math.round(+cpi.value*100)})});
  const d=await r.json();
  document.getElementById("tgt").innerHTML=\`
  <div class="grid" style="margin-top:14px">
    <div><label>Clean readings needed</label><div class="big">\${d.n_min}</div></div>
    <div><label>If one is wrong</label><div class="big">\${d.need_with_one_miss ?? "—"}</div></div>
    <div><label>Cost in human readings</label><div class="big">$\${(d.human_cost_cents/100).toFixed(2)}</div></div>
    <div><label>Cost in agent reads</label><div class="big">\${d.agent_cost_label}</div></div>
  </div>
  <p class="sowhat">To license anything at \${(d.floor*100).toFixed(1)}% you need <b>\${d.n_min} readings with
  nothing wrong in them</b>. Buying that evidence from people costs $\${(d.human_cost_cents/100).toFixed(2)};
  buying it from the cheapest sufficient agent costs \${d.agent_cost_label}. <b>Ruling a reader out is cheap
  and licensing one is expensive</b> — a single clear failure settles the first, while the second needs an
  unbroken run, and one wrong answer among them pushes the requirement to \${d.need_with_one_miss ?? "—"}.</p>\`;
}
target();
`;

  return page({ title: "Reader economics", current: "/optimize", body, extraCss: EXTRA_CSS, script });
}

export function registerOptimizeRoutes(app) {
  const json = express.json();

  app.post("/api/optimize/target", json, async (req, res) => {
    const floor = Math.min(0.999, Math.max(0.5, Number(req.body?.floor) || FLOOR));
    const cpi = Math.max(1, Number(req.body?.cpiCents) || 1200);
    const need = nMin(floor);
    let withOneMiss = null;
    for (let n = need; n < 5000; n++) {
      if (wilson(n - 1, n)[0] >= floor) { withOneMiss = n; break; }
    }
    const s = await optimizeState(floor).catch(() => null);
    const agent = s?.cheapest?.cost_cents ?? null;
    res.json({
      floor,
      n_min: need,
      need_with_one_miss: withOneMiss,
      human_cost_cents: need * cpi,
      agent_cost_label: agent == null ? "—" : money(need * agent),
    });
  });

  app.get("/api/optimize", async (_req, res) => {
    try {
      res.json(await optimizeState());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/optimize", async (_req, res) => {
    try {
      res.type("html").send(optimizePage(await optimizeState()));
    } catch (err) {
      res.status(500).send(`<pre>${String(err.message).replace(/[<>&]/g, "")}</pre>`);
    }
  });
}
