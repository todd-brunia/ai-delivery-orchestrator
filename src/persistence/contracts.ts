import type {
  SprintRunEvent,
  SprintRunInput,
  SprintRunState,
  TransitionMetadata,
  WorkItemState,
} from "../domain/sprint-delivery/v1/index.js";

export interface PersistedWorkItem {
  readonly id: string;
  readonly issueNumber: number;
  readonly state: WorkItemState;
  readonly revision: number;
}

export interface PersistedSprintRun {
  readonly id: string;
  readonly input: SprintRunInput;
  readonly state: SprintRunState;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly workItems: readonly PersistedWorkItem[];
}

export interface OutboxAction {
  readonly id: string;
  readonly type: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly idempotencyKey: string;
}

export interface RunTransitionRequest {
  readonly runId: string;
  readonly event: SprintRunEvent;
  readonly metadata: TransitionMetadata;
  readonly outbox: OutboxAction;
}

export interface RunTransitionResult {
  readonly run: PersistedSprintRun;
  readonly duplicate: boolean;
}

export interface LeaseRequest {
  readonly aggregateType: "sprint_run" | "work_item";
  readonly aggregateId: string;
  readonly ownerId: string;
  readonly expiresAt: Date;
}

export interface SprintRunRepository {
  createRun(id: string, input: SprintRunInput, now?: Date): Promise<PersistedSprintRun>;
  getRun(id: string): Promise<PersistedSprintRun | undefined>;
  transitionRun(request: RunTransitionRequest): Promise<RunTransitionResult>;
  tryAcquireLease(request: LeaseRequest, now?: Date): Promise<boolean>;
}

export class ConcurrencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConcurrencyError";
  }
}
