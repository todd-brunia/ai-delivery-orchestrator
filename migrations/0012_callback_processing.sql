-- Every delivery retains evidence, including repeated semantic observations.
ALTER TABLE orchestrator.github_callback_results DROP CONSTRAINT github_callback_results_semantic_key_key;
CREATE INDEX github_callback_results_semantic_idx ON orchestrator.github_callback_results (semantic_key);
CREATE TABLE orchestrator.github_callback_artifacts (
  repository text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('workflow','pull_request','check','review')),
  external_id text NOT NULL,
  work_item_id uuid NOT NULL REFERENCES orchestrator.work_items(id),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY (repository, kind, external_id)
);
-- Requests only; #74 owns reconciliation execution.
CREATE TABLE orchestrator.github_callback_notifications (
  delivery_id uuid PRIMARY KEY REFERENCES orchestrator.github_webhook_inbox(delivery_id),
  work_item_id uuid REFERENCES orchestrator.work_items(id),
  kind text NOT NULL CHECK (kind IN ('plan_authorization','reconciliation')),
  reason_class text NOT NULL,
  recorded_at timestamptz NOT NULL
);
CREATE TABLE orchestrator.github_callback_repository_blocks (
  repository text PRIMARY KEY,
  delivery_id uuid NOT NULL REFERENCES orchestrator.github_webhook_inbox(delivery_id),
  reason_class text NOT NULL,
  recorded_at timestamptz NOT NULL
);
