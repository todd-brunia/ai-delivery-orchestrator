ALTER TABLE orchestrator.sprint_runs
  ADD CONSTRAINT sprint_runs_state_v1_check CHECK (state IN (
    'accepted', 'collecting_plans', 'analyzing', 'active', 'waiting_for_human',
    'paused', 'completed', 'blocked', 'failed', 'cancelled', 'superseded'
  ));

ALTER TABLE orchestrator.work_items
  ADD CONSTRAINT work_items_state_v1_check CHECK (state IN (
    'discovered', 'awaiting_plan', 'feasibility_review',
    'human_plan_approval_required', 'ready_to_build', 'build_dispatched',
    'building', 'pr_open', 'checks_pending', 'reviewing', 'fixing',
    'ready_for_human_review', 'merged', 'blocked', 'failed', 'cancelled',
    'superseded'
  ));

CREATE FUNCTION orchestrator.reject_sprint_run_identity_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.workflow_version IS DISTINCT FROM OLD.workflow_version
    OR NEW.repository IS DISTINCT FROM OLD.repository
    OR NEW.issue_numbers IS DISTINCT FROM OLD.issue_numbers
    OR NEW.merge_policy IS DISTINCT FROM OLD.merge_policy THEN
    RAISE EXCEPTION 'sprint run identity is immutable' USING ERRCODE = '23000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER sprint_run_identity_immutable
BEFORE UPDATE ON orchestrator.sprint_runs
FOR EACH ROW EXECUTE FUNCTION orchestrator.reject_sprint_run_identity_change();
