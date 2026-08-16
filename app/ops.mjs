import express from "express";
import { query } from "./db.mjs";
import { CERTS, FIELDS, byId } from "./certs.mjs";
const FIELD_COUNT = 8;
import {
  createOpportunity,
  createProject,
  getOpportunity,
  getSubmissions,
  launchOpportunity,
  listProjects,
  opportunityBody,
  requestFeasibility,
  stopOpportunity,
} from "./terac.mjs";
import { thetaLicensed, label as readinessLabel, wilson, nMin } from "./readiness.mjs";
import { page } from "./ui.mjs";

const FLOOR = 0.9;

/**
 * What a wave can actually buy, before any money moves.
 *
 * The participant is the expensive unit, not their time: CPI floors around $9-12 and is
 * nearly flat in duration above ten minutes. So claims-per-task, not participant count,
 * is the lever on cost per judgment.
 *
 * nMin is the honest ceiling on ambition: below it, even PERFECT agreement cannot push the
 * Wilson lower bound to the floor, so no sample that small can ever license a process — it
 * can only rule one out. Planning against it stops us buying evidence that cannot conclude.
 */
export function planWave({ participants, claimsPerTask, cpiCents, processes = 3, floor = FLOOR }) {
  const judgments = participants * claimsPerTask;
  const perProcess = Math.floor(judgments / processes);
  const cost = participants * cpiCents;
  const need = nMin(floor);
  const [loPerfect] = wilson(perProcess, perProcess);
  return {
    participants,
    claims_per_task: claimsPerTask,
    judgments,
    claims_per_process: perProcess,
    cost_cents: cost,
    cost_per_judgment_cents: judgments ? cost / judgments : null,
    n_min_to_license: need,
    can_license: perProcess >= need,
    best_case_theta: loPerfect,
    // A process can be ruled out as soon as the upper bound falls under the floor, which
    // happens at far smaller n than licensing needs.
    can_rule_out: wilson(0, perProcess)[1] < floor,
  };
}

let schemaReady = null;
function ensureSchema() {
  // `create table if not exists` is a no-op on an existing table, so new columns must be
  // added explicitly or they silently never appear and the code falls back to defaults.
  schemaReady ??= query(`
    create table if not exists terac_opportunities (
      id             text primary key,
      wave           text not null unique,
      status         text not null,
      participants   integer,
      claims_per_task integer default 4,
      minutes        integer,
      cost_cents     integer,
      cpi_cents      integer,
      task_url       text,
      dashboard_url  text,
      created_at     timestamptz not null default now(),
      launched_at    timestamptz
    )`).then(() =>
    query(`
      alter table terac_opportunities add column if not exists claims_per_task integer default 4;
      alter table terac_opportunities add column if not exists minutes integer;
      alter table terac_opportunities add column if not exists cost_cents integer;
      alter table terac_opportunities add column if not exists cpi_cents integer;
      alter table terac_opportunities add column if not exists dashboard_url text;
      create unique index if not exists terac_opportunities_wave_idx on terac_opportunities (wave);
    `),
  );
  return schemaReady;
}

const money = (c) => (c == null ? null : `$${(c / 100).toFixed(2)}`);

async function opsState() {
  await ensureSchema();
  const [certRes, fieldRes, opps, openRes] = await Promise.all([
    query(`select cert_id, count(*)::int as n,
                  sum(correct)::int as correct, sum(total)::int as total
             from extractions where source = 'human' group by 1`),
    query(`select detail from extractions where source = 'human'`),
    query(`select * from terac_opportunities order by created_at desc limit 5`),
    query(`select payload->>'status' as status, count(*)::int as n
             from terac_responses group by 1`),
  ]);

  // Per-field correctness across every human extraction.
  const fields = {};
  for (const r of fieldRes.rows) {
    for (const [k, v] of Object.entries(r.detail ?? {})) {
      const f = (fields[k] ??= { n: 0, ok: 0 });
      f.n++;
      if (v.correct) f.ok++;
    }
  }

  const byCert = new Map(certRes.rows.map((r) => [r.cert_id, r]));
  const corpus = CERTS.map((c) => {
    const r = byCert.get(c.id);
    const n = r ? r.n : 0;
    const ok = r ? Number(r.correct) : 0;
    const tot = r ? Number(r.total) : 0;
    return {
      process_id: c.id,
      name: c.entity,
      expertise_area: c.truth.ratio_name,
      claims: FIELD_COUNT,
      rated_claims: n,
      agreed: ok,
      judgments: tot,
      theta: thetaLicensed(ok, tot),
      label: readinessLabel({ x: ok, n: tot, floor: FLOOR }),
      evidence_mode: n > 0 ? "live" : "synthetic",
    };
  });

  const opened = openRes.rows.reduce((a, r) => a + r.n, 0);
  const done = openRes.rows.find((r) => r.status === "completed")?.n ?? 0;
  return {
    floor: FLOOR,
    corpus,
    fields,
    opportunities: opps.rows,
    completed_tasks: done,
    opened_tasks: opened,
    total_attestations: certRes.rows.reduce((a, r) => a + Number(r.total ?? 0), 0),
  };
}

export function registerOpsRoutes(app) {
  const json = express.json();

  app.get("/api/ops/state", async (_req, res) => {
    try {
      res.json(await opsState());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /** Pure arithmetic. Touches no vendor, spends nothing. */
  app.post("/api/ops/plan", json, async (req, res) => {
    const cpi = Math.max(1, Number(req.body?.cpiCents) || 1200);
    const budget = Math.max(0, Number(req.body?.budgetCents) || 12500);
    const claimsPerTask = Math.max(1, Number(req.body?.claimsPerTask) || 4);
    const options = [];
    for (const c of [4, 8, 12, 20, 30, 40]) {
      const p = Math.floor(budget / cpi);
      options.push(planWave({ participants: p, claimsPerTask: c, cpiCents: cpi }));
    }
    res.json({
      budget_cents: budget,
      cpi_cents: cpi,
      n_min_to_license: nMin(FLOOR),
      selected: planWave({
        participants: Math.max(1, Number(req.body?.participants) || Math.floor(budget / cpi)),
        claimsPerTask,
        cpiCents: cpi,
      }),
      sweep: options,
    });
  });

  /**
   * Asks a human at Terac to price the work instead of accepting the autonomous estimate.
   * The returned id can be passed back on a draft to bind that confirmed CPI.
   */
  app.post("/api/ops/feasibility", json, async (req, res) => {
    try {
      const out = await requestFeasibility({
        role: req.body?.role ?? "General population, comfortable reading short documents in English",
        task:
          req.body?.task ??
          "Read a short business-document excerpt and say whether it supports a one-sentence claim, contradicts it, or does not contain enough information. No domain knowledge required — reading and simple arithmetic only. Repeated for several excerpts in one sitting.",
        count: Math.max(1, Number(req.body?.count) || 10),
      });
      res.json(out);
    } catch (err) {
      res.status(502).json({ error: err.message, detail: err.body ?? null });
    }
  });

  /** Builds a DRAFT. Costs nothing and starts no recruitment. */
  app.post("/api/ops/draft", json, async (req, res) => {
    try {
      await ensureSchema();
      const participants = Math.max(1, Math.min(1000, Number(req.body?.participants) || 12));
      // Required, not defaulted. A silent default advertises a duration nobody chose, which
      // is how the last wave came to offer 3 minutes for 7-9 minutes of work.
      const minutes = Number(req.body?.minutes);
      if (!Number.isFinite(minutes) || minutes < 1) {
        throw new Error("minutes is required — pass the real duration of the task, in minutes");
      }
      const days = Math.max(5, Number(req.body?.days) || 5);
      const claimsPerTask = Math.max(1, Math.min(60, Number(req.body?.claimsPerTask) || 4));
      const feasibilityRequestId = req.body?.feasibilityRequestId || undefined;
      if (!process.env.APP_URL?.startsWith("https://")) {
        throw new Error(`APP_URL must be a public https URL for Terac to reach the task page (currently ${process.env.APP_URL})`);
      }
      const wave = `w${Date.now().toString(36).slice(-4)}`;
      // Optional. Pins every reader in this wave to one certificate, so three waves give
      // three URLs whose responses separate by certificate. Omitted, the task page falls
      // back to assigning a certificate by hash of Terac's submission id.
      const certId = req.body?.certId;
      if (certId && !byId(certId)) throw new Error(`unknown certId ${certId}`);
      const taskUrl = certId
        ? `${process.env.APP_URL}/x/${wave}?cert=${certId}`
        : `${process.env.APP_URL}/x/${wave}`;

      let projectId = req.body?.projectId;
      if (!projectId) {
        const list = await listProjects().catch(() => null);
        projectId =
          list?.projects?.[0]?.id ??
          list?.data?.[0]?.id ??
          (await createProject("Coverage engine")).id;
      }

      const body = opportunityBody({ projectId, taskUrl, participants, minutes, days, claimsPerTask });
      if (feasibilityRequestId) body.feasibility_request_id = feasibilityRequestId;
      const draft = await createOpportunity(body);
      const id = draft.id ?? draft?.opportunity?.id;
      const full = await getOpportunity(id).catch(() => draft);
      const pricing = full?.pricing ?? draft?.pricing ?? null;
      const cost = pricing?.total_cost_cents ?? null;
      // A DRAFT price is an autonomous estimate and is not what Terac ends up charging:
      // the first wave was drafted at 1350/participant and settled at 169. Store what is
      // quoted, but treat it as provisional until refreshFromTerac() reads it back.
      const cpi = pricing?.cost_per_participant_cents ?? null;
      const dash =
        full?.links?.dashboard?.draft_editor ?? full?.links?.dashboard?.submissions ?? null;

      await query(
        `insert into terac_opportunities
           (id, wave, status, participants, claims_per_task, minutes, cost_cents, cpi_cents, task_url, dashboard_url)
         values ($1,$2,'draft',$3,$4,$5,$6,$7,$8,$9)
         on conflict (id) do update set status='draft',
           cost_cents=excluded.cost_cents, cpi_cents=excluded.cpi_cents`,
        [id, wave, participants, claimsPerTask, minutes, cost, cpi, taskUrl, dash],
      );

      const judgments = participants * claimsPerTask;
      res.status(201).json({
        id,
        wave,
        participants,
        claims_per_task: claimsPerTask,
        judgments,
        task_url: taskUrl,
        cost_cents: cost,
        cost: money(cost),
        cost_per_judgment: cost ? `$${(cost / 100 / judgments).toFixed(3)}` : null,
        dashboard_url: dash,
        pricing: full?.pricing ?? null,
      });
    } catch (err) {
      console.error("draft failed:", err.message);
      res.status(502).json({ error: err.message, detail: err.body ?? null });
    }
  });

  /** SPENDS REAL MONEY. Reached only by the operator clicking Launch in /ops. */
  app.post("/api/ops/launch", json, async (req, res) => {
    try {
      const id = req.body?.opportunityId;
      if (!id) return res.status(400).json({ error: "opportunityId is required" });
      const out = await launchOpportunity(id);
      // The draft estimate is superseded at launch, so read the settled price back rather
      // than keeping a number that was never charged.
      let settled = out?.pricing ?? null;
      if (!settled?.cost_per_participant_cents) {
        settled = (await getOpportunity(id).catch(() => null))?.pricing ?? settled;
      }
      await query(
        `update terac_opportunities
            set status='active', launched_at=now(),
                cost_cents = coalesce($2, cost_cents),
                cpi_cents  = coalesce($3, cpi_cents)
          where id=$1`,
        [id, settled?.total_cost_cents ?? null, settled?.cost_per_participant_cents ?? null],
      );
      res.json({ ok: true, opportunity: out });
    } catch (err) {
      console.error("launch failed:", err.message);
      res.status(502).json({ error: err.message, detail: err.body ?? null });
    }
  });

  app.post("/api/ops/stop", json, async (req, res) => {
    try {
      const id = req.body?.opportunityId;
      await stopOpportunity(id);
      await query(`update terac_opportunities set status='stopped' where id=$1`, [id]);
      res.json({ ok: true });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  app.get("/api/ops/submissions/:id", async (req, res) => {
    try {
      res.json(await getSubmissions(req.params.id, "?limit=100"));
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  app.get("/ops", async (_req, res) => {
    try {
      res.type("html").send(opsPage(await opsState()));
    } catch (err) {
      res.status(500).send(`<pre>${err.message}</pre>`);
    }
  });
}

function opsPage(s) {
  const live = s.opportunities.find((o) => o.status === "active");
  const draft = s.opportunities.find((o) => o.status === "draft");
  const need = nMin(s.floor);
  const floorPct = (s.floor * 100).toFixed(0);
  // Tag colour is presentation only: .tag borders in currentColor, so the utility class
  // colours the ring and the text together.
  const tone = (l) =>
    l === "LICENSED" ? "ok" : l === "RULED OUT" ? "bad" : l === "UNMEASURED" ? "dim" : "warn";
  const statusTone = (st) => (st === "active" ? "ok" : st === "draft" ? "warn" : "dim");

  const extraCss = `
.row input{width:120px}
.callout{margin:18px 0 0}
.callout .line{color:var(--fg);font-size:14px;margin-top:6px}
.callout .meta{color:var(--mut);font-size:12px;margin-top:5px;word-break:break-all}
.callout h3{font-size:10.5px;text-transform:uppercase;letter-spacing:.09em;font-weight:600;margin:0}
.tbl{overflow-x:auto}
`;

  const body = `
<h1>Operator</h1>
<p class="lede">Plan a calibration wave against a budget, price it with a human, and dispatch it.</p>
<p class="sub">Readiness is the Wilson 95% lower bound over independent field judgements, against a
${floorPct}% floor. Everything on this page is free except <b>Launch</b>.</p>

<h2>Evidence on hand</h2>
<div class="grid">
  <div><label>Fields judged</label><div class="big">${s.total_attestations}</div></div>
  <div><label>Completed tasks</label><div class="big">${s.completed_tasks}</div></div>
  <div><label>Tasks opened</label><div class="big">${s.opened_tasks}</div></div>
  <div><label>Certificates</label><div class="big">${s.corpus.length}</div></div>
</div>
<p class="sowhat">Judgments, not participants, are what buy readiness: <b>a field needs ${need}
independent clean readings before even perfect agreement can license it</b>. Read Fields judged
against that bar to see how many fields this console could decide today, and read Tasks opened
against Completed — that gap is recruitment already paid for that returned no evidence.</p>

<h2>Certificates</h2>
<div class="card"><div class="tbl"><table>
<thead><tr><th>Certificate</th><th>Primary ratio</th><th class="num">Fields</th>
<th class="num">Extractions</th><th class="num">Fields correct</th><th>Readiness</th><th>Evidence</th></tr></thead>
<tbody>
${s.corpus
  .map(
    (c) => `<tr>
  <td>${c.name}</td><td class="mut">${c.expertise_area}</td>
  <td class="num">${c.claims}</td><td class="num">${c.rated_claims}</td><td class="num">${c.agreed}</td>
  <td><b>${c.theta.toFixed(3)}</b> <span class="tag ${tone(c.label)}">${c.label}</span></td>
  <td><span class="tag ${c.evidence_mode === "live" ? "ok" : "warn"}">${c.evidence_mode.toUpperCase()}</span></td>
</tr>`,
  )
  .join("")}
</tbody>
</table></div>
<p class="sowhat">Readiness is a lower bound, so <b>0.000 means unmeasured, not unreliable</b> — a
certificate nobody has extracted cannot inherit readiness it was never tested for. Only two labels
change what you do: LICENSED means stop paying a human to read that certificate's fields, RULED OUT
means stop trying. Everything between them is <b>evidence you have not bought yet</b>, and ruling a
field out costs a fraction of what licensing one costs.</p>
</div>

<h2>Plan the wave</h2>
<div class="card">
  <p class="sub" style="margin-bottom:14px">
    The participant is the expensive unit, not their time. CPI floors near <b>$9–12</b> and is
    almost flat in duration above ten minutes, so <b>claims per task</b> — not participant count —
    is the lever on cost per judgment. Nothing here contacts Terac or spends anything.
  </p>
  <div class="row">
    <div><label>Budget ($)</label><input id="p_budget" type="number" value="125" min="1"></div>
    <div><label>CPI ($/participant)</label><input id="p_cpi" type="number" value="12" min="0.25" step="0.25"></div>
    <div><label>Claims / task</label><input id="p_claims" type="number" value="20" min="1" max="60"></div>
    <button class="ghost" onclick="plan()">Model it</button>
  </div>
  <div id="planout" style="margin-top:16px"></div>
</div>

<h2>Price it with a human</h2>
<div class="card">
  <p class="sub" style="margin-bottom:12px">
    A feasibility request puts a human at Terac on the price, and a confirmed CPI can be bound to a
    draft — the only way to argue this task is simpler, and cheaper, than it looks. Costs nothing.
  </p>
  <div class="row">
    <div><label>Participants to price</label><input id="f_count" type="number" value="10" min="1"></div>
    <button class="ghost" onclick="feas()">Request human pricing</button>
  </div>
  <pre id="feasout" style="display:none"></pre>
  <p class="sowhat"><b>A draft price is an autonomous estimate, not what Terac charges</b> — the last
  wave was drafted at one price and settled far below it. So a wave sized against the estimate can be
  wrong about what the budget buys before a single reader is recruited. If a confirmed price comes
  back different, re-run the plan above before drafting: it changes which verdict row you can afford.</p>
</div>

<h2>Dispatch</h2>
<div class="card">
  <div class="row">
    <div><label>Participants</label><input id="participants" type="number" value="6" min="1" max="1000"></div>
    <div><label>Claims / task</label><input id="claimsPerTask" type="number" value="20" min="1" max="60"></div>
    <div><label>Minutes / task</label><input id="minutes" type="number" value="10" min="1"></div>
    <div><label>Window (days, min 5)</label><input id="days" type="number" value="5" min="5"></div>
    <button class="ghost" onclick="draftIt()">Build draft (free)</button>
  </div>
  <pre id="draftout" style="display:none"></pre>
  ${
    draft
      ? `<div class="banner syn callout">
      <h3>Draft ready — launching spends real money</h3>
      <div class="line"><b>${draft.participants}</b> participants · <b>${money(draft.cost_cents) ?? "price on draft"}</b> · wave <code>${draft.wave}</code></div>
      <div class="meta">task_url: ${draft.task_url}</div>
      ${draft.dashboard_url ? `<div class="meta"><a href="${draft.dashboard_url}" target="_blank">Review draft in Terac dashboard →</a></div>` : ""}
      <div style="margin-top:12px"><button onclick="launchIt('${draft.id}')">Launch — begin recruiting</button></div>
    </div>
    <p class="sowhat">This is the last free step. <b>Launch is the only control on this page that
    spends money</b>, and stopping later does not refund readings already claimed. The figure above is
    the draft estimate rather than the charge — the settled number is only read back after launch — so
    decide on the shape of the wave, not on that price.</p>`
      : `<p class="sowhat">No draft yet. A draft costs nothing and starts no recruitment, so
    <b>there is no reason to plan a wave you have not drafted</b> — the draft is where Terac first
    tells you a price to argue with.</p>`
  }
  ${
    live
      ? `<div class="banner live callout">
      <h3>Live · recruiting</h3>
      <div class="line"><code>${live.id}</code> · ${live.participants} participants · ${money(live.cost_cents) ?? ""}</div>
      <div style="margin-top:12px"><button class="danger" onclick="stopIt('${live.id}')">Stop recruiting</button></div>
    </div>
    <p class="sowhat"><b>The cost is already committed; what is still open is whether the readings
    arrive.</b> Stop when Fields judged at the top of this page has moved far enough to decide a
    field — not when the wave merely looks slow. Stopping early keeps the money already spent and
    forfeits the evidence it was meant to buy.</p>`
      : ""
  }
</div>

<h2>Wave ledger</h2>
<div class="card"><div class="tbl"><table>
<thead><tr><th>ID</th><th>Wave</th><th>Status</th><th class="num">Participants</th>
<th class="num">Cost</th><th class="num">Created</th></tr></thead>
<tbody>
${
  s.opportunities.length
    ? s.opportunities
        .map(
          (o) => `<tr><td><code>${o.id.slice(0, 12)}…</code></td><td>${o.wave}</td>
    <td><span class="tag ${statusTone(o.status)}">${o.status}</span></td>
    <td class="num">${o.participants ?? "—"}</td><td class="num">${money(o.cost_cents) ?? "—"}</td>
    <td class="num mut">${new Date(o.created_at).toLocaleTimeString()}</td></tr>`,
        )
        .join("")
    : `<tr><td colspan="6" class="dim">none yet</td></tr>`
}
</tbody>
</table></div>
<p class="sowhat">This is the spend ledger, not the evidence: <b>a wave's cost is committed the
moment its status reads active</b>, and nothing in these columns says whether the readings arrived.
Read cost here against Fields judged at the top — a wave that cost money without moving that counter
is the one to stop, and the reason to buy more claims per task next time rather than more people.</p>
</div>
`;

  const script = `
const out=(id,v)=>{const e=document.getElementById(id);e.style.display="block";e.textContent=typeof v==="string"?v:JSON.stringify(v,null,2)};
async function post(u,b){const r=await fetch(u,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(b||{})});return[r.ok,await r.json()]}
async function draftIt(){
  out("draftout","building draft…");
  const[ok,j]=await post("/api/ops/draft",{participants:+participants.value,minutes:+minutes.value,days:+days.value,claimsPerTask:+claimsPerTask.value});
  out("draftout",j); if(ok)setTimeout(()=>location.reload(),900);
}
async function feas(){
  out("feasout","requesting human pricing…");
  const[,j]=await post("/api/ops/feasibility",{count:+f_count.value}); out("feasout",j);
}
const fmt=c=>"$"+(c/100).toFixed(2);
async function plan(){
  const[,j]=await post("/api/ops/plan",{budgetCents:Math.round(+p_budget.value*100),cpiCents:Math.round(+p_cpi.value*100),claimsPerTask:+p_claims.value});
  const rows=j.sweep.map(o=>{
    const verdict=o.can_license?'<span class="tag ok">can license</span>':(o.can_rule_out?'<span class="tag warn">rule-out only</span>':'<span class="tag bad">concludes nothing</span>');
    return \`<tr><td class="num"><b>\${o.claims_per_task}</b></td><td class="num">\${o.participants}</td><td class="num">\${o.judgments}</td>
      <td class="num">\${o.claims_per_process}</td><td class="num">\${fmt(o.cost_cents)}</td>
      <td class="num">\${(o.cost_per_judgment_cents/100).toFixed(3)}</td><td>\${verdict}</td></tr>\`;
  }).join("");
  const people=j.sweep.length?j.sweep[0].participants:0;
  document.getElementById("planout").innerHTML=
    \`<div class="tbl"><table><thead><tr><th class="num">Claims/task</th><th class="num">People</th><th class="num">Judgments</th><th class="num">Claims/process</th><th class="num">Cost</th><th class="num">$/judgment</th><th>Verdict</th></tr></thead><tbody>\${rows}</tbody></table></div>
     <p class="sowhat"><b>Read the Verdict column first — every row here costs the same, so a row that
     concludes nothing is the whole budget spent on an answer you cannot use.</b> The budget buys the
     same \${people} people whichever row you pick, which makes claims per task the only lever that
     changes what the wave can conclude: a process needs \${j.n_min_to_license} independent claims
     before even perfect agreement lifts the Wilson lower bound to the \${(100*${FLOOR}).toFixed(0)}% floor.
     <b>Take the topmost row that says "can license"</b>; if none does, this budget can only rule
     processes out, and the fix is fewer, longer tasks rather than more people.</p>\`;
}
plan();
async function launchIt(id){
  if(!confirm("Launch this wave? This spends real money from the Terac balance and begins recruiting.")) return;
  const[ok,j]=await post("/api/ops/launch",{opportunityId:id});
  out("draftout",j); if(ok)setTimeout(()=>location.reload(),900);
}
async function stopIt(id){
  if(!confirm("Stop recruiting on this wave?")) return;
  const[ok,j]=await post("/api/ops/stop",{opportunityId:id}); out("draftout",j); if(ok)setTimeout(()=>location.reload(),900);
}
setInterval(async()=>{
  const s=await (await fetch("/api/ops/state")).json();
  if(s.total_attestations!==${s.total_attestations}) location.reload();
},7000);
`;

  return page({
    title: "Coverage Engine — Operator",
    current: "/ops",
    body,
    extraCss,
    script,
  });
}
