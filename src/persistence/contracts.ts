import type {
  ConflictDomain,
  DependencyEdge,
  SprintRunEvent,
  SprintRunInput,
  SprintRunState,
  TransitionMetadata,
  WorkItemState,
  WorkItemEvent,
  ReconciliationReport,
  SchedulingDecision,
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

export interface WorkItemTransitionRequest {
  readonly workItemId: string;
  readonly event: WorkItemEvent;
  readonly metadata: TransitionMetadata;
  readonly outbox: OutboxAction;
}

export interface WorkItemTransitionResult {
  readonly workItem: PersistedWorkItem;
  readonly duplicate: boolean;
}

export interface WorkItemConflictAnalysis {
  readonly issueNumber: number;
  readonly domains: readonly ConflictDomain[];
}

export interface SprintAnalysis {
  readonly dependencies: readonly DependencyEdge[];
  readonly conflicts: readonly WorkItemConflictAnalysis[];
}

export interface PersistedSchedulingState extends SprintAnalysis {
  readonly workItems: readonly (PersistedWorkItem & { readonly conflictDomains: readonly ConflictDomain[] })[];
}

export interface PersistSchedulingRequest {
  readonly decision: SchedulingDecision;
  readonly reconciliation: ReconciliationReport;
  readonly expectedRunRevision: number;
}

export interface ClaimedOutboxAction extends OutboxAction {
  readonly attemptCount: number;
  readonly claimExpiresAt: string;
}

export interface GitHubMutationReceipt {
  readonly outboxId: string;
  readonly attempt: number;
  readonly operation: "set_labels" | "dispatch_workflow" | "submit_review" | "mark_ready_for_review";
  readonly actorRole: "builder" | "reviewer";
  readonly intentSha256: string;
  readonly outcome: "completed" | "retry" | "ambiguous";
  readonly requestId?: string;
  readonly errorClass?: string;
  readonly recordedAt: string;
}

export interface LeaseRequest {
  readonly aggregateType: "sprint_run" | "work_item";
  readonly aggregateId: string;
  readonly ownerId: string;
  readonly expiresAt: Date;
}

export interface CallbackCorrelation {
  readonly workItemId: string;
  readonly repository: string;
  readonly issueNodeId: string;
  readonly planningFingerprint: string;
  readonly automationMarker: string;
  readonly expectedBranch: string;
  readonly expectedBaseSha: string;
  readonly acceptedWorkflowRunId?: string;
  readonly pullRequestNodeId?: string;
  readonly pullRequestNumber?: number;
  readonly currentHeadSha?: string;
  readonly recordedAt: string;
}

export type CallbackDisposition = "pending" | "retrying" | "completed" | "ignored" | "blocked" | "dead_letter";

export interface CallbackResult {
  readonly deliveryId: string;
  readonly workItemId?: string;
  readonly semanticKey?: string;
  readonly disposition: CallbackDisposition;
  readonly reasonClass: string;
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly recordedAt: string;
}

export interface CommitCallbackResultRequest extends CallbackResult {
  readonly deliveryLeaseOwner: string;
  readonly workItemLeaseOwner?: string;
}

/** Immutable canonical evidence collected before feasibility or authorization may run. */
export interface PlanningBinding {
  readonly workItemId: string;
  readonly fingerprint: string;
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly observedAt: string;
}

export interface SavePlanningBindingRequest extends PlanningBinding {
  readonly expectedWorkItemRevision: number;
  readonly leaseOwnerId: string;
}

export interface PersistedPlanningBinding extends PlanningBinding {
  readonly workItemRevision: number;
  readonly createdAt: string;
}

export interface WorkflowNodeResult {
  readonly workItemId: string;
  readonly node: string;
  readonly idempotencyKey: string;
  readonly inputFingerprint: string;
  readonly output: Readonly<Record<string, unknown>>;
  readonly recordedAt: string;
}

export type DispatchAttemptStatus = "proposed" | "claimed" | "accepted" | "ambiguous" | "rejected" | "blocked";
export interface DispatchAttempt {
  readonly workItemId: string;
  readonly intentFingerprint: string;
  readonly status: DispatchAttemptStatus;
  readonly workflowRunId?: string;
  readonly evidenceUri?: string;
  readonly recordedAt: string;
}

export interface SprintRunRepository {
  createRun(id: string, input: SprintRunInput, now?: Date): Promise<PersistedSprintRun>;
  getRun(id: string): Promise<PersistedSprintRun | undefined>;
  transitionRun(request: RunTransitionRequest): Promise<RunTransitionResult>;
  transitionWorkItem(request: WorkItemTransitionRequest): Promise<WorkItemTransitionResult>;
  saveAnalysis(runId: string, analysis: SprintAnalysis): Promise<void>;
  listRunnableWorkItems(runId: string): Promise<readonly PersistedWorkItem[]>;
  loadSchedulingState?(runId: string): Promise<PersistedSchedulingState>;
  persistDryRunScheduling?(request: PersistSchedulingRequest): Promise<{ readonly duplicate: boolean }>;
  claimOutbox(ownerId: string, limit: number, expiresAt: Date, now?: Date, actionTypes?: readonly string[], actionIds?: readonly string[]): Promise<readonly ClaimedOutboxAction[]>;
  completeOutbox(id: string, ownerId: string, now?: Date): Promise<boolean>;
  retryOutbox(id: string, ownerId: string, error: string, now?: Date): Promise<boolean>;
  blockOutbox(id: string, ownerId: string, error: string, now?: Date): Promise<boolean>;
  recordGitHubMutationReceipt?(receipt: GitHubMutationReceipt): Promise<void>;
  savePlanningBinding?(request: SavePlanningBindingRequest, now?: Date): Promise<{ readonly binding: PersistedPlanningBinding; readonly duplicate: boolean }>;
  getPlanningBinding?(workItemId: string): Promise<PersistedPlanningBinding | undefined>;
  recordWorkflowNodeResult?(result: WorkflowNodeResult): Promise<{ readonly duplicate: boolean }>;
  getWorkflowNodeResult?(workItemId: string, node: string, idempotencyKey: string): Promise<WorkflowNodeResult | undefined>;
  recordDispatchAttempt?(attempt: DispatchAttempt): Promise<{ readonly duplicate: boolean }>;
  getDispatchAttempt?(workItemId: string, intentFingerprint: string): Promise<DispatchAttempt | undefined>;
  tryAcquireLease(request: LeaseRequest, now?: Date): Promise<boolean>;
  saveCallbackCorrelation?(correlation: CallbackCorrelation): Promise<{ readonly duplicate: boolean }>;
  getCallbackCorrelation?(workItemId: string): Promise<CallbackCorrelation | undefined>;
}

export class ConcurrencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConcurrencyError";
  }
}
