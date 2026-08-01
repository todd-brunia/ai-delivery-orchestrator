CREATE TABLE orchestrator.github_webhook_inbox (
  delivery_id uuid PRIMARY KEY,
  event_name text NOT NULL,
  action text NOT NULL,
  hook_id bigint NOT NULL CHECK (hook_id > 0),
  installation_id bigint NOT NULL CHECK (installation_id > 0),
  repository text,
  sender_login text NOT NULL,
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
  normalized_event jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'claimed', 'completed', 'dead_letter')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  claimed_by text,
  claim_expires_at timestamptz,
  last_error text,
  received_at timestamptz NOT NULL,
  completed_at timestamptz,
  dead_lettered_at timestamptz,
  CHECK ((status = 'claimed' AND claimed_by IS NOT NULL AND claim_expires_at IS NOT NULL)
    OR (status <> 'claimed' AND claimed_by IS NULL AND claim_expires_at IS NULL))
);

CREATE INDEX github_webhook_inbox_claim_idx
  ON orchestrator.github_webhook_inbox (received_at)
  WHERE status IN ('pending', 'claimed');
