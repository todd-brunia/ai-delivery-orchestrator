CREATE TABLE orchestrator.work_item_callback_correlations (
  work_item_id uuid PRIMARY KEY REFERENCES orchestrator.work_items(id) ON DELETE CASCADE,
  repository text NOT NULL,
  issue_node_id text NOT NULL,
  planning_fingerprint text NOT NULL CHECK (planning_fingerprint ~ '^[a-f0-9]{64}$'),
  automation_marker text NOT NULL,
  expected_branch text NOT NULL,
  expected_base_sha text NOT NULL CHECK (expected_base_sha ~ '^[a-f0-9]{40}$'),
  accepted_workflow_run_id text,
  pull_request_node_id text,
  pull_request_number integer CHECK (pull_request_number > 0),
  current_head_sha text CHECK (current_head_sha ~ '^[a-f0-9]{40}$'),
  recorded_at timestamptz NOT NULL,
  UNIQUE (repository, issue_node_id),
  UNIQUE (repository, automation_marker)
);

CREATE UNIQUE INDEX work_item_callback_correlations_workflow_run_unique_idx
  ON orchestrator.work_item_callback_correlations (repository, accepted_workflow_run_id)
  WHERE accepted_workflow_run_id IS NOT NULL;

CREATE UNIQUE INDEX work_item_callback_correlations_pr_node_unique_idx
  ON orchestrator.work_item_callback_correlations (repository, pull_request_node_id)
  WHERE pull_request_node_id IS NOT NULL;

CREATE UNIQUE INDEX work_item_callback_correlations_pr_number_unique_idx
  ON orchestrator.work_item_callback_correlations (repository, pull_request_number)
  WHERE pull_request_number IS NOT NULL;

CREATE TABLE orchestrator.github_callback_results (
  delivery_id uuid PRIMARY KEY REFERENCES orchestrator.github_webhook_inbox(delivery_id) ON DELETE RESTRICT,
  work_item_id uuid REFERENCES orchestrator.work_items(id) ON DELETE RESTRICT,
  semantic_key text UNIQUE,
  disposition text NOT NULL CHECK (disposition IN ('pending', 'retrying', 'completed', 'ignored', 'blocked', 'dead_letter')),
  reason_class text NOT NULL CHECK (reason_class ~ '^[a-z][a-z0-9_]{1,100}$'),
  evidence jsonb NOT NULL,
  recorded_at timestamptz NOT NULL
);

CREATE INDEX github_callback_results_disposition_idx
  ON orchestrator.github_callback_results (disposition, recorded_at);
