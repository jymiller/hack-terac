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
  const pct = (x) => (x == null ? "—" : (x * 100).toFixed(1) + "%");

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Coverage Engine — Operator</title><style>
:root{color-scheme:light dark;--bg:#0c0c0d;--fg:#f4f4f5;--mut:#a1a1aa;--line:#27272a;--card:#161617;--ok:#4ade80;--warn:#fbbf24;--bad:#f87171;--acc:#60a5fa}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
.wrap{max-width:1080px;margin:0 auto;padding:28px 20px 80px}
nav{display:flex;gap:18px;flex-wrap:wrap;margin:0 0 24px;padding-bottom:12px;border-bottom:1px solid var(--line);font-size:13px}
nav a{color:var(--mut);text-decoration:none}nav a.on{color:var(--fg)}
h1{font-size:22px;margin:0 0 2px}h2{font-size:12px;text-transform:uppercase;letter-spacing:.1em;color:var(--mut);margin:32px 0 10px}
.sub{color:var(--mut);margin:0 0 20px;font-size:13px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin-bottom:14px}
table{width:100%;border-collapse:collapse;font-size:14px}th{text-align:left;font-weight:500;color:var(--mut);font-size:11px;text-transform:uppercase;letter-spacing:.06em;padding:6px 8px;border-bottom:1px solid var(--line)}
td{padding:8px;border-bottom:1px solid var(--line)}tr:last-child td{border-bottom:0}
.tag{display:inline-block;font-size:10px;letter-spacing:.06em;padding:2px 7px;border-radius:99px;border:1px solid var(--line);color:var(--mut)}
.tag.live{color:var(--ok);border-color:var(--ok)}.tag.syn{color:var(--warn);border-color:var(--warn)}
button{background:var(--acc);color:#06121f;border:0;border-radius:8px;padding:9px 16px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit}
button.ghost{background:transparent;color:var(--fg);border:1px solid var(--line)}
button.danger{background:var(--bad);color:#1b0505}
button:disabled{opacity:.35;cursor:not-allowed}
input{background:#0c0c0d;color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:8px 10px;font:inherit;width:90px}
label{font-size:12px;color:var(--mut);display:block;margin-bottom:4px}
.row{display:flex;gap:14px;align-items:flex-end;flex-wrap:wrap}
.big{font-size:26px;font-variant-numeric:tabular-nums}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
pre{background:#0c0c0d;border:1px solid var(--line);border-radius:8px;padding:12px;overflow:auto;font-size:12px;margin:10px 0 0}
a{color:var(--acc)}
.warn{color:var(--warn)}.ok{color:var(--ok)}.bad{color:var(--bad)}
</style></head><body><div class="wrap">
<nav><a href="/">Coverage board</a><a href="/ops" class="on">Operator</a><a href="/design">Designer</a><a href="/funnel">Funnel</a><a href="/results">Results</a><a href="/support">Support</a></nav>
<h1>Coverage Engine — Operator</h1>
<p class="sub">Dispatch calibration waves. Readiness is the Wilson 95% lower bound over independent field judgements, against a ${(s.floor * 100).toFixed(0)}% floor.</p>

<div class="card"><div class="grid">
  <div><label>Completed tasks</label><div class="big">${s.completed_tasks}</div></div>
  <div><label>Fields judged</label><div class="big">${s.total_attestations}</div></div>
  <div><label>Tasks opened</label><div class="big">${s.opened_tasks}</div></div>
  <div><label>Certificates</label><div class="big">${s.corpus.length}</div></div>
</div></div>

<h2>Certificates</h2>
<div class="card"><table>
<tr><th>Certificate</th><th>Primary ratio</th><th>Fields</th><th>Extractions</th><th>Fields correct</th><th>Readiness</th><th>Evidence</th></tr>
${s.corpus
  .map(
    (c) => `<tr>
  <td>${c.name}</td><td style="color:var(--mut)">${c.expertise_area}</td>
  <td>${c.claims}</td><td>${c.rated_claims}</td><td>${c.agreed}</td>
  <td><strong>${c.theta.toFixed(3)}</strong> <span class="tag">${c.label}</span></td>
  <td><span class="tag ${c.evidence_mode === "live" ? "live" : "syn"}">${c.evidence_mode.toUpperCase()}</span></td>
</tr>`,
  )
  .join("")}
</table>
<p class="sub" style="margin:12px 0 0">A certificate nobody has extracted reports 0.000 by construction — it cannot inherit readiness it has not been measured for.</p>
</div>

<h2>Plan — what a wave can actually buy</h2>
<div class="card">
  <p class="sub" style="margin:0 0 14px">
    The participant is the expensive unit, not their time. CPI floors near <strong>$9–12</strong> and is
    almost flat in duration above ten minutes, so <strong>claims per task</strong> — not participant count —
    is the lever on cost per judgment. Nothing here contacts Terac or spends anything.
  </p>
  <div class="row">
    <div><label>Budget ($)</label><input id="p_budget" type="number" value="125" min="1"></div>
    <div><label>CPI ($/participant)</label><input id="p_cpi" type="number" value="12" min="0.25" step="0.25"></div>
    <div><label>Claims / task</label><input id="p_claims" type="number" value="20" min="1" max="60"></div>
    <button class="ghost" onclick="plan()">Model it</button>
  </div>
  <div id="planout" style="margin-top:14px"></div>
</div>

<h2>Price — ask a human instead of taking the estimate</h2>
<div class="card">
  <p class="sub" style="margin:0 0 12px">
    Draft pricing is an autonomous machine estimate. A feasibility request puts a human at Terac on it,
    and a confirmed CPI can be bound to a draft — which is the only way to argue this task is simpler,
    and cheaper, than it looks. Costs nothing.
  </p>
  <div class="row">
    <div><label>Participants to price</label><input id="f_count" type="number" value="10" min="1"></div>
    <button class="ghost" onclick="feas()">Request human pricing</button>
  </div>
  <pre id="feasout" style="display:none"></pre>
</div>

<h2>Dispatch a calibration wave</h2>
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
      ? `<div style="margin-top:14px;padding:14px;border:1px solid var(--warn);border-radius:10px">
      <div class="warn" style="font-size:12px;letter-spacing:.06em;text-transform:uppercase;margin-bottom:6px">Draft ready — launching spends real money</div>
      <div><strong>${draft.participants}</strong> participants · <strong>${money(draft.cost_cents) ?? "price on draft"}</strong> · wave <code>${draft.wave}</code></div>
      <div style="font-size:12px;color:var(--mut);margin-top:4px">task_url: ${draft.task_url}</div>
      ${draft.dashboard_url ? `<div style="margin-top:6px"><a href="${draft.dashboard_url}" target="_blank">Review draft in Terac dashboard →</a></div>` : ""}
      <div style="margin-top:12px"><button onclick="launchIt('${draft.id}')">Launch — begin recruiting</button></div>
    </div>`
      : `<p class="sub" style="margin:12px 0 0">No draft yet. A draft costs nothing and starts no recruitment.</p>`
  }
  ${
    live
      ? `<div style="margin-top:14px;padding:14px;border:1px solid var(--ok);border-radius:10px">
      <div class="ok" style="font-size:12px;letter-spacing:.06em;text-transform:uppercase">Live · recruiting</div>
      <div style="margin-top:4px"><code>${live.id}</code> · ${live.participants} participants · ${money(live.cost_cents) ?? ""}</div>
      <div style="margin-top:10px"><button class="danger" onclick="stopIt('${live.id}')">Stop recruiting</button></div>
    </div>`
      : ""
  }
</div>

<h2>Waves</h2>
<div class="card"><table>
<tr><th>ID</th><th>Wave</th><th>Status</th><th>Participants</th><th>Cost</th><th>Created</th></tr>
${
  s.opportunities.length
    ? s.opportunities
        .map(
          (o) => `<tr><td><code>${o.id.slice(0, 12)}…</code></td><td>${o.wave}</td>
    <td><span class="tag ${o.status === "active" ? "live" : ""}">${o.status}</span></td>
    <td>${o.participants ?? "—"}</td><td>${money(o.cost_cents) ?? "—"}</td>
    <td style="color:var(--mut)">${new Date(o.created_at).toLocaleTimeString()}</td></tr>`,
        )
        .join("")
    : `<tr><td colspan="6" style="color:var(--mut)">none yet</td></tr>`
}
</table></div>

<script>
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
    const verdict=o.can_license?'<span class="ok">can license</span>':(o.can_rule_out?'<span class="warn">rule-out only</span>':'<span class="bad">concludes nothing</span>');
    return \`<tr><td><strong>\${o.claims_per_task}</strong></td><td>\${o.participants}</td><td>\${o.judgments}</td>
      <td>\${o.claims_per_process}</td><td>\${fmt(o.cost_cents)}</td>
      <td>\${(o.cost_per_judgment_cents/100).toFixed(3)}</td><td>\${verdict}</td></tr>\`;
  }).join("");
  document.getElementById("planout").innerHTML=
    \`<table><tr><th>Claims/task</th><th>People</th><th>Judgments</th><th>Claims/process</th><th>Cost</th><th>$/judgment</th><th>Verdict</th></tr>\${rows}</table>
     <p class="sub" style="margin:12px 0 0">A process needs <strong>\${j.n_min_to_license} independent claims</strong> before even perfect agreement
     can push the Wilson lower bound to the \${(100*${FLOOR}).toFixed(0)}% floor. Below that, a wave can rule a process out but can never license one —
     so buying fewer, longer tasks is what makes licensing reachable at all.</p>\`;
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
</script>
</div></body></html>`;
}
