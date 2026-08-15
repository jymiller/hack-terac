# Calibration workflow (Render Workflows)

A **separate Render service** from the web app. It holds no database credentials and
imports no app code — every task reaches the coverage engine over HTTP at `APP_URL`.

## Why plain `.mjs` and not TypeScript

The Workflows docs are TypeScript-first and the templates run `tsx src/main.ts`, but
`@renderinc/sdk@0.6.0` ships **compiled CommonJS** with an `exports` map for the
`./workflows` subpath (`dist/workflows/index.js`). Node's CJS↔ESM interop resolves
`import { task } from '@renderinc/sdk/workflows'` from a `.mjs` file, verified locally on
Node 26. So this service is plain ESM JavaScript with **no build step and no `tsx`**,
matching the rest of the repo. Build is `npm install`; start is `node src/main.mjs`.

## Tasks

| Task | Instance | What it does |
| --- | --- | --- |
| `runCalibrationCycle` | `standard` | Root. Discovers processes from `GET /api/coverage`, fans out per process, returns the promotion packet. |
| `proposeOverCorpus` | `starter` | One process's machine pass over the claim corpus. |
| `scoreReadiness` | `starter` | Reads that process's Wilson lower bound and label back from `/api/coverage`. |

The root task's return value is the owner's decision packet:

```json
{
  "candidate_policy": { "arm": "economy-v1", "tier": "economy" },
  "floor": 0.9,
  "promote": [{ "process_id": "...", "lower": 0.93 }],
  "hold":    [{ "process_id": "...", "label": "NOT YET DISTINGUISHED" }],
  "decision": "PROMOTE_PENDING_APPROVAL",
  "requires_named_approval": true
}
```

It never promotes anything itself. Promoting a cheaper policy is the named human's call.

## Local development (no Render account needed)

```bash
cd workflows && npm install
APP_URL=http://localhost:3000 render workflows dev -- node src/main.mjs
```

Then, from the repo root, drive it through the same REST client the app uses:

```bash
RENDER_TASKS_URL=http://localhost:8120 RENDER_API_KEY=rnd_localdev \
RENDER_WORKFLOW_TASK=runCalibrationCycle \
node scripts/smoke-render-workflows.mjs
```

## Deploying (owner steps)

1. **Push this repo to GitHub** and either make it public or connect the Render GitHub app
   to the private repo. Render pulls workflow task definitions from a linked repo — it
   cannot see a local-only repo.
2. **Create a Render API key**: Account Settings → API Keys
   (<https://dashboard.render.com/settings#api-keys>). Put it in `.env` as
   `RENDER_API_KEY=rnd_...`.
3. **Create the workflow service** (CLI is already authenticated on this machine):

   ```bash
   render workflows create \
     --name hack-terac-calibration \
     --repo <github-url> \
     --root-directory workflows \
     --runtime node \
     --build-command "npm install" \
     --run-command "node src/main.mjs" \
     --region oregon \
     --env-var APP_URL=https://kathy-was-blvd-rfc.trycloudflare.com \
     --confirm -o json
   ```

   Or Dashboard → **New → Workflow** (Language: Node), same four fields.
4. Confirm the task slug on the workflow's Tasks page. If the workflow slug is not
   `hack-terac-calibration`, set `RENDER_WORKFLOW_TASK=<slug>/runCalibrationCycle` in
   `.env`.
5. `node --env-file=.env scripts/smoke-render-workflows.mjs`

Blueprints do not yet support workflows, so this service is **not** in `render.yaml` by
design — that is a documented beta limitation, not an omission.
