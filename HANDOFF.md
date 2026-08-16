# Handoff — build session → next session

`main` is at `cecdc4c`, pushed, tree clean, 15/15 tests passing.
**Live and independent of this machine:** https://hack-terac.onrender.com

## Standing owner instructions — read these first

1. **DO NOT START ANY TASK IN TERAC WITHOUT JOHN'S APPROVAL.** No launch, no resume, no
   draft, no feasibility request. He said this after I launched a wave while he was telling
   me he wanted to press the button himself. Reads are fine. **He presses launch, not you.**
2. ~~**Use the PDFs as-is.**~~ **Superseded 16 August 2026.** John instructed directly that
   all three certificates be rebuilt around fictitious companies and every trace removed
   throughout the application. The documents are now generated from
   `fixtures/certificates.json` by `scripts/build-certificates.mjs` and name nothing real.
3. He commits/pushes/merges when he asks. The design session has explicit authorisation to
   merge "with coordination with the full-stack-developer" — that coordination is you.

## Live surfaces

| Path | What |
|---|---|
| `/` | coverage board — per-field readiness, Wilson lower bound vs a 0.90 floor |
| `/results` | human vs model leaderboard + field heatmap |
| `/funnel` | recruitment → delivery; purple = all Terac can see, blue = only we can |
| `/design` | experiment designer (owned by the design session) |
| `/ops` | operator — plan, price, draft, launch |
| `/log` | experiment log — prompt version, render hash, commit per run |
| `/support` | worker support over iMessage + QR |
| `/expert` | **the open URL to hand an expert** — mints its own id, no Terac needed |
| `/x/:wave` | the Terac-recruited task page (owned by the design session) |

## State of the evidence

- **1 paid human reading** via Terac, 8/8. That is the only paid panel evidence that exists.
- **15 model runs**, 5 open-weight vision models × 3 certificates, on the corrected setup:
  llama-4-scout, qwen3-vl-235b, llama-4-maverick, qwen3-vl-30b all 24/24; gemma-3-27b 21/24
  (5/8 on the certificate whose numerator is four cash-flow lines summed rather than printed).
  These runs predate the 16 August certificate rebuild and refer to the superseded documents.
- **Walk-up readings** are `source='walkup'` — real human work, never counted as paid Terac
  evidence, no arrival receipt, no Terac callback.

## Vendors

Working: Neon · Stripe · Terac (MCP + REST) · Linq (send + tapback approval) · Band
(agents coordinating, real block, escalation) · Novita (5 vision models) · Render.
**Not working: Pioneer** — key valid, inference 403, plan never redeemed.

## Known-wrong / unfinished

1. `app/explog.mjs` logs `app_commit = null`. Worktree-aware lookup was added but still
   misses; cosmetic, everything else in the row is correct.
2. `/results` cost figures use the settled CPI (169) — correct — but **a draft price is not
   evidence**: the first wave drafted at 1350/participant and settled at 169. Only trust
   post-launch numbers.
3. The retired `/t/:wave` route still exists in `server.mjs`. Unreachable (nothing builds
   that URL) but dead. Coordinate with the design session before editing `server.mjs`.
4. `app/experiment.mjs`, `db/schema-experiments.sql`, `claims`/`processes` tables are the
   retired claims experiment. Dead weight, not referenced by any live surface.
5. Render is on the **free** plan — sleeps after 15 min, ~1 min cold wake. Hit `/healthz`
   before a demo, or upgrade.
6. Three junk arrival receipts in `terac_responses` from the design session's smoke tests:
   `preview-walkthrough`, `viewer-check` (wave `preview`) and `smoke` (wave `w`) — so a
   `wave <> 'preview'` filter misses the third. **Deleting needs John.** Neither session
   should do it for the other.

## Terac

One **stopped** wave `ylz2cq7dcj710a83uo6oxkl7`. Balance **$111.50**. Nothing recruiting.
`stop` returns a 500 from Terac's API (their bug); the wave is `paused`→`stopped` in effect.
All 18 stale drafts were deleted at John's instruction — `terac_opportunities` in Neon still
lists them and will not find them on Terac.

## The other session

`code-planning-design-4c937f`, branch `milbird/code-planning-design-4c937f`. It owns the
expert-facing surface (`/x/:wave`, `/design`) and has been the better reviewer all day — it
caught the CPI error, the 110-vs-200 DPI asymmetry that invalidated the first comparison, the
listing copy that recruited people for the wrong job, and a scorer that marked "Senior ICR"
wrong. **Take its files rather than rewriting them.** Reach it with `SendMessage`, or via Jam.

## Jam

Installed and healthy: single `jamd` from `/Applications`, DMG ejected, `band-peer` plugin
loaded. This session was online as **`john/full-stack-developer-qut`** (role
`full-stack-developer`, receiver active via a persistent Monitor). That lease dies with this
session — the new session should run `/jam as full-stack-developer` and get its own handle.

## What I'd do next

1. Get a second human reading. One is not evidence; 35 clean readings license a field at the
   0.90 floor, and at $1.69 that is about $59. **John launches, not you.**
2. Separate the two variables if anyone asks why the models improved — the re-run changed
   resolution *and* instruction at once, so "the models improved" is honest but "we can say
   why" is not.
