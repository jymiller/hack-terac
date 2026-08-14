#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REQUIRED_DECISION_IDS = Object.freeze([
  "outcome",
  "service-floor",
  "routing",
  "activation",
  "proof",
]);

const EXPECTED_RECORD_TYPE = "concept_lock";
const EXPECTED_OWNER = "owner:john";
const REQUIRED_OWNER_BOUNDARIES = Object.freeze([
  "standalone Terac-powered administrative product",
  "reduce delivery cost per trusted outcome",
  "preserve delivery quality",
  "no Enid code, data, API, MCP, client documents, or production integration",
  "synthetic financial cases only",
]);
const REQUIRED_RECORD_FIELDS = Object.freeze([
  "schema_version",
  "record_type",
  "decision_id",
  "at",
  "actor",
  "status",
  "answers",
  "decision",
  "source",
]);
const RESTRICTED_SCOPES = Object.freeze([
  "spend",
  "deployment",
  "external_terac_launch",
  "release_or_submission",
  "enid_integration",
  "enid_or_client_data",
  "non_synthetic_data",
]);
const DOES_NOT_PROVE = Object.freeze([
  "owner_identity_beyond_the_ledger_claim",
  "answer_substantive_quality_or_consistency",
  "concept_feasibility",
  "product_quality_or_event_qualification",
]);
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const LEDGER_DECISION_ID = /^D-\d{4,}$/;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactMembers(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    new Set(actual).size === actual.length &&
    expected.every((value) => actual.includes(value))
  );
}

function isNonEmptyText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isTimestampWithTimezone(value) {
  return (
    typeof value === "string" &&
    ISO_TIMESTAMP.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function validateContract(requirements) {
  const errors = [];
  if (!isPlainObject(requirements)) return ["requirements must be a JSON object"];

  if (requirements.schema_version !== 2) errors.push("requirements.schema_version must be 2");
  if (!hasExactMembers(requirements.owner_defined, REQUIRED_OWNER_BOUNDARIES)) {
    errors.push("owner_defined boundaries must remain complete and unchanged");
  }

  const gate = requirements.concept_lock;
  if (!isPlainObject(gate)) return [...errors, "concept_lock must be an object"];

  if (gate.schema_version !== 1) errors.push("concept_lock.schema_version must be 1");
  if (gate.authorization_scope !== "product_implementation_only") {
    errors.push("concept_lock.authorization_scope must be product_implementation_only");
  }
  if (gate.preserves_owner_defined_boundaries !== true) {
    errors.push("concept_lock.preserves_owner_defined_boundaries must be true");
  }
  if (gate.decision_ledger !== ".hackathon/decisions.jsonl") {
    errors.push("concept_lock.decision_ledger must be .hackathon/decisions.jsonl");
  }
  if (gate.required_decisions_from !== "open_decisions") {
    errors.push("concept_lock.required_decisions_from must be open_decisions");
  }

  const openDecisionIds = Array.isArray(requirements.open_decisions)
    ? requirements.open_decisions.map((decision) => decision?.id)
    : null;
  if (!hasExactMembers(openDecisionIds, REQUIRED_DECISION_IDS)) {
    errors.push(`open_decisions must contain exactly: ${REQUIRED_DECISION_IDS.join(", ")}`);
  }

  const record = gate.qualifying_record;
  if (!isPlainObject(record)) {
    errors.push("concept_lock.qualifying_record must be an object");
  } else {
    if (record.schema_version !== 1) errors.push("qualifying_record.schema_version must be 1");
    if (record.record_type !== EXPECTED_RECORD_TYPE) {
      errors.push(`qualifying_record.record_type must be ${EXPECTED_RECORD_TYPE}`);
    }
    if (record.actor !== EXPECTED_OWNER) {
      errors.push(`qualifying_record.actor must be ${EXPECTED_OWNER}`);
    }
    if (record.status !== "confirmed") {
      errors.push("qualifying_record.status must be confirmed");
    }
    if (!hasExactMembers(record.required_fields, REQUIRED_RECORD_FIELDS)) {
      errors.push(`qualifying_record.required_fields must contain exactly: ${REQUIRED_RECORD_FIELDS.join(", ")}`);
    }
    if (record.ledger_decision_id_rule !== "D-[0-9]{4,}") {
      errors.push("qualifying_record.ledger_decision_id_rule must be D-[0-9]{4,}");
    }
    if (record.answers_field !== "answers") {
      errors.push("qualifying_record.answers_field must be answers");
    }
    if (record.answer_rule !== "exact_required_keys_with_trimmed_non_empty_text") {
      errors.push("qualifying_record.answer_rule must require exact keys with non-empty text");
    }
    if (record.unique_ledger_decision_ids !== true) {
      errors.push("qualifying_record.unique_ledger_decision_ids must be true");
    }
    if (record.record_policy !== "exactly_one_confirmed_record") {
      errors.push("qualifying_record.record_policy must be exactly_one_confirmed_record");
    }
  }

  if (!hasExactMembers(gate.does_not_authorize, RESTRICTED_SCOPES)) {
    errors.push(`concept_lock.does_not_authorize must contain exactly: ${RESTRICTED_SCOPES.join(", ")}`);
  }
  if (!hasExactMembers(gate.does_not_prove, DOES_NOT_PROVE)) {
    errors.push(`concept_lock.does_not_prove must contain exactly: ${DOES_NOT_PROVE.join(", ")}`);
  }
  return errors;
}

function parseLedger(ledgerText) {
  const records = [];
  const errors = [];
  const decisionIdLines = new Map();

  ledgerText.split(/\r?\n/).forEach((line, index) => {
    if (line.trim() === "") return;
    try {
      const value = JSON.parse(line);
      if (!isPlainObject(value)) {
        errors.push({ line: index + 1, errors: ["ledger entry must be a JSON object"] });
        return;
      }
      if (isNonEmptyText(value.decision_id)) {
        const previousLine = decisionIdLines.get(value.decision_id);
        if (previousLine !== undefined) {
          errors.push({
            line: index + 1,
            errors: [`duplicate decision_id ${value.decision_id}; first seen on line ${previousLine}`],
          });
        } else {
          decisionIdLines.set(value.decision_id, index + 1);
        }
      }
      records.push({ line: index + 1, value });
    } catch {
      errors.push({ line: index + 1, errors: ["invalid JSON"] });
    }
  });
  return { records, errors };
}

function validateConceptLockRecord(record) {
  const errors = [];
  for (const field of REQUIRED_RECORD_FIELDS) {
    if (!Object.hasOwn(record, field)) errors.push(`missing ${field}`);
  }
  if (record.schema_version !== 1) errors.push("schema_version must be 1");
  if (record.record_type !== EXPECTED_RECORD_TYPE) {
    errors.push(`record_type must be ${EXPECTED_RECORD_TYPE}`);
  }
  if (!isNonEmptyText(record.decision_id) || !LEDGER_DECISION_ID.test(record.decision_id)) {
    errors.push("decision_id must match D-[0-9]{4,}");
  }
  if (!isTimestampWithTimezone(record.at)) {
    errors.push("at must be an ISO-8601 timestamp with a timezone");
  }
  if (record.actor !== EXPECTED_OWNER) errors.push(`actor must be ${EXPECTED_OWNER}`);
  if (record.status !== "confirmed") errors.push("status must be confirmed");
  if (!isNonEmptyText(record.decision)) errors.push("decision must be non-empty text");
  if (!isNonEmptyText(record.source)) errors.push("source must be non-empty text");

  if (!isPlainObject(record.answers)) {
    errors.push("answers must be a JSON object");
  } else {
    const answerIds = Object.keys(record.answers);
    const missing = REQUIRED_DECISION_IDS.filter((id) => !Object.hasOwn(record.answers, id));
    const extra = answerIds.filter((id) => !REQUIRED_DECISION_IDS.includes(id));
    if (missing.length > 0) errors.push(`answers missing: ${missing.join(", ")}`);
    if (extra.length > 0) errors.push(`answers contain unexpected IDs: ${extra.join(", ")}`);
    for (const id of REQUIRED_DECISION_IDS) {
      if (Object.hasOwn(record.answers, id) && !isNonEmptyText(record.answers[id])) {
        errors.push(`answers.${id} must be non-empty text`);
      }
    }
  }
  return errors;
}

export function evaluateConceptLock(requirements, ledgerText) {
  const contractErrors = validateContract(requirements);
  const { records, errors: ledgerErrors } = parseLedger(ledgerText);
  const conceptRecords = records.filter(({ value }) => value.record_type === EXPECTED_RECORD_TYPE);
  const invalidRecords = conceptRecords
    .map(({ line, value }) => ({
      line,
      decision_id: value.decision_id ?? null,
      errors: validateConceptLockRecord(value),
    }))
    .filter(({ errors }) => errors.length > 0);

  if (conceptRecords.length > 1) {
    ledgerErrors.push({
      line: conceptRecords[1].line,
      errors: ["multiple concept_lock records are ambiguous; exactly one is allowed"],
    });
  }

  const qualifyingRecord =
    conceptRecords.length === 1 && invalidRecords.length === 0 ? conceptRecords[0].value : null;
  const authorized =
    contractErrors.length === 0 &&
    ledgerErrors.length === 0 &&
    invalidRecords.length === 0 &&
    qualifyingRecord !== null;

  return {
    schema_version: 1,
    state: authorized
      ? "authorized_for_product_implementation"
      : contractErrors.length > 0 || ledgerErrors.length > 0 || invalidRecords.length > 0
        ? "blocked_invalid_concept_lock_evidence"
        : "blocked_pending_concept_lock",
    product_implementation_authorized: authorized,
    concept_lock_record_count: conceptRecords.length,
    required_decision_ids: [...REQUIRED_DECISION_IDS],
    confirmed_decision_ids: authorized ? [...REQUIRED_DECISION_IDS] : [],
    missing_decision_ids: authorized ? [] : [...REQUIRED_DECISION_IDS],
    contract_errors: contractErrors,
    ledger_errors: ledgerErrors,
    invalid_records: invalidRecords,
    does_not_authorize: [...RESTRICTED_SCOPES],
    does_not_prove: [...DOES_NOT_PROVE],
  };
}

export function exitCodeFor(report) {
  if (report.product_implementation_authorized) return 0;
  if (
    report.contract_errors.length > 0 ||
    report.ledger_errors.length > 0 ||
    report.invalid_records.length > 0
  ) return 2;
  return 1;
}

function formatHumanReport(report) {
  const lines = [
    `Concept lock: ${report.state}`,
    `Product implementation authorized: ${report.product_implementation_authorized ? "yes" : "no"}`,
  ];
  if (report.missing_decision_ids.length > 0) {
    lines.push(`Missing owner decisions: ${report.missing_decision_ids.join(", ")}`);
  }
  if (report.contract_errors.length > 0) {
    lines.push(`Contract errors: ${report.contract_errors.join("; ")}`);
  }
  for (const error of report.ledger_errors) {
    lines.push(`Ledger line ${error.line}: ${error.errors.join("; ")}`);
  }
  for (const error of report.invalid_records) {
    lines.push(`Invalid concept-lock record on line ${error.line}: ${error.errors.join("; ")}`);
  }
  lines.push(`This gate never authorizes: ${report.does_not_authorize.join(", ")}`);
  lines.push(`This gate does not prove: ${report.does_not_prove.join(", ")}`);
  return lines.join("\n");
}

async function main() {
  const scriptPath = fileURLToPath(import.meta.url);
  const repositoryRoot = resolve(dirname(scriptPath), "..");
  try {
    const argumentsList = process.argv.slice(2);
    if (argumentsList.some((argument) => argument !== "--json") || argumentsList.length > 1) {
      throw new Error("only --json is supported; the gate always reads the canonical repository contract and ledger");
    }
    const [requirementsText, ledgerText] = await Promise.all([
      readFile(resolve(repositoryRoot, ".hackathon/requirements.json"), "utf8"),
      readFile(resolve(repositoryRoot, ".hackathon/decisions.jsonl"), "utf8"),
    ]);
    const report = evaluateConceptLock(JSON.parse(requirementsText), ledgerText);
    const output = argumentsList[0] === "--json" ? JSON.stringify(report, null, 2) : formatHumanReport(report);
    process.stdout.write(`${output}\n`);
    process.exitCode = exitCodeFor(report);
  } catch (error) {
    process.stderr.write(`Concept-lock check failed: ${error.message}\n`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
