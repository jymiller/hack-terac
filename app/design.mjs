import express from "express";
import { query } from "./db.mjs";
import { CERTS, FIELDS, INSTRUCTION, byId } from "./certs.mjs";
import { SCHEMA_HINT } from "./models.mjs";
import { wilson, nMin } from "./readiness.mjs";
import { page } from "./ui.mjs";

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

/* Page-specific layout only. Everything else comes from the shared sheet in app/ui.mjs. */
const EXTRA_CSS = `
.split{display:grid;grid-template-columns:1.05fr 1fr;gap:14px;align-items:start;margin-top:14px}
@media(max-width:980px){.split{grid-template-columns:1fr}.doc{position:static;max-height:none}}
.doc{background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:10px;
  position:sticky;top:14px;max-height:88vh;overflow:auto}
.doc img{width:100%;display:block;border:1px solid var(--line);border-radius:7px;background:#fff}
.doc img + img{margin-top:10px}
.pane{background:var(--card);border:1px solid var(--line);border-left-width:2px;
  border-radius:var(--r);padding:18px;margin-bottom:12px}
.pane.agent{border-left-color:var(--agent)}
.pane.human{border-left-color:var(--acc)}
.shared{background:var(--card);border:1px dashed var(--line);border-radius:var(--r);padding:18px;
  margin-bottom:12px}
.who{font-size:10.5px;letter-spacing:.09em;text-transform:uppercase;font-weight:600;
  color:var(--dim);margin-bottom:11px}
.who.agent{color:var(--agent)}
.who.human{color:var(--acc)}
.pane .sub,.shared .sub{font-size:13px;margin:0 0 8px;max-width:none}
.pane .sub:last-child,.shared .sub:last-child{margin-bottom:0}
.sub b{color:var(--fg);font-weight:600}
.pane ol,.card ul,.card ol{margin:9px 0 0;padding-left:20px;font-size:13.5px;color:var(--mut)}
li{margin:5px 0}
li strong{color:var(--fg);font-weight:600}
pre{white-space:pre-wrap;max-height:230px}
.fname{color:var(--mut);white-space:nowrap}
.truth{font-weight:600}
.why{font-size:11.5px;color:var(--dim);margin-top:4px;font-weight:400}
.row input{width:112px}
`;

/* The target planner runs client-side; the page ships it, ui.mjs mounts it. */
const SCRIPT = `
async function target(){
  const r=await fetch("/api/design/target",{method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({floor:+floor.value/100,budgetCents:Math.round(+budget.value*100),cpiCents:Math.round(+cpi.value*100)})});
  const d=await r.json();
  document.getElementById("tgt").innerHTML=\`
  <div class="grid" style="margin-top:14px">
    <div><label>Clean readings to license one field</label><div class="big">\${d.n_min}</div></div>
    <div><label>Cost to license one certificate</label><div class="big">$\${(d.cost_to_license_one_cert_cents/100).toFixed(2)}</div></div>
    <div><label>If one reading is wrong</label><div class="big">\${d.need_with_one_miss ?? "—"} <small>readings</small></div></div>
    <div><label>Participants this budget buys</label><div class="big">\${d.options[0].participants}</div></div>
  </div>
  <p class="sowhat">A \${(d.floor*100).toFixed(1)}% floor costs <b>\${d.n_min} consecutive readings with nothing wrong in them</b>,
  or $\${(d.cost_to_license_one_cert_cents/100).toFixed(2)} of participant spend per certificate. Each participant reads one certificate
  and answers every field on it once, so a field's evidence is just the participants who drew that certificate — you cannot buy
  depth and breadth with the same money. Budget for the miss before you commit: one wrong answer in the run takes it to
  \${d.need_with_one_miss ?? "—"}.</p>
  <table style="margin-top:16px"><thead><tr><th>Certificates covered</th><th>Participants</th><th class="num">Readings per field</th><th class="num">Cost</th><th>Reaches target?</th></tr></thead>
  <tbody>\${d.options.map(o=>'<tr><td><strong>'+o.certificates+'</strong></td><td class="num">'+o.participants+'</td><td class="num">'+o.readings_per_field+'</td><td class="num">$'+(o.cost_cents/100).toFixed(2)+'</td><td>'+(o.reaches_target?'<span class="ok">yes</span>':'<span class="bad">no — short by '+o.shortfall+', rule-out only</span>')+'</td></tr>').join("")}</tbody>
  </table>
  <p class="sowhat">Every row costs the same money and buys a different answer. <b>A row marked "no" can still rule fields out —
  it just cannot license any</b>, because one clear failure settles a rule-out while a licence needs the whole clean run.
  If no row reaches the floor, either narrow the wave to fewer certificates until one does, or decide up front that this
  spend answers "which fields are not ready" and nothing more.</p>\`;
}
target();
`;

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

  const body = `
<h1>Is this a fair test?</h1>
<p class="lede">Before we pay anyone, check that the software and the person are being asked the same thing.</p>
<p class="sub">We compare a person against software on the same certificate. That comparison is only worth
anything if both were handed the same document and the same question — otherwise a difference in the scores
just tells you we asked them different things. This page shows exactly what each one was given, so you can
check that yourself before spending money on it.</p>

<div class="grid">
  <div><label>${esc(cert.entity)}</label><div class="big">${esc(cert.truth.ratio_name)}</div></div>
  <div><label>Size of the job</label><div class="big">${cert.pages} <small>pages</small> · ${FIELDS.length} <small>fields</small></div></div>
  <div><label>Agent${agent ? ` · ${esc(short(agent.who))}` : ""}</label><div class="big ${agent ? "" : "dim"}">${esc(score(agent))}</div></div>
  <div><label>People who have read it</label><div class="big">${humanCount}</div></div>
</div>
<p class="sowhat">Both readers answer the same <b>${FIELDS.length} fields on the same ${cert.pages} pages</b>, and we mark both the same way against what the certificate actually prints. So the two scores are directly comparable — though neither is proof of anything yet.
A handful of readings settles nothing about whether this work can run unattended; what it buys you is a look at <b>where</b>
the two disagree, which is what the rest of this page is for.</p>

<h2>Pick a document</h2>
<div class="card">
  <form class="row" method="get" action="/design">
    <div><label>Certificate</label><select name="cert">
      ${certs.map((c) => `<option value="${c.id}"${c.id === cert.id ? " selected" : ""}>${esc(c.entity)} — ${esc(c.truth.ratio_name)}</option>`).join("")}
    </select></div>
    ${
      agentChoices.length
        ? `<div><label>Software</label><select name="model">
      ${agentChoices.map((m) => `<option value="${esc(m)}"${agent && m === agent.who ? " selected" : ""}>${esc(short(m))}</option>`).join("")}
    </select></div>`
        : ""
    }
    <button class="ghost" type="submit">Show this one</button>
  </form>
  <p class="sowhat">Both readers get all ${cert.pages} pages, in this order, with nothing extracted in advance and no region
  highlighted — which is what licenses you to read a gap between the arms as <b>a difference in reading, not in what each side
  was handed</b>. Asking someone to confirm a value we already found measures whether they can read; asking them to find it
  measures the job we would be automating.</p>
</div>

<div class="split">
  <div class="doc">${images.map((src) => `<img src="${src}" alt="Certificate page" loading="lazy">`).join("")}</div>
  <div>
    <div class="shared">
      <div class="who">Both get this same wording</div>
      <pre>${esc(INSTRUCTION)}</pre>
      <p class="sowhat">This is one string — <code>INSTRUCTION</code> in <code>app/certs.mjs</code> — rendered into the worker's
      form and sent as the model's prompt, so <b>editing it moves both arms at once and retires every reading taken before the
      edit</b>. Neither side is told the ground truth, and neither is told that traps exist.</p>
    </div>

    <div class="pane agent">
      <div class="who agent">The software · ${agent ? esc(short(agent.who)) : "no run on this certificate yet"}</div>
      <p class="sub"><b>What it gets:</b> the same ${cert.pages} pages, as pictures, all at once.</p>
      <p class="sub"><b>What it is asked:</b> the wording above, plus how to format the reply:</p>
      <pre>${esc(SCHEMA_HINT)}</pre>
      <p class="sub"><b>How it answers:</b> once, straight through. It cannot go back for another look and it cannot ask us anything.
      Scored ${esc(score(agent))}${agent?.duration_ms ? ` in ${(agent.duration_ms / 1000).toFixed(1)}s` : ""} · cost ≈ $0.</p>
      ${
        agent
          ? `<p class="sowhat">The agent scored <b>${esc(score(agent))} at a marginal cost of about nothing</b>, so the fields it
      already gets right are fields a paid reading has to justify buying. The misses are where the money belongs — and because
      it answers once, blind, they are the honest floor rather than its best effort.</p>`
          : `<p class="sowhat">No agent run exists for this certificate, so <b>this pane cannot tell you whether any field here is
      automatable</b> — only what the agent would be shown if you asked it. Run the cheap arm before pricing the expensive one.</p>`
      }
    </div>

    <div class="pane human">
      <div class="who human">The person · paid participant recruited through Terac</div>
      <p class="sub"><b>What they get:</b> the same ${cert.pages} pages, on screen, and they can zoom in.</p>
      <p class="sub"><b>What they are asked:</b> the same wording, as a numbered list next to ${FIELDS.length} empty boxes:</p>
      <ol>${FIELDS.map((f) => `<li>${esc(f.label)} <span class="mut">— ${esc(f.hint)}</span></li>`).join("")}</ol>
      <p class="sub"><b>How they answer:</b> typed in, once. We time them from the moment the page loads, and they can text us a question.
      ${humanCount} participant${humanCount === 1 ? " has" : "s have"} read this certificate${
        human ? `; the most recent scored ${esc(score(human))}${human.duration_ms ? ` in ${Math.round(human.duration_ms / 1000)}s` : ""}` : ""
      } · $${(HUMAN_CPI_CENTS / 100).toFixed(2)} each.</p>
      <p class="sowhat"><b>${humanCount} reading${humanCount === 1 ? "" : "s"} is not a referee for this certificate.</b>
      Readiness is a Wilson 95% lower bound against a 0.90 floor, and that bound is flat on its back until a long clean run
      arrives — section 2 prices exactly how long. What this pane can settle is whether the human was asked a fair question;
      what it cannot settle is whether any field is ready.</p>
    </div>

    <div class="card">
      <strong>Where the two are not on equal footing</strong>
      <ul>
        <li>Identical pages, identical instruction, identical ${FIELDS.length} fields, scored by the identical function. That is what makes the comparison fair.</li>
        <li>The human can re-read, zoom, and text support. The model answers once and cannot ask. That favours the human.</li>
        <li>The model is sent the pages at whatever resolution we render them. A page too coarse to read is our failure, not the model's.</li>
        <li>Neither is graded against the other — both are graded against what the certificate prints, which is why the documents have to be synthetic.</li>
        <li class="warn">One human is not a referee for this certificate. They are one reading, and a field needs many before anything can be licensed. That is section 2.</li>
      </ul>
      <p class="sowhat">Every asymmetry left in the design runs the same way — <b>toward the human</b> — so the agent's score is a
      lower bound on automation, not a flattering one. That is the direction you want the bias pointing: a field the agent reads
      correctly under these conditions is a field you can argue about buying, and a field it misses stays bought.</p>
    </div>
  </div>
</div>

<h2>What each of them actually answered</h2>
<div class="card"><table>
<thead><tr><th>Field</th><th>The document prints</th><th>Agent${agent ? ` · ${esc(short(agent.who))}` : ""}</th><th>Human${
    human ? ` · most recent` : ""
  }</th></tr></thead>
<tbody>${answerRows(cert, agent, human)}</tbody>
</table>
<p class="sowhat">Read the red cells, not the totals. Green is exact after normalising case, whitespace, currency and separators,
so <b>a red cell is a real disagreement about what the page says</b> — and where it carries a reason, the reader landed on a
number the document itself printed. Those are the fields that decide whether this certificate can ever be read unattended;
totals this small cannot.</p>
</div>

<h2>The easy mistakes this document sets up</h2>
<div class="card">
  ${
    traps
      ? `<ul>${traps}</ul>
  <p class="sowhat">Every value listed here is <b>a real number printed on the same page</b>, so a citation check will confirm it
  and still be wrong. That is the case for buying a human reading rather than a second automated pass — and the reason a field
  carrying a trap has to earn its clean run before it is licensed, not after.</p>`
      : `<p class="sowhat">No distractors are recorded for this certificate, so <b>a clean score here is not evidence of trap
  resistance</b> — it is evidence of reading a document that does not fight back. Do not generalise it to the certificates that do.</p>`
  }
</div>

<h2>How much evidence would settle it?</h2>
<div class="card">
  <p class="sub" style="margin:0 0 12px">Decide how sure you want to be, then see what that costs. A wave that
cannot reach the bar you set is not a cheap wave — it is a wasted one.</p>
  <div class="row">
    <div><label>Target floor (%)</label><input id="floor" type="number" value="90" min="50" max="99.5" step="0.5"></div>
    <div><label>Budget ($)</label><input id="budget" type="number" value="125"></div>
    <div><label>CPI ($)</label><input id="cpi" type="number" value="${(HUMAN_CPI_CENTS / 100).toFixed(2)}" step="0.25"></div>
    <button class="ghost" onclick="target()">Show me what reaches it</button>
  </div>
  <div id="tgt"></div>
</div>`;

  return page({ title: "Is this a fair test?", current: "/design", body, extraCss: EXTRA_CSS, script: SCRIPT });
}
