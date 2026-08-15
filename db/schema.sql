-- Neon Postgres schema.
-- Apply with: psql "$DATABASE_URL" -f db/schema.sql

create table if not exists orders (
  id                text primary key,
  created_at        timestamptz not null default now(),
  email             text,
  product           text,
  amount_cents      integer,
  status            text not null default 'pending',
  stripe_session_id text,
  stripe_payment_intent text,
  paid_at           timestamptz,
  metadata          jsonb not null default '{}'::jsonb
);

create index if not exists orders_status_idx on orders (status);

-- Stripe redelivers events; this table makes the webhook handler idempotent.
create table if not exists stripe_events (
  id            text primary key,
  type          text not null,
  received_at   timestamptz not null default now()
);

-- Human input captured from Terac participants. The response body is NOT
-- retrievable from Terac's API after the fact, so this table is the only
-- durable record of what people actually said.
create table if not exists terac_responses (
  id                  bigserial primary key,
  terac_submission_id text unique not null,
  task_id             text,
  opportunity_id      text,
  captured_at         timestamptz not null default now(),
  payload             jsonb not null
);

-- Before/after evidence for the 40% judging criterion.
create table if not exists evals (
  id          bigserial primary key,
  phase       text not null check (phase in ('before', 'after')),
  subject_id  text not null,
  metric      text not null,
  value       double precision not null,
  n           integer,
  -- Defaults to synthetic: a row must CLAIM to be human-backed, never inherit it.
  evidence_mode text not null default 'synthetic' check (evidence_mode in ('live', 'synthetic')),
  recorded_at timestamptz not null default now()
);
