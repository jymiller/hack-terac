/**
 * Pioneer by Fastino Labs — open-weight model inference.
 *
 * Verified from docs (2026-08-15):
 *   Base URL   https://api.pioneer.ai
 *   Chat path  POST /v1/chat/completions   (OpenAI-compatible drop-in)
 *   Auth       docs are INCONSISTENT: api-reference/overview shows `X-API-Key: <key>`,
 *              while concepts/g-li-ner-2-pii shows `Authorization: Bearer <key>`.
 *              We send BOTH headers; whichever the gateway honours wins.
 *
 * Open-weight decoder model ids (docs/concepts/models):
 *   deepseek-ai/DeepSeek-V4-Flash, zai-org/GLM-5.2, zai-org/GLM-5.2-Fast
 * Encoder model ids:
 *   fastino/gliner2-base-v1
 *   fastino/gliner2-privacy-filter-PII-multi     (GLiNER2-PII)
 *   fastino/gliguard-LLMGuardrails-300M          (GLiGuard)
 *
 * Pioneer extends the OpenAI body with `schema` (entities / classifications),
 * `include_confidence` and `include_spans` for the GLiNER-family encoders.
 */

const DEFAULT_BASE_URL = "https://api.pioneer.ai";

/** Open-weight decoder. Override with PIONEER_MODEL. */
export const DEFAULT_MODEL = process.env.PIONEER_MODEL || "zai-org/GLM-5.2";
export const PII_MODEL = "fastino/gliner2-privacy-filter-PII-multi";
export const PROPOSER = "pioneer-open-weight-v1";

const DISPOSITIONS = new Set(["supported", "not_supported", "insufficient"]);

export function isConfigured() {
  return Boolean(process.env.PIONEER_API_KEY);
}

function requireKey() {
  const key = process.env.PIONEER_API_KEY;
  if (!key) {
    throw new Error(
      "PIONEER_API_KEY is not set. Add PIONEER_API_KEY=<key> to .env " +
        "(create one at https://agent.pioneer.ai -> Settings -> API Keys) " +
        "and run with `node --env-file=.env`.",
    );
  }
  return key;
}

function baseUrl() {
  return (process.env.PIONEER_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

async function post(path, body, { timeoutMs = 45000 } = {}) {
  const key = requireKey();
  const res = await fetch(`${baseUrl()}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": key,
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Pioneer ${path} ${res.status}: ${text.slice(0, 400)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Pioneer ${path} returned non-JSON: ${text.slice(0, 200)}`);
  }
}

/** OpenAI-compatible chat completion. Extra Pioneer fields pass straight through. */
export async function chat({ model = DEFAULT_MODEL, messages, ...rest }) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error("chat({ messages }) requires a non-empty messages array");
  }
  return post("/v1/chat/completions", { model, messages, ...rest });
}

/**
 * TODO(unverified): docs say "call GET /base-models" without stating whether it is
 * versioned. We try the unversioned path first, then /v1. Used only by the smoke script
 * to report the real catalog rather than trusting hardcoded ids.
 */
export async function listBaseModels() {
  const key = requireKey();
  const headers = { "X-API-Key": key, Authorization: `Bearer ${key}` };
  const errors = [];
  for (const path of ["/base-models", "/v1/base-models", "/v1/models"]) {
    try {
      const res = await fetch(`${baseUrl()}${path}`, {
        headers,
        signal: AbortSignal.timeout(20000),
      });
      if (res.ok) return { path, body: await res.json() };
      errors.push(`${path} -> ${res.status}`);
    } catch (err) {
      errors.push(`${path} -> ${err.message}`);
    }
  }
  throw new Error(`No base-model listing endpoint responded (${errors.join("; ")})`);
}

function textOf(completion) {
  const msg = completion?.choices?.[0]?.message;
  if (typeof msg?.content === "string") return msg.content;
  // Some gateways return content as an array of parts.
  if (Array.isArray(msg?.content)) {
    return msg.content.map((p) => (typeof p === "string" ? p : (p?.text ?? ""))).join("");
  }
  if (typeof completion?.choices?.[0]?.text === "string") return completion.choices[0].text;
  return "";
}

/** Pull the first JSON object out of a reply that may be fenced or have prose around it. */
function extractJson(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1], text];
  for (const c of candidates) {
    if (!c) continue;
    const start = c.indexOf("{");
    const end = c.lastIndexOf("}");
    if (start === -1 || end <= start) continue;
    try {
      return JSON.parse(c.slice(start, end + 1));
    } catch {
      /* fall through */
    }
  }
  return null;
}

function coerceDisposition(value) {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (DISPOSITIONS.has(v)) return v;
  if (v === "not_support" || v === "unsupported" || v === "refuted") return "not_supported";
  if (v === "insufficient_evidence" || v === "unknown") return "insufficient";
  return null;
}

function coerceConfidence(value) {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return n <= 100 ? n / 100 : 1;
  return n;
}

const SYSTEM_PROMPT = [
  "You adjudicate a proposition against an evidence snippet in a credit-agreement review.",
  "Reply with ONLY a JSON object, no prose, no code fence:",
  '{"disposition":"supported"|"not_supported"|"insufficient","confidence":<number 0-1>}',
  "",
  "supported     = the evidence contains every figure needed AND the proposition holds.",
  "not_supported = the evidence contains every figure needed AND the proposition fails.",
  "insufficient  = a figure required to decide is ABSENT from the evidence.",
  "",
  "Never assume, infer, or default a missing figure. If any input the test requires is",
  "not present in the snippet, the answer is insufficient regardless of how the other",
  "figures look. Confidence is your probability that your disposition is correct.",
].join("\n");

/**
 * Model-backed alternative to the rule extractor in app/experiment.mjs.
 *
 * Returns the same shape that experiment.propose() returns, so it can back an
 * experiment arm directly. Never throws on a bad/malformed model reply — returns
 * { disposition: null, confidence: 0 } and lets the caller decide. Throws ONLY when
 * PIONEER_API_KEY is missing, which is a config error worth surfacing loudly.
 */
export async function proposeDisposition(claim, { model = DEFAULT_MODEL, temperature = 0 } = {}) {
  requireKey();
  const started = Date.now();
  const base = { disposition: null, confidence: 0, cost_usd: 0, model, proposer: PROPOSER };

  let completion;
  try {
    completion = await chat({
      model,
      temperature,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: `EVIDENCE:\n${claim?.evidence ?? ""}\n\nPROPOSITION:\n${claim?.proposition ?? ""}`,
        },
      ],
    });
  } catch (err) {
    return { ...base, latency_ms: Date.now() - started, error: err.message };
  }

  const raw = textOf(completion);
  const parsed = extractJson(raw);
  const disposition = coerceDisposition(parsed?.disposition);
  const confidence = disposition ? coerceConfidence(parsed?.confidence) : 0;

  return {
    ...base,
    disposition,
    confidence,
    latency_ms: Date.now() - started,
    raw: raw.slice(0, 500),
  };
}

const PII_ENTITIES = [
  "person",
  "email",
  "phone_number",
  "address",
  "organization",
  "account_number",
  "date_of_birth",
];

function collectEntities(payload, text) {
  // TODO(unverified): the docs show the GLiNER2-PII request verbatim but do not publish
  // the response body. We probe the plausible carriers and tolerate all of them.
  const direct = payload?.entities ?? payload?.result?.entities ?? payload?.result;
  const fromContent = extractJson(textOf(payload));
  // Returns null when NO recognisable entity carrier was present at all. That is not the
  // same as "no PII found" and must not be reported as a successful redaction.
  const candidate =
    (Array.isArray(direct) && direct) ||
    (Array.isArray(fromContent?.entities) && fromContent.entities) ||
    (Array.isArray(fromContent) && fromContent) ||
    null;
  if (candidate === null) return null;

  return candidate
    .map((e) => {
      if (typeof e !== "object" || e === null) return null;
      const label = e.label ?? e.type ?? e.entity ?? e.entity_type ?? "REDACTED";
      const start = Number.isInteger(e.start) ? e.start : Number.isInteger(e.start_char) ? e.start_char : null;
      const end = Number.isInteger(e.end) ? e.end : Number.isInteger(e.end_char) ? e.end_char : null;
      const value =
        typeof e.text === "string"
          ? e.text
          : typeof e.value === "string"
            ? e.value
            : start !== null && end !== null
              ? text.slice(start, end)
              : null;
      if (!value && start === null) return null;
      return { label: String(label), value, start, end, confidence: coerceConfidence(e.confidence ?? e.score) };
    })
    .filter(Boolean);
}

/**
 * Redact PII from an evidence capsule with GLiNER2-PII before a human sees it.
 * Returns { redacted, entities, ok }. On any failure it returns the ORIGINAL text with
 * ok:false — callers must treat ok:false as "not safe to show a human" rather than
 * assuming redaction happened.
 */
export async function redactPII(text, { entities = PII_ENTITIES } = {}) {
  requireKey();
  if (typeof text !== "string" || text.length === 0) {
    return { redacted: text ?? "", entities: [], ok: true };
  }

  let payload;
  try {
    payload = await post("/v1/chat/completions", {
      model: PII_MODEL,
      messages: [{ role: "user", content: text }],
      schema: { entities },
      include_confidence: true,
      include_spans: true,
    });
  } catch (err) {
    return { redacted: text, entities: [], ok: false, error: err.message };
  }

  const found = collectEntities(payload, text);
  if (found === null) {
    return {
      redacted: text,
      entities: [],
      ok: false,
      error:
        "GLiNER2-PII response shape not recognised — cannot confirm redaction ran. " +
        "Treat this text as UNREDACTED. Response keys: " +
        Object.keys(payload ?? {}).join(",").slice(0, 120),
    };
  }
  if (found.length === 0) return { redacted: text, entities: [], ok: true };

  // Prefer spans (exact, handles repeats correctly); fall back to string replacement.
  const spanned = found.filter((e) => e.start !== null && e.end !== null && e.end > e.start);
  let redacted = text;
  if (spanned.length === found.length) {
    for (const e of [...spanned].sort((a, b) => b.start - a.start)) {
      redacted = redacted.slice(0, e.start) + `[${e.label.toUpperCase()}]` + redacted.slice(e.end);
    }
  } else {
    for (const e of found) {
      if (!e.value) continue;
      redacted = redacted.split(e.value).join(`[${e.label.toUpperCase()}]`);
    }
  }
  return { redacted, entities: found, ok: true };
}
