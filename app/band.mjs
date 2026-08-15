/**
 * Band (band.ai) agent coordination rooms — the promotion gate for this coverage engine.
 *
 * The load-bearing decision in this product is PROMOTING A CHEAPER ATTESTATION POLICY to
 * AUTO. That promotion is not allowed to happen in code. It happens in a Band room:
 *
 *   1. Coverage Proposer  posts the claim: process X cleared the floor at threshold T.
 *   2. Coverage Risk Officer independently recomputes the Wilson 95% lower bound and
 *      posts BLOCKED (terminal) or CLEARED.
 *   3. A named human replies APPROVE or BLOCK in the room.
 *   4. assertPromotionApproved() reads the room and returns a receipt — room id, message
 *      id, and the human's name — which is the only thing that unlocks the promotion.
 *
 * Delete the room and step 4 has nothing to read, so the promotion cannot happen.
 *
 * Transport: Band's Request API (REST) over global fetch. No SDK, no dependencies.
 * A WebSocket (wss://app.band.ai/api/v1/socket/websocket, Phoenix Channels) only matters
 * for push delivery to a long-running agent loop; this gate polls, which the docs list as
 * the supported alternative.
 *
 * Every call needs credentials. Nothing here touches the network at import time, and every
 * export throws a named-env-var Error rather than crashing the server that imported it.
 */

import { readFileSync, writeFileSync } from "node:fs";

const BASE = (process.env.BAND_BASE_URL || "https://app.band.ai").replace(/\/+$/, "");

/** Agent keys land here when auto-registered. `.env.*` is already gitignored. */
const CACHE_FILE = process.env.BAND_AGENTS_FILE || ".env.band.json";

/** The two agents that have to agree before a policy can ship. */
export const ROLES = {
  proposer: {
    name: "Coverage Proposer",
    description:
      "Proposes promoting a coverage process to AUTO once its Wilson 95% lower bound clears the service floor. Posts the evidence, never the decision.",
    idEnv: "BAND_PROPOSER_AGENT_ID",
    keyEnv: "BAND_PROPOSER_KEY",
  },
  risk: {
    name: "Coverage Risk Officer",
    description:
      "Blocks any promotion whose Wilson 95% lower bound sits under the service floor, or whose coverage or turnaround misses. A block is terminal until it is cleared in the room.",
    idEnv: "BAND_RISK_AGENT_ID",
    keyEnv: "BAND_RISK_KEY",
  },
};

export class BandError extends Error {
  constructor(message, { status, code, requestId } = {}) {
    super(message);
    this.name = "BandError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

const missing = (envVar, why) =>
  new BandError(
    `Band is not configured: ${envVar} is empty. ${why} Create a free account at https://app.band.ai, mint a user API key at ` +
      `https://app.band.ai/users/settings, put it in ${envVar} in .env, then re-run.`,
  );

/** True when Band can be reached at all. Callers use this to skip, not to silently pass. */
export const configured = () => Boolean(process.env.BAND_API_KEY);

function humanKey() {
  const k = process.env.BAND_API_KEY;
  if (!k) {
    throw missing(
      "BAND_API_KEY",
      "The promotion gate needs the account key to open the room, name the human approver, and read the verdict.",
    );
  }
  return k;
}

async function request(apiKey, method, path, { query, body } = {}) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, {
    method,
    headers: {
      "X-API-Key": apiKey,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = {};
  }
  if (!res.ok) {
    const e = json?.error || {};
    throw new BandError(
      `Band ${method} ${path} failed (${res.status} ${e.code || "error"}): ${e.message || text.slice(0, 200)}`,
      { status: res.status, code: e.code, requestId: e.request_id },
    );
  }
  return json;
}

/* ------------------------------------------------------------------ credentials */

function readCache() {
  try {
    return JSON.parse(readFileSync(CACHE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function writeCache(cache) {
  writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2) + "\n", { mode: 0o600 });
}

const creds = new Map();

/**
 * Credentials for one role, in order: explicit env vars, the local cache, then a fresh
 * registration against the account key. Band shows an agent API key exactly once, so a
 * newly registered pair is written to CACHE_FILE or it is lost.
 */
export async function agentCredentials(role) {
  const spec = ROLES[role];
  if (!spec) throw new BandError(`Unknown Band role "${role}". Known roles: ${Object.keys(ROLES).join(", ")}.`);
  if (creds.has(role)) return creds.get(role);

  const envId = process.env[spec.idEnv];
  const envKey = process.env[spec.keyEnv];
  if (envId && envKey) {
    const c = { id: envId, apiKey: envKey, name: spec.name, source: "env" };
    creds.set(role, c);
    return c;
  }

  const cache = readCache();
  if (cache[role]?.id && cache[role]?.api_key) {
    const c = { id: cache[role].id, apiKey: cache[role].api_key, name: cache[role].name || spec.name, source: CACHE_FILE };
    creds.set(role, c);
    return c;
  }

  const key = humanKey();
  const out = await request(key, "POST", "/api/v1/me/agents/register", {
    body: { agent: { name: spec.name, description: spec.description } },
  });
  const agent = out.data.agent;
  const apiKey = out.data.credentials.api_key;
  cache[role] = { id: agent.id, api_key: apiKey, name: agent.name };
  writeCache(cache);
  const c = { id: agent.id, apiKey, name: agent.name, source: "registered" };
  creds.set(role, c);
  return c;
}

/** The account owner — the named human whose APPROVE or BLOCK ends the flow. */
export async function approver() {
  const { data } = await request(humanKey(), "GET", "/api/v1/me/profile");
  const name = [data.first_name, data.last_name].filter(Boolean).join(" ") || data.handle;
  return { id: data.id, handle: data.handle, name, email: data.email };
}

/* ------------------------------------------------------------------ room primitives */

// TODO(unverified): Band documents the console at app.band.ai and the agent page at
// app.band.ai/agents, but never spells out the deep link to a single room. This pattern is
// a guess — override with BAND_ROOM_URL_TEMPLATE (use {id}) once you've opened a room and
// read the address bar. The room id is printed everywhere alongside it, so nothing breaks
// if the link is wrong.
const roomUrl = (roomId) =>
  // UI route is /chat/{id} (singular). The API paths below are /chats/ — different things.
  (process.env.BAND_ROOM_URL_TEMPLATE || `${BASE}/chat/{id}`).replace("{id}", roomId);

/** Opens a room owned by the proposer agent. */
export async function createRoom({ title, as = "proposer" } = {}) {
  const c = await agentCredentials(as);
  const { data } = await request(c.apiKey, "POST", "/api/v1/agent/chats", {
    body: { chat: { title: (title || "Policy promotion").slice(0, 120) } },
  });
  return { roomId: data.id, title: data.title, url: roomUrl(data.id) };
}

export async function participants(roomId, { as = "proposer" } = {}) {
  const c = await agentCredentials(as);
  const { data } = await request(c.apiKey, "GET", `/api/v1/agent/chats/${roomId}/participants`);
  return data;
}

/** Idempotently puts a participant in the room. `as` is the role whose key does the adding. */
async function addParticipant(roomId, participantId, { as = "proposer" } = {}) {
  const already = await participants(roomId, { as });
  if (already.some((p) => p.id === participantId)) return { added: false };
  const c = await agentCredentials(as);
  await request(c.apiKey, "POST", `/api/v1/agent/chats/${roomId}/participants`, {
    body: { participant: { participant_id: participantId, role: "member" } },
  });
  return { added: true };
}

/** joinAgent("<room>", "risk") — puts one of the ROLES agents in the room. */
export async function joinAgent(roomId, agentName, { as = "proposer" } = {}) {
  const role = resolveRole(agentName);
  const c = await agentCredentials(role);
  const { added } = await addParticipant(roomId, c.id, { as });
  return { role, agentId: c.id, name: c.name, added };
}

/** Puts the named human in the room. Humans see every message, mentioned or not. */
export async function joinHuman(roomId, { as = "proposer" } = {}) {
  const person = await approver();
  const { added } = await addParticipant(roomId, person.id, { as });
  return { ...person, added };
}

function resolveRole(agentName) {
  if (ROLES[agentName]) return agentName;
  const hit = Object.entries(ROLES).find(([, s]) => s.name.toLowerCase() === String(agentName).toLowerCase());
  if (hit) return hit[0];
  throw new BandError(`Unknown Band agent "${agentName}". Known: ${Object.keys(ROLES).join(", ")}.`);
}

/**
 * postMessage(roomId, "risk", "…", { mentions }) — a text message as that agent.
 * Band routes on @mentions: only mentioned agents receive a message, so every message in
 * this flow names who has to act on it.
 */
export async function postMessage(roomId, from, text, { mentions = [] } = {}) {
  const role = resolveRole(from);
  const c = await agentCredentials(role);
  const { data } = await request(c.apiKey, "POST", `/api/v1/agent/chats/${roomId}/messages`, {
    body: {
      message: {
        content: text,
        mentions: mentions.map((m) => ({ id: m.id, name: m.name, kind: m.kind || "mention" })),
      },
    },
  });
  return { messageId: data.id, recipients: data.recipients };
}

/** A non-text event (thought / tool_result / attention) — the room's evidence trail. */
export async function postEvent(roomId, from, { content, messageType = "thought", metadata }) {
  const role = resolveRole(from);
  const c = await agentCredentials(role);
  const { data } = await request(c.apiKey, "POST", `/api/v1/agent/chats/${roomId}/events`, {
    body: { event: { content, message_type: messageType, ...(metadata ? { metadata } : {}) } },
  });
  return { eventId: data.id, messageType: data.message_type };
}

/**
 * Full room transcript, oldest first. Read with the account key when present (a human sees
 * everything); otherwise fall back to an agent's mention-scoped context.
 */
export async function transcript(roomId, { as = "proposer", limit = 100 } = {}) {
  if (process.env.BAND_API_KEY) {
    const { data } = await request(humanKey(), "GET", `/api/v1/me/chats/${roomId}/messages`, {
      query: { limit },
    });
    return [...data].sort((a, b) => String(a.inserted_at).localeCompare(String(b.inserted_at)));
  }
  const c = await agentCredentials(as);
  const { data } = await request(c.apiKey, "GET", `/api/v1/agent/chats/${roomId}/context`, { query: { limit } });
  return data;
}

/* ------------------------------------------------------------------ the decision */

const APPROVE = /\bAPPROVE(D)?\b/i;
const BLOCK = /\bBLOCK(ED|S)?\b/i;

/**
 * Puts a blocking decision in front of named humans: a Band `attention` event (kind
 * "review", blocking true — the platform's human-in-the-loop primitive, which never
 * auto-resolves) plus the message that @mentions them.
 */
export async function requestDecision(roomId, { proposal, approvers, from = "proposer" } = {}) {
  if (!proposal) throw new BandError("requestDecision needs a { proposal } string — what exactly is being approved.");
  const people = approvers?.length ? approvers : [await approver()];
  const names = people.map((p) => p.name).join(", ");

  const { eventId } = await postEvent(roomId, from, {
    messageType: "attention",
    content: `Awaiting a human decision from ${names}: ${proposal}`,
    metadata: { kind: "review", blocking: true, proposal, approvers: people.map((p) => p.handle || p.name) },
  });

  const { messageId } = await postMessage(
    roomId,
    from,
    `${people.map((p) => `@${p.name}`).join(" ")} decision required. ${proposal}\n` +
      `Reply APPROVE to promote, or BLOCK to keep this process on HOLD. Nothing ships until you answer here.`,
    { mentions: people.map((p) => ({ id: p.id, name: p.name })) },
  );

  return { roomId, decisionId: eventId, messageId, approvers: people, url: roomUrl(roomId) };
}

/**
 * Reads the room and derives the verdict.
 *   - A BLOCK from the risk agent is terminal until that same agent posts CLEARED later.
 *   - Only a human (sender_type "User") can approve.
 * Returns a receipt the caller can store as the audit record for the promotion.
 */
export async function readDecision(roomId, { as = "proposer" } = {}) {
  const msgs = await transcript(roomId, { as });
  const risk = (await agentCredentials("risk")).id;
  // Match on id, and on name too: a reader that re-registered its agents still has to
  // honour a block posted by the risk officer that argued the case.
  const isRisk = (m) => m.sender_id === risk || m.sender_name === ROLES.risk.name;

  let riskVerdict = null;
  let human = null;

  for (const m of msgs) {
    const body = String(m.content || "");
    if (isRisk(m) && m.message_type === "text") {
      if (BLOCK.test(body)) riskVerdict = { status: "blocked", quote: body, at: m.inserted_at, messageId: m.id };
      else if (/\bCLEARED\b/i.test(body)) riskVerdict = { status: "cleared", quote: body, at: m.inserted_at, messageId: m.id };
    }
    // BLOCK is tested first on purpose: a reply containing both words is ambiguous, and an
    // ambiguous human answer must not promote anything.
    if (m.sender_type === "User" && m.message_type === "text") {
      if (BLOCK.test(body)) human = { status: "blocked", by: m.sender_name, quote: body, at: m.inserted_at, messageId: m.id };
      else if (APPROVE.test(body)) human = { status: "approved", by: m.sender_name, quote: body, at: m.inserted_at, messageId: m.id };
    }
  }

  const base = { roomId, url: roomUrl(roomId), risk: riskVerdict, human, messages: msgs.length };
  if (riskVerdict?.status === "blocked") {
    return { ...base, status: "blocked", by: ROLES.risk.name, reason: riskVerdict.quote, at: riskVerdict.at, messageId: riskVerdict.messageId };
  }
  if (human) return { ...base, status: human.status, by: human.by, reason: human.quote, at: human.at, messageId: human.messageId };
  return { ...base, status: "pending" };
}

/** Polls until the room produces a verdict. Pending at timeout stays pending — never approved. */
export async function awaitDecision(roomId, { timeoutMs = 120000, pollMs = 4000, as = "proposer" } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = await readDecision(roomId, { as });
  while (last.status === "pending" && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs));
    last = await readDecision(roomId, { as });
  }
  return last;
}

/* ------------------------------------------------------------------ product wiring */

/**
 * Opens the promotion room and posts the case: the proposer's claim plus the evidence it
 * rests on. Returns the room the rest of the flow runs in.
 */
export async function openPromotionRoom({
  processId,
  threshold,
  wilsonLower,
  floor,
  x,
  n,
  coverage,
  costPerTrusted,
}) {
  if (!processId) throw new BandError("openPromotionRoom needs a processId.");
  const room = await createRoom({ title: `Promote ${processId} to AUTO` });
  const risk = await joinAgent(room.roomId, "risk");
  const human = await joinHuman(room.roomId);

  await postEvent(room.roomId, "proposer", {
    messageType: "tool_result",
    content: `Readiness for ${processId}: Wilson 95% lower bound ${fmt(wilsonLower)} against a floor of ${fmt(floor)} on ${x}/${n} agreeing claims.`,
    metadata: {
      success: true,
      process_id: processId,
      threshold,
      wilson_lower: wilsonLower,
      floor,
      agreements: x,
      claims: n,
      coverage,
      cost_per_trusted_usd: costPerTrusted,
    },
  });

  await postMessage(
    room.roomId,
    "proposer",
    `@${risk.name} process ${processId} cleared the floor at threshold ${threshold} — promote to AUTO.\n` +
      `Wilson 95% lower bound ${fmt(wilsonLower)} vs floor ${fmt(floor)} on ${x}/${n} claims` +
      (coverage != null ? `, coverage ${fmt(coverage)}` : "") +
      (costPerTrusted != null ? `, $${Number(costPerTrusted).toFixed(4)} per trusted claim` : "") +
      `. Check the bound before this goes to the approver.`,
    { mentions: [{ id: risk.agentId, name: risk.name }] },
  );

  return { ...room, risk, human, processId, threshold, wilsonLower, floor, x, n };
}

/**
 * The risk agent recomputes the bound itself and posts a verdict. A BLOCK here is the veto
 * that readDecision treats as terminal, so this is what stops a bad promotion.
 */
export async function riskReview(roomId, { processId, wilsonLower, floor, x, n, coverage, coverageFloor }) {
  const proposer = await agentCredentials("proposer");
  const person = await approver();
  const boundShort = Number(wilsonLower) < Number(floor);
  const coverageShort = coverage != null && coverageFloor != null && Number(coverage) < Number(coverageFloor);
  const mentions = [
    { id: proposer.id, name: proposer.name },
    { id: person.id, name: person.name },
  ];

  if (boundShort || coverageShort) {
    const why = boundShort
      ? `Wilson 95% lower bound is ${fmt(wilsonLower)} on ${x}/${n} claims, under the ${fmt(floor)} floor`
      : `coverage is ${fmt(coverage)}, under the ${fmt(coverageFloor)} floor`;
    const text =
      `@${proposer.name} @${person.name} BLOCKED — ${processId} does not clear. ${why}. ` +
      `The observed rate is not the licensed rate; more attestations, not a lower floor.`;
    const { messageId } = await postMessage(roomId, "risk", text, { mentions });
    return { verdict: "blocked", reason: why, messageId };
  }

  const text =
    `@${proposer.name} @${person.name} CLEARED — ${processId} holds at ${fmt(wilsonLower)} against the ${fmt(floor)} floor on ${x}/${n} claims. ` +
    `No risk objection. The promotion still needs ${person.name} to approve it here.`;
  const { messageId } = await postMessage(roomId, "risk", text, { mentions });
  return { verdict: "cleared", messageId };
}

/**
 * The gate. Returns the approval receipt, or throws. There is no second path to a receipt:
 * the room is where a promotion becomes legal.
 */
export async function assertPromotionApproved(roomId) {
  const d = await readDecision(roomId);
  if (d.status !== "approved") {
    throw new BandError(
      `Promotion refused: Band room ${roomId} is "${d.status}"` +
        (d.by ? ` (${d.by}: ${String(d.reason).slice(0, 160)})` : "") +
        `. A named human has to APPROVE in ${d.url} before this policy can ship.`,
      { code: `decision_${d.status}` },
    );
  }
  return { roomId, url: d.url, approvedBy: d.by, approvedAt: d.at, messageId: d.messageId, quote: d.reason };
}

const fmt = (v) => (v == null ? "n/a" : Number(v).toFixed(4));
