import fs from "node:fs";
import { createOpportunity, opportunityBody, probeBusinessType } from "../app/terac.mjs";

const projectId = process.env.TERAC_PROJECT_ID;
const appUrl = process.env.APP_URL;
const participants = Number(process.argv[2] ?? 1);
const wave = process.argv[3] ?? "a";

if (!projectId) throw new Error("TERAC_PROJECT_ID is not set");
if (!appUrl) throw new Error("APP_URL is not set");

const taskUrl = `${appUrl.replace(/\/$/, "")}/t/${wave}`;

if (process.env.PROBE === "1") {
  const probe = await probeBusinessType(projectId, taskUrl);
  console.log("probe status", probe.status);
  console.log(JSON.stringify(probe.body, null, 2).slice(0, 2000));
  process.exit(0);
}

const res = await createOpportunity(opportunityBody({ projectId, taskUrl, participants }));
console.log("status", res.status);
console.log(JSON.stringify(res.body, null, 2).slice(0, 4000));

if (res.ok) {
  fs.mkdirSync(".hackathon/evidence", { recursive: true });
  const path = `.hackathon/evidence/terac-wave-${wave}-${res.status}.json`;
  fs.writeFileSync(path, JSON.stringify(res.body, null, 2));
  console.log(`saved ${path}`);
  console.log(`task_url ${taskUrl}`);
}
