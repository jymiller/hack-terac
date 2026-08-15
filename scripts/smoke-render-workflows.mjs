/**
 * node --env-file=.env scripts/smoke-render-workflows.mjs
 *
 * Triggers a real run of the calibration workflow via the Render REST API and polls it
 * to completion. Prints SKIPPED and exits 0 when RENDER_API_KEY is absent.
 */
import { calibrationTask, startTaskRun, waitForTaskRun } from "../app/render-workflows.mjs";

const key = (process.env.RENDER_API_KEY ?? "").trim();
if (!key) {
  console.log("SKIPPED: RENDER_API_KEY is not set.");
  console.log("  Create one at https://dashboard.render.com/settings#api-keys, then add");
  console.log("  RENDER_API_KEY=rnd_... to .env and re-run.");
  process.exit(0);
}

const task = calibrationTask();
const input = { arm: "economy-v1", tier: "economy" };
console.log(`triggering ${task} with input [${JSON.stringify(input)}]`);

try {
  const started = await startTaskRun(task, [input]);
  console.log(`started ${started.id} (status ${started.status})`);

  const run = await waitForTaskRun(started.id, { timeoutMs: 300_000, intervalMs: 3000 });
  const packet = run.results?.[0] ?? null;

  if (run.status === "failed" || run.status === "canceled") {
    console.error(`FAIL: run ${run.id} ${run.status}: ${run.error ?? "no error detail"}`);
    process.exit(1);
  }
  if (!packet) {
    console.error(`FAIL: run ${run.id} is ${run.status} but returned no result payload`);
    process.exit(1);
  }

  console.log(`PASS: run ${run.id} ${run.status}`);
  console.log(
    `  ${packet.processes_calibrated} processes calibrated at floor ${packet.floor}, ` +
      `decision ${packet.decision}`,
  );
  console.log(`  promote: ${packet.promote?.map((p) => p.process_id).join(", ") || "(none)"}`);
  console.log(`  hold:    ${packet.hold?.map((p) => p.process_id).join(", ") || "(none)"}`);
  const skipped = (packet.proposals ?? []).filter((p) => p.skipped);
  if (skipped.length) console.log(`  note: ${skipped.length} propose calls skipped — ${skipped[0].reason}`);
} catch (err) {
  console.error(`FAIL: ${err.message}`);
  process.exit(1);
}
