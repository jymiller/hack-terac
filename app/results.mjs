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
const short = (w) => w.replace(/^novita\//, "").replace(/^meta-llama\//, "").replace(/^qwen\//, "").replace(/^google\//, "").replace(/^human$/, "people").replace(/^walkup$/, "unpaid readers");

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

/** The internal labels are the statistics talking. A reader needs the decision. */
const VERDICT_SAYS = {
  LICENSED: "Safe to automate",
  "RULED OUT": "Keep a person on it",
  "NOT YET": "Not enough evidence yet",
  UNMEASURED: "Nobody has read it",
};


export function resultsPage(s) {
  const topHuman = s.humans[0];
  const topModel = s.models[0];

  const lede =
    !s.entrants.length
      ? "Nobody has read a certificate yet."
      : topHuman && topModel
        ? `People read at ${pct(topHuman.rate)}. The best software, ${short(topModel.who)}, read at ${pct(topModel.rate)}.`
        : topHuman
          ? `${s.humans.length} paid run${s.humans.length === 1 ? "" : "s"} at ${pct(topHuman.rate)}. No software has run yet.`
          : `${s.models.length} software runs. No human has read these documents yet.`;

  const rows = s.entrants
    .map((e) => {
      const bar = e.rate == null ? 0 : e.rate * 100;
      // Three populations, not two. A walk-up is a real reading but was never recruited or
      // paid, so it must never be mistaken for panel evidence — or for a model.
      const tone = e.source === "human" ? "hum" : e.source === "model" ? "mod" : "wlk";
      const badge = e.source === "human" ? "PAID" : e.source === "model" ? "SOFTWARE" : "UNPAID";
      const name =
        e.source === "human" ? "people" : e.source === "walkup" ? "readers, including our own tests" : short(e.who);
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
      <td><span class="tag ${VERDICT_TONE[e.verdict]}">${VERDICT_SAYS[e.verdict]}</span></td>
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
<h1>Same documents. Almost the same instructions.</h1>
<p class="lede">${lede}</p>
<p class="sub">Everyone below saw the same pages and answered the same eight questions, marked the same
way against what the documents print. The <a href="/log">run log</a> records the images each reader was
shown, so "same documents" can be checked rather than taken on trust. One difference: the software is
also told what shape to write its answer in, which no person is ever shown.</p>

<h2>Where things stand</h2>
<div class="grid">
  <div><label>Safe to automate</label><div class="big ok">${licensed}</div></div>
  <div><label>Ruled out</label><div class="big bad">${ruledOut}</div></div>
  <div><label>Still undecided</label><div class="big warn">${undecided}</div></div>
  <div><label>What a person costs</label><div class="big">${cpi} <small>per certificate</small></div></div>
</div>
<p class="sowhat"><b>Only the first number saves money.</b> A reader is safe to automate when the bottom
of its 95% range — the Wilson 95% lower bound — clears ${pct(s.floor)}. Ruling one out is just as firm
and far cheaper to reach. Everyone still undecided needs about 35 clean readings before we can decide,
at ${cpi} each; that is the bill to budget for.</p>

<h2>Every reader, scored the same way</h2>
<div class="card">${
    s.entrants.length
      ? `<div class="heat"><table><tr><th>Reader</th><th class="num">Docs read</th><th class="num">Answers right</th><th>Accuracy · range we can defend</th><th class="num">Typical time</th><th class="num">Cost</th><th class="num">Traps</th><th>Decision</th></tr>${rows}</table></div>
    <p class="sowhat"><b>The range decides, not the score.</b> A reader above ${pct(s.floor)} on a handful
    of documents has proved nothing; the decision only moves when the whole range clears the floor or
    falls below it. A person costs ${cpi} a certificate and software costs almost nothing — which is why
    ruling a reader out is cheap and clearing one is the expensive half.</p>`
      : `<div class="empty">No runs yet.</div>`
  }</div>

<h2>The eight things we ask for</h2>
<div class="card">${
    s.entrants.length
      ? `<div class="heat"><table>
    <tr><th></th>${whos.map((w) => `<th class="hd">${short(w)}</th>`).join("")}</tr>${grid}</table></div>
    <p class="sowhat"><b>A pale row is work you keep a person on. A pale column is only a reader you
    drop.</b> A row that stays pale all the way across is work no software here can take, whichever one
    you buy; one pale column is a bad purchase and nothing more. Cells show right out of tried, and
    under 35 readings is a hint about where to spend next, not a decision.</p>`
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
      : `<div class="empty">Nobody has taken one yet.</div>`
  }
  <p class="sowhat"><b>Every line here is a wrong answer that a source check would pass.</b> The wrong
  value is last period's figure, printed on the same page as the right one, so asking the reader to say
  where it got it — or asking other software to check it — cannot tell the two apart. Where these
  cluster, a person stays on the job even if the accuracy looks fine.</p>
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
