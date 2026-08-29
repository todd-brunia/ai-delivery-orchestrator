CREATE TABLE orchestrator.dispatch_attempts (
  work_item_id uuid NOT NULL REFERENCES orchestrator.work_items(id) ON DELETE CASCADE,
  intent_fingerprint text NOT NULL CHECK (intent_fingerprint ~ '^[a-f0-9]{64}$'),
  status text NOT NULL CHECK (status IN ('proposed', 'claimed', 'accepted', 'ambiguous', 'rejected', 'blocked')),
  workflow_run_id text,
  evidence_uri text,
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (work_item_id, intent_fingerprint),
  CHECK ((status = 'accepted') = (workflow_run_id IS NOT NULL AND evidence_uri IS NOT NULL))
);

CREATE INDEX dispatch_attempts_status_idx ON orchestrator.dispatch_attempts (status, recorded_at);
