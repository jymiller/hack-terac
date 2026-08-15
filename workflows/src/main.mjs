/**
 * Render Workflows entry point for the coverage engine's calibration cycle.
 *
 * Plain ESM JavaScript, no TypeScript and no build step: `@renderinc/sdk` publishes
 * compiled CommonJS with an `exports` map for the `./workflows` subpath, so `import
 * { task } from '@renderinc/sdk/workflows'` resolves from a .mjs file under Node.
 * Build command is `npm install`, start command is `node src/main.mjs` — nothing to
 * transpile, which matches the rest of this repo.
 *
 * Registration happens as a side effect of importing this file. The SDK starts its task
 * server automatically when RENDER_SDK_SOCKET_PATH is present (set by Render and by
 * `render workflows dev`), so there is no explicit start call.
 */
import { task } from "@renderinc/sdk/workflows";
import { appFetch } from "./app-api.mjs";

const FLOOR_DEFAULT = 0.9;

// TODO(unverified): this endpoint is NOT yet mounted in app/server.mjs. It is the
// contract this task expects: POST { processId, arm, tier } -> { proposed: <int> }.
// Until it exists, proposeOverCorpus reports skipped instead of failing the cycle.
const PROPOSE_PATH = "/api/experiment/propose";

/**
 * One process's machine pass over the claim corpus. Its own instance, so a slow or
 * flaky process cannot stall the others.
 */
export const proposeOverCorpus = task(
  {
    name: "proposeOverCorpus",
    plan: "starter",
    timeoutSeconds: 900,
    retry: { maxRetries: 2, waitDurationMs: 2000, backoffScaling: 2 },
  },
  async function proposeOverCorpus(processId, arm, tier) {
    const res = await appFetch(PROPOSE_PATH, { method: "POST", body: { processId, arm, tier } });

    // A missing route is a deployment fact, not a transient fault — retrying it would
    // burn three more instances to learn the same thing.
    if (res.status === 404 || res.status === 405) {
      return {
        process_id: processId,
        arm,
        tier,
        proposed: 0,
        skipped: true,
        reason: `${PROPOSE_PATH} is not mounted on the app yet`,
      };
    }
    if (!res.ok) {
      throw new Error(
        `propose for ${processId} failed: HTTP ${res.status} ${res.text.slice(0, 200)}`,
      );
    }
    return {
      process_id: processId,
      arm,
      tier,
      proposed: res.json?.proposed ?? res.json?.count ?? 0,
      skipped: false,
    };
  },
);

/**
 * Readiness for one process, read back from the app's own coverage computation rather
 * than recomputed here. The Wilson lower bound and the LICENSED/RULED OUT label have
 * exactly one implementation, in app/readiness.mjs.
 */
export const scoreReadiness = task(
  { name: "scoreReadiness", plan: "starter", timeoutSeconds: 300 },
  async function scoreReadiness(processId, floor) {
    const res = await appFetch("/api/coverage");
    if (!res.ok) {
      throw new Error(`GET /api/coverage failed: HTTP ${res.status} ${res.text.slice(0, 200)}`);
    }
    const row = (res.json?.rows ?? []).find((r) => r.process_id === processId);
    if (!row) throw new Error(`process ${processId} is not present in /api/coverage`);

    const f = floor ?? res.json?.floor ?? FLOOR_DEFAULT;
    return {
      process_id: row.process_id,
      name: row.name,
      claims: row.claims,
      judgments: row.judgments,
      agreement: row.agreement,
      lower: row.lower,
      label: row.label,
      evidence_mode: row.evidence_mode,
      cost_usd: row.cost,
      floor: f,
      clears_floor: row.label === "LICENSED",
    };
  },
);

/**
 * The root task. Fans out per process — propose over the corpus, then score readiness —
 * and returns the promotion packet: which processes the cheaper policy may run AUTO on,
 * and which must stay held. It never promotes anything itself; `requires_named_approval`
 * is the whole point, because promoting a cheaper policy is the owner's decision.
 */
export const runCalibrationCycle = task(
  { name: "runCalibrationCycle", plan: "standard", timeoutSeconds: 3600 },
  async function runCalibrationCycle(input = {}) {
    const { processIds, arm = "economy-v1", tier = "economy", floor } = input ?? {};

    const cov = await appFetch("/api/coverage");
    if (!cov.ok) {
      throw new Error(`GET /api/coverage failed: HTTP ${cov.status} ${cov.text.slice(0, 200)}`);
    }
    const ids =
      processIds?.length > 0 ? processIds : (cov.json?.rows ?? []).map((r) => r.process_id);
    if (ids.length === 0) {
      throw new Error("no processes to calibrate: /api/coverage returned zero rows");
    }
    const f = floor ?? cov.json?.floor ?? FLOOR_DEFAULT;

    // Promise.all is required for parallelism — awaiting the calls one at a time would
    // run the fan-out serially, one instance after another.
    const proposals = await Promise.all(ids.map((id) => proposeOverCorpus(id, arm, tier)));
    const readiness = await Promise.all(ids.map((id) => scoreReadiness(id, f)));

    const promote = readiness.filter((r) => r.clears_floor);
    const hold = readiness.filter((r) => !r.clears_floor);

    return {
      cycle_id: `cyc_${Date.now().toString(36)}`,
      generated_at: new Date().toISOString(),
      candidate_policy: { arm, tier },
      floor: f,
      processes_calibrated: ids.length,
      proposals,
      readiness,
      promote: promote.map((r) => ({ process_id: r.process_id, name: r.name, lower: r.lower })),
      hold: hold.map((r) => ({ process_id: r.process_id, name: r.name, label: r.label })),
      decision: promote.length > 0 ? "PROMOTE_PENDING_APPROVAL" : "HOLD",
      requires_named_approval: promote.length > 0,
    };
  },
);
