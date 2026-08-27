CREATE TABLE orchestrator.github_mutation_receipts (
  outbox_id uuid NOT NULL REFERENCES orchestrator.outbox(id) ON DELETE CASCADE,
  attempt integer NOT NULL CHECK (attempt > 0),
  operation text NOT NULL CHECK (operation IN ('set_labels', 'dispatch_workflow', 'submit_review', 'mark_ready_for_review')),
  actor_role text NOT NULL CHECK (actor_role IN ('builder', 'reviewer')),
  intent_sha256 text NOT NULL CHECK (intent_sha256 ~ '^[a-f0-9]{64}$'),
  outcome text NOT NULL CHECK (outcome IN ('completed', 'retry', 'ambiguous')),
  request_id text,
  error_class text,
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (outbox_id, attempt)
);

CREATE INDEX github_mutation_receipts_outcome_idx
  ON orchestrator.github_mutation_receipts (outcome, recorded_at);
