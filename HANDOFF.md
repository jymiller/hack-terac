# Handoff — build session, before Jam restart

Working tree is clean. `main` and this branch are both at `cfe7fc3`, pushed.
**Render is live and independent of this machine:** https://hack-terac.onrender.com

## Live surfaces

| Path | What it is |
|---|---|
| `/` | coverage board — per-field readiness, Wilson lower bound vs a 0.90 floor |
| `/ops` | operator — plan a wave, request Terac pricing, build a draft, launch |
| `/design` | experiment designer — **stale here; the design session has a finished rewrite** |
| `/funnel` | recruitment → delivery funnel, Terac stages vs ours |
| `/results` | human vs model leaderboard + per-field heatmap |
| `/support` | worker support over iMessage, QR, auto-answer + escalation |
| `/x/:wave` | the paid worker task page |

## Vendors proven end to end

Neon · Stripe (checkout, signed webhook, idempotent replay) · Terac (MCP + REST) ·
Linq (iMessage send **and** tapback approval) · Band (two agents, real block, escalation) ·
Novita (5 open-weight vision models) · Render.

Not working: **Pioneer** — key valid, inference 403, plan never redeemed.

## Results so far

1 paid human, 8/8 in 411s. Five models on the same documents: llama-4-scout 24/24,
qwen3-vl-235b 23/24, llama-4-maverick 23/24, qwen3-vl-30b 23/24, gemma-3-27b 22/24,
each in 2–6s.

## Blockers and known-wrong things — read before launching anything

1. **CPI is $1.69, not $13.50.** Terac's record: `cost_per_participant_cents 169`,
   `total_cost_cents 1352` for 8. I misread the wave total as the per-person price all day.
   `HUMAN_CPI_CENTS = 1350` at `app/results.mjs:6` is 8x too high and should derive from
   `terac_opportunities` rather than be hardcoded. $111.50 buys ~65 participants.
2. **The certificates say ENID on them.** Every PDF's first line is
   "SYNTHETIC DEMONSTRATION DOCUMENT — CREATED FOR ENID PLATFORM INGESTION TESTING".
   Now clearly legible at 200 DPI. Collides with the no-Enid boundary in `AGENTS.md`.
   Needs the PDFs regenerating with neutral wording. **Owner decision, launch blocker.**
3. **`app/terac.mjs opportunityBody()` still advertises the retired claims task** while
   `task_url` sends people to certificate extraction. Experts were recruited for one job
   and shown another — the likely cause of 10 screened in, 2 arrived. Rewrite before launch.
4. **`APP_URL` must be `https://hack-terac.onrender.com`.** The stopped wave pointed at a
   cloudflared tunnel that died mid-run.
5. **`render.yaml` is `plan: free`** — sleeps after 15 min, ~1 min cold wake.
6. `doc_comfort` screener rejected 0 of 14. It screens nobody out and spends panel time.
7. Model runs were scored against 110 DPI images the design session has since replaced at
   200 DPI. `/results` is not like-for-like until they are re-run — but don't spend that
   until the ENID wording is settled.

## Terac state

Wave `ylz2cq7dcj710a83uo6oxkl7` **stopped**. Balance **$111.50**. All 18 stuck drafts were
deleted at John's instruction; `terac_opportunities` in Neon still lists them and will not
find them on Terac. Nothing is launched. Nothing launches without John pressing the button.

## Data hygiene

`terac_responses` holds two junk arrival receipts from the design session's local rendering —
`preview-walkthrough` and `viewer-check`, wave `preview`. They inflate `/funnel`'s arrival
count. Deleting needs John's authorization; filtering `wave <> 'preview'` in `funnelState`
is the honest workaround.

## The other session

`code-planning-design-4c937f`, branch `milbird/code-planning-design-4c937f` — separate
worktree, nothing committed or pushed. It has a finished `/design` rewrite, a rebuilt
`/x/:wave` document viewer at 200 DPI with zoom, nav CSS fixes for `/ops` `/design`
`/support`, and `docs/run-of-show.md`. **Take its files rather than rewriting them.**

## Lost on restart

The cloudflared tunnel (pid 2480) and a background agent researching Band Jam setup. Neither
matters now — Render is the host, and Jam is already installed.
