import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { query } from "./db.mjs";

/**
 * The experiment log.
 *
 * A score is only evidence if you can say what produced it. Today the instruction text and
 * the certificate renders both changed mid-afternoon, and nothing recorded which run saw
 * which — so every number collected before that point became unattributable rather than
 * merely old.
 *
 * One row per run, written at the moment of the run, holding the exact prompt, the exact
 * images (by content hash, not filename — the filenames did not change when the pixels did),
 * the raw reply, and the score. Append-only: a run is a historical fact and is never updated.
 */

let ready = null;
export function ensureLog() {
  ready ??= query(`
    create table if not exists experiment_runs (
      id               bigserial primary key,
      run_key          text unique,
      source           text not null,
      provider         text,
      model_id         text,
      temperature      double precision,
      cert_id          text not null,
      -- the prompt exactly as sent, plus a hash so runs can be grouped by prompt version
      instruction      text,
      instruction_sha  text,
      schema_hint      text,
      prompt_sha       text,
      -- what the reader actually looked at: content hashes, so a re-render is visible
      images           jsonb,
      images_sha       text,
      raw_response     text,
      answers          jsonb,
      correct          integer,
      total            integer,
      detail           jsonb,
      duration_ms      integer,
      error            text,
      app_commit       text,
      created_at       timestamptz not null default now()
    )`).then(() =>
    query(`
      create index if not exists explog_model_idx on experiment_runs (model_id);
      create index if not exists explog_prompt_idx on experiment_runs (prompt_sha);
      create index if not exists explog_cert_idx on experiment_runs (cert_id);
    `),
  );
  return ready;
}

export const sha = (s) => crypto.createHash("sha256").update(s ?? "").digest("hex").slice(0, 16);

/** Content hashes of the page images, so a silent re-render shows up as a different run. */
export async function imageManifest(cert) {
  const out = [];
  for (let i = 1; i <= cert.pages; i++) {
    const f = path.join("public/docs/png", `${cert.file}-${i}.png`);
    try {
      const buf = await fs.readFile(f);
      out.push({ page: i, file: `${cert.file}-${i}.png`, bytes: buf.length, sha256: sha(buf.toString("base64")) });
    } catch {
      out.push({ page: i, file: `${cert.file}-${i}.png`, missing: true });
    }
  }
  return out;
}

let commitCache;
async function appCommit() {
  if (commitCache !== undefined) return commitCache;
  try {
    // In a worktree, .git is a FILE holding "gitdir: <path>", not a directory — reading
    // .git/HEAD directly silently yields nothing, which is how this logged null commits.
    let gitDir = ".git";
    const dotGit = await fs.readFile(".git", "utf8").catch(() => null);
    if (dotGit?.startsWith("gitdir:")) gitDir = dotGit.replace("gitdir:", "").trim();
    const head = (await fs.readFile(path.join(gitDir, "HEAD"), "utf8")).trim();
    if (head.startsWith("ref:")) {
      const ref = head.replace(/^ref:\s*/, "");
      const direct = await fs.readFile(path.join(gitDir, ref), "utf8").catch(() => null);
      if (direct) commitCache = direct.trim().slice(0, 7);
      else {
        // packed-refs holds it once the ref has been packed
        const packed = await fs.readFile(path.join(gitDir, "..", "..", "packed-refs"), "utf8").catch(() => "");
        const line = packed.split("\n").find((l) => l.endsWith(` ${ref}`));
        commitCache = line ? line.slice(0, 7) : null;
      }
    } else commitCache = head.slice(0, 7);
  } catch {
    commitCache = null;
  }
  return commitCache;
}

export async function logRun({
  source,
  provider = null,
  modelId = null,
  // Distinguishes two readers who saw the identical pixels under the identical instruction.
  // Null for models, where that combination genuinely is one repeated run.
  subjectId = null,
  temperature = null,
  certId,
  instruction,
  schemaHint = null,
  images = null,
  rawResponse = null,
  answers = null,
  scored = null,
  durationMs = null,
  error = null,
}) {
  await ensureLog();
  const instructionSha = sha(instruction);
  const promptSha = sha(`${instruction ?? ""}\n---\n${schemaHint ?? ""}`);
  const imagesSha = images ? sha(images.map((i) => i.sha256 ?? i.file).join("|")) : null;
  // Same model, same prompt, same pixels, same document = the same run. Re-running after a
  // re-render or a prompt edit is a NEW row, which is the point.
  //
  // That identity holds for a model and is false for people: two experts reading the same
  // pixels under the same instruction are two independent readings, and that independence is
  // what the Wilson bound on /board is counting. Without a discriminator a whole wave would
  // collapse to one row per certificate and `do nothing` would drop the rest silently.
  // subjectId is appended and filtered, so model keys stay byte-identical and still dedupe.
  const runKey = [source, modelId ?? "human", certId, promptSha, imagesSha ?? "none", subjectId]
    .filter(Boolean)
    .join(":");
  const { rows } = await query(
    `insert into experiment_runs
       (run_key, source, provider, model_id, temperature, cert_id,
        instruction, instruction_sha, schema_hint, prompt_sha,
        images, images_sha, raw_response, answers, correct, total, detail, duration_ms, error, app_commit)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
     on conflict (run_key) do nothing
     returning id`,
    [
      runKey, source, provider, modelId, temperature, certId,
      instruction ?? null, instructionSha, schemaHint, promptSha,
      images ? JSON.stringify(images) : null, imagesSha,
      rawResponse == null ? null : String(rawResponse).slice(0, 20000),
      answers ? JSON.stringify(answers) : null,
      scored?.correct ?? null, scored?.total ?? null,
      scored?.fields ? JSON.stringify(scored.fields) : null,
      durationMs, error, await appCommit(),
    ],
  );
  return rows[0]?.id ?? null;
}

export async function logState() {
  await ensureLog();
  const [runs, prompts, images] = await Promise.all([
    query(`select source, coalesce(model_id,'human') as who, cert_id, prompt_sha, images_sha,
                  correct, total, duration_ms, app_commit, created_at, error
             from experiment_runs order by created_at desc limit 200`),
    query(`select prompt_sha, instruction_sha, min(created_at) as first_seen,
                  count(*)::int as runs, substring(instruction for 160) as instruction
             from experiment_runs group by 1,2,5 order by first_seen`),
    query(`select images_sha, cert_id, count(*)::int as runs, min(created_at) as first_seen
             from experiment_runs where images_sha is not null group by 1,2 order by first_seen`),
  ]);
  return { runs: runs.rows, prompts: prompts.rows, images: images.rows };
}

export function registerLogRoutes(app) {
  app.get("/api/log", async (_req, res) => {
    try {
      res.json(await logState());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/log/run/:id", async (req, res) => {
    try {
      await ensureLog();
      const { rows } = await query(`select * from experiment_runs where id = $1`, [req.params.id]);
      if (!rows.length) return res.status(404).json({ error: "no such run" });
      res.json(rows[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/log", async (_req, res) => {
    try {
      res.type("html").send(logPage(await logState()));
    } catch (err) {
      res.status(500).send(`<pre>${err.message}</pre>`);
    }
  });
}

const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
const short = (w) => String(w ?? "").replace(/^(novita|pioneer)\//, "").replace(/^(meta-llama|qwen|google)\//, "");

function logPage(s) {
  const nav = `<nav><a href="/">Coverage board</a><a href="/ops">Operator</a><a href="/design">Designer</a><a href="/funnel">Funnel</a><a href="/results">Results</a><a href="/log" class="on">Log</a><a href="/support">Support</a></nav>`;

  const runRows = s.runs.length
    ? s.runs
        .map(
          (r) => `<tr>
      <td class="mut">${new Date(r.created_at).toLocaleTimeString()}</td>
      <td><span class="tag ${r.source}">${r.source}</span> ${esc(short(r.who))}</td>
      <td>${esc(r.cert_id)}</td>
      <td class="num">${r.error ? '<span class="bad">error</span>' : `${r.correct}/${r.total}`}</td>
      <td class="num mut">${r.duration_ms ? Math.round(r.duration_ms / 1000) + "s" : "—"}</td>
      <td><code class="mut">${esc(r.prompt_sha)}</code></td>
      <td><code class="mut">${esc(r.images_sha ?? "—")}</code></td>
      <td><code class="mut">${esc(r.app_commit ?? "—")}</code></td>
    </tr>`,
        )
        .join("")
    : `<tr><td colspan="8" class="mut">No runs logged yet.</td></tr>`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Experiment Log</title><style>
:root{color-scheme:light dark;--bg:#0c0c0d;--fg:#f4f4f5;--mut:#a1a1aa;--line:#27272a;--card:#161617;--ok:#4ade80;--bad:#f87171;--acc:#60a5fa;--mod:#c084fc}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
.wrap{max-width:1120px;margin:0 auto;padding:26px 20px 90px}
nav{display:flex;gap:18px;margin:0 0 24px;padding-bottom:12px;border-bottom:1px solid var(--line);font-size:13px}
nav a{color:var(--mut);text-decoration:none}nav a.on{color:var(--fg)}
h1{font-size:22px;margin:0 0 4px}h2{font-size:12px;text-transform:uppercase;letter-spacing:.1em;color:var(--mut);margin:32px 0 10px}
.sub{color:var(--mut);font-size:13.5px;margin:0 0 18px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px}
table{width:100%;border-collapse:collapse;font-size:13.5px}
th{text-align:left;font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--mut);padding:7px 8px;border-bottom:1px solid var(--line);font-weight:500}
td{padding:8px;border-bottom:1px solid var(--line)}tr:last-child td{border-bottom:0}
.num{text-align:right;font-variant-numeric:tabular-nums}
.tag{font-size:9px;letter-spacing:.07em;padding:2px 6px;border-radius:99px;border:1px solid currentColor}
.tag.model{color:var(--mod)}.tag.human{color:var(--acc)}.tag.walkup{color:var(--ok)}
.mut{color:var(--mut)}.bad{color:var(--bad)}code{font-size:11.5px}
pre{background:#0c0c0d;border:1px solid var(--line);border-radius:8px;padding:11px;overflow:auto;font-size:11.5px;white-space:pre-wrap;margin:6px 0 0}
</style></head><body><div class="wrap">${nav}
<h1>Experiment log</h1>
<p class="sub">One row per run, written when the run happened. A score is only evidence if you can say what produced it — so each row carries the exact prompt, the content hash of the exact images the reader saw, and the commit the app was running.</p>

<h2>Prompt versions</h2>
<div class="card">${
    s.prompts.length
      ? s.prompts
          .map(
            (p) => `<div style="margin-bottom:14px">
    <code>${esc(p.prompt_sha)}</code> <span class="mut">· ${p.runs} run${p.runs === 1 ? "" : "s"} · first seen ${new Date(p.first_seen).toLocaleTimeString()}</span>
    <pre>${esc(p.instruction)}…</pre></div>`,
          )
          .join("")
      : `<span class="mut">No prompts logged yet.</span>`
  }
  <p class="sub" style="margin:10px 0 0">Two different hashes here mean two different experiments. Numbers from different prompt versions are not comparable and should not be averaged together.</p>
</div>

<h2>Document renders</h2>
<div class="card"><table>
<tr><th>Images hash</th><th>Certificate</th><th class="num">Runs</th><th>First seen</th></tr>
${
  s.images.length
    ? s.images
        .map(
          (i) =>
            `<tr><td><code>${esc(i.images_sha)}</code></td><td>${esc(i.cert_id)}</td><td class="num">${i.runs}</td><td class="mut">${new Date(i.first_seen).toLocaleTimeString()}</td></tr>`,
        )
        .join("")
    : `<tr><td colspan="4" class="mut">No renders logged yet.</td></tr>`
}
</table>
<p class="sub" style="margin:10px 0 0">Hashed by content, not filename — the certificate filenames did not change when the pixels went from 110 to 200 DPI, so only the hash makes that visible.</p>
</div>

<h2>Runs</h2>
<div class="card"><table>
<tr><th>Time</th><th>Reader</th><th>Cert</th><th class="num">Score</th><th class="num">Took</th><th>Prompt</th><th>Images</th><th>Commit</th></tr>
${runRows}
</table>
<p class="sub" style="margin:10px 0 0">Full detail including the raw reply: <code>/api/log/run/&lt;id&gt;</code></p>
</div>
</div></body></html>`;
}
