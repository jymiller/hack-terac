#!/usr/bin/env node
/**
 * node --env-file=.env scripts/smoke-superserve.mjs
 *
 * Proves the differentiator end to end:
 *   create -> exec (write) -> pause -> wait -> resume -> exec (read back) -> destroy
 *
 * The read-back after resume is the whole point: the file (and the VM state around it)
 * survived the snapshot, which is how an experiment arm stays open for hours while
 * human attestations come back from Terac.
 *
 * SKIPPED (exit 0) when SUPERSERVE_API_KEY is absent.
 */

import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { config, createSandbox, exec, pause, resume, destroy, getSandbox } from "../app/superserve.mjs";

const step = (n, msg) => console.log(`[${n}] ${msg}`);

if (!process.env.SUPERSERVE_API_KEY) {
  console.log("SKIPPED: SUPERSERVE_API_KEY is not set (run with: node --env-file=.env scripts/smoke-superserve.mjs)");
  process.exit(0);
}

const cfg = config();
console.log(`control plane: ${cfg.baseUrl}  data plane: https://${cfg.sandboxHost}  region: ${cfg.region ?? "(not in key, defaulted)"}`);

const nonce = randomUUID();
const STATE = "/home/user/arm-state.txt";
let id = null;
let failure = null;

try {
  step(1, "create sandbox (superserve/base)...");
  const sandbox = await createSandbox({
    name: `smoke-${Date.now()}`,
    metadata: { app: "coverage-engine", purpose: "smoke" },
    autoDeleteSeconds: 3600,
  });
  id = sandbox.id;
  step(1, `created ${id} status=${sandbox.status}`);

  step(2, `exec write: ${STATE} <- ${nonce}`);
  const wrote = await exec(id, `printf '%s' '${nonce}' > ${STATE} && echo ok`);
  if (wrote.exit_code !== 0) throw new Error(`write exited ${wrote.exit_code}: ${wrote.stderr}`);
  step(2, `wrote (stdout=${wrote.stdout.trim()})`);

  step(3, "pause (snapshot memory + disk)...");
  await pause(id);
  const paused = await getSandbox(id);
  step(3, `paused status=${paused.status} snapshot_id=${paused.snapshot_id ?? "(none reported)"}`);
  if (paused.status !== "paused") throw new Error(`expected status=paused, got ${paused.status}`);

  step(4, "wait 5s (stands in for the hours-long wait on Terac attestations)...");
  await sleep(5000);

  step(5, "resume...");
  const resumed = await resume(id);
  step(5, `resumed status=${resumed.status} fresh access_token=${resumed.access_token ? "yes" : "no"}`);

  step(6, `exec read back: cat ${STATE}`);
  const read = await exec(id, `cat ${STATE}`);
  if (read.exit_code !== 0) throw new Error(`read exited ${read.exit_code}: ${read.stderr}`);
  const got = read.stdout.trim();
  step(6, `read "${got}"`);
  if (got !== nonce) throw new Error(`VM state did NOT survive: expected ${nonce}, got ${got}`);
  step(6, "VM state survived pause/resume");
} catch (err) {
  failure = err;
} finally {
  if (id) {
    try {
      step(7, `destroy ${id}...`);
      await destroy(id);
      step(7, "destroyed");
    } catch (err) {
      console.error(`cleanup failed for ${id}: ${err.message}`);
    }
  }
}

if (failure) {
  console.error(`FAIL: ${failure.message}`);
  process.exit(1);
}
console.log("PASS: create -> exec -> pause -> resume -> exec (state intact) -> destroy");
