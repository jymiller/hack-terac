/**
 * Superserve control/data plane client — raw fetch, no SDK.
 *
 * Control plane: https://api.superserve.ai            auth header X-API-Key
 * Data plane:    https://sandbox.superserve.ai        auth header X-Access-Token
 *                                                     + X-Superserve-Sandbox-Id
 *
 * Region is derived from the key (ss_live_<region>_<32>), matching the SDK:
 *   use -> api.superserve.ai      / sandbox.superserve.ai
 *   usw -> api-usw.superserve.ai  / usw-sandbox.superserve.ai
 * Unknown/absent region falls back to the `use` pair. SUPERSERVE_BASE_URL overrides.
 *
 * Nothing here touches process.env at import time, so importing is always safe.
 */

const REGIONS = new Map([
  ["use", { baseUrl: "https://api.superserve.ai", sandboxHost: "sandbox.superserve.ai" }],
  ["usw", { baseUrl: "https://api-usw.superserve.ai", sandboxHost: "usw-sandbox.superserve.ai" }],
]);
const DEFAULT = REGIONS.get("use");
const REGION_KEY_RE = /^ss_live_([a-z0-9]{1,17})_[A-Za-z0-9_-]{32}$/;

const tokens = new Map();

export function config() {
  const apiKey = process.env.SUPERSERVE_API_KEY;
  if (!apiKey) {
    throw new Error(
      "SUPERSERVE_API_KEY is not set. Add it to .env (key looks like ss_live_use_<32 chars>) — get one at https://console.superserve.ai",
    );
  }
  const override = process.env.SUPERSERVE_BASE_URL?.trim();
  if (override) {
    let sandboxHost = DEFAULT.sandboxHost;
    for (const cell of REGIONS.values()) {
      if (new URL(cell.baseUrl).hostname === new URL(override).hostname) sandboxHost = cell.sandboxHost;
    }
    return { apiKey, baseUrl: override, sandboxHost, region: null };
  }
  const region = REGION_KEY_RE.exec(apiKey)?.[1];
  const cell = (region && REGIONS.get(region)) || DEFAULT;
  return { apiKey, baseUrl: cell.baseUrl, sandboxHost: cell.sandboxHost, region: region ?? null };
}

async function unwrap(res) {
  if (res.status === 204) return null;
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  if (!res.ok) {
    const err = new Error(
      `Superserve ${res.status}: ${json?.error?.message ?? text.slice(0, 300) ?? res.statusText}`,
    );
    err.status = res.status;
    err.code = json?.error?.code ?? null;
    throw err;
  }
  return json;
}

async function control(path, { method = "GET", body, timeoutMs = 60000 } = {}) {
  const { apiKey, baseUrl } = config();
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "X-API-Key": apiKey,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return unwrap(res);
}

async function data(path, { sandboxId, token, body, timeoutMs = 120000 }) {
  const { sandboxHost } = config();
  const res = await fetch(`https://${sandboxHost}${path}`, {
    method: "POST",
    headers: {
      "X-Access-Token": token,
      "X-Superserve-Sandbox-Id": sandboxId,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return unwrap(res);
}

/** Idempotent: returns a fresh access token, resuming the sandbox first if it is paused. */
export async function activate(id) {
  const sandbox = await control(`/sandboxes/${id}/activate`, { method: "POST" });
  if (sandbox?.access_token) tokens.set(id, sandbox.access_token);
  return sandbox;
}

export async function createSandbox({
  name = `hack-terac-${Date.now()}`,
  template,
  metadata,
  envVars,
  timeoutSeconds,
  autoDeleteSeconds,
} = {}) {
  const sandbox = await control("/sandboxes", {
    method: "POST",
    body: {
      name,
      ...(template ? { from_template: template } : {}),
      ...(metadata ? { metadata } : {}),
      ...(envVars ? { env_vars: envVars } : {}),
      ...(timeoutSeconds === undefined ? {} : { timeout_seconds: timeoutSeconds }),
      ...(autoDeleteSeconds === undefined ? {} : { auto_delete_seconds: autoDeleteSeconds }),
    },
  });
  if (sandbox?.access_token) tokens.set(sandbox.id, sandbox.access_token);
  return sandbox;
}

/**
 * Run a command to completion. Returns { stdout, stderr, exit_code } — a non-zero
 * exit code comes back in the body, it does not throw. A paused sandbox is activated
 * (and therefore resumed) automatically, same as the SDK does.
 */
export async function exec(id, command, { args, env, workingDir, timeoutS = 30 } = {}) {
  const body = {
    command,
    ...(args ? { args } : {}),
    ...(env ? { env } : {}),
    ...(workingDir ? { working_dir: workingDir } : {}),
    timeout_s: timeoutS,
  };
  let token = tokens.get(id) ?? (await activate(id)).access_token;
  try {
    return await data("/exec", { sandboxId: id, token, body, timeoutMs: (timeoutS + 30) * 1000 });
  } catch (err) {
    // 401 = stale token, 503 = sandbox not running. Both are fixed by activate().
    if (err.status !== 401 && err.status !== 503) throw err;
    token = (await activate(id)).access_token;
    return data("/exec", { sandboxId: id, token, body, timeoutMs: (timeoutS + 30) * 1000 });
  }
}

/** Snapshots memory + disk and suspends the VM. Resolves true on 204. */
export async function pause(id) {
  await control(`/sandboxes/${id}/pause`, { method: "POST" });
  tokens.delete(id);
  return true;
}

/** Restores the snapshot. Returns { id, status, access_token }. */
export async function resume(id) {
  const out = await control(`/sandboxes/${id}/resume`, { method: "POST" });
  if (out?.access_token) tokens.set(id, out.access_token);
  return out;
}

export async function destroy(id) {
  await control(`/sandboxes/${id}`, { method: "DELETE" });
  tokens.delete(id);
  return true;
}

export const getSandbox = (id) => control(`/sandboxes/${id}`);

export function listSandboxes({ status, metadata } = {}) {
  const params = new URLSearchParams();
  if (status) params.set("status", status);
  for (const [k, v] of Object.entries(metadata ?? {})) params.set(`metadata.${k}`, v);
  const qs = params.toString();
  return control(`/sandboxes${qs ? `?${qs}` : ""}`);
}
