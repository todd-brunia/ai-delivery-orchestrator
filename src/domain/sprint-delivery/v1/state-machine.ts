import type {
  SprintRunEvent,
  SprintRunState,
  WorkItemEvent,
  WorkItemState,
} from "./contracts.js";

export class InvalidTransitionError extends Error {
  constructor(aggregate: "sprint_run" | "work_item", state: string, event: string) {
    super(`Invalid ${aggregate} transition: ${state} + ${event}`);
    this.name = "InvalidTransitionError";
  }
}

const terminalRunStates = new Set<SprintRunState>([
  "completed",
  "failed",
  "cancelled",
  "superseded",
]);

const terminalWorkItemStates = new Set<WorkItemState>([
  "merged",
  "failed",
  "cancelled",
  "superseded",
]);

const runTransitions: Partial<
  Record<SprintRunState, Partial<Record<SprintRunEvent["type"], SprintRunState>>>
> = {
  accepted: { plan_collection_started: "collecting_plans" },
  collecting_plans: { analysis_started: "analyzing", paused: "paused" },
  analyzing: {
    activated: "active",
    human_attention_required: "waiting_for_human",
    paused: "paused",
  },
  active: {
    human_attention_required: "waiting_for_human",
    paused: "paused",
    completed: "completed",
  },
  waiting_for_human: { activated: "active", paused: "paused" },
};

const workItemTransitions: Partial<
  Record<WorkItemState, Partial<Record<WorkItemEvent, WorkItemState>>>
> = {
  discovered: {
    plan_requested: "awaiting_plan",
    plan_available: "feasibility_review",
  },
  awaiting_plan: { plan_available: "feasibility_review" },
  feasibility_review: {
    human_plan_approval_required: "human_plan_approval_required",
    build_authorized: "ready_to_build",
  },
  human_plan_approval_required: { build_authorized: "ready_to_build" },
  ready_to_build: { build_dispatched: "build_dispatched" },
  build_dispatched: { build_started: "building" },
  building: { pull_request_opened: "pr_open" },
  pr_open: { checks_awaited: "checks_pending" },
  checks_pending: { review_started: "reviewing" },
  reviewing: {
    repair_requested: "fixing",
    human_review_ready: "ready_for_human_review",
  },
  fixing: { checks_awaited: "checks_pending" },
  ready_for_human_review: {
    checks_awaited: "checks_pending",
    merged: "merged",
  },
};

const recoveryRunEvents: Partial<Record<SprintRunEvent["type"], SprintRunState>> = {
  blocked: "blocked",
  failed: "failed",
  cancelled: "cancelled",
  superseded: "superseded",
};

const recoveryWorkItemEvents: Partial<Record<WorkItemEvent, WorkItemState>> = {
  blocked: "blocked",
  failed: "failed",
  cancelled: "cancelled",
  superseded: "superseded",
};

export function transitionSprintRun(
  current: SprintRunState,
  event: SprintRunEvent,
): SprintRunState {
  if (event.type === "reconciled") return current;

  if (event.type === "resumed") {
    if (current !== "paused") {
      throw new InvalidTransitionError("sprint_run", current, event.type);
    }
    return event.target;
  }

  if (!terminalRunStates.has(current)) {
    const recovery = recoveryRunEvents[event.type];
    if (recovery) return recovery;
  }

  const next = runTransitions[current]?.[event.type];
  if (!next) throw new InvalidTransitionError("sprint_run", current, event.type);
  return next;
}

export function transitionWorkItem(
  current: WorkItemState,
  event: WorkItemEvent,
): WorkItemState {
  if (!terminalWorkItemStates.has(current)) {
    const recovery = recoveryWorkItemEvents[event];
    if (recovery) return recovery;
  }

  const next = workItemTransitions[current]?.[event];
  if (!next) throw new InvalidTransitionError("work_item", current, event);
  return next;
}
