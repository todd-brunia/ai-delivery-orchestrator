CREATE SCHEMA IF NOT EXISTS orchestrator;

CREATE TABLE orchestrator.workflow_definitions (
  version text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO orchestrator.workflow_definitions (version)
VALUES ('sprint-delivery/v1')
ON CONFLICT DO NOTHING;

CREATE TABLE orchestrator.sprint_runs (
  id uuid PRIMARY KEY,
  workflow_version text NOT NULL REFERENCES orchestrator.workflow_definitions(version),
  repository text NOT NULL,
  issue_numbers integer[] NOT NULL,
  merge_policy text NOT NULL CHECK (merge_policy = 'human'),
  state text NOT NULL,
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK (cardinality(issue_numbers) > 0)
);

CREATE TABLE orchestrator.work_items (
  id uuid PRIMARY KEY,
  sprint_run_id uuid NOT NULL REFERENCES orchestrator.sprint_runs(id) ON DELETE CASCADE,
  issue_number integer NOT NULL CHECK (issue_number > 0),
  state text NOT NULL,
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (sprint_run_id, issue_number)
);

CREATE TABLE orchestrator.dependency_edges (
  sprint_run_id uuid NOT NULL REFERENCES orchestrator.sprint_runs(id) ON DELETE CASCADE,
  prerequisite_issue_number integer NOT NULL,
  dependent_issue_number integer NOT NULL,
  kind text NOT NULL CHECK (kind = 'blocks'),
  PRIMARY KEY (sprint_run_id, prerequisite_issue_number, dependent_issue_number),
  CHECK (prerequisite_issue_number <> dependent_issue_number)
);

CREATE TABLE orchestrator.conflict_domains (
  id uuid PRIMARY KEY,
  work_item_id uuid NOT NULL REFERENCES orchestrator.work_items(id) ON DELETE CASCADE,
  kind text NOT NULL,
  value text NOT NULL,
  confidence text NOT NULL,
  UNIQUE (work_item_id, kind, value)
);

CREATE TABLE orchestrator.transitions (
  id uuid PRIMARY KEY,
  aggregate_type text NOT NULL CHECK (aggregate_type IN ('sprint_run', 'work_item')),
  aggregate_id uuid NOT NULL,
  aggregate_revision integer NOT NULL CHECK (aggregate_revision > 0),
  from_state text NOT NULL,
  to_state text NOT NULL,
  event jsonb NOT NULL,
  actor jsonb NOT NULL,
  evidence jsonb NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  occurred_at timestamptz NOT NULL,
  UNIQUE (aggregate_type, aggregate_id, aggregate_revision)
);

CREATE TABLE orchestrator.leases (
  aggregate_type text NOT NULL CHECK (aggregate_type IN ('sprint_run', 'work_item')),
  aggregate_id uuid NOT NULL,
  owner_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (aggregate_type, aggregate_id)
);

CREATE TABLE orchestrator.outbox (
  id uuid PRIMARY KEY,
  transition_id uuid NOT NULL REFERENCES orchestrator.transitions(id),
  action_type text NOT NULL,
  payload jsonb NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'claimed', 'completed', 'failed')),
  created_at timestamptz NOT NULL,
  completed_at timestamptz
);

CREATE INDEX outbox_pending_idx
  ON orchestrator.outbox (created_at)
  WHERE status = 'pending';
