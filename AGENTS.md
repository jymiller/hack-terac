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
- Use only synthetic financial fixtures created for this event.
- Do not read, copy, mount, query, or depend on Enid, Enid Vault, client
  documents, client data, production systems, or MongoDB-hackathon code.
- Do not add an Enid API, MCP server, database connection, or product
  integration.

## Execution

- Preserve `.hackathon/trace.jsonl`, `.hackathon/decisions.jsonl`, and
  `.hackathon/build-ledger.jsonl` as append-only records.
- Every material claim needs independent evidence and a stated
  `does_not_prove` boundary.
- Never store credentials, participant PII, raw interviews, or confidential
  material in Git.
- Spending, live Terac launches, public deployment, visibility changes, and
  submission require explicit owner authorization.
- Do not begin product implementation until the concept-lock record contains
  all five required owner decisions.

## Quality

- Favor the smallest testable capability.
- Keep live and synthetic evidence visibly distinct.
- A HOLD counts against delivery coverage; it cannot be used to game quality.
- Generated output is not evidence until a separate check passes.

