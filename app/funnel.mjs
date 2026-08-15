import { query } from "./db.mjs";
import { getSubmissions } from "./terac.mjs";

/**
 * The recruitment-to-delivery funnel.
 *
 * Terac's dashboard ends at its own boundary: it knows who applied, who screened out, and who
 * it marked complete. It cannot see whether anyone reached the work or produced anything
 * usable, because that happens on our host. We hold the other half — an arrival receipt per
 * participant, the answers, and the score.
 *
 * Joining the two is the only way to see the gap that actually costs money: people Terac
 * counts as in-progress who never loaded the task at all.
 */

const STAGES = [
  { key: "applied", label: "Applied", who: "terac" },
  { key: "screened", label: "Passed screening", who: "terac" },
  { key: "arrived", label: "Opened the task", who: "us" },
  { key: "submitted", label: "Submitted answers", who: "us" },
  { key: "scored", label: "Scored against ground truth", who: "us" },
];

export async function funnelState(opportunityId) {
  let subs = [];
  let teracError = null;
  if (opportunityId) {
    try {
      const r = await getSubmissions(opportunityId, "?limit=100");
      subs = r.data ?? r.submissions ?? [];
    } catch (err) {
      teracError = err.message;
    }
  }

  const [openRes, extRes, oppRes] = await Promise.all([
    query(`select terac_submission_id, payload->>'status' as status from terac_responses`),
    query(`select terac_submission_id, correct, total, duration_ms from extractions where source='human'`),
    query(`select id, wave, status, participants, cost_cents from terac_opportunities
            where id = $1 or $1 is null order by created_at desc limit 1`, [opportunityId ?? null]),
  ]);

  const opened = new Set(openRes.rows.map((r) => r.terac_submission_id));
  const submitted = new Map(extRes.rows.map((r) => [r.terac_submission_id, r]));

  const byStatus = {};
  for (const s of subs) byStatus[s.status] = (byStatus[s.status] ?? 0) + 1;

  const applied = subs.length;
  const screenedOut = byStatus.screened_out ?? 0;
  const screened = applied - screenedOut;
  const arrived = subs.filter((s) => opened.has(s.id)).length;
  const submittedN = subs.filter((s) => submitted.has(s.id)).length;
  const scored = [...submitted.values()].filter((r) => r.total > 0).length;

  const counts = { applied, screened, arrived, submitted: submittedN, scored };

  // Money is committed per recruited participant, so the cost of a stage is what we paid to
  // reach it — including everyone who then fell out of the next one.
  const opp = oppRes.rows[0];
  const cpi = opp?.participants ? (opp.cost_cents ?? 0) / opp.participants : null;

  const rows = STAGES.map((st, i) => {
    const n = counts[st.key];
    const prev = i === 0 ? null : counts[STAGES[i - 1].key];
    return {
      ...st,
      n,
      of_applied: applied ? n / applied : null,
      step_conversion: prev == null ? null : prev ? n / prev : 0,
      lost: prev == null ? null : prev - n,
    };
  });

  // The stage Terac cannot see, and the one that cost us today.
  const ghost = counts.screened - counts.arrived;
  const abandoned = counts.arrived - counts.submitted;

  const scores = [...submitted.values()];
  return {
    opportunity: opp ?? null,
    teracError,
    stages: rows,
    byStatus,
    cpi_cents: cpi,
    ghost,
    abandoned,
    wasted_cents: cpi != null ? Math.round(cpi * (ghost + abandoned)) : null,
    field_accuracy: scores.length
      ? scores.reduce((a, r) => a + r.correct / r.total, 0) / scores.length
      : null,
    median_seconds: scores.length
      ? Math.round(
          scores.map((r) => r.duration_ms ?? 0).sort((a, b) => a - b)[Math.floor(scores.length / 2)] / 1000,
        )
      : null,
  };
}

const pct = (x) => (x == null ? "—" : (x * 100).toFixed(0) + "%");
const money = (c) => (c == null ? "—" : `$${(c / 100).toFixed(2)}`);

export function funnelPage(s) {
  const max = Math.max(1, ...s.stages.map((x) => x.n));
  const W = 720, BAND = 74, GAP = 8, MINW = 90;
  const widthFor = (n) => MINW + (W - MINW) * (n / max);

  // Each band is a trapezoid running from its own width to the next stage's, so the shape
  // narrows exactly in proportion to the people actually lost at that step.
  const bands = s.stages
    .map((st, i) => {
      const y = i * (BAND + GAP);
      const wTop = widthFor(st.n);
      const wBot = widthFor(i + 1 < s.stages.length ? s.stages[i + 1].n : st.n);
      const x1 = (W - wTop) / 2, x2 = (W - wBot) / 2;
      const fill = st.who === "terac" ? "var(--terac)" : "var(--acc)";
      const lost = st.lost;
      return `
      <polygon points="${x1},${y} ${x1 + wTop},${y} ${x2 + wBot},${y + BAND} ${x2},${y + BAND}"
               fill="${fill}" fill-opacity="0.26" stroke="${fill}" stroke-opacity="0.55"/>
      <text x="${W / 2}" y="${y + 30}" text-anchor="middle" class="fn">${st.n}</text>
      <text x="${W / 2}" y="${y + 50}" text-anchor="middle" class="fl">${st.label}</text>
      <text x="${W / 2}" y="${y + 66}" text-anchor="middle" class="fs">${
        st.step_conversion == null ? `${st.who === "terac" ? "Terac" : "ours"}` : `${pct(st.step_conversion)} of previous`
      }</text>
      ${
        lost > 0
          ? `<text x="${W - 4}" y="${y + BAND / 2 + 4}" text-anchor="end" class="fx">−${lost}</text>`
          : ""
      }`;
    })
    .join("");
  const svgH = s.stages.length * (BAND + GAP);
  const bars = `<svg viewBox="0 0 ${W} ${svgH}" width="100%" height="${svgH}" role="img"
     aria-label="Funnel from ${s.stages[0].n} applicants to ${s.stages[s.stages.length - 1].n} scored extractions">
  <style>
    .fn{fill:var(--fg);font:700 21px ui-sans-serif,system-ui;font-variant-numeric:tabular-nums}
    .fl{fill:var(--fg);font:600 12.5px ui-sans-serif,system-ui}
    .fs{fill:var(--mut);font:11px ui-sans-serif,system-ui}
    .fx{fill:var(--bad);font:600 12px ui-sans-serif,system-ui}
  </style>${bands}</svg>
  <p class="sub" style="margin:14px 0 0">End to end: <strong>${s.stages[s.stages.length - 1].n} of ${s.stages[0].n}</strong>
  applicants produced usable work — <strong>${pct(s.stages[0].n ? s.stages[s.stages.length - 1].n / s.stages[0].n : null)}</strong>.
  Purple stages are all Terac can see; blue stages happen on our host.</p>`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Recruitment Funnel</title><style>
:root{color-scheme:light dark;--bg:#0c0c0d;--fg:#f4f4f5;--mut:#a1a1aa;--line:#27272a;--card:#161617;--ok:#4ade80;--warn:#fbbf24;--bad:#f87171;--acc:#60a5fa;--terac:#a78bfa}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
.wrap{max-width:960px;margin:0 auto;padding:26px 20px 90px}
nav{display:flex;gap:18px;margin:0 0 24px;padding-bottom:12px;border-bottom:1px solid var(--line);font-size:13px}
nav a{color:var(--mut);text-decoration:none}nav a.on{color:var(--fg)}
h1{font-size:22px;margin:0 0 4px}h2{font-size:12px;text-transform:uppercase;letter-spacing:.1em;color:var(--mut);margin:32px 0 12px}
.sub{color:var(--mut);font-size:13.5px;margin:0 0 20px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
.big{font-size:26px;font-variant-numeric:tabular-nums}
label{font-size:11px;color:var(--mut);text-transform:uppercase;letter-spacing:.06em;display:block}
.stage{margin-bottom:16px}
.lbl{font-size:14px;margin-bottom:5px}
.who{font-size:9px;letter-spacing:.09em;padding:2px 6px;border-radius:99px;border:1px solid;margin-right:7px;vertical-align:1px}
.who.terac{color:var(--terac);border-color:var(--terac)}.who.us{color:var(--acc);border-color:var(--acc)}
.track{position:relative;background:#0c0c0d;border:1px solid var(--line);border-radius:7px;height:32px}
.bar{height:100%;border-radius:6px;opacity:.32}
.bar.terac{background:var(--terac)}.bar.us{background:var(--acc)}
.n{position:absolute;left:11px;top:5px;font-variant-numeric:tabular-nums;font-size:15px;font-weight:600}
.meta{font-size:12px;color:var(--mut);margin-top:4px}
.bad{color:var(--bad)}.mut{color:var(--mut)}.ok{color:var(--ok)}.warn{color:var(--warn)}
.callout{border:1px solid var(--warn);border-radius:10px;padding:14px;margin-top:18px;font-size:13.5px}
table{width:100%;border-collapse:collapse;font-size:14px}
th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--mut);padding:6px 8px;border-bottom:1px solid var(--line);font-weight:500}
td{padding:8px;border-bottom:1px solid var(--line)}tr:last-child td{border-bottom:0}
</style></head><body><div class="wrap">
<nav><a href="/">Coverage board</a><a href="/ops">Operator</a><a href="/design">Designer</a><a href="/funnel" class="on">Funnel</a><a href="/support">Support</a></nav>
<h1>Recruitment → delivery funnel</h1>
<p class="sub">Terac's dashboard stops at its own boundary. The stages marked OURS happen on our host and are invisible to it — which is where the money actually leaks.</p>

<div class="card grid">
  <div><label>Cost per recruit</label><div class="big">${money(s.cpi_cents)}</div></div>
  <div><label>Paid, never arrived</label><div class="big ${s.ghost > 0 ? "bad" : ""}">${s.ghost}</div></div>
  <div><label>Arrived, abandoned</label><div class="big ${s.abandoned > 0 ? "warn" : ""}">${s.abandoned}</div></div>
  <div><label>Spent on non-delivery</label><div class="big ${s.wasted_cents ? "bad" : ""}">${money(s.wasted_cents)}</div></div>
</div>

<h2>The funnel</h2>
<div class="card">${bars}
${
  s.ghost > 0
    ? `<div class="callout"><strong class="warn">${s.ghost} participant${s.ghost === 1 ? "" : "s"} passed screening and never loaded the task.</strong>
   Terac counts them as in-progress and will hold or charge for them. Only an arrival receipt on our
   side can tell that apart from someone who is genuinely working — which is exactly the number a
   recruitment dashboard cannot show you.</div>`
    : ""
}
</div>

<h2>Delivered work</h2>
<div class="card grid">
  <div><label>Field accuracy</label><div class="big">${s.field_accuracy == null ? "—" : pct(s.field_accuracy)}</div></div>
  <div><label>Median time on task</label><div class="big">${s.median_seconds ? s.median_seconds + "s" : "—"}</div></div>
  <div><label>Usable extractions</label><div class="big">${s.stages.find((x) => x.key === "scored").n}</div></div>
</div>

<h2>Terac submission states</h2>
<div class="card"><table><tr><th>Status</th><th>Count</th><th>Meaning</th></tr>
${
  Object.keys(s.byStatus).length
    ? Object.entries(s.byStatus)
        .map(
          ([k, v]) =>
            `<tr><td><code>${k}</code></td><td>${v}</td><td class="mut">${
              {
                screened_out: "answered the screener, did not qualify",
                screen_passed: "qualified, has not started",
                in_progress: "Terac believes they are working",
                awaiting_review: "Terac marked complete, waiting on us",
                approved: "accepted and paid",
                rejected: "did the work, not accepted",
                abandoned: "stopped part-way",
              }[k] ?? ""
            }</td></tr>`,
        )
        .join("")
    : `<tr><td colspan="3" class="mut">${s.teracError ? "Terac: " + s.teracError : "No submissions."}</td></tr>`
}
</table></div>
<script>setInterval(()=>location.reload(),20000)</script>
</div></body></html>`;
}

export function registerFunnelRoutes(app) {
  const DEFAULT = "ylz2cq7dcj710a83uo6oxkl7";
  app.get("/api/funnel", async (req, res) => {
    try {
      res.json(await funnelState(req.query.opportunity ?? DEFAULT));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
  app.get("/funnel", async (req, res) => {
    try {
      res.type("html").send(funnelPage(await funnelState(req.query.opportunity ?? DEFAULT)));
    } catch (err) {
      res.status(500).send(`<pre>${err.message}</pre>`);
    }
  });
}
