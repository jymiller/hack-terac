import express from "express";
import QRCode from "qrcode";
import { query } from "./db.mjs";
import { sendMessage, notifySupervisor } from "./linq.mjs";

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

function supportPage(s) {
  const nav = `<nav><a href="/">Coverage board</a><a href="/ops">Operator</a><a href="/design">Designer</a><a href="/funnel">Funnel</a><a href="/results">Results</a><a href="/support" class="on">Support</a></nav>`;
  const rows = s.messages.length
    ? s.messages
        .map(
          (m) => `<tr>
    <td style="color:var(--mut);white-space:nowrap">${new Date(m.received_at).toLocaleTimeString()}</td>
    <td><code>${m.from_number}</code></td>
    <td>${m.body.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c])}</td>
    <td>${m.answered ? `<span class="ok">auto · ${m.matched}</span>` : m.escalated ? `<span class="warn">escalated</span>` : "—"}</td>
    <td>${
      m.resolved
        ? '<span class="ok">replied</span>'
        : m.answered
          ? "—"
          : `<button class="ghost" onclick="reply(${m.id})">Reply</button>`
    }</td></tr>`,
        )
        .join("")
    : `<tr><td colspan="5" style="color:var(--mut)">No worker messages yet. Text +1 646 299-5885 to try it.</td></tr>`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Worker Support</title><style>
:root{color-scheme:light dark;--bg:#0c0c0d;--fg:#f4f4f5;--mut:#a1a1aa;--line:#27272a;--card:#161617;--ok:#4ade80;--warn:#fbbf24;--acc:#60a5fa}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
.wrap{max-width:1080px;margin:0 auto;padding:26px 20px 80px}
nav{display:flex;gap:18px;flex-wrap:wrap;margin:0 0 24px;padding-bottom:12px;border-bottom:1px solid var(--line);font-size:13px}
nav a{color:var(--mut);text-decoration:none}nav a.on{color:var(--fg)}
h1{font-size:22px;margin:0 0 2px}.sub{color:var(--mut);font-size:13px;margin:0 0 18px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:16px}
.big{font-size:26px;font-variant-numeric:tabular-nums}
label{font-size:12px;color:var(--mut);display:block}
table{width:100%;border-collapse:collapse;font-size:14px}
th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--mut);padding:6px 8px;border-bottom:1px solid var(--line);font-weight:500}
td{padding:9px 8px;border-bottom:1px solid var(--line);vertical-align:top}tr:last-child td{border-bottom:0}
.ok{color:var(--ok)}.warn{color:var(--warn)}
button{background:transparent;color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:6px 12px;cursor:pointer;font:inherit}
a{color:var(--acc)}code{font-size:12.5px}
</style></head><body><div class="wrap">${nav}
<h1>Worker Support</h1>
<p class="sub">Questions from paid participants, over iMessage on +1 646 299-5885. Written answers go out automatically; anything else waits for you here or on your phone.</p>
<div class="card grid">
  <div><label>Messages</label><div class="big">${s.totals.total ?? 0}</div></div>
  <div><label>Auto-answered</label><div class="big ok">${s.totals.auto_answered ?? 0}</div></div>
  <div><label>Escalated to you</label><div class="big warn">${s.totals.escalated ?? 0}</div></div>
</div>
<div class="card" style="display:flex;gap:20px;align-items:center;margin-bottom:16px">
  <img src="/api/support/qr.png" alt="Scan to text worker support" width="150" height="150"
       style="background:#fff;padding:8px;border-radius:10px;flex:none">
  <div>
    <strong>Scan to reach support</strong>
    <p class="sub" style="margin:6px 0 0">Opens a text to <code>${supportNumber()}</code>.
    Point a participant, a judge, or anyone helping at this and they can ask a question without typing a number.
    Written answers come back automatically; anything else lands in the table below and on the supervisor's phone.</p>
  </div>
</div>
<div class="card"><table>
<tr><th>Time</th><th>From</th><th>Message</th><th>Handling</th><th></th></tr>${rows}
</table></div>
<script>
async function reply(id){
  const text=prompt("Reply to this worker over iMessage:");
  if(!text) return;
  const r=await fetch("/api/support/reply",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({id,text})});
  const j=await r.json();
  if(!r.ok) return alert("Failed: "+(j.error||"unknown"));
  location.reload();
}
setInterval(()=>location.reload(),15000);
</script>
</div></body></html>`;
}
