# Run of show — judging, 19:00

Written 15:2x. Numbers below are live as of writing; re-read section 3 before you present.

## 1 · The one sentence

> We run a compliance-certificate review service. The hard decision the company has to make
> autonomously is which parts of that review it is allowed to do without a human — and we buy
> human judgment through Terac to earn the right to make it.

Say this first, every time. Do not open with a dashboard.

## 2 · The five-minute path

| # | Page | What you say | What you point at |
|---|---|---|---|
| 0 | — | The sentence above. | — |
| 1 | `/design` | "Before spending anything, the company checks the comparison is fair." | The certificate on the left. Both arms get **these pages**, this instruction, these 8 fields. Scroll to the field-by-field table. |
| 2 | `/ops` | "It priced and dispatched the wave itself." | The modeler. The wave that ran cost $1.69 per participant, and CPI is driven by task duration — so the lever is what each participant reads. |
| 3 | `/funnel` | "Terac's dashboard stops at its own boundary. Ours doesn't." | Paid-never-arrived. Spent-on-non-delivery. Arrival receipts are ours; Terac structurally cannot see this stage. |
| 4 | `/results` | "Same documents, same instruction, both readers." | Leaderboard, then the interval column — not the rate column. |
| 5 | `/` | "And here is what the human input bought us." | Per-field licensed floor: 0.000 before the wave, by construction. Where it is now. |
| 6 | `/support` | "It answers its own workers over iMessage, unprompted." | QR code, auto-answered count. |

Beat 1 is the strongest opener and most people skip its equivalent. Use it.

## 3 · The three numbers, cold

- **35** — clean readings needed to license one field at the 90% floor. **53** if one is wrong.
- **$59.15** — cost to license one certificate at the real $1.69 CPI (35 x $1.69). Ruling one out costs one failure.
- **0.000** — what an unmeasured field licenses. Not by discipline; by construction, in `readiness.mjs`.

Live as of writing: 1 human reading, 15 model runs, **0 traps taken by anyone**, every verdict `NOT YET`.

## 4 · The framing that survives contact

Do **not** claim "humans catch what the models miss." No reader has taken a distractor, and until
the scorer was fixed the apparent model errors were not misreadings at all — `Senior ICR` is the
document's own defined abbreviation and was being marked wrong. A judge who opens `/results` sees
zero traps and the claim dies in front of them.

Claim this instead, which the data does support:

> Before human input, every reader — including a model that read 24 out of 24 — sat in
> NOT YET. Perfect observed accuracy licensed a floor of 0.862, under the 0.90 the business
> requires. The company could not justify automating anything. Human readings are the only
> thing that moves a field out of NOT YET, and we can price the move exactly: $59.15 to
> license, one clear failure to rule out.

That is honest, it is the actual finding, and it is stronger than the trap story because it is a
result about *cost of evidence* rather than a result about who is smarter.

**The before/after to measure (40% of scoring):** per-field licensed floor at wave start (0.000,
by construction) versus now. It is monotone, computable from rows already in Neon, and it grows
all afternoon regardless of what any participant answers. It cannot die on you.

**The second axis (25% — quality/efficiency of input):** arrive-rate between wave 1 and wave 2. If
the agent tightens the screener or the task description and more paid recruits reach the work,
that is human input improving the company's own procurement, visible on `/funnel`.

## 5 · Before 17:15

1. **Re-run the five models** against the 200 DPI renders and the corrected instruction. Until that
   lands, `/results` compares readers who were asked different questions at different resolutions.
2. **Run a second wave** so `/funnel` has two waves to compare. One wave is a snapshot, two is a
   before-and-after.
3. **Check `funnel.mjs:232`** — `DEFAULT` is a hardcoded opportunity id. If today's live wave is a
   different opportunity, `/funnel` shows the wrong one and you will not notice mid-demo.

## 6 · If it goes wrong

- **Judge asks whether the scoring is fair to synonyms.** It is now: `same()` in `certs.mjs`
  accepts date formats, numeric equivalents, `£`/`m` suffixes, a trailing parenthetical the
  document itself prints, and per-certificate aliases like `Senior ICR`. Verified over all 24
  cert x field cells with no alias colliding with any distractor.
- **Zero traps still at 19:00.** Say so before they find it: "the traps are the failure mode we
  built the corpus to catch, and at this n nobody has hit one. That is a real result about how
  much evidence this costs, not a gap in the demo."
- **Pages auto-reload every 20–25s.** If Neon blips mid-sentence a page 500s. Have `/results`
  open in a second tab.
- **Nothing is LICENSED.** Expected at this n, but say why it is reachable rather than hopeless:
  35 clean readings on one certificate is $59.15 at the real CPI, inside the $111.50 balance.
  "Rule-out is cheap, rule-in is expensive" is a passing test in this repo, not a rationalisation.
