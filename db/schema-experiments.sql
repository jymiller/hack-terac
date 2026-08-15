-- Coverage-engine schema. Apply after db/schema.sql.
-- Terac is the CALIBRATION instrument, not a production route: human attestations
-- are bought once to set a confidence threshold, after which the process runs
-- AUTO or HOLD with no human in the delivery path.

create table if not exists processes (
  id             text primary key,
  name           text not null,
  expertise_area text not null,
  -- measured: real attestations exist. designed: task built, not yet run. not_yet: identified only.
  status         text not null default 'designed'
                 check (status in ('measured', 'designed', 'not_yet')),
  atomizable     boolean not null default true,
  notes          text,
  created_at     timestamptz not null default now()
);

create table if not exists claims (
  id           text primary key,
  process_id   text not null references processes (id),
  evidence     text not null,
  proposition  text not null,
  -- synthetic corpora are authored with known truth, which is what makes scoring possible
  ground_truth text not null check (ground_truth in ('supported', 'not_supported', 'insufficient')),
  corpus       text not null default 'synthetic',
  holdout      boolean not null default false
);

create index if not exists claims_process_idx on claims (process_id);

create table if not exists machine_proposals (
  id          bigserial primary key,
  claim_id    text not null references claims (id),
  arm         text not null,
  tier        text not null,
  disposition text not null check (disposition in ('supported', 'not_supported', 'insufficient')),
  confidence  double precision not null,
  cost_usd    double precision not null default 0,
  created_at  timestamptz not null default now(),
  unique (claim_id, arm)
);

-- One row per (claim, submission): a worker answers several claims in one task, so the
-- submission id is NOT unique on its own. Uniqueness on the pair also makes a replayed
-- POST idempotent instead of a constraint violation on the first real paid response.
create table if not exists attestations (
  id                  bigserial primary key,
  claim_id            text not null references claims (id),
  source              text not null check (source in ('terac', 'synthetic_oracle')),
  answer              text not null check (answer in ('AGREE', 'CORRECT', 'INSUFFICIENT', 'RECUSE')),
  terac_submission_id text,
  cost_usd            double precision not null default 0,
  received_at         timestamptz not null default now(),
  unique (claim_id, terac_submission_id)
);

-- Migration for a database where the old single-column unique already exists.
alter table attestations drop constraint if exists attestations_terac_submission_id_key;
create unique index if not exists attestations_claim_submission_idx
  on attestations (claim_id, terac_submission_id);

create index if not exists attestations_claim_idx on attestations (claim_id);

-- One row per (process, policy) evaluation. evidence_mode keeps live and synthetic
-- results visibly distinct, which the repository contract requires.
create table if not exists policy_results (
  id                bigserial primary key,
  process_id        text not null references processes (id),
  policy            text not null,
  threshold         double precision,
  n                 integer not null,
  accuracy          double precision,
  coverage          double precision,
  cost_per_trusted  double precision,
  expected_exceptions_per_1000 double precision,
  risk_reserve_usd  double precision,
  evidence_mode     text not null default 'synthetic' check (evidence_mode in ('live', 'synthetic')),
  recorded_at       timestamptz not null default now()
);
