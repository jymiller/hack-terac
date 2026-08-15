import express from "express";
import { query } from "./db.mjs";
import { CERTS, FIELDS, INSTRUCTION, byId } from "./certs.mjs";
import { SCHEMA_HINT } from "./models.mjs";
import { wilson, nMin } from "./readiness.mjs";

/**
 * The experiment design surface.
 *
 * An agreement number is only meaningful if you can see what each side was actually asked.
 * This page puts the document itself on the left — the same rendered pages the paid worker
 * gets at /x/:wave and the same ones the model is sent — and both arms of the comparison on
 * the right, so a designer can judge whether the comparison is fair before spending anything.
 *
 * It reads the live `extractions` rows, so what it shows is the experiment actually running,
 * not a description of one.
 */

const HUMAN_CPI_CENTS = 1350;

const esc = (s) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

async function compareState(certId, modelId) {
  const cert = byId(certId) ?? CERTS[0];
  const { rows } = await query(
    `select source, coalesce(model_id,'human') as who, answers, detail, correct, total, duration_ms
       from extractions where cert_id = $1 order by received_at desc`,
    [cert.id],
  ).catch(() => ({ rows: [] }));

  const models = rows.filter((r) => r.source === "model");
  const humans = rows.filter((r) => r.source === "human");
  return {
    cert,
    certs: CERTS,
    images: Array.from({ length: cert.pages }, (_, i) => `/docs/png/${cert.file}-${i + 1}.png`),
    agent: models.find((r) => r.who === modelId) ?? models[0] ?? null,
    agentChoices: [...new Set(models.map((r) => r.who))],
    human: humans[0] ?? null,
    humanCount: humans.length,
  };
}

export function registerDesignRoutes(app) {
  const json = express.json();

  app.get("/api/design/compare", async (req, res) => {
    try {
      const s = await compareState(req.query.cert, req.query.model);
      res.json({ ...s, instruction: INSTRUCTION, schema_hint: SCHEMA_HINT, fields: FIELDS });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /** Target-first planning: say the floor you want, see what reaching it costs. */
  app.post("/api/design/target", json, async (req, res) => {
    const floor = Math.min(0.999, Math.max(0.5, Number(req.body?.floor) || 0.9));
    const cpi = Math.max(1, Number(req.body?.cpiCents) || HUMAN_CPI_CENTS);
    const budget = Math.max(0, Number(req.body?.budgetCents) || 12500);
    const need = nMin(floor);
    const people = Math.floor(budget / cpi);

    // Each participant reads one certificate and answers every field on it exactly once, so
    // n for a field is just the number of participants who drew that certificate.
    const options = [1, 2, 3].map((certs) => {
      const perCert = Math.floor(people / certs);
      return {
        certificates: certs,
        participants: people,
        readings_per_field: perCert,
        cost_cents: people * cpi,
        reaches_target: perCert >= need,
        shortfall: Math.max(0, need - perCert),
      };
    });

    let withOneMiss = null;
    for (let n = need; n < 5000; n++) {
      if (wilson(n - 1, n)[0] >= floor) {
        withOneMiss = n;
        break;
      }
    }

    res.json({
      floor,
      n_min: need,
      need_with_one_miss: withOneMiss,
      cpi_cents: cpi,
      budget_cents: budget,
      cost_to_license_one_cert_cents: need * cpi,
      options,
    });
  });

  app.get("/design", async (req, res) => {
    try {
      res.type("html").send(designPage(await compareState(req.query.cert, req.query.model)));
    } catch (err) {
      res.status(500).send(`<pre>${esc(err.message)}</pre>`);
    }
  });
}

/** One row per field: ground truth beside what each reader actually reported. */
function answerRows(cert, agent, human) {
  return FIELDS.map((f) => {
    const cell = (row) => {
      if (!row) return `<td class="mut">—</td>`;
      const d = row.detail?.[f.key];
      if (!d) return `<td class="mut">—</td>`;
      const given = d.given === "" || d.given == null ? "(blank)" : d.given;
      if (d.correct) return `<td class="ok">${esc(given)}</td>`;
      return `<td class="bad">${esc(given)}${
        d.distractor ? `<div class="why">${esc(d.distractor)}</div>` : ""
      }</td>`;
    };
    return `<tr><td class="fname">${esc(f.label)}</td>
      <td class="truth">${esc(cert.truth[f.key])}</td>${cell(agent)}${cell(human)}</tr>`;
  }).join("");
}

function designPage(s) {
  const { cert, certs, images, agent, human, agentChoices, humanCount } = s;
  const short = (w) => String(w).replace(/^novita\//, "").replace(/^meta-llama\//, "").replace(/^qwen\//, "").replace(/^google\//, "");
  const score = (r) => (r ? `${r.correct}/${r.total}` : "no run yet");

  const traps = Object.entries(cert.distractors ?? {})
    .map(
      ([k, d]) =>
        `<li><strong>${esc(FIELDS.find((f) => f.key === k)?.label ?? k)}</strong> — the page also prints
         <code>${esc(d.value)}</code>. ${esc(d.why)}.</li>`,
    )
    .join("");

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Experiment Designer</title><style>
:root{color-scheme:light dark;--bg:#0c0c0d;--fg:#f4f4f5;--mut:#a1a1aa;--line:#27272a;--card:#161617;--ok:#4ade80;--warn:#fbbf24;--bad:#f87171;--acc:#60a5fa;--agent:#c084fc}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
.wrap{max-width:1240px;margin:0 auto;padding:26px 20px 90px}
nav{display:flex;gap:18px;flex-wrap:wrap;margin:0 0 24px;padding-bottom:12px;border-bottom:1px solid var(--line);font-size:13px}
nav a{color:var(--mut);text-decoration:none}nav a.on{color:var(--fg)}
h1{font-size:22px;margin:0 0 2px}h2{font-size:12px;text-transform:uppercase;letter-spacing:.1em;color:var(--mut);margin:30px 0 10px}
.sub{color:var(--mut);font-size:13px;margin:0 0 18px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px}
.split{display:grid;grid-template-columns:1.05fr 1fr;gap:16px;align-items:start}
@media(max-width:980px){.split{grid-template-columns:1fr}}
.doc{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:10px;position:sticky;top:14px;max-height:88vh;overflow:auto}
.doc img{width:100%;display:block;margin-bottom:10px;border:1px solid var(--line);border-radius:6px;background:#fff}
.pane{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin-bottom:14px}
.pane.agent{border-color:var(--agent)}.pane.human{border-color:var(--acc)}
.who{font-size:11px;letter-spacing:.1em;text-transform:uppercase;margin-bottom:10px}
.who.agent{color:var(--agent)}.who.human{color:var(--acc)}
.shared{border:1px dashed var(--line);border-radius:12px;padding:16px;margin-bottom:14px;background:var(--card)}
pre{white-space:pre-wrap;font:12.5px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--mut);margin:8px 0 0;
  background:#0c0c0d;border:1px solid var(--line);border-radius:8px;padding:12px;max-height:220px;overflow:auto}
ol,ul{margin:8px 0 0;padding-left:20px;font-size:13.5px;color:var(--mut)}li{margin:5px 0}
.row{display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap}
label{font-size:12px;color:var(--mut);display:block;margin-bottom:4px}
select,input{background:#0c0c0d;color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:8px 10px;font:inherit}
input{width:92px}
button{background:var(--acc);color:#06121f;border:0;border-radius:8px;padding:9px 15px;cursor:pointer;font:inherit;font-weight:600}
button.ghost{background:transparent;color:var(--fg);border:1px solid var(--line)}
table{width:100%;border-collapse:collapse;font-size:13.5px;margin-top:10px}
th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--mut);padding:6px 8px;border-bottom:1px solid var(--line);font-weight:500}
td{padding:7px 8px;border-bottom:1px solid var(--line);vertical-align:top}tr:last-child td{border-bottom:0}
.fname{color:var(--mut);white-space:nowrap}.truth{font-weight:600}
.why{font-size:11.5px;color:var(--mut);margin-top:3px;font-weight:400}
.ok{color:var(--ok)}.warn{color:var(--warn)}.bad{color:var(--bad)}.mut{color:var(--mut)}
.tag{font-size:10px;letter-spacing:.06em;padding:2px 8px;border-radius:99px;border:1px solid currentColor}
code{font-size:12.5px}
a{color:var(--acc)}
.note{font-size:12.5px;color:var(--mut);margin-top:10px}
</style></head><body><div class="wrap">
<nav><a href="/">Coverage board</a><a href="/ops">Operator</a><a href="/design" class="on">Designer</a><a href="/funnel">Funnel</a><a href="/results">Results</a><a href="/support">Support</a></nav>
<h1>Experiment Designer</h1>
<p class="sub">Both arms of the comparison, on the document itself. If the two readers are not really being asked the same question, the agreement number means nothing — so look before you buy.</p>

<h2>1 · What are we comparing?</h2>
<div class="card">
  <form class="row" method="get" action="/design">
    <div><label>Certificate</label><select name="cert">
      ${certs.map((c) => `<option value="${c.id}"${c.id === cert.id ? " selected" : ""}>${esc(c.entity)} — ${esc(c.truth.ratio_name)}</option>`).join("")}
    </select></div>
    ${
      agentChoices.length
        ? `<div><label>Agent</label><select name="model">
      ${agentChoices.map((m) => `<option value="${esc(m)}"${agent && m === agent.who ? " selected" : ""}>${esc(short(m))}</option>`).join("")}
    </select></div>`
        : ""
    }
    <button class="ghost" type="submit">Show this one</button>
  </form>
  <p class="note">${cert.pages} rendered pages. Both readers get all of them, in this order, with nothing extracted in advance
  and no region highlighted. Asking someone to confirm a value we already found measures whether they can read;
  asking them to find it measures the job.</p>
</div>

<div class="split" style="margin-top:14px">
  <div class="doc">${images.map((src) => `<img src="${src}" alt="Certificate page" loading="lazy">`).join("")}</div>
  <div>
    <div class="shared">
      <div class="who">Identical instruction · both readers</div>
      <pre>${esc(INSTRUCTION)}</pre>
      <p class="note">This is the same string in both arms — <code>INSTRUCTION</code> in
      <code>app/certs.mjs</code>, rendered into the worker's form and sent as the model's prompt.
      Neither side is told the ground truth, and neither is told that traps exist.</p>
    </div>

    <div class="pane agent">
      <div class="who agent">The agent · ${agent ? esc(short(agent.who)) : "no run on this certificate yet"}</div>
      <p class="note"><strong>Sees:</strong> the ${cert.pages} pages above as images, at full resolution, in one message.</p>
      <p class="note"><strong>Told:</strong> the instruction above, plus the reply format:</p>
      <pre>${esc(SCHEMA_HINT)}</pre>
      <p class="note"><strong>Answers:</strong> once, at temperature 0, with no chance to re-read and no way to ask a question.
      Scored ${score(agent)}${agent?.duration_ms ? ` in ${(agent.duration_ms / 1000).toFixed(1)}s` : ""} · cost ≈ $0.</p>
    </div>

    <div class="pane human">
      <div class="who human">The human · paid participant recruited through Terac</div>
      <p class="note"><strong>Sees:</strong> the same ${cert.pages} pages, in a scrollable panel they can zoom.</p>
      <p class="note"><strong>Told:</strong> the same instruction, as a numbered list beside ${FIELDS.length} empty fields:</p>
      <ol>${FIELDS.map((f) => `<li>${esc(f.label)} <span class="mut">— ${esc(f.hint)}</span></li>`).join("")}</ol>
      <p class="note"><strong>Answers:</strong> free text, once, timed from first paint to submit. Can text support mid-task.
      ${humanCount} participant${humanCount === 1 ? " has" : "s have"} read this certificate${
        human ? `; the most recent scored ${score(human)}${human.duration_ms ? ` in ${Math.round(human.duration_ms / 1000)}s` : ""}` : ""
      } · $${(HUMAN_CPI_CENTS / 100).toFixed(2)} each.</p>
    </div>

    <div class="card">
      <strong>The asymmetry to be honest about.</strong>
      <ul>
        <li>Identical pages, identical instruction, identical ${FIELDS.length} fields, scored by the identical function. That is what makes the comparison fair.</li>
        <li>The human can re-read, zoom, and text support. The model answers once and cannot ask. That favours the human.</li>
        <li>The model is sent the pages at whatever resolution we render them. A page too coarse to read is our failure, not the model's.</li>
        <li>Neither is graded against the other — both are graded against what the certificate prints, which is why the documents have to be synthetic.</li>
        <li class="warn">One human is not a referee for this certificate. They are one reading, and a field needs many before anything can be licensed. That is section 2.</li>
      </ul>
    </div>
  </div>
</div>

<h2>Field by field · what each reader reported</h2>
<div class="card"><table>
<tr><th>Field</th><th>The document prints</th><th>Agent${agent ? ` · ${esc(short(agent.who))}` : ""}</th><th>Human${
    human ? ` · most recent` : ""
  }</th></tr>
${answerRows(cert, agent, human)}
</table>
<p class="note">Green is exact after normalising case, whitespace, currency and separators. Red carries the reason
when the answer is a value the page itself invites.</p>
</div>

<h2>What this document invites you to get wrong</h2>
<div class="card">
  ${traps ? `<ul>${traps}</ul>` : `<p class="note">No distractors recorded for this certificate.</p>`}
  <p class="note">Every one of these is a real number printed on the same page. A citation check cannot separate them
  from the right answer, which is the whole reason to buy a human reading rather than a second automated pass.</p>
</div>

<h2>2 · What do you want to get to?</h2>
<div class="card">
  <p class="sub" style="margin:0 0 12px">Set the target first, then see what reaching it costs. A design that cannot reach your target is not cheap — it is worthless.</p>
  <div class="row">
    <div><label>Target floor (%)</label><input id="floor" type="number" value="90" min="50" max="99.5" step="0.5"></div>
    <div><label>Budget ($)</label><input id="budget" type="number" value="125"></div>
    <div><label>CPI ($)</label><input id="cpi" type="number" value="${(HUMAN_CPI_CENTS / 100).toFixed(2)}" step="0.25"></div>
    <button class="ghost" onclick="target()">Show me what reaches it</button>
  </div>
  <div id="tgt"></div>
</div>

<script>
async function target(){
  const r=await fetch("/api/design/target",{method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({floor:+floor.value/100,budgetCents:Math.round(+budget.value*100),cpiCents:Math.round(+cpi.value*100)})});
  const d=await r.json();
  document.getElementById("tgt").innerHTML=\`
  <p class="note">Each participant reads one certificate and answers every field on it once, so a field's evidence
  is just the number of participants who drew that certificate. To license a field at
  <strong>\${(d.floor*100).toFixed(1)}%</strong> you need <strong>\${d.n_min}</strong> readings with no mistakes —
  <strong>$\${(d.cost_to_license_one_cert_cents/100).toFixed(2)}</strong> per certificate. One wrong answer among them and it becomes
  <strong>\${d.need_with_one_miss ?? "—"}</strong> readings.</p>
  <table><tr><th>Certificates covered</th><th>Participants</th><th>Readings per field</th><th>Cost</th><th>Reaches target?</th></tr>
  \${d.options.map(o=>'<tr><td><strong>'+o.certificates+'</strong></td><td>'+o.participants+'</td><td>'+o.readings_per_field+'</td><td>$'+(o.cost_cents/100).toFixed(2)+'</td><td>'+(o.reaches_target?'<span class="ok">yes</span>':'<span class="bad">no — short by '+o.shortfall+', rule-out only</span>')+'</td></tr>').join("")}
  </table>
  <p class="note">This is the honest shape of the thing: ruling a field out is cheap, because one clear failure does it.
  Licensing one is expensive, because it takes a run of readings with nothing wrong in it.</p>\`;
}
target();
</script>
</div></body></html>`;
}
