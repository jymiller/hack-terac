# Agent operating contract

## Authority

- John makes binding concept, spend, release, deployment, and submission
  decisions.
- Agent recommendations remain proposals until an owner decision is appended
  to `.hackathon/decisions.jsonl`.
- Do not infer a decision from a default, a draft, a recommendation, or a UI
  selection that was not saved.

## Scope

- Work only in this repository.
- Seed and demonstrate with synthetic fixtures. Real event-day participants,
  their submitted inputs, and real Stripe payments are permitted, because the
  event requires real human input and real revenue.
- Do not read, copy, mount, query, or depend on Enid, Enid Vault, client
  documents, client data, production systems, or MongoDB-hackathon code.
  This boundary is not relaxed by anything below.
- Do not add an Enid API, MCP server, database connection, or product
  integration.

## Execution

- Preserve `.hackathon/trace.jsonl`, `.hackathon/decisions.jsonl`, and
  `.hackathon/build-ledger.jsonl` as append-only records.
- Every material claim needs independent evidence and a stated
  `does_not_prove` boundary.
- Never store credentials, participant PII, raw interviews, or confidential
  material in Git.
- Public deployment to Render, live Terac launches, and Stripe collection are
  authorized for 15 August 2026 by `D-0002`. Submission still requires an
  explicit owner go.
- The five-answer concept-lock gate is retired for this event by `D-0002`.
  `scripts/check-concept-lock.mjs` and its tests remain in the repository as
  history; they no longer gate implementation.

## Quality

- Favor the smallest testable capability.
- Keep live and synthetic evidence visibly distinct.
- A HOLD counts against delivery coverage; it cannot be used to game quality.
- Generated output is not evidence until a separate check passes.

