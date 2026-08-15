import { query } from "./db.mjs";
import { CERTS, FIELDS } from "./certs.mjs";
import { wilson } from "./readiness.mjs";

const FLOOR = 0.9;
const HUMAN_CPI_CENTS = 1350;

/**
 * The outcome surface: one table of who read the same documents and what they got right.
 *
 * Humans and models are scored by the identical function against the identical ground truth,
 * so the only thing that differs between the rows is who did the reading.
 */
export async function resultsState() {
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
      const costCents = w.source === "human" ? HUMAN_CPI_CENTS * w.runs : 0;
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

export function resultsPage(s) {
  const nav = `<nav><a href="/">Coverage board</a><a href="/ops">Operator</a><a href="/design">Designer</a><a href="/funnel">Funnel</a><a href="/results" class="on">Results</a><a href="/support">Support</a></nav>`;

  const best = s.entrants[0];
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

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Results — Human vs Agent</title><style>
:root{color-scheme:light dark;--bg:#0a0a0b;--fg:#f4f4f5;--mut:#a1a1aa;--line:#26262a;--card:#141416;--ok:#4ade80;--warn:#fbbf24;--bad:#f87171;--hum:#60a5fa;--mod:#c084fc}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
.wrap{max-width:1120px;margin:0 auto;padding:26px 20px 90px}
nav{display:flex;gap:18px;margin:0 0 26px;padding-bottom:12px;border-bottom:1px solid var(--line);font-size:13px}
nav a{color:var(--mut);text-decoration:none}nav a.on{color:var(--fg)}
h1{font-size:30px;margin:0 0 8px;letter-spacing:-.02em}
h2{font-size:12px;text-transform:uppercase;letter-spacing:.1em;color:var(--mut);margin:36px 0 12px}
.lede{font-size:19px;line-height:1.45;margin:0 0 6px}
.sub{color:var(--mut);font-size:13.5px;margin:0 0 22px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px}
table{width:100%;border-collapse:collapse;font-size:14px}
th{text-align:left;font-size:10.5px;text-transform:uppercase;letter-spacing:.07em;color:var(--mut);padding:8px;border-bottom:1px solid var(--line);font-weight:500}
td{padding:10px 8px;border-bottom:1px solid var(--line);vertical-align:middle}tr:last-child td{border-bottom:0}
.num{font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap}
.badge{font-size:9px;letter-spacing:.08em;padding:2px 6px;border-radius:99px;border:1px solid currentColor;vertical-align:1px}
.badge.hum{color:var(--hum)}.badge.mod{color:var(--mod)}
.rail{height:7px;background:#0a0a0b;border:1px solid var(--line);border-radius:99px;overflow:hidden}
.fill{height:100%;border-radius:99px}.fill.hum{background:var(--hum)}.fill.mod{background:var(--mod)}
.rt{font-size:11.5px;margin-top:3px;font-variant-numeric:tabular-nums}
.cell{text-align:center;font-variant-numeric:tabular-nums;font-size:12px;border:1px solid var(--line)}
.fname{font-size:13px;white-space:nowrap;padding-right:14px}
.hd{font-size:10px;color:var(--mut);writing-mode:vertical-rl;transform:rotate(180deg);padding:6px 2px;white-space:nowrap}
.mut{color:var(--mut)}.bad{color:var(--bad)}.ok{color:var(--ok)}.warn{color:var(--warn)}
.trap{border-left:2px solid var(--bad);padding:8px 0 8px 12px;margin-bottom:10px;font-size:13.5px}
.empty{color:var(--mut);padding:26px;text-align:center}
</style></head><body><div class="wrap">${nav}
<h1>Same documents. Same instruction.</h1>
<p class="lede">${lede}</p>
<p class="sub">Every row below read the identical rendered pages and answered the identical eight questions, scored by the identical function against ground truth the documents themselves print. Nothing was extracted in advance for anyone.</p>

<h2>Leaderboard</h2>
<div class="card">${
    s.entrants.length
      ? `<table><tr><th>Reader</th><th class="num">Docs</th><th class="num">Fields</th><th>Accuracy · 95% interval</th><th class="num">Median</th><th class="num">Cost</th><th class="num">Traps</th></tr>${rows}</table>
    <p class="sub" style="margin:14px 0 0">Cost is what it took to obtain that reader's answers: ${"$" + (HUMAN_CPI_CENTS / 100).toFixed(2)} per certificate for a recruited human, effectively nothing for an API call. The interval is what the evidence licenses, not the observed rate.</p>`
      : `<div class="empty">No runs yet.</div>`
  }</div>

<h2>Field by field</h2>
<div class="card">${
    s.entrants.length
      ? `<div style="overflow-x:auto"><table>
    <tr><th></th>${whos.map((w) => `<th class="hd">${short(w)}</th>`).join("")}</tr>${grid}</table></div>
    <p class="sub" style="margin:14px 0 0">Read it as a shape before you read it as numbers: a column that goes pale is a reader that struggles everywhere, a row that goes pale is a field that is genuinely hard for everyone — and those are different problems with different fixes.</p>`
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
  <p class="sub" style="margin:14px 0 0">Each certificate prints its prior-period figure beside the current one. A citation check cannot separate them — the digits really are on the page — so this is the failure automated verification structurally cannot catch.</p>
</div>
<script>setInterval(()=>location.reload(),25000)</script>
</div></body></html>`;
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
