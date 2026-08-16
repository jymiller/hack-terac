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
  const [certRes, fieldRes, opps, openRes, waveRes] = await Promise.all([
    query(`select cert_id, count(*)::int as n,
                  sum(correct)::int as correct, sum(total)::int as total
             from extractions where source = 'human' group by 1`),
    query(`select detail from extractions where source = 'human'`),
    query(`select * from terac_opportunities order by created_at desc limit 5`),
    query(`select payload->>'status' as status, count(*)::int as n
             from terac_responses group by 1`),
    // Delivery per launched wave, from our own tables only. The funnel page joins Terac's
    // side for applied/screened; an operator glance does not need a network call to answer
    // "did the people we paid for turn up".
    query(`select o.wave, o.participants, o.cost_cents, o.cpi_cents, o.status,
             (select count(*)::int from terac_responses r where r.payload->>'wave' = o.wave) arrived,
             (select count(*)::int from extractions e where e.wave = o.wave and e.source='human') delivered
             from terac_opportunities o where o.launched_at is not null
             order by o.launched_at desc`),
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
    // Drafts built against a previous host are unlaunchable garbage, and the launch button
    // cannot be allowed to sit on one. The page needs the current host to tell them apart.
    app_url: process.env.APP_URL ?? null,
    opportunities: opps.rows,
    completed_tasks: done,
    opened_tasks: opened,
    waves: waveRes.rows,
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
  const need = nMin(s.floor);
  const floorPct = (s.floor * 100).toFixed(0);
  // Tag colour is presentation only: .tag borders in currentColor, so the utility class
  // colours the ring and the text together.
  const tone = (l) =>
    l === "LICENSED" ? "ok" : l === "RULED OUT" ? "bad" : l === "UNMEASURED" ? "dim" : "warn";
  const statusTone = (st) => (st === "active" ? "ok" : st === "draft" ? "warn" : "dim");
  // A draft is only launchable if its task_url points at the host we are actually serving.
  // Drafts left over from the cloudflared tunnel recruit people to a dead address, so they
  // are listed as stale rather than offered a launch button.
  const host = (u) => {
    try {
      return new URL(u).host;
    } catch {
      return null;
    }
  };
  const here = host(s.app_url);
  const launchable = (o) => here != null && host(o.task_url) === here;
  const draft = s.opportunities.find((o) => o.status === "draft" && launchable(o));
  const stale = s.opportunities.filter((o) => o.status === "draft" && !launchable(o));

  const extraCss = `
.row input{width:110px}
.strip{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:1px;background:var(--line);
  border:1px solid var(--line);border-radius:var(--r);overflow:hidden}
.strip > div{background:var(--card);padding:16px}
.strip .big{font-size:28px}
.strip .k{font-size:11.5px;color:var(--dim);margin-top:5px}
.live-dot{display:inline-block;width:7px;height:7px;border-radius:99px;background:var(--ok);
  margin-right:7px;vertical-align:1px}
.mini{display:flex;gap:2px;align-items:stretch;margin-top:12px}
.mini > div{flex:1;background:var(--card);border:1px solid var(--line);padding:11px 13px;border-radius:8px}
.mini .n{font-size:21px;font-variant-numeric:tabular-nums;font-weight:600}
.mini .l{font-size:11px;color:var(--dim);text-transform:uppercase;letter-spacing:.06em;margin-top:3px}
.mini .d{font-size:11.5px;color:var(--bad);margin-top:4px}
.act{display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:14px 16px;border-radius:var(--r);
  border:1px solid var(--line);background:var(--card);margin-bottom:10px}
.act .t{flex:1;min-width:240px;font-size:13.5px}
.act .t b{display:block;font-size:14px;margin-bottom:2px}
.act.go{border-color:var(--warn)}
.act.on{border-color:var(--ok)}
.quiet{color:var(--dim);font-size:13.5px;padding:14px 16px;border:1px dashed var(--line);border-radius:var(--r)}
details{border:1px solid var(--line);border-radius:var(--r);background:var(--card);margin-top:12px}
details summary{cursor:pointer;padding:13px 16px;font-size:12px;text-transform:uppercase;
  letter-spacing:.08em;color:var(--mut);font-weight:600;list-style:none}
details summary::-webkit-details-marker{display:none}
details summary::before{content:"› ";display:inline-block;transition:transform .15s}
details[open] summary::before{transform:rotate(90deg)}
details .inner{padding:0 16px 16px}
.tbl{overflow-x:auto}
.callout .meta{color:var(--mut);font-size:12px;margin-top:5px;word-break:break-all}
`;

  const w = s.waves?.[0] ?? null;
  const paid = w?.participants ?? 0;
  const arrived = w?.arrived ?? 0;
  const delivered = w?.delivered ?? 0;
  const committed = (s.waves ?? []).reduce((a, x) => a + Number(x.cost_cents ?? 0), 0);
  const deliveredAll = (s.waves ?? []).reduce((a, x) => a + Number(x.delivered ?? 0), 0);
  const perUsable = deliveredAll ? committed / deliveredAll : null;
  const decidable = s.corpus.filter((c) => c.label === "LICENSED" || c.label === "RULED OUT").length;

  const body = `
<h1>Operator</h1>
<p class="sub" style="margin-bottom:18px">${
    live
      ? `<span class="live-dot"></span>Wave <code>${live.wave}</code> is recruiting.`
      : draft
        ? "A draft is ready. Nothing is recruiting."
        : "Nothing is recruiting."
  } Everything here is free except <b>Launch</b>.</p>

<div class="strip">
  <div><label>Delivered, this wave</label><div class="big">${delivered}<span style="font-size:15px;color:var(--mut)">/${paid || "—"}</span></div>
    <div class="k">${deliveredAll} across every wave</div></div>
  <div><label>Committed</label><div class="big">${money(committed) ?? "$0.00"}</div>
    <div class="k">${w?.cpi_cents ? money(w.cpi_cents) + " per recruit" : "spend is committed at launch"}</div></div>
  <div><label>Per usable reading</label><div class="big ${perUsable && w?.cpi_cents && perUsable > w.cpi_cents * 2 ? "bad" : ""}">${money(perUsable) ?? "—"}</div>
    <div class="k">${
      perUsable && w?.cpi_cents
        ? `list price is ${money(w.cpi_cents)} — the gap is non-delivery`
        : "what a reading actually cost"
    }</div></div>
  <div><label>Fields decided</label><div class="big">${decidable}<span style="font-size:15px;color:var(--mut)">/${s.corpus.length}</span></div>
    <div class="k">${need} clean readings needed per field</div></div>
</div>

<div class="mini">
  <div><div class="n">${paid}</div><div class="l">Paid for</div></div>
  <div><div class="n">${arrived}</div><div class="l">Opened the task</div>${
    paid - arrived > 0 ? `<div class="d">−${paid - arrived} never arrived</div>` : ""
  }</div>
  <div><div class="n">${delivered}</div><div class="l">Delivered</div>${
    arrived - delivered > 0 ? `<div class="d">−${arrived - delivered} abandoned</div>` : ""
  }</div>
</div>

<h2>Needs you</h2>
${
  draft
    ? `<div class="act go"><div class="t"><b>Draft ready to launch</b>
    ${draft.participants} participants · ${money(draft.cost_cents) ?? "price on draft"} · wave <code>${draft.wave}</code>
    ${draft.dashboard_url ? `<div class="meta"><a href="${draft.dashboard_url}" target="_blank">Review in Terac →</a></div>` : ""}</div>
    <button onclick="launchIt('${draft.id}')">Launch</button></div>`
    : ""
}
${
  live
    ? `<div class="act on"><div class="t"><b>Recruiting now</b>
    ${live.participants} participants · ${money(live.cost_cents) ?? ""} · <code>${live.wave}</code></div>
    <button class="danger" onclick="stopIt('${live.id}')">Stop</button></div>`
    : ""
}
${
  stale.length
    ? `<div class="act"><div class="t"><b>${stale.length} draft${stale.length > 1 ? "s" : ""} cannot be launched</b>
    Built against a host we no longer serve — they would send readers to a dead address.
    ${stale.map((o) => `<code>${o.wave}</code>`).join(" ")}</div></div>`
    : ""
}
${!draft && !live && !stale.length ? `<div class="quiet">Nothing needs you. Build a draft below to start a wave.</div>` : ""}

<h2>Readiness by certificate</h2>
<div class="card"><div class="tbl"><table>
<thead><tr><th>Certificate</th><th class="num">Readings</th><th class="num">Fields correct</th>
<th>Readiness</th><th>Evidence</th></tr></thead>
<tbody>
${s.corpus
  .map(
    (c) => `<tr>
  <td>${c.name}<div class="dim" style="font-size:12px">${c.expertise_area}</div></td>
  <td class="num">${c.rated_claims}</td><td class="num">${c.agreed}/${c.judgments}</td>
  <td><b>${c.theta.toFixed(3)}</b> <span class="tag ${tone(c.label)}">${c.label}</span></td>
  <td><span class="tag ${c.evidence_mode === "live" ? "ok" : "warn"}">${c.evidence_mode.toUpperCase()}</span></td>
</tr>`,
  )
  .join("")}
</tbody>
</table></div></div>

<h2>Dispatch a wave</h2>
<div class="card">
  <div class="row">
    <div><label>Participants</label><input id="participants" type="number" value="5" min="1" max="1000"></div>
    <div><label>Minutes</label><input id="minutes" type="number" value="10" min="1"></div>
    <div><label>Window (days)</label><input id="days" type="number" value="5" min="5"></div>
    <div><label>Certificate</label><select id="certId">
      ${CERTS.map((c) => `<option value="${c.id}">${c.id} — ${c.pages}pp</option>`).join("")}
      <option value="">any (assigned by hash)</option>
    </select></div>
    <button class="ghost" onclick="draftIt()">Build draft</button>
    <div><label>Price check</label><input id="f_count" type="number" value="10" min="1"></div>
    <button class="ghost" onclick="feas()">Ask Terac to price it</button>
  </div>
  <pre id="draftout" style="display:none"></pre>
  <pre id="feasout" style="display:none"></pre>
</div>

<details>
  <summary>How to read this page</summary>
  <div class="inner">
    <p class="sowhat">Readiness is a Wilson 95% lower bound, so <b>0.000 means unmeasured, not
    unreliable</b> — a certificate nobody has read cannot inherit readiness it was never tested for.
    Only two labels change what you do: LICENSED means stop paying a human to read those fields,
    RULED OUT means stop trying. Everything between is <b>evidence you have not bought yet</b>.</p>
    <p class="sowhat">A field needs <b>${need} independent clean readings</b> before even perfect
    agreement can license it, which is why judgments rather than participants are what buy readiness.</p>
    <p class="sowhat"><b>Launch is the only control here that spends money</b>, and stopping later
    does not refund readings already claimed. The price on a draft is Terac's autonomous estimate, not
    the charge — the settled figure is only readable after launch, and the two have differed by 8×.</p>
    <p class="sowhat">Per usable reading is committed spend divided by readings that actually arrived.
    <b>When it runs far above the list price, the gap is recruitment that returned nothing</b> — which
    is a funnel problem, not a pricing one.</p>
  </div>
</details>

<details>
  <summary>Wave ledger</summary>
  <div class="inner"><div class="tbl"><table>
  <thead><tr><th>Wave</th><th>Status</th><th class="num">Participants</th>
  <th class="num">Cost</th><th class="num">Created</th></tr></thead>
  <tbody>
  ${
    s.opportunities.length
      ? s.opportunities
          .map(
            (o) => `<tr><td>${o.wave}</td>
      <td><span class="tag ${statusTone(o.status)}">${o.status}</span></td>
      <td class="num">${o.participants ?? "—"}</td><td class="num">${money(o.cost_cents) ?? "—"}</td>
      <td class="num mut">${new Date(o.created_at).toLocaleTimeString()}</td></tr>`,
          )
          .join("")
      : `<tr><td colspan="5" class="dim">none yet</td></tr>`
  }
  </tbody></table></div></div>
</details>
`;

  const script = `
const out=(id,v)=>{const e=document.getElementById(id);e.style.display="block";e.textContent=typeof v==="string"?v:JSON.stringify(v,null,2)};
async function post(u,b){const r=await fetch(u,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(b||{})});return[r.ok,await r.json()]}
async function draftIt(){
  out("draftout","building draft…");
  const[ok,j]=await post("/api/ops/draft",{participants:+participants.value,minutes:+minutes.value,days:+days.value,certId:certId.value});
  out("draftout",j); if(ok)setTimeout(()=>location.reload(),900);
}
async function feas(){
  out("feasout","requesting human pricing…");
  const[,j]=await post("/api/ops/feasibility",{count:+f_count.value}); out("feasout",j);
}
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
    title: "Operator",
    current: "/ops",
    body,
    extraCss,
    script,
  });
}
