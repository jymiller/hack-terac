import express from "express";
import crypto from "node:crypto";
import { query } from "./db.mjs";
import { CERTS, FIELDS, INSTRUCTION, byId, scoreAnswer, verifyFixtures } from "./certs.mjs";
import { refFor, supportNumber } from "./support.mjs";

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

export const WALKUP_WAVE = "walkup";
export const WALKUP_PREFIX = "walk_";

/**
 * QA readings. Marked on three independent axes so they can never be mistaken for evidence:
 * the submission id carries a prefix, the wave is its own value, and the row is written with
 * source 'walkup' so it is outside the paid-panel `human` population by construction. The
 * page also says so on screen, so nobody fills one in believing it counts.
 */
export const TEST_PREFIX = "test_";
export const TEST_WAVE = "qatest";
const isTest = (sid, wave) => wave === TEST_WAVE || String(sid ?? "").startsWith(TEST_PREFIX);

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
  /**
   * The open door. One stable URL an expert can be handed, scanned, or typed — no Terac
   * submission id, no query string. Each visit mints its own id so two people on the same
   * link get their own certificate and their own row.
   */
  app.get("/expert", (_req, res) => {
    const id = `${WALKUP_PREFIX}${crypto.randomBytes(6).toString("hex")}`;
    res.redirect(302, `/x/${WALKUP_WAVE}?teracSubmissionId=${id}`);
  });

  app.get("/thanks", (req, res) => {
    const ref = String(req.query.ref ?? "");
    res.type("html").send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Thank you</title><style>
:root{color-scheme:light dark;--bg:#fbfaf8;--fg:#18181b;--mut:#6b7280;--line:#e4e4e7;--card:#fff;--acc:#1d4ed8}
@media(prefers-color-scheme:dark){:root{--bg:#0c0c0d;--fg:#f4f4f5;--mut:#a1a1aa;--line:#27272a;--card:#161617;--acc:#60a5fa}}
body{margin:0;background:var(--bg);color:var(--fg);font:17px/1.6 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:32px;max-width:520px}
h1{font-size:25px;margin:0 0 10px}p{color:var(--mut);font-size:15px}code{font-size:13px}
a{color:var(--acc)}</style></head><body><div class="card">
<h1>Thank you — that's recorded.</h1>
<p>Your reading has been scored against what the certificate actually prints, and it now sits
alongside the model runs on the same document.</p>
<p>Your reference is <strong><code>${ref.replace(/[^\w-]/g, "")}</code></strong>.</p>
<p><a href="/results">See how you did against the models &rarr;</a> &nbsp;·&nbsp;
<a href="/expert">Read another certificate</a></p>
</div></body></html>`);
  });

  app.get("/x/:wave", async (req, res) => {
    const sid = req.query.teracSubmissionId ?? req.query.submissionId;
    if (!sid) return res.status(400).send("This link is missing its Terac submission id.");
    // Terac mints the submission id, so hashing it cannot produce a URL pinned to one
    // certificate. An explicit ?cert= does, which is what three separate Terac opportunities
    // need. An absent or unknown value falls back to the hash, so every existing link and
    // every walk-up behaves exactly as before.
    const cert = byId(req.query.cert) ?? certFor(sid);
    const test = isTest(sid, req.params.wave);
    const walkup =
      test || req.params.wave === WALKUP_WAVE || String(sid).startsWith(WALKUP_PREFIX);
    // Arrival receipts exist to measure the Terac funnel. A walk-up was never recruited,
    // so recording one there would count a stranger as a participant we paid for.
    if (!walkup) {
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
    }
    res.type("html").send(
      extractPage({
        cert,
        submissionId: sid,
        ref: refFor(sid),
        taskId: req.query.taskId ?? "",
        wave: test ? TEST_WAVE : req.params.wave,
        test,
      }),
    );
  });

  app.post("/api/extract", form, json, async (req, res) => {
    const b = req.body ?? {};
    const sid = b.teracSubmissionId;
    const certId = b.certId;
    // A walk-up reader came through the open link, not through Terac. Their work is real
    // and worth recording, but it is not paid panel evidence and is never redirected to
    // Terac's callback, which would try to settle a submission that does not exist.
    const test = isTest(sid, b.wave);
    const walkup = test || b.wave === WALKUP_WAVE || String(sid).startsWith(WALKUP_PREFIX);
    if (!sid || !certId) return res.status(400).json({ error: "teracSubmissionId and certId required" });
    try {
      // The unique index carries model_id, which is NULL for every human row, and Postgres
      // treats NULLs as distinct — so ON CONFLICT never fires here. Without this guard a
      // back-then-resubmit writes a second row from one paid reader, and the readiness bound
      // counts it as independent evidence. Pay them either way; just don't count it twice.
      await ensureSchema();
      const { rows: dup } = await query(
        `select 1 from extractions where terac_submission_id = $1 and source = $2 limit 1`,
        [sid, walkup ? "walkup" : "human"],
      );
      if (dup.length) {
        const url =
          `https://terac.com/api/external/callback?teracSubmissionId=${encodeURIComponent(sid)}` +
          `&taskId=${encodeURIComponent(b.taskId ?? "")}&result=completed`;
        return req.is("application/x-www-form-urlencoded")
          ? res.redirect(303, url)
          : res.status(200).json({ ok: true, duplicate: true, redirect: url });
      }

      const answers = Object.fromEntries(FIELDS.map((f) => [f.key, b[f.key] ?? ""]));
      await recordExtraction({
        submissionId: sid,
        wave: test ? TEST_WAVE : b.wave,
        certId,
        source: walkup ? "walkup" : "human",
        answers,
        durationMs: Number(b.durationMs) || null,
      });
      if (!walkup) {
        await query(
          `update terac_responses set payload = payload || $2::jsonb
            where terac_submission_id = $1`,
          [sid, JSON.stringify({ status: "completed", submitted_at: new Date().toISOString() })],
        ).catch(() => {});
      }
      const url = walkup
        ? `/thanks?ref=${encodeURIComponent(sid)}`
        : `https://terac.com/api/external/callback?teracSubmissionId=${encodeURIComponent(sid)}` +
          `&taskId=${encodeURIComponent(b.taskId ?? "")}&result=completed`;
      if (req.is("application/x-www-form-urlencoded")) return res.redirect(303, url);
      res.status(201).json({ ok: true, redirect: url });
    } catch (err) {
      console.error("extract capture failed:", err.message);
      res.status(500).json({ error: "could not record your answers" });
    }
  });
}

function extractPage({ cert, submissionId, taskId, wave, ref, test = false }) {
  const imgs = Array.from(
    { length: cert.pages },
    (_, i) => `/docs/png/${cert.file}-${i + 1}.png`,
  );
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Read this certificate and report what it states</title><style>
:root{color-scheme:light dark;--bg:#fbfaf8;--fg:#18181b;--mut:#6b7280;--line:#e4e4e7;--card:#fff;--acc:#1d4ed8}
@media(prefers-color-scheme:dark){:root{--bg:#0c0c0d;--fg:#f4f4f5;--mut:#a1a1aa;--line:#27272a;--card:#161617;--acc:#60a5fa}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
.wrap{max-width:1440px;margin:0 auto;padding:24px 18px 90px}
h1{font-size:23px;margin:0 0 6px}
.sub{color:var(--mut);margin:0 0 18px;font-size:14px}
.cols{display:grid;grid-template-columns:1.45fr 1fr;gap:18px;align-items:start}
/* Recruiting is desktop-only, but a stray small-screen visit must degrade rather than trap the
   document inside a nested scroller they cannot get out of. */
@media(max-width:900px){.cols{grid-template-columns:1fr}
  .doc{position:static;max-height:none;overflow:visible}
  .pages{overflow:visible}
  .pages.zoomed{overflow-x:auto}
  .bar{position:sticky;top:0;background:var(--card);z-index:2}
  #pp,#pn,#pl{display:none}
  .smallscreen{display:block}}
.smallscreen{display:none;font-size:13px;color:var(--mut);margin:-8px 0 16px}
.doc{background:var(--card);border:1px solid var(--line);border-radius:12px;position:sticky;top:14px;
  display:flex;flex-direction:column;max-height:92vh;overflow:hidden}
.bar{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid var(--line);flex-wrap:wrap}
.bar .spacer{flex:1}
.bar button{margin:0;width:auto;background:transparent;color:var(--fg);border:1px solid var(--line);
  border-radius:7px;padding:5px 10px;font-size:13px;font-weight:500}
.bar button:hover{border-color:var(--mut)}
.bar .lbl{font-size:12.5px;color:var(--mut);font-variant-numeric:tabular-nums;white-space:nowrap}
.pages{overflow:auto;padding:10px;flex:1;scroll-behavior:smooth}
.pages img{display:block;margin:0 auto 10px;border:1px solid var(--line);border-radius:6px;
  width:calc(100% * var(--z,1));max-width:none;cursor:zoom-in;aspect-ratio:1653/2339}
.pages.zoomed img{cursor:zoom-out}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px}
ol{margin:8px 0 0;padding-left:20px;font-size:14px}li{margin:5px 0}
label{display:block;font-size:13px;font-weight:600;margin:16px 0 3px}
.hint{font-size:12px;color:var(--mut);font-weight:400}
input,select{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg);font:inherit}
button{margin-top:22px;width:100%;background:var(--acc);color:#fff;border:0;border-radius:10px;padding:14px;font-size:16px;font-weight:600;cursor:pointer;font-family:inherit}
.note{font-size:13px;color:var(--mut);margin-top:14px}
/* Help has to be reachable BEFORE the eight fields, not below the submit button — a reader
   who is stuck is stuck at field three and will never scroll past the end to find it. */
.ask{display:block;margin:14px 0 4px;padding:11px 14px;border:1px solid var(--acc);color:var(--acc);
  border-radius:9px;text-decoration:none;font-size:14px;font-weight:600;text-align:center}
.ask:hover{background:var(--acc);color:var(--bg)}
.ask span{display:block;font-weight:400;font-size:12px;opacity:.8;margin-top:2px}
.warn{background:#fef3c7;color:#78350f;border-radius:8px;padding:10px 12px;font-size:13px;margin:14px 0}
@media(prefers-color-scheme:dark){.warn{background:#3f2d0a;color:#fde68a}}
</style></head><body><div class="wrap">
<h1>Read this compliance certificate and report eight things it states</h1>
<p class="sub">A ${cert.pages}-page compliance certificate is on the left — click it to zoom in. All eight answers are printed in it, so nothing has to be worked out. Most people take 7 to 9 minutes, and there is no time limit.</p>
${
  test
    ? `<div style="border:2px solid #b45309;color:#b45309;border-radius:10px;padding:12px 14px;margin:0 0 18px;font-size:14px;font-weight:600">
    TEST READING — not paid panel evidence. This is recorded as wave <code>${TEST_WAVE}</code> under
    reference <code>${submissionId}</code> and is excluded from the expert results.</div>`
    : ""
}
<p class="smallscreen">The print on this document is small. If you can, open this task on a laptop or desktop — it will be much easier to read.</p>
<div class="cols">
  <div class="doc">
    <div class="bar">
      <button type="button" id="zo" title="Zoom out">&minus;</button>
      <span class="lbl" id="zl">Fit</span>
      <button type="button" id="zi" title="Zoom in">+</button>
      <button type="button" id="zf">Fit width</button>
      <span class="spacer"></span>
      <button type="button" id="pp" title="Previous page">&uarr;</button>
      <span class="lbl" id="pl">Page 1 of ${imgs.length}</span>
      <button type="button" id="pn" title="Next page">&darr;</button>
    </div>
    <div class="pages" id="pages">${imgs
      .map((s, i) => `<img src="${s}" alt="Certificate page ${i + 1} of ${imgs.length}"${i ? ' loading="lazy"' : ""}>`)
      .join("")}</div>
  </div>
  <form class="card" method="post" action="/api/extract">
    <input type="hidden" name="teracSubmissionId" value="${submissionId}">
    <input type="hidden" name="taskId" value="${taskId}">
    <input type="hidden" name="wave" value="${wave}">
    <input type="hidden" name="certId" value="${cert.id}">
    <input type="hidden" name="durationMs" id="durationMs" value="">
    <strong>Your task</strong>
    <p class="sub" style="margin:6px 0 0">${INSTRUCTION.split("\n")[0]}</p>
    <ol>${INSTRUCTION.split("\n").filter((l) => /^\d\./.test(l.trim())).map((l) => `<li>${l.replace(/^\s*\d\.\s*/, "")}</li>`).join("")}</ol>
    <div class="warn">${INSTRUCTION.split("\n\n").pop().replace(/\n/g, " ").replace('"not stated"', "<strong>not stated</strong>")}</div>
    <a class="ask" href="sms:${supportNumber()}?&body=${encodeURIComponent(`Ref ${ref}: `)}">
      Text us a question
      <span>Something unclear or looks wrong? We reply. Your reference ${ref} is filled in for you.</span>
    </a>
    ${FIELDS.map((f) =>
      f.key === "compliant"
        ? `<label>${f.label} <span class="hint">— ${f.hint}</span></label>
           <select name="${f.key}" required><option value="">Choose…</option><option value="yes">yes</option><option value="no">no</option><option value="not stated">not stated</option></select>`
        : `<label>${f.label} <span class="hint">— ${f.hint}</span></label>
           <input name="${f.key}" required autocomplete="off">`,
    ).join("")}
    <button type="submit">Submit my answers</button>
    <p class="note">Stuck or something looks wrong? Text <a href="sms:${supportNumber()}?&body=${encodeURIComponent(`Ref ${ref}: `)}"><strong>${supportNumber()}</strong></a> and we will reply. Your reference is <strong>${ref}</strong> — please include it so we know which task you are on. Answering &quot;not stated&quot; is fine when the document does not print something.</p>
    <p class="note">Your answers are recorded against this task only. The document is a synthetic example created for testing and describes no real company.</p>
  </form>
</div>
<script>
const t0=Date.now();
document.querySelector("form").addEventListener("submit",()=>{document.getElementById("durationMs").value=Date.now()-t0});

// Document viewer. The pages render at 200dpi, so "Fit width" is a downscale and zooming in
// walks back toward native resolution rather than past it into mush.
const pages=document.getElementById("pages"), imgs=[...pages.querySelectorAll("img")];
const Z=[1,1.5,2,3]; let zi=0;
const zl=document.getElementById("zl"), pl=document.getElementById("pl");

function apply(keep){
  const sw=pages.scrollWidth, sh=pages.scrollHeight;
  const fx=keep?(pages.scrollLeft+keep.cx)/sw:0, fy=keep?(pages.scrollTop+keep.cy)/sh:0;
  pages.style.setProperty("--z",Z[zi]);
  pages.classList.toggle("zoomed",zi>0);
  zl.textContent=zi?Math.round(Z[zi]*100)+"%":"Fit";
  if(keep)requestAnimationFrame(()=>{
    pages.scrollLeft=fx*pages.scrollWidth-keep.cx;
    pages.scrollTop=fy*pages.scrollHeight-keep.cy;
  });
}
function label(){
  const top=pages.getBoundingClientRect().top; let n=1;
  imgs.forEach((im,i)=>{if(im.getBoundingClientRect().top-top<=80)n=i+1});
  pl.textContent="Page "+n+" of "+imgs.length;
}
function cur(){
  const top=pages.getBoundingClientRect().top; let n=0;
  imgs.forEach((im,i)=>{if(im.getBoundingClientRect().top-top<=80)n=i});
  return n;
}
function goto(i){
  i=Math.max(0,Math.min(imgs.length-1,i));
  pages.scrollTop+=imgs[i].getBoundingClientRect().top-pages.getBoundingClientRect().top-8;
}
document.getElementById("zi").onclick=()=>{if(zi<Z.length-1){zi++;apply()}};
document.getElementById("zo").onclick=()=>{if(zi>0){zi--;apply()}};
document.getElementById("zf").onclick=()=>{zi=0;apply()};
document.getElementById("pn").onclick=()=>goto(cur()+1);
document.getElementById("pp").onclick=()=>goto(cur()-1);
pages.addEventListener("click",e=>{
  if(e.target.tagName!=="IMG")return;
  const r=pages.getBoundingClientRect();
  zi=zi===0?2:0;
  apply({cx:e.clientX-r.left,cy:e.clientY-r.top});
});
pages.addEventListener("scroll",label,{passive:true});
imgs.forEach(im=>im.addEventListener("load",label));
label();
</script>
</div></body></html>`;
}
