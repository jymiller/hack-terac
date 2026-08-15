/**
 * Experiment-arm hold, backed by Superserve pause/resume.
 *
 * An experiment arm is opened when we buy human attestations through Terac and cannot
 * be closed until those humans come back — typically hours. Instead of keeping a live
 * process (or re-deriving the arm's state from scratch on every poll), the arm's full
 * working state is parked inside a sandbox, the VM is snapshotted, and the sandbox is
 * resumed exactly where it left off when the attestations land.
 *
 * Every function throws a clear error naming SUPERSERVE_API_KEY when the key is absent.
 */

import { createSandbox, exec, pause, resume, destroy, listSandboxes } from "./superserve.mjs";

const STATE_PATH = "/home/user/arm.json";
const APP_TAG = "coverage-engine";

// superserve/base ships ca-certificates, curl and git only — no python, no node.
// Everything below is POSIX sh.
function writeStateCmd(json) {
  const delim = `SSARM_${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
  return `cat > ${STATE_PATH} <<'${delim}'\n${json}\n${delim}\n`;
}

/**
 * Park an arm and snapshot it. Returns { sandboxId, heldAt }.
 * `state` must be JSON-serializable and is stringified to a single line.
 */
export async function holdArm({ experimentId, arm, processId, state }) {
  const sandbox = await createSandbox({
    name: `arm-${experimentId}-${arm}`.slice(0, 64),
    metadata: {
      app: APP_TAG,
      experiment_id: String(experimentId),
      arm: String(arm),
      ...(processId ? { process_id: String(processId) } : {}),
      held_for: "terac-attestations",
    },
    autoDeleteSeconds: 604800,
  });
  const wrote = await exec(
    sandbox.id,
    writeStateCmd(JSON.stringify({ experiment_id: experimentId, arm, process_id: processId ?? null, held_at: new Date().toISOString(), state })),
  );
  if (wrote.exit_code !== 0) {
    await destroy(sandbox.id);
    throw new Error(`Failed to write arm state into sandbox ${sandbox.id}: ${wrote.stderr}`);
  }
  await pause(sandbox.id);
  return { sandboxId: sandbox.id, heldAt: new Date().toISOString() };
}

/** Resume the snapshot and read the arm back out. Returns the parked object. */
export async function releaseArm(sandboxId) {
  await resume(sandboxId);
  const read = await exec(sandboxId, `cat ${STATE_PATH}`);
  if (read.exit_code !== 0) throw new Error(`Arm state missing in sandbox ${sandboxId}: ${read.stderr}`);
  return JSON.parse(read.stdout);
}

export const listHeldArms = (experimentId) =>
  listSandboxes({
    metadata: { app: APP_TAG, ...(experimentId ? { experiment_id: String(experimentId) } : {}) },
  });

export const discardArm = (sandboxId) => destroy(sandboxId);
