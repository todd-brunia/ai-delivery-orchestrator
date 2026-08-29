CREATE TABLE orchestrator.work_item_planning_bindings (
  work_item_id uuid PRIMARY KEY REFERENCES orchestrator.work_items(id) ON DELETE CASCADE,
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  evidence jsonb NOT NULL,
  observed_at timestamptz NOT NULL,
  work_item_revision integer NOT NULL CHECK (work_item_revision >= 0),
  created_at timestamptz NOT NULL
);

CREATE TABLE orchestrator.workflow_node_results (
  work_item_id uuid NOT NULL REFERENCES orchestrator.work_items(id) ON DELETE CASCADE,
  node text NOT NULL CHECK (node ~ '^[a-z][a-z0-9_]{1,100}$'),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{7,199}$'),
  input_fingerprint text NOT NULL CHECK (input_fingerprint ~ '^[a-f0-9]{64}$'),
  output jsonb NOT NULL,
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (work_item_id, node, idempotency_key)
);

CREATE INDEX workflow_node_results_lookup_idx
  ON orchestrator.workflow_node_results (work_item_id, node, recorded_at DESC);
