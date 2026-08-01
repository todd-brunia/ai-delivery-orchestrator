ALTER TABLE orchestrator.outbox
  ADD COLUMN attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  ADD COLUMN claimed_by text,
  ADD COLUMN claim_expires_at timestamptz,
  ADD COLUMN last_error text,
  ADD CONSTRAINT outbox_claim_shape CHECK (
    (status = 'claimed' AND claimed_by IS NOT NULL AND claim_expires_at IS NOT NULL)
    OR (status <> 'claimed' AND claimed_by IS NULL AND claim_expires_at IS NULL)
  );

CREATE INDEX outbox_claim_recovery_idx
  ON orchestrator.outbox (claim_expires_at)
  WHERE status = 'claimed';
