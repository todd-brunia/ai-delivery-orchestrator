ALTER TABLE orchestrator.sprint_runs
  DROP CONSTRAINT sprint_runs_merge_policy_check;

ALTER TABLE orchestrator.sprint_runs
  ADD COLUMN run_authorization jsonb,
  ADD COLUMN authorization_fingerprint text;

ALTER TABLE orchestrator.sprint_runs
  ADD CONSTRAINT sprint_runs_merge_policy_check
    CHECK (merge_policy IN ('human', 'automatic')),
  ADD CONSTRAINT sprint_runs_authorization_mode_check CHECK (
    (merge_policy = 'human' AND run_authorization IS NULL AND authorization_fingerprint IS NULL)
    OR
    (merge_policy = 'automatic' AND run_authorization IS NOT NULL AND
      authorization_fingerprint ~ '^[a-f0-9]{64}$')
  ),
  ADD CONSTRAINT sprint_runs_authorization_fingerprint_unique
    UNIQUE (authorization_fingerprint),
  DROP CONSTRAINT sprint_runs_state_v1_check,
  ADD CONSTRAINT sprint_runs_state_v1_check CHECK (state IN (
    'accepted', 'collecting_plans', 'analyzing', 'active', 'waiting_for_human',
    'paused', 'completed', 'blocked', 'failed', 'cancelled', 'superseded'
  ));

ALTER TABLE orchestrator.work_items
  DROP CONSTRAINT work_items_state_v1_check,
  ADD CONSTRAINT work_items_state_v1_check CHECK (state IN (
    'discovered', 'awaiting_plan', 'feasibility_review',
    'human_plan_approval_required', 'ready_to_build', 'build_dispatched',
    'building', 'pr_open', 'checks_pending', 'reviewing', 'fixing',
    'ready_for_human_review', 'exact_head_captured',
    'automatic_merge_policy_check', 'ready_for_merger', 'merge_requested',
    'merged', 'blocked', 'failed', 'cancelled', 'superseded'
  ));

CREATE OR REPLACE FUNCTION orchestrator.reject_sprint_run_identity_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.workflow_version IS DISTINCT FROM OLD.workflow_version
    OR NEW.repository IS DISTINCT FROM OLD.repository
    OR NEW.issue_numbers IS DISTINCT FROM OLD.issue_numbers
    OR NEW.merge_policy IS DISTINCT FROM OLD.merge_policy
    OR NEW.run_authorization IS DISTINCT FROM OLD.run_authorization
    OR NEW.authorization_fingerprint IS DISTINCT FROM OLD.authorization_fingerprint THEN
    RAISE EXCEPTION 'sprint run identity and authorization are immutable'
      USING ERRCODE = '23000';
  END IF;
  RETURN NEW;
END;
$$;
