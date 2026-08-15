import crypto from "node:crypto";

/**
 * Linq Partner API (iMessage) — raw fetch, no SDK.
 *
 * Every fact below is taken from the Linq Partner API OpenAPI 3.1 spec
 * (title "Linq Partner API", version 1.0.0):
 *   servers[0].url                     -> https://api.linqapp.com/api/partner
 *   components.securitySchemes.BearerAuth -> Authorization: Bearer <token>
 *   POST /v3/messages (operationId sendMessage)
 *   POST /v3/webhook-subscriptions (operationId createWebhookSubscription)
 *   Webhooks tag -> Standard Webhooks signature scheme (verbatim Node snippet)
 *   webhooks: reaction.added / reaction.removed / message.received / message.read /
 *             chat.typing_indicator.started|stopped
 *
 * Nothing here is invented. Where the spec is silent it says so in a TODO.
 */

const DEFAULT_BASE = "https://api.linqapp.com/api/partner";

/** Standard iMessage tapback types, from components.schemas.ReactionType. */
export const REACTION_TYPES = [
  "love",
  "like",
  "dislike",
  "laugh",
  "emphasize",
  "question",
  "custom",
  "sticker",
];

/**
 * The supervisor's approve/block gesture. A tapback is the whole decision UI:
 * love/like on the promotion request message approves it, dislike blocks it.
 * Anything else is deliberately NOT a decision — an ambiguous gesture must not
 * be read as consent to ship a cheaper policy.
 */
export function decisionFromReaction(reactionType) {
  if (reactionType === "love" || reactionType === "like") return "approved";
  if (reactionType === "dislike") return "blocked";
  return null;
}

/** Webhook events this app actually consumes. Values from components.schemas.WebhookEventType. */
export const SUBSCRIBED_EVENTS = [
  "message.received",
  "message.read",
  "reaction.added",
  "reaction.removed",
  "chat.typing_indicator.started",
  "chat.typing_indicator.stopped",
];

const base = () => (process.env.LINQ_API_BASE ?? DEFAULT_BASE).replace(/\/+$/, "");

function apiKey() {
  const key = process.env.LINQ_API_KEY;
  if (!key) {
    throw new Error(
      "LINQ_API_KEY is not set. Get a sandbox key at https://dashboard.linqapp.com/sandbox-signup " +
        "and add LINQ_API_KEY=... to .env, then restart the server.",
    );
  }
  return key;
}

function webhookSecret() {
  const secret = process.env.LINQ_WEBHOOK_SECRET;
  if (!secret) {
    throw new Error(
      "LINQ_WEBHOOK_SECRET is not set. It is the `signing_secret` returned once by " +
        "POST /v3/webhook-subscriptions (format: whsec_<base64>). Add LINQ_WEBHOOK_SECRET=... to .env.",
    );
  }
  return secret;
}

/**
 * E.164 or bust — the spec rejects bare national numbers on `exclude_from` and the
 * same shape is expected on `to`. A 10-digit US number typed by hand is the one
 * forgiving case, because that is what the owner will type at a demo.
 */
export function toE164(handle) {
  const raw = String(handle ?? "").trim();
  if (raw.includes("@")) return raw; // email handles are valid recipients too
  const digits = raw.replace(/[^\d]/g, "");
  if (raw.startsWith("+")) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  throw new Error(`"${handle}" is not an E.164 phone number (expected e.g. +12025551234).`);
}

async function request(path, { method = "POST", body, idempotencyKey } = {}) {
  const headers = { Authorization: `Bearer ${apiKey()}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;

  const res = await fetch(`${base()}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}

  if (!res.ok) {
    // components.schemas.ErrorResponse -> { error: { status, code, message, doc_url }, success: false }
    const e = json?.error ?? {};
    const err = new Error(
      `Linq ${method} ${path} failed: ${res.status} ${e.message ?? text.slice(0, 300)}` +
        (e.code ? ` (code ${e.code})` : ""),
    );
    err.status = res.status;
    err.code = e.code;
    err.docUrl = e.doc_url;
    err.traceId = json?.trace_id ?? res.headers.get("x-trace-id");
    throw err;
  }
  return json ?? text;
}

/**
 * Send one iMessage/SMS. Uses POST /v3/messages, which resolves the sending line AND
 * the target chat itself — that is the only send endpoint that does not require us to
 * already know a chat id, so it is the only one that can cold-start a conversation.
 *
 * `preferred_service` is left unset on purpose: the spec's default fallback chain is
 * iMessage -> RCS -> SMS, so iMessage is tried first anyway, and pinning "iMessage"
 * makes the send FAIL outright for a non-Apple recipient instead of degrading.
 *
 * Sandbox constraint (linqapp.com/hackathon, not the OpenAPI spec): inbound-first —
 * the recipient must text the Linq number once before an outbound send will land.
 */
export async function sendMessage({ to, text, preferredService, idempotencyKey, effect } = {}) {
  if (!text || !String(text).trim()) throw new Error("sendMessage: `text` is required");
  const recipients = (Array.isArray(to) ? to : [to]).filter(Boolean).map(toE164);
  if (!recipients.length) throw new Error("sendMessage: `to` is required");

  const message = { parts: [{ type: "text", value: String(text).slice(0, 10000) }] };
  if (preferredService) message.preferred_service = preferredService;
  if (effect) message.effect = effect;
  if (idempotencyKey) message.idempotency_key = idempotencyKey;

  // 202 Accepted, body = components.schemas.SendMessageResult
  const result = await request("/v3/messages", {
    body: { to: recipients, message },
    idempotencyKey,
  });

  return {
    messageId: result?.message?.id ?? null,
    chatId: result?.chat_id ?? null,
    from: result?.from ?? null,
    service: result?.service ?? null,
    createdNewChat: result?.created_new_chat ?? null,
    reason: result?.from_selection?.reason ?? null,
    deliveryStatus: result?.message?.delivery_status ?? null,
    raw: result,
  };
}

/**
 * Standard Webhooks verification, transcribed from the Node.js snippet in the spec's
 * Webhooks tag description.
 *
 * Signed content is `{webhook-id}.{webhook-timestamp}.{body}` over the RAW bytes —
 * parsing and re-serializing the body changes them and the signature will not match.
 *
 * Returns { valid: true, webhookId, timestamp } or { valid: false, reason }.
 * Throws only for a missing signing secret, which is a config error, not a bad caller.
 *
 * TODO(unverified): the deprecated `X-Webhook-Signature` (hex HMAC) header is also sent
 * on every delivery, but the spec does not state what content it signs. Not implemented
 * rather than guessed.
 */
export function verifyWebhook(rawBody, headers = {}, { toleranceSeconds = 300 } = {}) {
  const secret = webhookSecret();
  const h = (name) => headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()];

  const webhookId = h("webhook-id");
  const timestamp = h("webhook-timestamp");
  const signature = h("webhook-signature");
  if (!webhookId || !timestamp || !signature) {
    return { valid: false, reason: "missing webhook-id / webhook-timestamp / webhook-signature" };
  }

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { valid: false, reason: "webhook-timestamp is not a unix time" };
  const skew = Math.abs(Math.floor(Date.now() / 1000) - ts);
  if (skew > toleranceSeconds) {
    return { valid: false, reason: `timestamp ${skew}s out of ${toleranceSeconds}s tolerance (replay)` };
  }

  const secretStr = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  const keyBytes = Buffer.from(secretStr, "base64");
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), "utf8");
  const signedContent = Buffer.concat([
    Buffer.from(`${webhookId}.${timestamp}.`, "utf8"),
    body,
  ]);
  const expected = crypto.createHmac("sha256", keyBytes).update(signedContent).digest();

  const matched = String(signature)
    .split(" ")
    .some((sig) => {
      if (!sig.startsWith("v1,")) return false;
      try {
        return crypto.timingSafeEqual(expected, Buffer.from(sig.slice(3), "base64"));
      } catch {
        return false;
      }
    });

  return matched
    ? { valid: true, webhookId, timestamp: ts }
    : { valid: false, reason: "signature mismatch" };
}

const textOfParts = (parts) =>
  (Array.isArray(parts) ? parts : [])
    .filter((p) => p?.type === "text" || p?.type === "link")
    .map((p) => p.value)
    .filter(Boolean)
    .join("\n") || null;

/**
 * Normalize either webhook payload version into one shape.
 *
 * Both versions are handled because the shape depends on when the SUBSCRIPTION was
 * created, not on when we wrote this: `2026-02-03` uses `direction` + flat message
 * fields, `2025-01-01` uses `is_from_me` + a nested `message` object. Reaction, typing
 * and read events are identical across versions (spec: "All other events ... use the
 * same format regardless of version").
 */
export function parseInboundEvent(body) {
  const eventType = body?.event_type ?? null;
  const d = body?.data ?? {};
  const common = {
    eventId: body?.event_id ?? null,
    eventType,
    webhookVersion: body?.webhook_version ?? null,
    chatId: d.chat?.id ?? d.chat_id ?? null,
    from: null,
    text: null,
    reaction: null,
    reactionType: null,
    messageId: null,
    isFromMe: null,
    raw: body,
  };

  switch (eventType) {
    case "reaction.added":
    case "reaction.removed":
    case "poll.reaction.added":
      return {
        ...common,
        kind: "reaction",
        from: d.from_handle?.handle ?? d.from ?? null,
        // custom tapbacks carry the emoji in custom_emoji; standard ones do not
        reaction: d.reaction_type === "custom" ? (d.custom_emoji ?? "custom") : (d.reaction_type ?? null),
        reactionType: d.reaction_type ?? null,
        messageId: d.message_id ?? null,
        isFromMe: d.is_from_me ?? null,
        removed: eventType === "reaction.removed",
      };

    case "message.received":
      return {
        ...common,
        kind: "message",
        // v2026-02-03: sender_handle + flat parts. v2025-01-01: from_handle + message.parts.
        from: d.sender_handle?.handle ?? d.from_handle?.handle ?? d.from ?? null,
        text: textOfParts(d.parts ?? d.message?.parts),
        messageId: d.id ?? d.message?.id ?? d.message_id ?? null,
        isFromMe: d.direction ? d.direction === "outbound" : (d.is_from_me ?? false),
      };

    case "message.read":
      return {
        ...common,
        kind: "read",
        from: d.sender_handle?.handle ?? d.from_handle?.handle ?? d.from ?? null,
        messageId: d.id ?? d.message?.id ?? d.message_id ?? null,
        isFromMe: d.direction ? d.direction === "outbound" : (d.is_from_me ?? null),
      };

    case "chat.typing_indicator.started":
    case "chat.typing_indicator.stopped":
      // data is only { chat_id } in both versions — there is no `from` to report.
      return { ...common, kind: "typing", typing: eventType.endsWith("started") };

    default:
      return {
        ...common,
        kind: "other",
        from: d.sender_handle?.handle ?? d.from_handle?.handle ?? d.from ?? null,
        text: textOfParts(d.parts ?? d.message?.parts),
        messageId: d.id ?? d.message?.id ?? d.message_id ?? null,
      };
  }
}

const LIFECYCLE = {
  started: "Calibration started",
  filled: "Calibration wave filled",
  result: "Readiness result",
  "promotion-requested": "POLICY PROMOTION — decision needed",
};

function renderDetail(detail) {
  if (detail == null) return [];
  if (typeof detail === "string") return [detail];
  if (Array.isArray(detail)) return detail.map(String);
  return Object.entries(detail).map(([k, v]) => `${k}: ${v}`);
}

/**
 * Experiment lifecycle notification to the named supervisor.
 *
 * `promotion-requested` is the one that matters: it is the only place a human is asked
 * to authorize shipping a cheaper policy, and the instruction line tells them the
 * tapback IS the decision — no link to click, no dashboard to open.
 */
export async function notifySupervisor({ to, event, detail } = {}) {
  const recipient = to ?? process.env.LINQ_SUPERVISOR_NUMBER;
  if (!recipient) {
    throw new Error(
      "notifySupervisor: no recipient. Pass `to`, or set LINQ_SUPERVISOR_NUMBER=+1... in .env.",
    );
  }
  const title = LIFECYCLE[event];
  if (!title) {
    throw new Error(
      `notifySupervisor: unknown event "${event}". Expected one of ${Object.keys(LIFECYCLE).join(", ")}.`,
    );
  }

  const lines = [`[coverage engine] ${title}`, ...renderDetail(detail)];
  if (event === "promotion-requested") {
    lines.push("", "Tapback this message to decide: Like or Love = APPROVE, Dislike = BLOCK.");
  }

  return sendMessage({ to: recipient, text: lines.join("\n") });
}

/**
 * Register the inbound webhook with Linq. POST /v3/webhook-subscriptions returns
 * `signing_secret` EXACTLY ONCE — capture it into LINQ_WEBHOOK_SECRET immediately or
 * the subscription has to be deleted and recreated.
 *
 * The `?version=` pin is deliberate: without it the payload shape is whatever was
 * latest at creation time, which silently changes between recreations.
 */
export function createWebhookSubscription({
  targetUrl,
  events = SUBSCRIBED_EVENTS,
  phoneNumbers,
  version = "2026-02-03",
} = {}) {
  if (!targetUrl) throw new Error("createWebhookSubscription: `targetUrl` is required (must be https)");
  const url = new URL(targetUrl);
  if (version && !url.searchParams.has("version")) url.searchParams.set("version", version);
  const body = { target_url: url.toString(), subscribed_events: events };
  if (phoneNumbers?.length) body.phone_numbers = phoneNumbers.map(toE164);
  return request("/v3/webhook-subscriptions", { body });
}

export const listWebhookSubscriptions = () =>
  request("/v3/webhook-subscriptions", { method: "GET" });

/** Lines available to send from. Handy for proving the key works without sending anything. */
export const listPhoneNumbers = () => request("/v3/phone_numbers", { method: "GET" });
