import { query } from "./db.mjs";
import { nMin } from "./readiness.mjs";
import { getSubmissions } from "./terac.mjs";
import { page } from "./ui.mjs";

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
  // Count only submissions belonging to THIS opportunity. Counting every human extraction ever
  // recorded made the last stage larger than the one above it — a funnel that widens at the
  // bottom, which is both impossible and the first thing anyone looking at it would notice.
  const scored = subs.filter((s) => (submitted.get(s.id)?.total ?? 0) > 0).length;

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

// Copy only: the readings a field needs before a 95% lower bound can clear the 0.90 floor.
const FLOOR = 0.9;
const N_MIN = nMin(FLOOR);

const EXTRA_CSS = `
.legend{display:flex;gap:8px;align-items:center;margin:0 0 16px}
.card .banner{margin:18px 0 0}
`;

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
  const applied = s.stages[0].n;
  const scoredN = s.stages[s.stages.length - 1].n;
  const svg = `<svg viewBox="0 0 ${W} ${svgH}" width="100%" height="${svgH}" role="img"
     aria-label="Funnel from ${applied} applicants to ${scoredN} scored extractions">
  <style>
    .fn{fill:var(--fg);font:700 21px ui-sans-serif,system-ui;font-variant-numeric:tabular-nums}
    .fl{fill:var(--fg);font:600 12.5px ui-sans-serif,system-ui}
    .fs{fill:var(--mut);font:11px ui-sans-serif,system-ui}
    .fx{fill:var(--bad);font:600 12px ui-sans-serif,system-ui}
  </style>${bands}</svg>`;

  const body = `
<h1>Recruitment → delivery funnel</h1>
<p class="sub">Terac's dashboard stops at its own boundary. The blue stages happen on our host and are
invisible to it — which is where the money actually leaks.</p>

${
  s.teracError
    ? `<div class="banner syn">Terac did not answer: <code>${s.teracError}</code>. The applied and
       screening counts below are <b>missing, not zero</b> — read nothing into the funnel's top two bands
       until it responds.</div>`
    : ""
}

<h2>What this wave has cost so far</h2>
<div class="grid">
  <div><label>Cost per recruit</label><div class="big">${money(s.cpi_cents)}</div></div>
  <div><label>Paid, never arrived</label><div class="big ${s.ghost > 0 ? "bad" : ""}">${s.ghost}</div></div>
  <div><label>Arrived, abandoned</label><div class="big ${s.abandoned > 0 ? "warn" : ""}">${s.abandoned}</div></div>
  <div><label>Spent on non-delivery</label><div class="big ${s.wasted_cents ? "bad" : ""}">${money(s.wasted_cents)}</div></div>
</div>
<p class="sowhat">${
    s.wasted_cents == null
      ? `The ${s.ghost + s.abandoned} recruits who cleared screening and delivered nothing cannot be
         priced: this opportunity carries no cost and participant count yet. <b>The leak is visible here,
         its value is not</b> — until the opportunity records both, do not quote a waste figure.`
      : `<b>${money(s.wasted_cents)} of this wave's recruitment spend bought no work at all</b> —
         ${s.ghost} cleared screening and never opened the task, ${s.abandoned} opened it and left without
         answers. At ${money(s.cpi_cents)} a recruit that loss scales with the wave, so it is worth fixing
         the screening and the hand-off before buying a bigger one.`
  }</p>

<h2>The funnel</h2>
<div class="card">
  <div class="legend">
    <span class="tag" style="color:var(--terac)">TERAC CAN SEE</span>
    <span class="tag" style="color:var(--acc)">ONLY WE CAN SEE</span>
  </div>
  ${svg}
  <p class="sowhat">${
    applied
      ? `<b>${scoredN} of ${applied} applicants produced usable work — ${pct(scoredN / applied)}.</b>
         Terac's record ends at the purple bands; the ${s.ghost} lost between screening and "opened the
         task" appears on no recruitment dashboard, because only an arrival receipt on our host
         distinguishes a working participant from one who never showed. Size the next wave off the blue
         end of this shape, not the purple top of it.`
      : `No applicants have been returned for this opportunity, so <b>the shape below is not yet evidence
         of anything</b>. All it shows is the boundary: purple stages Terac reports, blue stages that exist
         only because we record them.`
  }</p>
${
  s.ghost > 0
    ? `<div class="banner syn"><b>${s.ghost} participant${s.ghost === 1 ? "" : "s"} passed screening and never loaded the task.</b>
   Terac counts them as in-progress and will hold or charge for them. Only an arrival receipt on our
   side can tell that apart from someone who is genuinely working — which is exactly the number a
   recruitment dashboard cannot show you.</div>`
    : ""
}
</div>

<h2>Delivered work</h2>
<div class="grid">
  <div><label>Field accuracy</label><div class="big">${s.field_accuracy == null ? "—" : pct(s.field_accuracy)}</div></div>
  <div><label>Median time on task</label><div class="big">${s.median_seconds ? s.median_seconds + "s" : "—"}</div></div>
  <div><label>Usable extractions</label><div class="big">${s.stages.find((x) => x.key === "scored").n}</div></div>
</div>
<p class="sowhat">${
    scoredN === 0
      ? `<b>Nothing here is evidence yet.</b> With no scored extractions, accuracy and time on task are
         undefined, and no field can be licensed or ruled out from this wave at all.`
      : `<b>The ${scoredN} scored extraction${scoredN === 1 ? "" : "s"}, not the accuracy beside them, is what
         this wave bought.</b> Each one is a single reading of every field on the certificate it covers, and
         a field needs ${N_MIN} clean readings before a 95% lower bound can clear the ${FLOOR.toFixed(2)} floor — so
         whether anything gets licensed depends on how many people read the <i>same</i> certificate, which
         this total cannot tell you. Median time on task prices the next human wave; it says nothing about
         whether the step can run without one.`
  }</p>

<h2>Terac submission states</h2>
<div class="card"><table><tr><th>Status</th><th class="num">Count</th><th>Meaning</th></tr>
${
  Object.keys(s.byStatus).length
    ? Object.entries(s.byStatus)
        .map(
          ([k, v]) =>
            `<tr><td><code>${k}</code></td><td class="num">${v}</td><td class="mut">${
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
</table>
<p class="sowhat">${
    Object.keys(s.byStatus).length
      ? `<b>These are Terac's beliefs about the work, not observations of it.</b> <code>in_progress</code>
         covers both a participant mid-task and one who never opened it; only the arrival count above
         separates the two. Reconcile against that before you chase, approve or re-recruit anyone on the
         strength of this column.`
      : `<b>An empty status column rules nothing out.</b> ${
          s.teracError
            ? "Terac errored rather than returning zero submissions, so this wave's recruitment state is unknown right now."
            : "No submissions came back for this opportunity, so there is no recruitment state to reconcile against our arrival and scoring counts."
        }`
  }</p>
</div>`;

  return page({
    title: "Recruitment Funnel",
    current: "/funnel",
    body,
    extraCss: EXTRA_CSS,
    script: "setInterval(()=>location.reload(),20000)",
  });
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
