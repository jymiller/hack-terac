/**
 * Trigger and poll Render Workflows task runs over the REST API.
 *
 * Zero dependencies: global fetch against https://api.render.com/v1. The Render SDK is
 * only needed to *define* tasks (workflows/src/main.mjs); triggering them is two plain
 * HTTP calls, so the app keeps its dependency list unchanged.
 *
 * Import-safe with no key: nothing here reads env at module scope.
 */

const TERMINAL = new Set(["completed", "succeeded", "failed", "canceled"]);

/** Set RENDER_TASKS_URL to http://localhost:8120 to hit `render workflows dev` instead. */
const apiBase = () =>
  (process.env.RENDER_TASKS_URL ?? "https://api.render.com").replace(/\/+$/, "");

/** Slug format is {workflow-slug}/{task-name}; the workflow slug is set at creation. */
export const calibrationTask = () =>
  process.env.RENDER_WORKFLOW_TASK ?? "hack-terac-calibration/runCalibrationCycle";

function apiKey() {
  const key = (process.env.RENDER_API_KEY ?? "").trim();
  if (!key) {
    throw new Error(
      "RENDER_API_KEY is not set. Create one at https://dashboard.render.com/settings#api-keys " +
        "(Account Settings > API Keys) and add RENDER_API_KEY=rnd_... to .env.",
    );
  }
  return key;
}

async function renderApi(path, { method = "GET", body, signal } = {}) {
  const res = await fetch(`${apiBase()}/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${apiKey()}`,
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // Non-JSON error page; `text` carries the detail into the thrown message.
  }
  if (!res.ok) {
    throw new Error(`Render API ${method} ${path} failed: HTTP ${res.status} ${text.slice(0, 300)}`);
  }
  return json;
}

/**
 * POST /v1/task-runs. `input` is positional (an array) or named (an object); both are
 * accepted by the API. Returns as soon as the run is created, with its id.
 */
export function startTaskRun(task, input = [], { signal } = {}) {
  return renderApi("/task-runs", { method: "POST", body: { task, input }, signal });
}

export function getTaskRun(taskRunId, { signal } = {}) {
  return renderApi(`/task-runs/${encodeURIComponent(taskRunId)}`, { signal });
}

/** Polls until the run reaches a terminal status. `paused` is not terminal. */
export async function waitForTaskRun(taskRunId, { timeoutMs = 600_000, intervalMs = 3000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const run = await getTaskRun(taskRunId);
    if (TERMINAL.has(run.status)) return run;
    if (Date.now() >= deadline) {
      throw new Error(
        `task run ${taskRunId} still ${run.status} after ${Math.round(timeoutMs / 1000)}s`,
      );
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/**
 * Start a calibration cycle and wait for the promotion packet. The resolved value is the
 * root task's return value — the list of processes a cheaper policy may run AUTO on,
 * pending a named human's approval.
 */
export async function runCalibrationCycle(input = {}, { timeoutMs, intervalMs } = {}) {
  const started = await startTaskRun(calibrationTask(), [input]);
  const run = await waitForTaskRun(started.id, { timeoutMs, intervalMs });
  if (run.status === "failed" || run.status === "canceled") {
    throw new Error(`calibration cycle ${run.id} ${run.status}: ${run.error ?? "no error detail"}`);
  }
  return { taskRunId: run.id, status: run.status, packet: run.results?.[0] ?? null };
}
