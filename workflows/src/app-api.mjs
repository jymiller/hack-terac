/**
 * The workflow service is deliberately independent of the app: it holds no database
 * credentials and imports no app code. It reaches the coverage engine over HTTP only,
 * so a task run can never diverge from what the app itself reports.
 */

/** Resolved lazily, never at import time, so task registration succeeds without any env. */
export function appBase() {
  const base = (process.env.APP_URL ?? "").trim().replace(/\/+$/, "");
  if (!base) {
    throw new Error(
      "APP_URL is not set for this workflow service. Set it to the coverage engine's public " +
        "base URL (e.g. https://kathy-was-blvd-rfc.trycloudflare.com) via the Render Dashboard " +
        "(workflow > Environment) or `render workflows create --env-var APP_URL=...`.",
    );
  }
  return base;
}

export async function appFetch(path, { method = "GET", body, timeoutMs = 60_000 } = {}) {
  const res = await fetch(`${appBase()}${path}`, {
    method,
    headers: {
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // Non-JSON body (an HTML error page); `text` is kept for the error message.
  }
  return { ok: res.ok, status: res.status, json, text };
}
