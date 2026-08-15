import express from "express";
import { query } from "./db.mjs";
import { propose, PROCESSES, PROPOSER } from "./experiment.mjs";
import { wilson, nMin } from "./readiness.mjs";

/**
 * The experiment design surface.
 *
 * An agreement number is only meaningful if you can see what each side was actually asked.
 * This page puts the agent's task and the human's task side by side on the SAME claim, so a
 * designer can judge whether the comparison is fair before spending anything on it.
 */

const ANSWERS = [
  { key: "AGREE", label: "Agree", blurb: "The excerpt supports the statement as written." },
  { key: "CORRECT", label: "Correct", blurb: "A bounded replacement value is supported instead." },
  { key: "INSUFFICIENT", label: "Insufficient", blurb: "The excerpt does not establish an answer." },
  { key: "RECUSE", label: "Recuse", blurb: "Conflict or expertise boundary prevents judgment." },
];

const HUMAN_INSTRUCTIONS =
  "Read the excerpt. Decide whether it supports the statement, contradicts it, or does not " +
  "say enough to tell. Answer only from the excerpt shown — do not search for anything else.";

/** What the agent is given, stated plainly enough to argue with. */
const AGENT_SPEC = {
  name: PROPOSER,
  sees: "The same excerpt text and the same statement. Nothing else — no deal, no client, no history.",
  does: [
    "Extract the named figures with a regular expression (EBITDA, funded debt, the covenant cap, the tested date, the carried limit).",
    "Apply the covenant rule arithmetically.",
    "Emit supported / not_supported / insufficient with a confidence.",
  ],
  blindspot:
    "It never checks whether a required figure was present. When one is missing it falls through to the common case and reports HIGH confidence (0.91) on an answer it cannot justify. That is the failure the human is being bought to expose.",
};

export function registerDesignRoutes(app) {
  const json = express.json();

  app.get("/api/design/sample", async (req, res) => {
    try {
      const processId = req.query.process ?? PROCESSES[0].id;
      const tier = req.query.tier ?? "balanced";
      const { rows } = await query(
        `select c.*, p.name as process_name, p.expertise_area
           from claims c join processes p on p.id = c.process_id
          where c.process_id = $1 order by random() limit 1`,
        [processId],
      );
      if (!rows.length) return res.status(404).json({ error: "no claims for that process" });
      const claim = rows[0];
      const machine = propose(claim, tier);
      res.json({
        claim,
        machine,
        agrees: machine.disposition === claim.ground_truth,
        answers: ANSWERS,
        human_instructions: HUMAN_INSTRUCTIONS,
        agent_spec: AGENT_SPEC,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /** Target-first planning: say the floor you want, see what reaching it costs. */
  app.post("/api/design/target", json, async (req, res) => {
    const floor = Math.min(0.999, Math.max(0.5, Number(req.body?.floor) || 0.9));
    const cpi = Math.max(1, Number(req.body?.cpiCents) || 1200);
    const budget = Math.max(0, Number(req.body?.budgetCents) || 12500);
    const processes = Math.max(1, Number(req.body?.processes) || 3);
    const need = nMin(floor);
    const rows = [];
    for (const c of [4, 10, 20, 30, 40]) {
      const people = Math.floor(budget / cpi);
      const perProcess = Math.floor((people * c) / processes);
      rows.push({
        claims_per_task: c,
        people,
        claims_per_process: perProcess,
        cost_cents: people * cpi,
        reaches_target: perProcess >= need,
        // With one disagreement, how much evidence would it take instead?
        need_with_one_miss: (() => {
          for (let n = need; n < 5000; n++) if (wilson(n - 1, n)[0] >= floor) return n;
          return null;
        })(),
      });
    }
    res.json({ floor, n_min: need, budget_cents: budget, cpi_cents: cpi, options: rows });
  });

  app.get("/design", async (req, res) => {
    try {
      const processId = req.query.process ?? PROCESSES[0].id;
      const { rows: procs } = await query(`select id, name, expertise_area from processes order by name`);
      res.type("html").send(designPage({ procs, processId }));
    } catch (err) {
      res.status(500).send(`<pre>${err.message}</pre>`);
    }
  });
}

function designPage({ procs, processId }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Experiment Designer</title><style>
:root{color-scheme:light dark;--bg:#0c0c0d;--fg:#f4f4f5;--mut:#a1a1aa;--line:#27272a;--card:#161617;--ok:#4ade80;--warn:#fbbf24;--bad:#f87171;--acc:#60a5fa;--agent:#c084fc}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
.wrap{max-width:1180px;margin:0 auto;padding:26px 20px 90px}
h1{font-size:22px;margin:0 0 2px}h2{font-size:12px;text-transform:uppercase;letter-spacing:.1em;color:var(--mut);margin:30px 0 10px}
.sub{color:var(--mut);font-size:13px;margin:0 0 18px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:14px}
@media(max-width:860px){.cols{grid-template-columns:1fr}}
.pane{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px}
.pane.agent{border-color:var(--agent)}.pane.human{border-color:var(--acc)}
.who{font-size:11px;letter-spacing:.1em;text-transform:uppercase;margin-bottom:10px}
.who.agent{color:var(--agent)}.who.human{color:var(--acc)}
.ev{background:#0c0c0d;border:1px solid var(--line);border-radius:8px;padding:12px;font-size:13.5px;line-height:1.6}
.stmt{margin-top:10px;padding:10px 12px;border-left:2px solid var(--mut);color:var(--fg)}
ol,ul{margin:8px 0 0;padding-left:20px;font-size:13.5px;color:var(--mut)}li{margin:4px 0}
.opt{border:1px solid var(--line);border-radius:8px;padding:9px 11px;margin-top:7px}
.opt b{display:block;font-size:13px}.opt span{font-size:12px;color:var(--mut)}
.verdict{margin-top:12px;padding:11px 13px;border-radius:8px;border:1px solid var(--line);font-size:13.5px}
.row{display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap}
label{font-size:12px;color:var(--mut);display:block;margin-bottom:4px}
select,input{background:#0c0c0d;color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:8px 10px;font:inherit}
input{width:92px}
button{background:var(--acc);color:#06121f;border:0;border-radius:8px;padding:9px 15px;font-weight:600;cursor:pointer;font:inherit;font-weight:600}
button.ghost{background:transparent;color:var(--fg);border:1px solid var(--line)}
table{width:100%;border-collapse:collapse;font-size:13.5px;margin-top:10px}
th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--mut);padding:6px 8px;border-bottom:1px solid var(--line);font-weight:500}
td{padding:7px 8px;border-bottom:1px solid var(--line)}tr:last-child td{border-bottom:0}
.ok{color:var(--ok)}.warn{color:var(--warn)}.bad{color:var(--bad)}.mut{color:var(--mut)}
code{font-size:12.5px}
a{color:var(--acc)}
.note{font-size:12.5px;color:var(--mut);margin-top:10px}
</style></head><body><div class="wrap">
<nav style="display:flex;gap:18px;margin:0 0 22px;padding-bottom:12px;border-bottom:1px solid var(--line);font-size:13px"><a href="/" style="color:var(--mut)">Coverage board</a><a href="/ops" style="color:var(--mut)">Operator</a><a href="/design" style="color:var(--acc)">Designer</a><span style="flex:1"></span><a href="/healthz" style="color:var(--mut)">health</a></nav>
<h1>Experiment Designer</h1>
<p class="sub">Both sides of one comparison, on the same claim. If the two tasks are not really the same question, the agreement number means nothing — so look before you buy.</p>

<h2>1 · What are we comparing?</h2>
<div class="card">
  <div class="row">
    <div><label>Process</label><select id="proc">
      ${procs.map((p) => `<option value="${p.id}"${p.id === processId ? " selected" : ""}>${p.name} — ${p.expertise_area}</option>`).join("")}
    </select></div>
    <div><label>Agent tier</label><select id="tier">
      <option value="economy">economy</option><option value="balanced" selected>balanced</option><option value="frontier">frontier</option>
    </select></div>
    <button class="ghost" onclick="load()">Draw another claim</button>
  </div>
</div>

<div id="side" style="margin-top:14px"></div>

<h2>2 · What do you want to get to?</h2>
<div class="card">
  <p class="sub" style="margin:0 0 12px">Set the target first, then see which designs can actually reach it. A design that cannot reach your target is not cheap — it is worthless.</p>
  <div class="row">
    <div><label>Target floor (%)</label><input id="floor" type="number" value="90" min="50" max="99.5" step="0.5"></div>
    <div><label>Budget ($)</label><input id="budget" type="number" value="125"></div>
    <div><label>CPI ($)</label><input id="cpi" type="number" value="12" step="0.25"></div>
    <button class="ghost" onclick="target()">Show me what reaches it</button>
  </div>
  <div id="tgt"></div>
</div>

<script>
const esc=s=>String(s).replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));
async function load(){
  const r=await fetch("/api/design/sample?process="+proc.value+"&tier="+tier.value);
  const d=await r.json();
  if(d.error){document.getElementById("side").innerHTML='<div class="card bad">'+d.error+'</div>';return}
  const c=d.claim, m=d.machine;
  const agreeTxt = d.agrees
    ? '<span class="ok">matches ground truth</span>'
    : '<span class="bad">WRONG — ground truth is '+c.ground_truth+'</span>';
  document.getElementById("side").innerHTML = \`
  <div class="cols">
    <div class="pane agent">
      <div class="who agent">The agent · \${esc(d.agent_spec.name)}</div>
      <div class="ev">\${esc(c.evidence)}</div>
      <div class="stmt">\${esc(c.proposition)}</div>
      <p class="note"><strong>Sees:</strong> \${esc(d.agent_spec.sees)}</p>
      <p class="note"><strong>Does:</strong></p><ol>\${d.agent_spec.does.map(x=>'<li>'+esc(x)+'</li>').join("")}</ol>
      <div class="verdict">
        answered <strong>\${esc(m.disposition)}</strong> at confidence <strong>\${m.confidence}</strong> · \${agreeTxt}
        <div class="note" style="margin-top:6px">cost \$\${m.cost_usd.toFixed(2)} per claim</div>
      </div>
      <p class="note"><strong class="warn">Known blind spot:</strong> \${esc(d.agent_spec.blindspot)}</p>
    </div>
    <div class="pane human">
      <div class="who human">The human · paid panellist</div>
      <div class="ev">\${esc(c.evidence)}</div>
      <div class="stmt">\${esc(c.proposition)}</div>
      <p class="note"><strong>Told:</strong> \${esc(d.human_instructions)}</p>
      <p class="note"><strong>Chooses one of:</strong></p>
      \${d.answers.map(a=>'<div class="opt"><b>'+esc(a.label)+'</b><span>'+esc(a.blurb)+'</span></div>').join("")}
      <p class="note" style="margin-top:12px">Never sees: the deal, the client, the borrower, any other claim, the agent's answer, or the ground truth.</p>
    </div>
  </div>
  <div class="card" style="margin-top:14px">
    <strong>The asymmetry to be honest about.</strong>
    <ul>
      <li>Identical inputs — same excerpt, same statement, same four options. That is what makes the comparison fair.</li>
      <li>The agent answers in milliseconds for \$\${m.cost_usd.toFixed(2)}; the human takes ~30 seconds and costs roughly \$0.60 at 20 claims per task.</li>
      <li>Neither is graded against the other. Both are graded against ground truth we authored, which is why the corpus has to be synthetic.</li>
      <li class="warn">The human is not a referee for this claim — they are evidence about the agent's reliability on this KIND of claim. That is why n matters more than any single disagreement.</li>
    </ul>
  </div>\`;
}
async function target(){
  const r=await fetch("/api/design/target",{method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({floor:+floor.value/100,budgetCents:Math.round(+budget.value*100),cpiCents:Math.round(+cpi.value*100)})});
  const d=await r.json();
  document.getElementById("tgt").innerHTML=\`
  <p class="note">To claim <strong>\${(d.floor*100).toFixed(1)}%</strong> you need at least <strong>\${d.n_min}</strong> perfectly-agreed claims per process. One disagreement and it becomes <strong>\${d.options[0].need_with_one_miss ?? "—"}</strong>.</p>
  <table><tr><th>Claims/task</th><th>People</th><th>Claims per process</th><th>Cost</th><th>Reaches target?</th></tr>
  \${d.options.map(o=>'<tr><td><strong>'+o.claims_per_task+'</strong></td><td>'+o.people+'</td><td>'+o.claims_per_process+'</td><td>\$'+(o.cost_cents/100).toFixed(2)+'</td><td>'+(o.reaches_target?'<span class="ok">yes</span>':'<span class="bad">cannot — rule-out only</span>')+'</td></tr>').join("")}
  </table>\`;
}
load(); target();
</script>
</div></body></html>`;
}
