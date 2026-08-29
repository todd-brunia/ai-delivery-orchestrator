ALTER TABLE orchestrator.work_items
  DROP CONSTRAINT work_items_state_v1_check;

ALTER TABLE orchestrator.work_items
  ADD CONSTRAINT work_items_state_v1_check CHECK (state IN (
    'discovered', 'awaiting_plan', 'feasibility_review',
    'human_plan_approval_required', 'ready_to_build', 'dispatch_queued',
    'build_dispatched', 'building', 'pr_open', 'checks_pending', 'reviewing',
    'fixing', 'ready_for_human_review', 'merged', 'blocked', 'failed',
    'cancelled', 'superseded'
  ));
