import { query } from "./db.mjs";
import { CERTS, FIELDS } from "./certs.mjs";
import { wilson } from "./readiness.mjs";
import { page } from "./ui.mjs";

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
  const { rows } = await query(
    `select source, coalesce(model_id,'human') as who, cert_id, detail, correct, total, duration_ms
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
      const costCents = w.source === "human" ? cpiCents * w.runs : 0;
      return {
        ...w,
        certs: [...w.certs],
        rate,
        lo,
        hi,
        med_seconds: medMs ? Math.round(medMs / 1000) : null,
        cost_cents: costCents,
        cost_per_correct: w.correct ? costCents / w.correct : null,
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
.badge.hum{color:var(--acc)}.badge.mod{color:var(--agent)}
.rail{height:6px;background:#0a0a0b;border:1px solid var(--line);border-radius:99px;overflow:hidden}
.fill{height:100%;border-radius:99px}
.fill.hum{background:var(--acc)}.fill.mod{background:var(--agent)}
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
      const tone = e.source === "human" ? "hum" : "mod";
      return `<tr>
      <td><span class="badge ${tone}">${e.source === "human" ? "HUMAN" : "MODEL"}</span> <strong>${short(e.who)}</strong></td>
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

<h2>Leaderboard</h2>
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
    title: "Results — human and agent on the same documents",
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
