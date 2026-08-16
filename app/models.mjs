import fs from "node:fs/promises";
import path from "node:path";
import { CERTS, FIELDS, INSTRUCTION, byId } from "./certs.mjs";
import { recordExtraction } from "./extract.mjs";
import { imageManifest, logRun } from "./explog.mjs";

/**
 * The agent arm.
 *
 * The model gets exactly what the human gets: the same rendered pages and the same
 * instruction, with nothing extracted for it in advance. Sending it clean text would be
 * doing the hard half of the job on its behalf and would make the comparison meaningless.
 *
 * Providers are OpenAI-compatible, so the only thing that changes between them is a base
 * URL and a key.
 */
const PROVIDERS = {
  novita: { base: "https://api.novita.ai/v3/openai", key: () => process.env.NOVITA_API_KEY },
  pioneer: { base: "https://api.pioneer.ai/v1", key: () => process.env.PIONEER_API_KEY },
};

export function providerFor(name) {
  const p = PROVIDERS[name];
  if (!p) throw new Error(`unknown provider "${name}" (have: ${Object.keys(PROVIDERS).join(", ")})`);
  const key = p.key();
  if (!key) throw new Error(`${name.toUpperCase()}_API_KEY is not set`);
  return { ...p, key };
}

export function availableProviders() {
  return Object.entries(PROVIDERS)
    .map(([name, p]) => ({ name, ready: Boolean(p.key()) }))
    .filter((x) => x.ready)
    .map((x) => x.name);
}

async function pageDataUrls(cert) {
  const out = [];
  for (let i = 1; i <= cert.pages; i++) {
    const f = path.join("public/docs/png", `${cert.file}-${i}.png`);
    out.push(`data:image/png;base64,${(await fs.readFile(f)).toString("base64")}`);
  }
  return out;
}

export const SCHEMA_HINT = `Reply with ONLY a JSON object, no prose and no code fence, with exactly these keys:
${FIELDS.map((f) => `  "${f.key}"  // ${f.label} — ${f.hint}`).join("\n")}
Use the string "not stated" for anything the document does not print.`;

/** Tolerant of fenced or chatty replies; returns null rather than throwing on junk. */
export function parseAnswer(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

export async function runModel({ provider = "novita", model, certId, temperature = 0 }) {
  const p = providerFor(provider);
  const cert = byId(certId);
  if (!cert) throw new Error(`unknown certificate "${certId}"`);
  const images = await pageDataUrls(cert);
  const manifest = await imageManifest(cert);
  const promptText = `${INSTRUCTION}\n\n${SCHEMA_HINT}`;

  const body = {
    model,
    temperature,
    max_tokens: 900,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: promptText },
          ...images.map((url) => ({ type: "image_url", image_url: { url } })),
        ],
      },
    ],
  };

  const t0 = Date.now();
  const res = await fetch(`${p.base}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${p.key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const took = Date.now() - t0;
  const text = await res.text();
  if (!res.ok) {
    await logRun({
      source: "model", provider, modelId: `${provider}/${model}`, temperature, certId,
      instruction: INSTRUCTION, schemaHint: SCHEMA_HINT, images: manifest,
      rawResponse: text, durationMs: took, error: `${res.status}: ${text.slice(0, 200)}`,
    }).catch(() => {});
    const err = new Error(`${provider}/${model} -> ${res.status}: ${text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${provider}/${model} returned unparseable envelope`);
  }
  const content = json.choices?.[0]?.message?.content ?? "";
  const answers = parseAnswer(typeof content === "string" ? content : JSON.stringify(content));
  if (!answers) {
    // A model that will not produce the schema is a real result, not an error to swallow:
    // record it as an all-wrong run so it counts against that model rather than vanishing.
    const blank = Object.fromEntries(FIELDS.map((f) => [f.key, ""]));
    const { scored: blankScored } = await recordExtraction({
      submissionId: `model_${model}_${certId}`,
      certId,
      source: "model",
      modelId: `${provider}/${model}`,
      answers: blank,
      durationMs: took,
    });
    await logRun({
      source: "model", provider, modelId: `${provider}/${model}`, temperature, certId,
      instruction: INSTRUCTION, schemaHint: SCHEMA_HINT, images: manifest,
      rawResponse: content, answers: blank, scored: blankScored, durationMs: took,
      error: "unparseable: model did not return the schema",
    }).catch(() => {});
    return { model, certId, parsed: false, correct: 0, total: FIELDS.length, ms: took };
  }

  const { scored } = await recordExtraction({
    submissionId: `model_${model}_${certId}`,
    certId,
    source: "model",
    modelId: `${provider}/${model}`,
    answers,
    durationMs: took,
  });
  await logRun({
    source: "model", provider, modelId: `${provider}/${model}`, temperature, certId,
    instruction: INSTRUCTION, schemaHint: SCHEMA_HINT, images: manifest,
    rawResponse: content, answers, scored, durationMs: took,
  }).catch((e) => console.error("explog write failed:", e.message));
  return { model, certId, parsed: true, correct: scored.correct, total: scored.total, ms: took, answers };
}

/** Every certificate, one model. Sequential so a rate limit degrades instead of exploding. */
export async function runModelAllCerts({ provider, model }) {
  const out = [];
  for (const c of CERTS) {
    try {
      out.push(await runModel({ provider, model, certId: c.id }));
    } catch (err) {
      out.push({ model, certId: c.id, error: err.message });
    }
  }
  return out;
}

export function registerModelRoutes(app, json) {
  app.get("/api/models/providers", (_req, res) =>
    res.json({ ready: availableProviders(), certs: CERTS.map((c) => c.id) }),
  );

  app.post("/api/models/run", json, async (req, res) => {
    const { provider = "novita", model, certId } = req.body ?? {};
    if (!model) return res.status(400).json({ error: "model is required" });
    try {
      const out = certId
        ? [await runModel({ provider, model, certId })]
        : await runModelAllCerts({ provider, model });
      res.json({ runs: out });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });
}
