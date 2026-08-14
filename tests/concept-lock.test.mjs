import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  REQUIRED_DECISION_IDS,
  evaluateConceptLock,
  exitCodeFor,
} from "../scripts/check-concept-lock.mjs";

const requirements = JSON.parse(
  await readFile(new URL("../.hackathon/requirements.json", import.meta.url), "utf8"),
);
const repositoryLedger = await readFile(
  new URL("../.hackathon/decisions.jsonl", import.meta.url),
  "utf8",
);

function conceptLockRecord(overrides = {}) {
  return {
    schema_version: 1,
    record_type: "concept_lock",
    decision_id: "D-0101",
    at: "2026-08-14T12:00:00-07:00",
    actor: "owner:john",
    status: "confirmed",
    answers: Object.fromEntries(
      REQUIRED_DECISION_IDS.map((id) => [id, `Explicit owner answer for ${id}`]),
    ),
    decision: "Concept lock confirmed from five explicit owner answers.",
    source: "looping-lab:owner-confirmed-concept-lock",
    ...overrides,
  };
}

function jsonl(records) {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

test("the repository stays blocked because D-0001 is not a composite concept lock", () => {
  const report = evaluateConceptLock(requirements, repositoryLedger);
  assert.equal(report.product_implementation_authorized, false);
  assert.equal(report.concept_lock_record_count, 0);
  assert.deepEqual(report.missing_decision_ids, REQUIRED_DECISION_IDS);
  assert.equal(exitCodeFor(report), 1);
});

test("one valid composite owner record authorizes product implementation only", () => {
  const report = evaluateConceptLock(requirements, jsonl([conceptLockRecord()]));
  assert.equal(report.state, "authorized_for_product_implementation");
  assert.equal(report.product_implementation_authorized, true);
  assert.deepEqual(report.confirmed_decision_ids, REQUIRED_DECISION_IDS);
  assert.deepEqual(report.missing_decision_ids, []);
  assert.ok(report.does_not_authorize.includes("external_terac_launch"));
  assert.ok(report.does_not_authorize.includes("enid_or_client_data"));
  assert.ok(report.does_not_prove.includes("answer_substantive_quality_or_consistency"));
  assert.equal(exitCodeFor(report), 0);
});

test("agent recommendations never count as the owner concept-lock record", () => {
  const recommendation = conceptLockRecord({
    record_type: "agent_recommendation",
    actor: "agent:codex",
  });
  const ignored = evaluateConceptLock(requirements, jsonl([recommendation]));
  assert.equal(ignored.state, "blocked_pending_concept_lock");
  assert.equal(ignored.concept_lock_record_count, 0);

  const impersonatingRecord = conceptLockRecord({ actor: "agent:codex" });
  const rejected = evaluateConceptLock(requirements, jsonl([impersonatingRecord]));
  assert.equal(rejected.state, "blocked_invalid_concept_lock_evidence");
  assert.match(rejected.invalid_records[0].errors.join(" "), /actor must be owner:john/);
});

test("the answers object must have exactly the five required IDs", () => {
  const missingAnswers = { ...conceptLockRecord().answers };
  delete missingAnswers.routing;
  const missing = evaluateConceptLock(
    requirements,
    jsonl([conceptLockRecord({ answers: missingAnswers })]),
  );
  assert.match(missing.invalid_records[0].errors.join(" "), /answers missing: routing/);

  const extra = evaluateConceptLock(
    requirements,
    jsonl([conceptLockRecord({ answers: { ...conceptLockRecord().answers, naming: "Reflex" } })]),
  );
  assert.match(extra.invalid_records[0].errors.join(" "), /unexpected IDs: naming/);
});

test("every owner answer must be trimmed non-empty text", () => {
  for (const invalidAnswer of ["   ", false, 0, ["text"], { text: "answer" }]) {
    const report = evaluateConceptLock(
      requirements,
      jsonl([
        conceptLockRecord({
          answers: { ...conceptLockRecord().answers, proof: invalidAnswer },
        }),
      ]),
    );
    assert.equal(report.product_implementation_authorized, false);
    assert.match(report.invalid_records[0].errors.join(" "), /answers.proof must be non-empty text/);
  }
});

test("malformed and non-object ledger entries fail closed", () => {
  const malformed = evaluateConceptLock(requirements, "{not-json}\n");
  assert.equal(malformed.state, "blocked_invalid_concept_lock_evidence");
  assert.deepEqual(malformed.ledger_errors, [{ line: 1, errors: ["invalid JSON"] }]);

  const nonObject = evaluateConceptLock(requirements, "[]\n");
  assert.deepEqual(nonObject.ledger_errors, [
    { line: 1, errors: ["ledger entry must be a JSON object"] },
  ]);
});

test("duplicate audit IDs and multiple concept-lock records fail closed", () => {
  const duplicateId = conceptLockRecord({ decision_id: "D-0001" });
  const duplicate = evaluateConceptLock(requirements, `${repositoryLedger}${jsonl([duplicateId])}`);
  assert.match(duplicate.ledger_errors[0].errors.join(" "), /duplicate decision_id D-0001/);

  const multiple = evaluateConceptLock(
    requirements,
    jsonl([conceptLockRecord(), conceptLockRecord({ decision_id: "D-0102" })]),
  );
  assert.equal(multiple.product_implementation_authorized, false);
  assert.match(multiple.ledger_errors[0].errors.join(" "), /multiple concept_lock records/);
});

test("contract drift cannot change the five IDs, owner authority, or fixed boundaries", () => {
  const changedIds = structuredClone(requirements);
  changedIds.open_decisions = changedIds.open_decisions.slice(0, 1);
  assert.match(
    evaluateConceptLock(changedIds, "").contract_errors.join(" "),
    /open_decisions/,
  );

  const changedOwner = structuredClone(requirements);
  changedOwner.concept_lock.qualifying_record.actor = "agent:codex";
  assert.match(
    evaluateConceptLock(changedOwner, "").contract_errors.join(" "),
    /actor must be owner:john/,
  );

  const weakenedBoundary = structuredClone(requirements);
  weakenedBoundary.owner_defined = weakenedBoundary.owner_defined.filter(
    (boundary) => boundary !== "synthetic financial cases only",
  );
  assert.match(
    evaluateConceptLock(weakenedBoundary, "").contract_errors.join(" "),
    /owner_defined boundaries/,
  );
});

test("the CLI cannot authorize against alternate contract or ledger paths", () => {
  const scriptPath = fileURLToPath(new URL("../scripts/check-concept-lock.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [scriptPath, "--ledger", "/tmp/fabricated.jsonl"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /only --json is supported/);
});
