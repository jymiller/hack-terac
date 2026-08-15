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
    )`);
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
export async function handleInbound({ from, text }) {
  await ensureSchema();
  const body = (text ?? "").trim();
  if (!body) return { action: "ignored" };

  const supervisor = process.env.LINQ_SUPERVISOR_NUMBER;
  const fromSupervisor = supervisor && from && from.replace(/\D/g, "") === supervisor.replace(/\D/g, "");
  const faq = fromSupervisor ? null : matchFaq(body);

  const { rows } = await query(
    `insert into support_messages (from_number, body, matched, answered, escalated)
     values ($1,$2,$3,$4,$5) returning id`,
    [from ?? "unknown", body, faq?.key ?? null, Boolean(faq), !faq && !fromSupervisor],
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
    detail: `${from} asks: "${body}"\n\nReply to them directly on ${from}. Logged as support #${id}.`,
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
