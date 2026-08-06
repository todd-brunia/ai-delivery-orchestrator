CREATE TABLE orchestrator.schedule_decisions (
  run_id uuid PRIMARY KEY REFERENCES orchestrator.sprint_runs(id) ON DELETE CASCADE,
  run_revision integer NOT NULL CHECK (run_revision >= 0),
  decision jsonb NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE orchestrator.reconciliation_reports (
  run_id uuid PRIMARY KEY REFERENCES orchestrator.sprint_runs(id) ON DELETE CASCADE,
  report jsonb NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE orchestrator.proposed_actions (
  idempotency_key text PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES orchestrator.sprint_runs(id) ON DELETE CASCADE,
  issue_number integer NOT NULL CHECK (issue_number > 0),
  action_type text NOT NULL CHECK (action_type IN ('set_labels', 'dispatch_workflow')),
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'proposed' CHECK (status = 'proposed'),
  created_at timestamptz NOT NULL
);

CREATE INDEX proposed_actions_run_idx ON orchestrator.proposed_actions (run_id, issue_number);
