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
  { key: "scored", label: "Marked against the answers", who: "us" },
];

/**
 * A worked example, at a scale we have not run.
 *
 * The rates are NOT invented: they are the ones measured across every real wave so far, applied
 * to a larger cohort so the shape of the funnel is legible. Anything invented would be a picture
 * of a business we do not have, so the only fiction here is the size of the intake.
 */
const SAMPLE_APPLIED = 250;

function sampleFrom(measured) {
  const rates = measured.map((st, i) =>
    i === 0 ? 1 : measured[i - 1].n > 0 ? st.n / measured[i - 1].n : 0,
  );
  let n = SAMPLE_APPLIED;
  return measured.map((st, i) => {
    n = i === 0 ? SAMPLE_APPLIED : Math.round(n * rates[i]);
    const prev = i === 0 ? null : null;
    return { ...st, n, of_applied: n / SAMPLE_APPLIED, step_conversion: i === 0 ? null : rates[i], lost: null };
  });
}

export async function funnelState(opportunityId) {
  // Every launched wave, so the page can offer them and so "all" can add them up. A funnel
  // over one wave answers "did that wave work"; a funnel over all of them answers "does
  // recruitment work" — different questions, and mixing them silently answers neither.
  const { rows: allWaves } = await query(
    `select id, wave, participants, cost_cents, launched_at, task_url
       from terac_opportunities where launched_at is not null order by launched_at desc`,
  ).catch(() => ({ rows: [] }));

  const wantSample = opportunityId === "sample";
  const scope =
    opportunityId === "all" || wantSample ? allWaves.map((w) => w.id) : [opportunityId].filter(Boolean);

  let subs = [];
  let teracError = null;
  for (const id of scope) {
    try {
      const r = await getSubmissions(id, "?limit=100");
      subs = subs.concat(r.data ?? r.submissions ?? []);
    } catch (err) {
      teracError = err.message;
    }
  }

  const [openRes, extRes, oppRes] = await Promise.all([
    query(`select terac_submission_id, payload->>'status' as status from terac_responses`),
    query(`select terac_submission_id, correct, total, duration_ms from extractions where source='human'`),
    query(`select id, wave, status, participants, cost_cents from terac_opportunities
            where id = $1 order by created_at desc limit 1`, [opportunityId === "all" ? null : opportunityId ?? null]),
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
  // The worked example prices its invented volume at the blended rate we have actually paid.
  const inScope =
    opportunityId === "all" || wantSample ? allWaves : allWaves.filter((w) => w.id === opportunityId);
  const paidTotal = inScope.reduce((a, w) => a + Number(w.participants ?? 0), 0);
  const spentTotal = inScope.reduce((a, w) => a + Number(w.cost_cents ?? 0), 0);
  const opp = oppRes.rows[0] ?? null;
  const cpi = paidTotal ? spentTotal / paidTotal : null;

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
  let ghost = counts.screened - counts.arrived;
  let abandoned = counts.arrived - counts.submitted;

  const sampled = wantSample ? sampleFrom(rows) : null;
  if (sampled) {
    for (let i = 1; i < sampled.length; i++) sampled[i].lost = sampled[i - 1].n - sampled[i].n;
    ghost = sampled[1].n - sampled[2].n;
    abandoned = sampled[2].n - sampled[3].n;
  }

  const scores = [...submitted.values()];
  return {
    sample: wantSample,
    opportunity: opp ?? null,
    scope: opportunityId === "all" ? "all" : opportunityId,
    sample_applied: SAMPLE_APPLIED,
    waves: allWaves,
    spent_cents: spentTotal,
    teracError,
    stages: sampled ?? rows,
    measured_stages: rows,
    byStatus,
    cpi_cents: cpi,
    ghost,
    abandoned,
    wasted_cents:
      cpi != null
        ? Math.round(
            cpi *
              (sampled
                ? sampled[1].n - sampled[2].n + (sampled[2].n - sampled[3].n)
                : ghost + abandoned),
          )
        : null,
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
.picker{display:flex;gap:10px;align-items:center;margin:0 0 18px}
.picker label{margin:0;font-size:10.5px}
.legend{display:flex;gap:8px;align-items:center;margin:0 0 16px}
.card .banner{margin:18px 0 0}
`;

export function funnelPage(s) {
  const max = Math.max(1, ...s.stages.map((x) => x.n));
  const W = 720, BAND = 70, GAP = 22, MINW = 90;
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
        st.who === "terac" ? "Terac sees this" : "only we see this"
      }</text>
      ${
        // The conversion sits in the gap BETWEEN two bands, because that is where the drop
        // happens. A count of who was lost says nothing without the base it was lost from.
        i + 1 < s.stages.length
          ? `<text x="${W / 2}" y="${y + BAND + GAP - 1}" text-anchor="middle" class="fc">${pct(
              s.stages[i + 1].step_conversion,
            )}</text>`
          : ""
      }`;
    })
    .join("");
  const svgH = s.stages.length * (BAND + GAP);
  const applied = s.stages[0].n;
  const scoredN = s.stages[s.stages.length - 1].n;
  const svg = `<svg viewBox="0 0 ${W} ${svgH}" width="100%" height="${svgH}" role="img"
     aria-label="Funnel from ${applied} applicants to ${scoredN} marked readings">
  <style>
    .fn{fill:var(--fg);font:700 21px ui-sans-serif,system-ui;font-variant-numeric:tabular-nums}
    .fl{fill:var(--fg);font:600 12.5px ui-sans-serif,system-ui}
    .fs{fill:var(--mut);font:11px ui-sans-serif,system-ui}
    .fx{fill:var(--bad);font:600 12px ui-sans-serif,system-ui}
    .fc{fill:var(--mut);font:600 11px ui-sans-serif,system-ui;letter-spacing:.04em}
  </style>${bands}</svg>`;

  const body = `
<h1>From applicants to finished work</h1>
<form class="picker" method="get" action="/funnel">
  <label for="opportunity">Showing</label>
  <select name="opportunity" id="opportunity" onchange="this.form.submit()">
    <option value="all"${s.scope === "all" ? " selected" : ""}>Every wave together</option>
    <option value="sample"${s.sample ? " selected" : ""}>Worked example · 250 applicants</option>
    ${(s.waves ?? [])
      .map((w) => {
        const c = (w.task_url?.match(/[?&]cert=([a-z0-9]+)/) ?? [])[1];
        return `<option value="${w.id}"${s.scope === w.id ? " selected" : ""}>Wave ${w.wave}${
          c ? ` · ${c.toUpperCase()}` : ""
        } · ${w.participants ?? "?"} paid</option>`;
      })
      .join("")}
  </select>
  <noscript><button class="ghost" type="submit">Show</button></noscript>
</form>
<p class="sub">Purple is what Terac can see. Blue happens on our site, and that is where the money
goes missing.</p>

${
  s.sample
    ? `<div class="banner syn"><b>WORKED EXAMPLE — these people do not exist.</b> The intake of
       ${s.sample_applied} applicants is invented. Every conversion rate between the stages is the one
       we have actually measured across our real waves, applied to that larger intake, so the shape is
       real even though the volume is not. Switch the picker above to see the waves that genuinely ran.</div>`
    : ""
}
${
  s.teracError
    ? `<div class="banner syn">Terac did not answer: <code>${s.teracError}</code>. The top two numbers are
       <b>missing, not zero</b> — ignore them until it responds.</div>`
    : ""
}

<div class="card">
  <div class="legend">
    <span class="tag" style="color:var(--terac)">TERAC CAN SEE</span>
    <span class="tag" style="color:var(--acc)">ONLY WE CAN SEE</span>
  </div>
  ${svg}
  <p class="sowhat">${
    applied
      ? `<b>${scoredN} of ${applied} applicants produced usable work — ${pct(scoredN / applied)}.</b>
         Terac's record stops at the purple bands. The ${s.ghost} lost between screening and opening the
         task show up on no recruitment dashboard: only our own record of who turned up tells someone
         working from someone who never showed. Size the next wave off the blue end, not the purple top.`
      : `No applicants have come back for this wave, so <b>the shape below proves nothing yet</b>. It only
         shows the line: purple is what Terac reports, blue exists only because we record it.`
  }</p>
${
  s.ghost > 0
    ? `<div class="banner syn"><b>${s.ghost} ${s.ghost === 1 ? "person" : "people"} passed screening and never opened the task.</b>
   Terac counts them as working and will still hold or charge for them. Only our own record of who
   turned up tells them apart from someone genuinely mid-task.</div>`
    : ""
}
</div>

<h2>What this wave has cost so far</h2>
<div class="grid">
  <div><label>Cost per recruit</label><div class="big">${money(s.cpi_cents)}</div></div>
  <div><label>Paid, never arrived</label><div class="big ${s.ghost > 0 ? "bad" : ""}">${s.ghost}</div></div>
  <div><label>Arrived, then left</label><div class="big ${s.abandoned > 0 ? "warn" : ""}">${s.abandoned}</div></div>
  <div><label>Paid for no work</label><div class="big ${s.wasted_cents ? "bad" : ""}">${money(s.wasted_cents)}</div></div>
</div>
<p class="sowhat">${
    s.wasted_cents == null
      ? `<b>We can see the leak but not what it cost.</b> ${s.ghost + s.abandoned} people passed screening
         and delivered nothing, but this wave has no cost or headcount recorded yet — so do not quote a
         waste figure.`
      : `<b>${money(s.wasted_cents)} of this wave's spend bought no work at all</b> — ${s.ghost} passed
         screening and never opened the task, ${s.abandoned} opened it and left without answers. At
         ${money(s.cpi_cents)} a head that loss grows with every wave, so fix the screening and the
         hand-off before buying a bigger one.`
  }</p>

<h2>Delivered work</h2>
<div class="grid">
  <div><label>Answers they got right</label><div class="big">${s.field_accuracy == null ? "—" : pct(s.field_accuracy)}</div></div>
  <div><label>Median time on task</label><div class="big">${s.median_seconds ? s.median_seconds + "s" : "—"}</div></div>
  <div><label>Readings we can use</label><div class="big">${s.stages.find((x) => x.key === "scored").n}</div></div>
</div>
<p class="sowhat">${
    scoredN === 0
      ? `<b>Nothing here is evidence yet.</b> With nothing marked there is no accuracy or time to report, and
         this wave can neither clear anything for automation nor rule it out.`
      : `<b>What this wave bought is ${scoredN} marked reading${scoredN === 1 ? "" : "s"}, not the accuracy
         beside them.</b> Each is one person reading one certificate, and it takes ${N_MIN} clean readings
         before we can call one of the eight things safe to automate — so whether anything gets there
         depends on how many people read the <i>same</i> certificate, which this total cannot tell you.
         Median time prices the next human wave; it says nothing about whether the step needs a person.`
  }</p>

<h2>What Terac thinks is happening</h2>
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
      ? `<b>This is what Terac believes, not what happened.</b> <code>in_progress</code> covers both someone
         mid-task and someone who never opened it; only the arrival count above tells them apart. Check
         that before you chase, approve or re-recruit anyone.`
      : `<b>An empty column rules nothing out.</b> ${
          s.teracError
            ? "Terac errored instead of returning zero submissions, so we do not know where this wave stands."
            : "No submissions came back for this wave, so there is nothing here to check our own counts against."
        }`
  }</p>
</div>`;

  return page({
    title: "Recruitment Funnel",
    current: "/funnel",
    body,
    extraCss: EXTRA_CSS,
    script: "",
  });
}

export function registerFunnelRoutes(app) {
  // Default to every wave. A single hardcoded id was silently right for one afternoon and
  // wrong the moment a second wave launched.
  const DEFAULT = "all";
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
