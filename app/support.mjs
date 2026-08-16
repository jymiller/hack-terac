import express from "express";
import QRCode from "qrcode";
import { query } from "./db.mjs";
import { sendMessage, notifySupervisor } from "./linq.mjs";
import { page } from "./ui.mjs";

/**
 * Worker support over iMessage.
 *
 * A participant stuck on the task can text the Linq line. Answers that are already written
 * down get sent back immediately; anything else is escalated to the supervisor with the
 * worker's number attached. Escalation is the honest default — guessing at an answer about
 * how to complete PAID work is how you corrupt the data you are buying.
 */

let ready = null;
function ensureSchema() {
  ready ??= query(`
    create table if not exists support_messages (
      id            bigserial primary key,
      from_number   text not null,
      body          text not null,
      matched       text,
      answered      boolean not null default false,
      escalated     boolean not null default false,
      resolved      boolean not null default false,
      received_at   timestamptz not null default now()
    )`).then(() => query(`
      alter table support_messages add column if not exists direction text not null default 'inbound';
      alter table support_messages add column if not exists ref text;
      alter table support_messages add column if not exists terac_submission_id text;
      alter table support_messages add column if not exists cert_id text;
      alter table support_messages add column if not exists raw jsonb;
      create index if not exists support_from_idx on support_messages (from_number);
      create index if not exists support_ref_idx on support_messages (ref);
    `));
  return ready;
}

/**
 * Deliberately keyword-matched rather than model-generated. These answers are promises to
 * someone being paid; a hallucinated one about payment or eligibility is worse than silence.
 */
const FAQ = [
  {
    key: "not_stated",
    match: /not stated|can.?t find|cannot find|isn.?t (in|there)|missing|no.*(figure|value|number)/i,
    reply:
      "If the document genuinely does not print something, type \"not stated\" in that box. That is a correct answer, not a failure — please do not estimate or work it out yourself.",
  },
  {
    key: "which_ratio",
    match: /which ratio|primary ratio|two ratios|more than one ratio|schedule 2/i,
    reply:
      "Some certificates certify more than one ratio. Report the PRIMARY one — the ratio named in the certificate's main body and set out in Schedule 1. Use the name exactly as the document writes it.",
  },
  {
    key: "format",
    match: /format|decimal|how should i write|units|£|pounds|currency|date format/i,
    reply:
      "Write figures exactly as the document prints them, without the £ sign — for example 534.3 or 2.91. Dates as YYYY-MM-DD.",
  },
  {
    key: "payment",
    match: /pay|paid|payment|money|reward|how much|when will i/i,
    reply:
      "Payment is handled by Terac, not by us. Submit the task and Terac approves and pays automatically. If something looks wrong with payment, contact Terac support.",
  },
  {
    key: "period",
    match: /period|date.*(cert|end)|accounting date|calculation date|test date/i,
    reply:
      "We want the date the REPORTING PERIOD ended — the Accounting Date, Test Date, or Calculation Date the certificate covers. That is usually not the same as the date the certificate was signed.",
  },
  {
    key: "broken",
    match: /(doesn.?t|not|won.?t|can.?t).*(load|open|work|submit)|blank|error|stuck/i,
    reply:
      "Sorry about that. Try reloading the link once. If it still will not load, reply BROKEN and a human will pick this up.",
  },
];

export function matchFaq(body) {
  return FAQ.find((f) => f.match.test(body)) ?? null;
}

/** Returns what was done, so the webhook can log it without deciding anything itself. */
/**
 * The ref is a hash of the submission id, so it cannot be inverted — we recompute it over
 * the submissions we have seen and match. The set is small (one row per participant who
 * opened the task), so this stays cheap and needs no extra column to stay in sync.
 */
export async function resolveRef(ref) {
  const want = String(ref).toUpperCase().replace(/-/g, "");
  const { rows } = await query(
    `select terac_submission_id, payload->>'cert' as cert
       from terac_responses order by captured_at desc limit 2000`,
  ).catch(() => ({ rows: [] }));
  return rows.find((r) => refFor(r.terac_submission_id).replace("-", "") === want) ?? null;
}

export async function handleInbound({ from, text, raw = null }) {
  await ensureSchema();
  const body = (text ?? "").trim();
  if (!body) return { action: "ignored" };

  // Who is this? A ref in the message names the submission outright. Failing that, this
  // number has texted before and we already know. Failing that, it stays unattributed
  // rather than being guessed at.
  let ref = (body.match(REF_RE) ?? []).slice(1, 3).join("-").toUpperCase() || null;
  let submissionId = null;
  let certId = null;
  if (!ref) {
    const { rows } = await query(
      `select ref, terac_submission_id, cert_id from support_messages
        where from_number = $1 and ref is not null order by received_at desc limit 1`,
      [from ?? ""],
    ).catch(() => ({ rows: [] }));
    if (rows[0]) { ref = rows[0].ref; submissionId = rows[0].terac_submission_id; certId = rows[0].cert_id; }
  }
  if (ref && !submissionId) {
    const found = await resolveRef(ref);
    if (found) { submissionId = found.terac_submission_id; certId = found.cert; }
  }

  const supervisor = process.env.LINQ_SUPERVISOR_NUMBER;
  const fromSupervisor = supervisor && from && from.replace(/\D/g, "") === supervisor.replace(/\D/g, "");
  const faq = fromSupervisor ? null : matchFaq(body);

  const { rows } = await query(
    `insert into support_messages
       (from_number, body, matched, answered, escalated, direction, ref, terac_submission_id, cert_id, raw)
     values ($1,$2,$3,$4,$5,'inbound',$6,$7,$8,$9) returning id`,
    [from ?? "unknown", body, faq?.key ?? null, Boolean(faq), !faq && !fromSupervisor,
     ref, submissionId, certId, raw],
  );
  const id = rows[0].id;

  if (fromSupervisor) return { action: "from_supervisor", id };

  if (faq) {
    await sendMessage({ to: from, text: faq.reply });
    return { action: "auto_answered", id, matched: faq.key };
  }

  // Nothing written down covers it, so a person decides.
  await notifySupervisor({
    event: "worker question",
    detail:
      `${ref ? `Participant ${ref}` : "Unidentified number"} ${from} asks:\n"${body}"\n\n` +
      `${certId ? `They are working on the ${certId.toUpperCase()} certificate. ` : ""}` +
      `Reply here or in the Support console. Logged as support #${id}.`,
  }).catch((e) => console.error("escalation notify failed:", e.message));
  return { action: "escalated", id };
}

export async function supportState() {
  await ensureSchema();
  const { rows } = await query(
    `select id, from_number, body, matched, answered, escalated, resolved, received_at
       from support_messages order by received_at desc limit 50`,
  );
  const { rows: agg } = await query(
    `select count(*)::int as total,
            sum(answered::int)::int as auto_answered,
            sum(escalated::int)::int as escalated
       from support_messages`,
  );
  return { messages: rows, totals: agg[0] };
}

/**
 * The line workers text. Deliberately NOT LINQ_SUPERVISOR_NUMBER: that is the human's own
 * mobile, and routing participants straight to it bypasses auto-answer, logging, and the
 * reference code that says who is asking.
 */
export const supportNumber = () => process.env.LINQ_SUPPORT_NUMBER ?? "+16462995885";

/**
 * A short, per-participant reference. Deterministic from the submission id, so it can be
 * recomputed rather than stored, and drawn from an alphabet with no 0/O or 1/I so it
 * survives being read off a screen and typed into a text.
 */
const ALPHABET = "ACDEFGHJKLMNPQRTUVWXY2346789";
export function refFor(submissionId) {
  let h = 2166136261 >>> 0;
  for (const ch of String(submissionId)) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  let out = "";
  for (let i = 0; i < 6; i++) {
    out += ALPHABET[h % ALPHABET.length];
    h = Math.floor(h / ALPHABET.length) + 7919;
  }
  return out.slice(0, 3) + "-" + out.slice(3);
}
export const REF_RE = /\b([ACDEFGHJKLMNPQRTUVWXY2346789]{3})-?([ACDEFGHJKLMNPQRTUVWXY2346789]{3})\b/i;

export function registerSupportRoutes(app) {
  const json = express.json();

  app.get("/api/support", async (_req, res) => {
    try {
      res.json(await supportState());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /** Answer a worker from the console. The reply goes out over the same iMessage thread. */
  app.post("/api/support/reply", json, async (req, res) => {
    const { id, text } = req.body ?? {};
    if (!id || !text?.trim()) return res.status(400).json({ error: "id and text are required" });
    try {
      await ensureSchema();
      const { rows } = await query(`select from_number from support_messages where id = $1`, [id]);
      if (!rows.length) return res.status(404).json({ error: "no such message" });
      await sendMessage({ to: rows[0].from_number, text: text.trim() });
      await query(`update support_messages set resolved = true where id = $1`, [id]);
      res.json({ ok: true, to: rows[0].from_number });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  /**
   * QR targets are looked up server-side by ticket id rather than taken from the query
   * string, so this cannot be turned into a generator for arbitrary numbers.
   *   ?ticket=N     -> texts that worker, with their ref pre-filled
   *   ?supervisor=1 -> texts the supervisor, for whoever is operating this dashboard
   */
  app.get("/api/support/qr.png", async (req, res) => {
    try {
      let uri;
      if (req.query.ticket) {
        await ensureSchema();
        const { rows } = await query(
          `select from_number, ref from support_messages where id = $1`,
          [req.query.ticket],
        );
        if (!rows.length) return res.status(404).send("no such ticket");
        const body = rows[0].ref ? `Ref ${rows[0].ref}: ` : "";
        uri = `sms:${rows[0].from_number}${body ? `?&body=${encodeURIComponent(body)}` : ""}`;
      } else if (req.query.supervisor) {
        const n = process.env.LINQ_SUPERVISOR_NUMBER;
        if (!n) return res.status(404).send("LINQ_SUPERVISOR_NUMBER not set");
        uri = `sms:${n.startsWith("+") ? n : "+" + n}`;
      } else {
        uri = `sms:${supportNumber()}`;
      }
      const png = await QRCode.toBuffer(uri, { width: 300, margin: 1 });
      res.type("png").set("Cache-Control", "no-store").send(png);
    } catch (err) {
      res.status(500).send(err.message);
    }
  });

  app.get("/support", async (_req, res) => {
    try {
      const s = await supportState();
      res.type("html").send(supportPage(s));
    } catch (err) {
      res.status(500).send(`<pre>${err.message}</pre>`);
    }
  });
}

const esc = (t) =>
  String(t).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);

function supportPage(s) {
  const rows = s.messages.length
    ? s.messages
        .map(
          (m) => `<tr>
    <td class="t">${new Date(m.received_at).toLocaleTimeString()}</td>
    <td><code>${esc(m.from_number)}</code></td>
    <td class="msg">${esc(m.body)}</td>
    <td>${m.answered ? `<span class="tag ok">auto · ${esc(m.matched)}</span>` : m.escalated ? `<span class="tag warn">escalated</span>` : `<span class="dim">—</span>`}</td>
    <td class="act">${
      m.resolved
        ? '<span class="ok">replied</span>'
        : m.answered
          ? `<span class="dim">—</span>`
          : `<button class="ghost" onclick="reply(${m.id})">Reply</button>`
    }</td></tr>`,
        )
        .join("")
    : `<tr><td colspan="5" class="mut">No worker messages yet. Text ${supportNumber()} to try it.</td></tr>`;

  const tableSoWhat = s.messages.length
    ? `<p class="sowhat">The Handling column is the split that matters: <b>every “escalated” row is a question that cost a human their attention</b>, and every “auto” row is one that cost nothing because the answer was already written down. A row still offering Reply is a paid participant sitting idle — at roughly $1.69 a reading, a stalled worker is worth more than the minute it takes to answer. When the same question escalates twice, that is a missing FAQ entry, not a careless worker.</p>`
    : `<p class="sowhat">Nothing has arrived yet, so <b>this table cannot yet tell you whether the task is clear or merely untried</b> — a well-written task and an unstarted one look identical from here. It becomes evidence about task clarity only once participants are working.</p>`;

  const body = `
<h1>Worker support</h1>
<p class="lede">Questions from paid participants, over SMS on ${supportNumber()}.</p>
<p class="sub">Answers that are already written down go back immediately. Anything else escalates to a human, here and on the supervisor's phone — guessing at an answer about payment or eligibility is how you corrupt the readings you are buying.</p>
<div class="banner live">Live line. These are real inbound texts, and Reply sends over the same thread.</div>

<h2>Volume</h2>
<div class="grid">
  <div><label>Messages</label><div class="big">${s.totals.total ?? 0}</div></div>
  <div><label>Auto-answered</label><div class="big ok">${s.totals.auto_answered ?? 0}</div></div>
  <div><label>Escalated to you</label><div class="big warn">${s.totals.escalated ?? 0}</div></div>
</div>
<p class="sowhat">Only the middle number is free. <b>Escalated is the count of times a person had to stop and answer</b>, and it is the entire human cost of running support for this batch; auto-answered questions were settled from text written once, in advance. Watch the two move against each other — escalations growing while auto-answers stall means the written answers no longer cover what workers are actually asking.</p>

<h2>Reach the line</h2>
<div class="card qr">
  <img src="/api/support/qr.png" alt="Scan to text worker support" width="150" height="150">
  <div>
    <strong>Scan to reach support</strong>
    <p class="sub">Opens a text to <code>${supportNumber()}</code>. Point a participant, a reviewer, or anyone helping at this and they can ask without typing a number. Written answers come back automatically; anything else lands in the table below.</p>
  </div>
</div>
<p class="sowhat">This is deliberately not the supervisor's mobile. <b>A question that arrives on a personal number is invisible to every count on this page</b> — it skips auto-answer, logging, and the reference code that says who is asking. Route people here if you want support volume to stay measurable.</p>

<h2>Messages</h2>
<div class="card"><table>
<thead><tr><th>Time</th><th>From</th><th>Message</th><th>Handling</th><th></th></tr></thead>
<tbody>${rows}</tbody>
</table></div>
${tableSoWhat}
<p class="sub" style="margin-top:14px">Refreshes every 15 seconds.</p>`;

  const extraCss = `
.qr{display:flex;gap:20px;align-items:center}
.qr img{background:#fff;padding:8px;border-radius:10px;flex:none}
.qr .sub{margin:6px 0 0}
td.t{white-space:nowrap;color:var(--dim);font-variant-numeric:tabular-nums}
td.msg{max-width:44ch}
td.act{text-align:right;white-space:nowrap}
`;

  const script = `
async function reply(id){
  const text=prompt("Reply to this worker over iMessage:");
  if(!text) return;
  const r=await fetch("/api/support/reply",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({id,text})});
  const j=await r.json();
  if(!r.ok) return alert("Failed: "+(j.error||"unknown"));
  location.reload();
}
setInterval(()=>location.reload(),15000);
`;

  return page({ title: "Worker Support", current: "/support", body, extraCss, script });
}
