import { query } from "./db.mjs";
import { CERTS, FIELDS } from "./certs.mjs";
import { wilson } from "./readiness.mjs";
import { page } from "./ui.mjs";
import { readCostCents, money as cmoney } from "./economics.mjs";

const FLOOR = 0.9;

/**
 * Fallback only. Terac's own record is authoritative and is read per-wave below:
 * `cost_per_participant_cents` was 169 on the first wave, while `total_cost_cents` was
 * 1352 for eight people. Reading the wave total as a per-person price overstates every
 * human cost figure by the participant count, which is exactly the mistake this replaces.
 */
const FALLBACK_CPI_CENTS = 169;

async function humanCpiCents() {
  // Prefer the price Terac quotes per participant. Dividing a total by a head count
  // reproduces whatever error is in the total, and a launched wave's total is the only
  // one worth trusting anyway.
  const { rows } = await query(
    `select cpi_cents from terac_opportunities
      where cpi_cents > 0 and launched_at is not null
      order by launched_at desc limit 1`,
  ).catch(() => ({ rows: [] }));
  return rows[0]?.cpi_cents ?? FALLBACK_CPI_CENTS;
}

/**
 * The outcome surface: one table of who read the same documents and what they got right.
 *
 * Humans and models are scored by the identical function against the identical ground truth,
 * so the only thing that differs between the rows is who did the reading.
 */
export async function resultsState() {
  const cpiCents = await humanCpiCents();
  // Measured token spend per model, so the chart can plot what each reader actually cost
  // rather than ranking them on accuracy as though price were not a variable.
  const { rows: usageRows } = await query(
    `select model_id, usage, duration_ms from experiment_runs
      where source = 'model' and usage is not null`,
  ).catch(() => ({ rows: [] }));
  const costBy = new Map();
  for (const r of usageRows) {
    const c = readCostCents(r.model_id, r.usage);
    if (c == null) continue;
    const e = costBy.get(r.model_id) ?? { cents: 0, n: 0 };
    e.cents += c;
    e.n++;
    costBy.set(r.model_id, e);
  }
  const { rows } = await query(
    // `who` must distinguish a paid panellist from a walk-up. Both carry a null model_id, so
    // coalescing on that alone filed every walk-up — including QA readings written to exercise
    // the scorer — into the paid-human bucket, and their perfect scores pushed the human
    // Wilson bound over the 0.90 floor. The page reported LICENSED off test data.
    `select source, case when source = 'model' then model_id else source end as who,
            cert_id, detail, correct, total, duration_ms
       from extractions order by received_at`,
  );

  const byWho = new Map();
  const fieldTotals = {};
  for (const f of FIELDS) fieldTotals[f.key] = {};

  for (const r of rows) {
    const w = byWho.get(r.who) ?? {
      who: r.who,
      source: r.source,
      runs: 0,
      correct: 0,
      total: 0,
      ms: [],
      certs: new Set(),
      fields: {},
      traps: [],
    };
    w.runs++;
    w.correct += Number(r.correct ?? 0);
    w.total += Number(r.total ?? 0);
    if (r.duration_ms) w.ms.push(Number(r.duration_ms));
    w.certs.add(r.cert_id);
    for (const f of FIELDS) {
      const d = r.detail?.[f.key];
      if (!d) continue;
      (w.fields[f.key] ??= { n: 0, ok: 0 }).n++;
      if (d.correct) w.fields[f.key].ok++;
      (fieldTotals[f.key][r.who] ??= { n: 0, ok: 0 }).n++;
      if (d.correct) fieldTotals[f.key][r.who].ok++;
      if (d.distractor) w.traps.push({ field: f.key, why: d.distractor, gave: d.given });
    }
    byWho.set(r.who, w);
  }

  const entrants = [...byWho.values()]
    .map((w) => {
      const rate = w.total ? w.correct / w.total : null;
      const [lo, hi] = wilson(w.correct, w.total);
      const medMs = w.ms.length ? w.ms.sort((a, b) => a - b)[Math.floor(w.ms.length / 2)] : null;
      // A human costs one CPI per certificate read; a model costs its API call, which at
      // these sizes rounds to nothing next to $13.50.
      // A model's cost is measured tokens at list price; a human's is the wave CPI per
      // certificate read. Unknown stays null, because rendering unknown as free is the error
      // that made a model look infinitely cheaper than a person.
      const perRead =
        w.source === "human"
          ? cpiCents
          : costBy.has(w.who)
            ? costBy.get(w.who).cents / costBy.get(w.who).n
            : null;
      const costCents = perRead == null ? null : perRead * w.runs;
      return {
        ...w,
        certs: [...w.certs],
        rate,
        lo,
        hi,
        med_seconds: medMs ? Math.round(medMs / 1000) : null,
        cost_cents: costCents,
        cost_per_read: perRead,
        cost_per_correct: w.correct && costCents != null ? costCents / w.correct : null,
        verdict: w.total === 0 ? "UNMEASURED" : hi < FLOOR ? "RULED OUT" : lo >= FLOOR ? "LICENSED" : "NOT YET",
      };
    })
    .sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1) || b.total - a.total);

  return {
    floor: FLOOR,
    cpi_cents: cpiCents,
    entrants,
    fields: FIELDS.map((f) => ({ ...f, byWho: fieldTotals[f.key] })),
    humans: entrants.filter((e) => e.source === "human"),
    models: entrants.filter((e) => e.source === "model"),
    certs: CERTS.map((c) => ({ id: c.id, entity: c.entity, ratio: c.truth.ratio_name })),
  };
}

const pct = (x) => (x == null ? "—" : (x * 100).toFixed(0) + "%");
const short = (w) => w.replace(/^novita\//, "").replace(/^meta-llama\//, "").replace(/^qwen\//, "").replace(/^google\//, "");

/** Green through amber to red, so a row of cells reads as a shape before it reads as numbers. */
function heat(rate) {
  if (rate == null) return "background:transparent;color:var(--mut)";
  const h = Math.round(rate * 130);
  return `background:hsl(${h} 62% 42% / ${0.18 + rate * 0.5});color:var(--fg)`;
}

/** Page-specific only: the accuracy rail, the heat cells and the trap list. */
const EXTRA_CSS = `
.badge{display:inline-block;font-size:9.5px;letter-spacing:.07em;font-weight:600;padding:2px 7px;
  border-radius:99px;border:1px solid currentColor;vertical-align:1px}
.badge.hum{color:var(--acc)}.badge.mod{color:var(--agent)}.badge.wlk{color:var(--dim)}
.rail{height:6px;background:#0a0a0b;border:1px solid var(--line);border-radius:99px;overflow:hidden}
.fill{height:100%;border-radius:99px}
.fill.hum{background:var(--acc)}.fill.mod{background:var(--agent)}.fill.wlk{background:var(--dim)}
.rt{font-size:11.5px;margin-top:4px;font-variant-numeric:tabular-nums}
.heat{overflow-x:auto}
.cell{text-align:center;font-variant-numeric:tabular-nums;font-size:12px;padding:8px 6px;
  border:1px solid var(--line-soft)}
.fname{font-size:13px;white-space:nowrap;padding-right:14px}
.hd{font-size:10px;color:var(--dim);writing-mode:vertical-rl;transform:rotate(180deg);
  padding:6px 2px;white-space:nowrap}
.trap{border-left:2px solid var(--bad);padding:7px 0 7px 12px;margin-bottom:10px;font-size:13.5px}
.trap:last-of-type{margin-bottom:0}
.empty{color:var(--dim);padding:26px;text-align:center}
`;

const VERDICT_TONE = { LICENSED: "ok", "RULED OUT": "bad", "NOT YET": "warn", UNMEASURED: "dim" };


/**
 * Cost against accuracy, cost on a log scale because the readers span five orders of
 * magnitude — 0.012c to $12.00. A linear axis would stack every model on the left edge and
 * hide the only shape that matters: accuracy stops improving long before cost stops rising.
 */
function curve(s) {
  const pts = s.entrants.filter((e) => e.cost_per_read != null && e.total > 0);
  if (pts.length < 2) return "";
  const W = 780, H = 340, L = 54, R = 18, T = 18, B = 46;
  const lo = Math.min(...pts.map((p) => p.cost_per_read)) / 2;
  const hi = Math.max(...pts.map((p) => p.cost_per_read)) * 2;
  const lx = (c) => L + ((Math.log10(c) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo))) * (W - L - R);
  const ly = (r) => T + (1 - r) * (H - T - B);

  const ticks = [];
  for (let e = Math.floor(Math.log10(lo)); e <= Math.ceil(Math.log10(hi)); e++) {
    const v = 10 ** e;
    if (v < lo || v > hi) continue;
    ticks.push(`<line x1="${lx(v)}" y1="${T}" x2="${lx(v)}" y2="${H - B}" class="gr"/>
      <text x="${lx(v)}" y="${H - B + 16}" text-anchor="middle" class="ax">${cmoney(v)}</text>`);
  }
  const rows = [0.5, 0.75, 0.9, 1].map(
    (r) => `<line x1="${L}" y1="${ly(r)}" x2="${W - R}" y2="${ly(r)}" class="${r === 0.9 ? "fl" : "gr"}"/>
      <text x="${L - 8}" y="${ly(r) + 4}" text-anchor="end" class="ax">${(r * 100).toFixed(0)}%</text>`,
  );

  const dots = pts
    .map((p) => {
      const isH = p.source === "human";
      const cls = isH ? "ph" : p.source === "walkup" ? "pw" : "pm";
      const label = isH ? "a person" : short(p.who).replace(/-instruct.*$/, "").slice(0, 22);
      const x = lx(p.cost_per_read), y = ly(p.rate);
      const flip = x > W - 190;
      return `<circle cx="${x}" cy="${y}" r="${isH ? 9 : 6}" class="${cls}"/>
        <text x="${flip ? x - 12 : x + 12}" y="${y + 4}" text-anchor="${flip ? "end" : "start"}"
              class="pl ${isH ? "plh" : ""}">${label}</text>`;
    })
    .join("");

  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img"
    aria-label="Cost per document against accuracy for every reader">
  <style>
    .gr{stroke:var(--line);stroke-width:1}
    .fl{stroke:var(--ok);stroke-width:1;stroke-dasharray:4 4;opacity:.7}
    .ax{fill:var(--dim);font:10.5px ui-sans-serif,system-ui}
    .pm{fill:var(--agent);fill-opacity:.9}
    .ph{fill:var(--acc)}
    .pw{fill:var(--dim);fill-opacity:.6}
    .pl{fill:var(--mut);font:11px ui-sans-serif,system-ui}
    .plh{fill:var(--acc);font-weight:600}
    .cap{fill:var(--dim);font:10.5px ui-sans-serif,system-ui}
  </style>
  ${rows.join("")}${ticks.join("")}
  <text x="${L}" y="${H - 6}" class="cap">cost of one reading, log scale →</text>
  <text x="${W - R}" y="${ly(0.9) - 7}" text-anchor="end" class="cap">the 90% bar</text>
  ${dots}
  </svg>`;
}

export function resultsPage(s) {
  const topHuman = s.humans[0];
  const topModel = s.models[0];

  const lede =
    !s.entrants.length
      ? "Nobody has read a certificate yet."
      : topHuman && topModel
        ? `${short(topHuman.who)} read at ${pct(topHuman.rate)}. The best model, ${short(topModel.who)}, read at ${pct(topModel.rate)}.`
        : topHuman
          ? `${s.humans.length} human run${s.humans.length === 1 ? "" : "s"} at ${pct(topHuman.rate)}. No model has run yet.`
          : `${s.models.length} model runs. No human has read these documents yet.`;

  const rows = s.entrants
    .map((e) => {
      const bar = e.rate == null ? 0 : e.rate * 100;
      // Three populations, not two. A walk-up is a real reading but was never recruited or
      // paid, so it must never be mistaken for panel evidence — or for a model.
      const tone = e.source === "human" ? "hum" : e.source === "model" ? "mod" : "wlk";
      const badge = e.source === "human" ? "PAID PANEL" : e.source === "model" ? "MODEL" : "WALK-UP";
      const name = e.source === "walkup" ? "unpaid readers (incl. QA)" : short(e.who);
      return `<tr>
      <td><span class="badge ${tone}">${badge}</span> <strong>${name}</strong></td>
      <td class="num">${e.runs}</td>
      <td class="num">${e.correct}/${e.total}</td>
      <td style="min-width:170px">
        <div class="rail"><div class="fill ${tone}" style="width:${bar}%"></div></div>
        <div class="rt">${pct(e.rate)} <span class="mut">· ${pct(e.lo)}–${pct(e.hi)}</span></div>
      </td>
      <td class="num">${e.med_seconds ? e.med_seconds + "s" : "—"}</td>
      <td class="num">${e.cost_cents ? "$" + (e.cost_cents / 100).toFixed(2) : "≈$0"}</td>
      <td class="num">${e.traps.length ? `<span class="bad">${e.traps.length}</span>` : "—"}</td>
      <td><span class="tag ${VERDICT_TONE[e.verdict]}">${e.verdict}</span></td>
    </tr>`;
    })
    .join("");

  const whos = s.entrants.map((e) => e.who);
  const grid = s.fields
    .map((f) => {
      const cells = whos
        .map((w) => {
          const v = f.byWho[w];
          const rate = v && v.n ? v.ok / v.n : null;
          return `<td class="cell" style="${heat(rate)}" title="${short(w)} — ${f.label}: ${v ? `${v.ok}/${v.n}` : "no runs"}">${
            v ? `${v.ok}/${v.n}` : "·"
          }</td>`;
        })
        .join("");
      return `<tr><td class="fname">${f.label}</td>${cells}</tr>`;
    })
    .join("");

  const traps = s.entrants
    .flatMap((e) => e.traps.map((t) => ({ ...t, who: e.who, source: e.source })))
    .slice(0, 12);

  const licensed = s.entrants.filter((e) => e.verdict === "LICENSED").length;
  const ruledOut = s.entrants.filter((e) => e.verdict === "RULED OUT").length;
  const undecided = s.entrants.length - licensed - ruledOut;
  const cpi = "$" + (s.cpi_cents / 100).toFixed(2);

  const body = `
<h1>Same documents. Nearly the same instruction.</h1>
<p class="lede">${lede}</p>
<p class="sub">Every reader below saw the identical rendered pages — each run records the content hash of
the images it was shown, so "same documents" is checkable on the <a href="/log">run log</a> rather than
asserted — and answered the identical eight questions, scored by one function against ground truth the
documents themselves print. One difference is real and worth saying out loud: a model is additionally
given a JSON reply format that no human is ever shown. Nothing was extracted in advance for anyone.</p>

<h2>Where the evidence stands</h2>
<div class="grid">
  <div><label>Licensed</label><div class="big ok">${licensed}</div></div>
  <div><label>Ruled out</label><div class="big bad">${ruledOut}</div></div>
  <div><label>Still undecided</label><div class="big warn">${undecided}</div></div>
  <div><label>Human reading</label><div class="big">${cpi} <small>per certificate</small></div></div>
</div>
<p class="sowhat"><b>Only the licensed count is spendable.</b> A reader is licensed when the bottom of its
95% interval clears the ${pct(s.floor)} floor, which is the bar for letting it read a field unattended;
ruled out is settled just as firmly and costs far less to reach. Every reader still undecided is an
unpaid bill — roughly 35 clean readings apiece before an interval is tight enough to decide — and at
${cpi} a reading, that bill is the number to budget against.</p>

<h2>What each reading costs, and what it buys</h2>
<div class="card">${curve(s)}
<p class="sowhat">${(() => {
  const m = s.entrants.filter((e) => e.source === "model" && e.cost_per_read != null && e.total);
  const perfect = m.filter((e) => e.rate === 1).sort((a, b) => a.cost_per_read - b.cost_per_read)[0];
  const dear = m.slice().sort((a, b) => b.cost_per_read - a.cost_per_read)[0];
  const cheap = m.slice().sort((a, b) => a.cost_per_read - b.cost_per_read)[0];
  if (!perfect || !dear || !cheap) return "Not enough priced readers to plot a curve yet.";
  return `<b>Accuracy stops improving long before cost stops rising.</b> ${short(perfect.who)} reads
  everything correctly at ${cmoney(perfect.cost_per_read)} a document, while ${short(dear.who)} costs
  ${Math.round(dear.cost_per_read / perfect.cost_per_read)}× that and reads at ${pct(dear.rate)}. At the
  other end ${short(cheap.who)} is the cheapest reader here and scores ${pct(cheap.rate)} — cheap is only
  cheap if it can do the job. <b>Everything to the right of the knee is money spent on nothing.</b>`;
})()}</p>
<p class="sowhat">A person sits far off the right of this chart at
${cmoney(s.cpi_cents)} a reading. <b>They are not there to be more accurate</b> — on this evidence they
are not — they are there because a counterparty will not take software's word for it. That is the price
of the signature, not the price of the reading.</p>
</div>

<h2>Every reader, scored the same way</h2>
<div class="card">${
    s.entrants.length
      ? `<div class="heat"><table><tr><th>Reader</th><th class="num">Docs</th><th class="num">Fields</th><th>Accuracy · 95% interval</th><th class="num">Median</th><th class="num">Cost</th><th class="num">Traps</th><th>Verdict</th></tr>${rows}</table></div>
    <p class="sowhat"><b>The interval decides, not the rate.</b> A reader sitting above ${pct(s.floor)} on
    a handful of documents has proved nothing yet; the verdict only moves when the whole interval clears
    the floor or falls below it. Cost is what those answers took to obtain — ${cpi} per certificate for a
    recruited human against effectively nothing for an API call — so the asymmetry to trade on is that
    ruling a reader out is cheap and licensing one is the expensive half.</p>`
      : `<div class="empty">No runs yet.</div>`
  }</div>

<h2>Field by field</h2>
<div class="card">${
    s.entrants.length
      ? `<div class="heat"><table>
    <tr><th></th>${whos.map((w) => `<th class="hd">${short(w)}</th>`).join("")}</tr>${grid}</table></div>
    <p class="sowhat"><b>A pale row is a field you keep a human on; a pale column is only a reader you
    drop.</b> The field is the unit of the decision, so a row that stays pale straight across is work no
    model on the list can take, no matter which one you buy — while a single pale column is a purchasing
    mistake and nothing more. Cells show correct over attempted, and anything short of 35 readings is a
    hint about where to spend next, not a licence.</p>`
      : `<div class="empty">Nothing to compare yet.</div>`
  }</div>

<h2>Traps taken</h2>
<div class="card">${
    traps.length
      ? traps
          .map(
            (t) =>
              `<div class="trap"><strong>${short(t.who)}</strong> answered <code>${t.gave}</code> for <strong>${
                FIELDS.find((f) => f.key === t.field)?.label ?? t.field
              }</strong><br><span class="mut">${t.why}</span></div>`,
          )
          .join("")
      : `<div class="empty">No reader has taken a distractor yet.</div>`
  }
  <p class="sowhat"><b>Every line here is a wrong answer that a citation check would pass.</b> The
  distractor is the prior period's figure, printed on the same page as the right one, so asking the
  reader to quote its source — or asking a second model to verify it — cannot separate them. Where these
  cluster is where review has to stay human even if the accuracy column looks fine.</p>
</div>`;

  return page({
    title: "Evaluations — every reader on the same documents",
    current: "/results",
    body,
    extraCss: EXTRA_CSS,
    script: "setInterval(()=>location.reload(),25000)",
  });
}

export function registerResultsRoutes(app) {
  app.get("/api/results", async (_req, res) => {
    try {
      res.json(await resultsState());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
  app.get("/results", async (_req, res) => {
    try {
      res.type("html").send(resultsPage(await resultsState()));
    } catch (err) {
      res.status(500).send(`<pre>${err.message}</pre>`);
    }
  });
}
