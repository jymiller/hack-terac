import express from "express";
import { query } from "./db.mjs";
import { CERTS, FIELDS, INSTRUCTION, byId, scoreAnswer, verifyFixtures } from "./certs.mjs";

let ready = null;
function ensureSchema() {
  ready ??= query(`
    create table if not exists extractions (
      id                  bigserial primary key,
      terac_submission_id text,
      wave                text,
      cert_id             text not null,
      source              text not null check (source in ('human', 'model')),
      model_id            text,
      answers             jsonb not null,
      correct             integer,
      total               integer,
      detail              jsonb,
      duration_ms         integer,
      received_at         timestamptz not null default now(),
      unique (terac_submission_id, cert_id, source, model_id)
    )`);
  return ready;
}

/** One certificate per participant, spread evenly by submission id. */
export function certFor(submissionId) {
  let h = 0;
  for (const ch of String(submissionId)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return CERTS[h % CERTS.length];
}

export async function recordExtraction({
  submissionId,
  wave,
  certId,
  source,
  modelId = null,
  answers,
  durationMs = null,
}) {
  await ensureSchema();
  const scored = scoreAnswer(certId, answers);
  const { rows } = await query(
    `insert into extractions
       (terac_submission_id, wave, cert_id, source, model_id, answers, correct, total, detail, duration_ms)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     on conflict (terac_submission_id, cert_id, source, model_id) do update
       set answers = excluded.answers, correct = excluded.correct, detail = excluded.detail
     returning *`,
    [
      submissionId ?? null,
      wave ?? null,
      certId,
      source,
      modelId,
      answers,
      scored?.correct ?? null,
      scored?.total ?? null,
      scored?.fields ?? null,
      durationMs,
    ],
  );
  return { row: rows[0], scored };
}

export function registerExtractRoutes(app) {
  const json = express.json();
  const form = express.urlencoded({ extended: false });

  app.get("/api/extract/fixtures", (_req, res) => res.json(verifyFixtures()));

  app.get("/api/extract/results", async (_req, res) => {
    try {
      await ensureSchema();
      const { rows } = await query(
        `select source, coalesce(model_id,'human') as who, cert_id,
                count(*)::int as n,
                sum(correct)::int as correct, sum(total)::int as total,
                round(avg(correct::numeric / nullif(total,0)), 4) as field_accuracy
           from extractions group by 1,2,3 order by 1,2,3`,
      );
      res.json({ rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * The worker task. Same document and same instruction a model gets — no highlighted
   * region, no pre-filled figure. Asking someone to confirm a value we already found
   * measures whether they can read; asking them to find it measures the actual job.
   */
  app.get("/x/:wave", async (req, res) => {
    const sid = req.query.teracSubmissionId ?? req.query.submissionId;
    if (!sid) return res.status(400).send("This link is missing its Terac submission id.");
    const cert = certFor(sid);
    try {
      await ensureSchema();
      await query(
        `insert into terac_responses (terac_submission_id, task_id, opportunity_id, payload)
         values ($1,$2,$3,$4)
         on conflict (terac_submission_id) do update set payload = excluded.payload
         where terac_responses.payload->>'status' is distinct from 'completed'`,
        [
          sid,
          req.query.taskId ?? null,
          req.query.opportunityId ?? null,
          { status: "opened", wave: req.params.wave, cert: cert.id, opened_at: new Date().toISOString() },
        ],
      );
    } catch (err) {
      console.error("extract open receipt failed:", err.message);
    }
    res.type("html").send(
      extractPage({
        cert,
        submissionId: sid,
        taskId: req.query.taskId ?? "",
        wave: req.params.wave,
      }),
    );
  });

  app.post("/api/extract", form, json, async (req, res) => {
    const b = req.body ?? {};
    const sid = b.teracSubmissionId;
    const certId = b.certId;
    if (!sid || !certId) return res.status(400).json({ error: "teracSubmissionId and certId required" });
    try {
      const answers = Object.fromEntries(FIELDS.map((f) => [f.key, b[f.key] ?? ""]));
      await recordExtraction({
        submissionId: sid,
        wave: b.wave,
        certId,
        source: "human",
        answers,
        durationMs: Number(b.durationMs) || null,
      });
      await query(
        `update terac_responses set payload = payload || $2::jsonb
          where terac_submission_id = $1`,
        [sid, JSON.stringify({ status: "completed", submitted_at: new Date().toISOString() })],
      ).catch(() => {});
      const url =
        `https://terac.com/api/external/callback?teracSubmissionId=${encodeURIComponent(sid)}` +
        `&taskId=${encodeURIComponent(b.taskId ?? "")}&result=completed`;
      if (req.is("application/x-www-form-urlencoded")) return res.redirect(303, url);
      res.status(201).json({ ok: true, redirect: url });
    } catch (err) {
      console.error("extract capture failed:", err.message);
      res.status(500).json({ error: "could not record your answers" });
    }
  });
}

function extractPage({ cert, submissionId, taskId, wave }) {
  const imgs = Array.from(
    { length: cert.pages },
    (_, i) => `/docs/png/${cert.file}-${i + 1}.png`,
  );
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Read this certificate and report what it states</title><style>
:root{color-scheme:light dark;--bg:#fbfaf8;--fg:#18181b;--mut:#6b7280;--line:#e4e4e7;--card:#fff;--acc:#1d4ed8}
@media(prefers-color-scheme:dark){:root{--bg:#0c0c0d;--fg:#f4f4f5;--mut:#a1a1aa;--line:#27272a;--card:#161617;--acc:#60a5fa}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
.wrap{max-width:1180px;margin:0 auto;padding:24px 18px 90px}
h1{font-size:23px;margin:0 0 6px}
.sub{color:var(--mut);margin:0 0 18px;font-size:14px}
.cols{display:grid;grid-template-columns:1.15fr 1fr;gap:18px;align-items:start}
@media(max-width:900px){.cols{grid-template-columns:1fr}}
.doc{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:10px;position:sticky;top:14px;max-height:88vh;overflow:auto}
.doc img{width:100%;display:block;margin-bottom:10px;border:1px solid var(--line);border-radius:6px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px}
ol{margin:8px 0 0;padding-left:20px;font-size:14px}li{margin:5px 0}
label{display:block;font-size:13px;font-weight:600;margin:16px 0 3px}
.hint{font-size:12px;color:var(--mut);font-weight:400}
input,select{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg);font:inherit}
button{margin-top:22px;width:100%;background:var(--acc);color:#fff;border:0;border-radius:10px;padding:14px;font-size:16px;font-weight:600;cursor:pointer;font-family:inherit}
.note{font-size:13px;color:var(--mut);margin-top:14px}
.warn{background:#fef3c7;color:#78350f;border-radius:8px;padding:10px 12px;font-size:13px;margin:14px 0}
@media(prefers-color-scheme:dark){.warn{background:#3f2d0a;color:#fde68a}}
</style></head><body><div class="wrap">
<h1>Read this certificate and report what it states</h1>
<p class="sub">Everything you need is in the document on the left. Roughly 5 minutes.</p>
<div class="cols">
  <div class="doc">${imgs.map((s) => `<img src="${s}" alt="Certificate page" loading="lazy">`).join("")}</div>
  <form class="card" method="post" action="/api/extract">
    <input type="hidden" name="teracSubmissionId" value="${submissionId}">
    <input type="hidden" name="taskId" value="${taskId}">
    <input type="hidden" name="wave" value="${wave}">
    <input type="hidden" name="certId" value="${cert.id}">
    <input type="hidden" name="durationMs" id="durationMs" value="">
    <strong>Your task</strong>
    <ol>${INSTRUCTION.split("\n").filter((l) => /^\d\./.test(l.trim())).map((l) => `<li>${l.replace(/^\s*\d\.\s*/, "")}</li>`).join("")}</ol>
    <div class="warn">Report only what the document states. If something is not stated, write <strong>not stated</strong>. Please do not estimate or calculate anything the document does not print.</div>
    ${FIELDS.map((f) =>
      f.key === "compliant"
        ? `<label>${f.label} <span class="hint">— ${f.hint}</span></label>
           <select name="${f.key}" required><option value="">Choose…</option><option value="yes">yes</option><option value="no">no</option><option value="not stated">not stated</option></select>`
        : `<label>${f.label} <span class="hint">— ${f.hint}</span></label>
           <input name="${f.key}" required autocomplete="off">`,
    ).join("")}
    <button type="submit">Submit my answers</button>
    <p class="note">Stuck or something looks wrong? Text <strong>${process.env.LINQ_SUPPORT_NUMBER ?? "+1 646 299-5885"}</strong> and we will reply. Answering &quot;not stated&quot; is fine when the document does not print something.</p>
    <p class="note">Your answers are recorded against this task only. The document is a synthetic example created for testing and describes no real company.</p>
  </form>
</div>
<script>const t0=Date.now();document.querySelector("form").addEventListener("submit",()=>{document.getElementById("durationMs").value=Date.now()-t0});</script>
</div></body></html>`;
}
