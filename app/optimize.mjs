import express from "express";
import { query } from "./db.mjs";
import { FIELDS } from "./certs.mjs";
import { wilson, nMin } from "./readiness.mjs";
import { page } from "./ui.mjs";
import { readCostCents, money, priceFor, PRICES_AS_OF, PRICE_SOURCE } from "./economics.mjs";

/**
 * What it costs to read one document.
 *
 * Software reads every document either way, so "person versus model" is not the decision. The
 * decisions are: which software reads well enough for the least money, and what does the
 * person's signature on top of it cost. This page answers those two and nothing else.
 *
 * The person is not here to beat the models. On this evidence they do not, and saying so
 * plainly is the point — a signature is bought for trust, not for accuracy, and pretending
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
      // Cost divided by accuracy: what one CORRECT reading costs. A reader at half accuracy
      // is not half as useful, it is twice as expensive per usable answer, and a raw price
      // ranking hides that entirely.
      cost_per_good: perDoc == null || !m.total || m.correct === 0 ? null : perDoc / (m.correct / m.total),
      per_1000: perDoc == null ? null : (perDoc * 1000) / 100,
      per_1000_good:
        perDoc == null || !m.total || m.correct === 0
          ? null
          : ((perDoc / (m.correct / m.total)) * 1000) / 100,
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
  const bestValue =
    priced.filter((r) => r.cost_per_good != null).sort((a, b) => a.cost_per_good - b.cost_per_good)[0] ?? null;

  const h = humanRes.rows[0] ?? { n: 0, correct: 0, total: 0, med_ms: null };
  const [hlo, hhi] = wilson(Number(h.correct ?? 0), Number(h.total ?? 0));
  const cpi = cpiRes.rows[0]?.cpi_cents ?? null;

  return {
    floor,
    n_min: nMin(floor),
    fields: FIELDS.length,
    readers: readers.sort((a, b) => (a.cost_cents ?? Infinity) - (b.cost_cents ?? Infinity)),
    cheapest,
    bestValue,
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
      }${isHuman ? ' <span class="tag dim">signature</span>' : ""}</td>
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
<h1>What it costs to read one document</h1>
<p class="sub">Software reads every document either way, so this is not people against machines. Two
questions: <b>which software reads well enough for the least money</b>, and <b>what does a person's
signature on top of it cost</b>.</p>

<div class="hero">
  <div class="${s.cheapest ? "win" : ""}">
    <label>${s.provisional ? "Cheapest at the best score so far" : `Cheapest software clearing ${(s.floor * 100).toFixed(0)}%`}</label>
    <div class="big">${s.cheapest ? money(s.cheapest.cost_cents) : "—"}</div>
    <div class="k">${
      s.cheapest
        ? `${s.cheapest.name} · ${pct(s.cheapest.rate)} of ${s.cheapest.total} answers right${
            s.provisional ? " · not enough evidence yet" : ""
          }`
        : "nothing measured yet"
    }</div>
  </div>
  <div>
    <label>One human signature</label>
    <div class="big">${h.cost_cents == null ? "—" : "$" + (h.cost_cents / 100).toFixed(2)}</div>
    <div class="k">${h.n} reading${h.n === 1 ? "" : "s"} so far, median ${secs(h.median_s)}</div>
  </div>
  <div>
    <label>The person costs this much more</label>
    <div class="big">${ratio ? ratio.toLocaleString() + "×" : "—"}</div>
    <div class="k">one signature, priced in reads by the cheapest software good enough</div>
  </div>
  <div>
    <label>Per 1,000 documents</label>
    <div class="big">${s.cheapest ? "$" + s.cheapest.per_1000.toFixed(2) : "—"}</div>
    <div class="k">${h.cost_cents ? "against $" + ((h.cost_cents * 1000) / 100).toLocaleString() + " if people read them" : ""}</div>
  </div>
</div>

${
  s.provisional
    ? `<p class="sowhat" style="margin-bottom:22px"><b>Nothing is safe to automate yet, and nothing can
       be on three documents.</b> That is ${s.readers[0]?.total ?? 24} answers, and being 95% sure of
       ${(s.floor * 100).toFixed(0)}% takes ${s.n_min} clean ones however perfect the run. The costs are
       measured and final; the accuracy is not settled, so the ranking above is <b>cheapest at the best
       score so far</b>.</p>`
    : ""
}

<h2>The software, ranked by what a correct reading costs</h2>
<div class="card">
<table>
<thead><tr><th>Model</th><th class="num">Correct</th><th>Accuracy</th>
<th class="num">Per document</th><th class="num">Per correct reading</th><th class="num">Per 1,000 documents</th></tr></thead>
<tbody>
${s.readers
  .filter((r) => r.cost_cents != null)
  .slice()
  .sort((a, b) => (a.cost_per_good ?? Infinity) - (b.cost_per_good ?? Infinity))
  .map(
    (r) => `<tr>
    <td><strong>${r.name}</strong>${
      s.bestValue && r.id === s.bestValue.id ? ' <span class="tag ok">best value</span>' : ""
    }</td>
    <td class="num">${r.correct}/${r.total}</td>
    <td style="min-width:140px"><div class="bar"><i style="width:${(r.rate ?? 0) * 100}%"></i></div>
      <div class="rt">${pct(r.rate)}</div></td>
    <td class="num">${money(r.cost_cents)}</td>
    <td class="num"><strong>${r.cost_per_good == null ? "never" : money(r.cost_per_good)}</strong></td>
    <td class="num">${r.per_1000_good == null ? "—" : "$" + r.per_1000_good.toFixed(2)}</td>
  </tr>`,
  )
  .join("")}
</tbody></table>
<p class="sowhat"><b>Rank on what a correct reading costs.</b> A model that is right half the time is
not half as useful, it is twice as dear per answer you can use. It is the price of a document divided
by how often the model gets it right — get none right and there is no price at all.</p>
<p class="sowhat"><b>One catch, and it matters.</b> Dividing by accuracy assumes you can tell which
readings were wrong and buy those again. You cannot: a wrong answer comes back looking exactly like a
right one. So a cheap reader at ${(() => {
    const g = s.readers.filter((r) => r.cost_per_good != null && r.rate < 1).sort((a,b)=>a.cost_per_good-b.cost_per_good)[0];
    return g ? pct(g.rate) : "under 100%";
  })()} is only good value <em>if something catches its mistakes</em>. That is what the
person is for.</p>
<p class="src">Prices: ${s.price_source}, read ${s.prices_as_of}. Cost is the tokens actually used at
those list rates. Models we have no price for are left out rather than shown as free.</p>
</div>

<h2>What the people cost</h2>
<div class="card">
  <div class="grid">
    <div><label>Per signature</label><div class="big">${h.cost_cents == null ? "—" : "$" + (h.cost_cents / 100).toFixed(2)}</div></div>
    <div><label>Accuracy</label><div class="big">${pct(h.rate)}</div><div class="k">${h.correct}/${h.total} answers</div></div>
    <div><label>Per correct reading</label><div class="big">${
      h.rate ? "$" + (h.cost_cents / 100 / h.rate).toFixed(2) : "—"
    }</div></div>
    <div><label>Per 1,000 documents</label><div class="big">${
      h.rate && h.cost_cents ? "$" + Math.round((h.cost_cents / 100 / h.rate) * 1000).toLocaleString() : "—"
    }</div></div>
  </div>
  <p class="sowhat"><b>Separate on purpose.</b> The software reads every document either way; the
  person is there because the other side of the deal will not take software's word for it. You are
  buying a reading from one and a signature from the other, so neither can be dropped for being
  dearer.</p>
</div>

<h2>What would this cost at your volume?</h2>
<div class="card">
  <div class="row">
    <div><label>Documents per deal</label><input id="perdeal" type="number" value="12" min="1"></div>
    <div><label>Deals a month</label><input id="deals" type="number" value="20" min="1"></div>
    <div><label>Share needing a signature (%)</label><input id="attest" type="number" value="10" min="0" max="100"></div>
    <button class="ghost" onclick="vol()">Work it out</button>
  </div>
  <div id="volout"></div>
</div>

<h2>How much evidence before we can trust the software?</h2>
<div class="card">
  <p class="sub">Software is safe to automate when the <em>bottom</em> of its 95% confidence range clears
  the floor (the Wilson 95% lower bound). That is why a perfect score on a handful of documents still
  counts as undecided.</p>
  <div class="row">
    <div><label>Floor (%)</label><input id="floor" type="number" value="${(s.floor * 100).toFixed(0)}" min="50" max="99.5" step="0.5"></div>
    <div><label>What a person costs ($/reading)</label><input id="cpi" type="number" value="${h.cost_cents ? (h.cost_cents / 100).toFixed(2) : "12.00"}" step="0.25"></div>
    <button class="ghost" onclick="target()">What would it take?</button>
  </div>
  <div id="tgt"></div>
</div>`;

  const script = `
const BEST = ${JSON.stringify(
    s.bestValue ? { name: s.bestValue.name, perGood: s.bestValue.cost_per_good } : null,
  )};
const HUMAN = ${JSON.stringify(h.cost_cents && h.rate ? { perGood: h.cost_cents / h.rate } : null)};
function vol(){
  const docs = (+perdeal.value||0) * (+deals.value||0);
  const share = Math.min(100, Math.max(0, +attest.value||0)) / 100;
  const el = document.getElementById("volout");
  if(!BEST || !docs){ el.innerHTML = '<p class="sowhat">Enter a volume to price it.</p>'; return; }
  const read = docs * BEST.perGood / 100;
  const sign = HUMAN ? docs * share * HUMAN.perGood / 100 : null;
  const usd = v => "$" + v.toLocaleString(undefined,{maximumFractionDigits:2});
  el.innerHTML = \`
  <div class="grid" style="margin-top:14px">
    <div><label>Documents a month</label><div class="big">\${docs.toLocaleString()}</div></div>
    <div><label>Software reads them all</label><div class="big">\${usd(read)}</div>
      <div class="k">\${BEST.name}, per correct reading</div></div>
    <div><label>Signatures on \${Math.round(share*100)}%</label><div class="big">\${sign==null?"—":usd(sign)}</div>
      <div class="k">\${Math.round(docs*share).toLocaleString()} signatures</div></div>
    <div><label>Total a month</label><div class="big">\${sign==null?usd(read):usd(read+sign)}</div>
      <div class="k">\${sign==null?"":Math.round((sign/(read+sign))*100)+"% of it is the signatures"}</div></div>
  </div>
  <p class="sowhat">\${sign==null?"":"<b>The reading is not the cost — the signatures are.</b> Software reads all "+docs.toLocaleString()+" documents for "+usd(read)+", and signing off on "+Math.round(share*100)+"% of them costs "+usd(sign)+". Changing that percentage matters far more than changing model."}</p>\`;
}
vol();
async function target(){
  const r=await fetch("/api/optimize/target",{method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({floor:+floor.value/100,cpiCents:Math.round(+cpi.value*100)})});
  const d=await r.json();
  document.getElementById("tgt").innerHTML=\`
  <div class="grid" style="margin-top:14px">
    <div><label>Clean readings needed</label><div class="big">\${d.n_min}</div></div>
    <div><label>If one is wrong</label><div class="big">\${d.need_with_one_miss ?? "—"}</div></div>
    <div><label>Cost if people read them</label><div class="big">$\${(d.human_cost_cents/100).toFixed(2)}</div></div>
    <div><label>Cost if software reads them</label><div class="big">\${d.agent_cost_label}</div></div>
  </div>
  <p class="sowhat">To call anything safe to automate at \${(d.floor*100).toFixed(1)}% you need <b>\${d.n_min}
  readings with nothing wrong in them</b>. That evidence costs $\${(d.human_cost_cents/100).toFixed(2)} from
  people, or \${d.agent_cost_label} from the cheapest software good enough. <b>Ruling a reader out is cheap;
  clearing one is expensive</b> — one clear failure settles the first, the second needs an unbroken run, and
  a single wrong answer pushes it to \${d.need_with_one_miss ?? "—"}.</p>\`;
}
target();
`;

  return page({ title: "What a read costs", current: "/", body, extraCss: EXTRA_CSS, script });
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

  // The root is the strongest page: what a read costs. /optimize stays as an alias so any
  // link already handed out keeps working.
  for (const path of ["/", "/optimize"])
  app.get(path, async (_req, res) => {
    try {
      res.type("html").send(optimizePage(await optimizeState()));
    } catch (err) {
      res.status(500).send(`<pre>${String(err.message).replace(/[<>&]/g, "")}</pre>`);
    }
  });
}
