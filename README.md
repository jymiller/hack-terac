# Hack Terac

**Status:** PREP — CONCEPT LOCK PENDING  
**Event:** Zero-Human Company Hackathon by Terac · 15 August 2026

This repository is the canonical build, experiment, evidence, and submission
workspace for the Terac hackathon.

## Owner-set brief

Build a standalone Terac-powered administrative product that reduces the cost
of producing a trusted client outcome while preserving the service contract.
The hackathon product does not modify or integrate with Enid and uses no Enid
code, Enid data, client documents, or production credentials.

Only synthetic financial cases are permitted.

## What is settled

- Clients buy trusted outcomes, not a labor model.
- Delivery cost should fall over time without lowering quality.
- Qualified Terac judgment is a measurable delivery resource.
- The hackathon product is standalone and outside Enid.
- The competition build and its evidence live in this repository.

## What remains open

John must decide:

1. the first outcome to optimize;
2. the full service floor;
3. the allowed delivery routes;
4. who may activate a cheaper policy; and
5. the evidence required before the build is authorized.

The current agent recommendations are advisory. They are not product
requirements until recorded as owner decisions in
[.hackathon/decisions.jsonl](.hackathon/decisions.jsonl).

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
