# Hack Terac

**Status:** BUILD — CONCEPT PENDING (gate retired by `D-0002`)  
**Event:** Zero-Human Company Hackathon by Terac · 15 August 2026  
**Submissions lock:** 18:45 PDT · **feature freeze:** 17:15 PDT

This repository is the canonical build, experiment, evidence, and submission
workspace for the Terac hackathon.

## Event rules that actually bind

Build one or more agents that run a company autonomously — product, marketing,
outbound, selling, payments, legal/compliance, hard decisions.

Every project must:

- use the Terac MCP;
- collect real human input through Terac during the event; and
- show a measurable before-and-after improvement caused by that input.

Scoring for Best Overall Project is 40% improvement from human input, 35% what
was built, 25% quality and efficiency of the human input. A second $2,500 prize
goes to the agent-run company that earns real revenue during the day *and* looks
most likely to succeed after it. Revenue is tracked by organizers through a
read-only Stripe restricted key.

## Owner-set boundary

Standalone product. No Enid code, Enid data, client documents, or production
credentials — that boundary is unchanged and is not relaxed by `D-0002`.

Real event participants and real Stripe payments are permitted; synthetic
fixtures seed the demo and stay visibly labeled as synthetic.

## Committed stack

| Layer | Vendor |
|---|---|
| Human input | Terac (required) — MCP at `https://terac.com/api/mcp` |
| Hosting + orchestration | Render, including Render Workflows |
| Database | Neon Postgres |
| Payments | Stripe (required for the revenue prize) |
| Messaging surface | Linq |
| Agent sandboxes | Superserve |
| Agent coordination | Band |
| Open-weight models | Pioneer by Fastino Labs |
| QA | Replay |

## What remains open

The concept itself. `D-0001`'s administrative-product framing is superseded;
the replacement direction is a clean sheet and is not yet recorded.

## Concept-lock gate

Run the deterministic gate before treating product implementation as
authorized:

```sh
npm run check:concept-lock
```

The command exits `0` only when the canonical append-only decision ledger
contains exactly one valid, explicit owner concept-lock record with answers
for all five IDs: `outcome`, `service-floor`, `routing`, `activation`, and
`proof`. Exit `1` means that record is still missing; exit `2` means the
contract or gate evidence is invalid. The CLI cannot substitute alternate
contract or ledger paths. Use
`npm run check:concept-lock -- --json` for machine-readable output.

A qualifying ledger entry has this shape:

```json
{"schema_version":1,"record_type":"concept_lock","decision_id":"D-0002","at":"<ISO-8601 timestamp with timezone>","actor":"owner:john","status":"confirmed","answers":{"outcome":"<owner text>","service-floor":"<owner text>","routing":"<owner text>","activation":"<owner text>","proof":"<owner text>"},"decision":"Concept lock confirmed from five explicit owner answers.","source":"<owner decision reference>"}
```

Every answer must be trimmed non-empty text. An agent recommendation, broad
project-boundary record, incomplete answers object, or second concept-lock
record does not qualify. The version 1 record contract intentionally has no
implicit replacement rule; define explicit supersession semantics before
appending a revised lock. Even a passing gate authorizes product implementation
only; it never authorizes spend, deployment, an external Terac launch, release,
or submission. It also cannot relax the standalone, synthetic-only, no-Enid,
and no-client-data boundaries.

The validator proves only that the ledger has one syntactically complete
composite record containing five answers and claiming the required owner
authority. It does not authenticate the actor beyond that ledger claim or
judge whether the answers are wise, consistent, feasible, sufficient evidence,
or likely to produce a qualifying product. Its output is the only derived
concept-lock status; experiment configuration and prose are not lock authority.

Run the dependency-free tests with `npm test`.

## Repository roles

- [hackathon-prep](../hackathon-prep) remains authoritative for campaign
  research, concept lineage, and cross-event learning.
- The private Looping Lab briefing site remains the owner decision surface.
- This repository becomes authoritative for the event build and its proof.

No license has been selected. Visibility and licensing are release-gate
decisions after the event rules and repository contents are verified.
