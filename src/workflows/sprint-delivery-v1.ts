import { createHash } from "node:crypto";

import { Annotation, END, START, StateGraph, type BaseCheckpointSaver } from "@langchain/langgraph";

import { planApprovalRequirement, ReconciliationReportSchema, scheduleDryRun, WORKFLOW_VERSION, type ReconciliationReport, type SchedulingDecision } from "../domain/sprint-delivery/v1/index.js";
import type { PersistedSprintRun, SprintRunRepository } from "../persistence/index.js";
import {
  CanonicalIssueSchema,
  CanonicalPlanSchema,
  FeasibilityResultSchema,
  PROVIDER_CONTRACT_VERSION,
  type FeasibilityResult,
  type ProviderSet,
  type CanonicalIssue,
} from "../providers/v1/index.js";
import {
  DryRunWorkflowRequestSchema,
  DryRunWorkflowResultSchema,
  type DryRunWorkflowRequest,
  type DryRunWorkflowResult,
  type DryRunWorkflowRuntime,
} from "./contracts.js";

const GraphState = Annotation.Root({
  request: Annotation<DryRunWorkflowRequest>,
  run: Annotation<PersistedSprintRun>,
  issues: Annotation<readonly CanonicalIssue[]>,
  plans: Annotation<Readonly<Record<string, string>>>,
  analysis: Annotation<FeasibilityResult>,
  schedule: Annotation<SchedulingDecision>,
  reconciliation: Annotation<ReconciliationReport>,
  result: Annotation<DryRunWorkflowResult>,
});

export type DryRunNodeName = "load_run" | "collect_issues" | "analyze" | "persist_analysis" | "compute_schedule" | "reconcile_issues" | "save_schedule";

export interface SprintDeliveryGraphOptions {
  readonly interruptAfter?: readonly DryRunNodeName[];
}

function deterministicUuid(scope: string): string {
  const hex = createHash("sha256").update(scope).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function transitionIdentity(runId: string, aggregateId: string, event: string) {
  const scope = `${WORKFLOW_VERSION}:${runId}:${aggregateId}:${event}`;
  return {
    transitionId: deterministicUuid(`${scope}:transition`),
    transitionKey: `workflow:${scope}:transition`,
    outboxId: deterministicUuid(`${scope}:outbox`),
    outboxKey: `workflow:${scope}:outbox`,
  };
}

function evidence(issueNumbers: readonly number[]) {
  return issueNumbers.map((issueNumber) => ({
    kind: "issue" as const,
    uri: `github://issue/${issueNumber}`,
  }));
}

export function createSprintDeliveryV1Runtime(
  repository: SprintRunRepository,
  providers: ProviderSet,
  checkpointer: BaseCheckpointSaver,
  options: SprintDeliveryGraphOptions = {},
): DryRunWorkflowRuntime {
  const graph = new StateGraph(GraphState)
    .addNode("load_run", async (state) => {
      const request = DryRunWorkflowRequestSchema.parse(state.request);
      const run = await repository.getRun(request.runId);
      if (!run) throw new Error(`sprint run not found: ${request.runId}`);
      if (run.input.workflowVersion !== WORKFLOW_VERSION) throw new Error("unsupported workflow version");
      const expectedKeys = run.input.issueNumbers.map(String).sort();
      const actualKeys = Object.keys(request.planFingerprints).sort();
      if (JSON.stringify(expectedKeys) !== JSON.stringify(actualKeys)) throw new Error("plan fingerprints must exactly match the immutable issue list");
      return { run };
    })
    .addNode("collect_issues", async (state) => {
      const issues = await Promise.all(state.run.input.issueNumbers.map((number) =>
        providers.githubRead.getIssue(state.run.input.repository, number)));
      if (issues.some((issue) => issue.state !== "open")) throw new Error("all workflow issues must be open");
      const parsedIssues = issues.map((issue) => CanonicalIssueSchema.parse(issue));
      const plans = await Promise.all(state.run.input.issueNumbers.map((number) =>
        providers.githubRead.getMarkedPlan(state.run.input.repository, number)));
      const planFingerprints: Record<string, string> = {};
      for (const rawPlan of plans) {
        const plan = CanonicalPlanSchema.parse(rawPlan);
        const expected = state.request.planFingerprints[String(plan.issueNumber)];
        if (!expected || expected !== plan.bodySha256) {
          throw new Error(`canonical marked plan drifted for issue ${plan.issueNumber}`);
        }
        planFingerprints[String(plan.issueNumber)] = plan.bodySha256;
      }
      if (Object.keys(planFingerprints).length !== state.run.input.issueNumbers.length) throw new Error("canonical marked plans must cover every workflow issue");
      return { issues: parsedIssues, plans: planFingerprints };
    })
    .addNode("analyze", async (state) => {
      const analysis = await providers.modelAnalysis.analyzeFeasibility({
        version: PROVIDER_CONTRACT_VERSION,
        repository: state.run.input.repository,
        issueNumbers: state.run.input.issueNumbers,
        planFingerprints: state.plans,
        defaultBranchSha: state.request.defaultBranchSha,
      });
      const parsed = FeasibilityResultSchema.parse(analysis);
      const analyzedIssues = new Set(parsed.conflicts.map((entry) => entry.issueNumber));
      if (parsed.conflicts.length !== state.run.input.issueNumbers.length ||
          state.run.input.issueNumbers.some((number) => !analyzedIssues.has(number))) {
        throw new Error("conflict analysis must cover every workflow issue exactly once");
      }
      return { analysis: parsed };
    })
    .addNode("persist_analysis", async (state) => {
      const { request, analysis } = state;
      if (!analysis.feasible || analysis.unresolvedDecisions.length > 0) {
        throw new Error("feasibility analysis did not authorize workflow progress");
      }
      await repository.saveAnalysis(request.runId, {
        dependencies: analysis.dependencies,
        conflicts: analysis.conflicts,
      });

      let run = await repository.getRun(request.runId);
      if (!run) throw new Error(`sprint run not found: ${request.runId}`);
      const runSteps = [
        { from: "accepted", event: { type: "plan_collection_started" as const }, name: "plan_collection_started" },
        { from: "collecting_plans", event: { type: "analysis_started" as const }, name: "analysis_started" },
      ];
      for (const step of runSteps) {
        if (run.state !== step.from) continue;
        const identity = transitionIdentity(run.id, run.id, step.name);
        const transitioned = await repository.transitionRun({
          runId: run.id,
          event: step.event,
          metadata: {
            transitionId: identity.transitionId,
            aggregateId: run.id,
            expectedRevision: run.revision,
            idempotencyKey: identity.transitionKey,
            occurredAt: request.occurredAt,
            actor: { kind: "system", id: WORKFLOW_VERSION },
            evidence: evidence(run.input.issueNumbers),
          },
          outbox: {
            id: identity.outboxId,
            type: "projection.update",
            payload: { runId: run.id, event: step.name },
            idempotencyKey: identity.outboxKey,
          },
        });
        run = transitioned.run;
      }

      const approval = planApprovalRequirement(analysis.risk);
      for (const initialItem of run.workItems) {
        let item = (await repository.getRun(run.id))?.workItems.find(({ id }) => id === initialItem.id);
        if (!item) throw new Error(`work item not found: ${initialItem.id}`);
        const events: Array<"plan_available" | "human_plan_approval_required" | "build_authorized"> = [];
        if (item.state === "discovered") events.push("plan_available");
        if (item.state === "discovered" || item.state === "feasibility_review") {
          events.push(approval === "human_required" ? "human_plan_approval_required" : "build_authorized");
        }
        for (const event of events) {
          const identity = transitionIdentity(run.id, item.id, event);
          const transitioned = await repository.transitionWorkItem({
            workItemId: item.id,
            event,
            metadata: {
              transitionId: identity.transitionId,
              aggregateId: item.id,
              expectedRevision: item.revision,
              idempotencyKey: identity.transitionKey,
              occurredAt: request.occurredAt,
              actor: { kind: "system", id: WORKFLOW_VERSION },
              evidence: evidence([item.issueNumber]),
            },
            outbox: {
              id: identity.outboxId,
              type: "github.mutation.proposed",
              payload: {
                version: PROVIDER_CONTRACT_VERSION,
                repository: run.input.repository,
                issueNumber: item.issueNumber,
                type: "set_labels",
                labels: [event === "build_authorized"
                  ? "approved-for-build"
                  : event === "human_plan_approval_required"
                    ? "human-plan-review-required"
                    : "feasibility-review"],
              },
              idempotencyKey: identity.outboxKey,
            },
          });
          item = transitioned.workItem;
        }
      }

      run = await repository.getRun(run.id);
      if (!run) throw new Error(`sprint run not found: ${request.runId}`);
      const finalEvent = approval === "human_required"
        ? { type: "human_attention_required" as const }
        : { type: "activated" as const };
      if (run.state === "analyzing") {
        const identity = transitionIdentity(run.id, run.id, finalEvent.type);
        run = (await repository.transitionRun({
          runId: run.id,
          event: finalEvent,
          metadata: {
            transitionId: identity.transitionId,
            aggregateId: run.id,
            expectedRevision: run.revision,
            idempotencyKey: identity.transitionKey,
            occurredAt: request.occurredAt,
            actor: { kind: "system", id: WORKFLOW_VERSION },
            evidence: evidence(run.input.issueNumbers),
          },
          outbox: {
            id: identity.outboxId,
            type: "projection.update",
            payload: { runId: run.id, event: finalEvent.type },
            idempotencyKey: identity.outboxKey,
          },
        })).run;
      }
      return { run };
    })
    .addNode("compute_schedule", async (state) => {
      const persisted = state.run.state === "active" && repository.loadSchedulingState
        ? await repository.loadSchedulingState(state.run.id)
        : undefined;
      const workItems = persisted?.workItems ?? state.run.workItems.map((item) => ({
        ...item,
        conflictDomains: state.analysis.conflicts.find(({ issueNumber }) => issueNumber === item.issueNumber)?.domains ?? [],
      }));
      const activeImplementationCount = workItems.filter(({ state: itemState }) => ["build_dispatched", "building", "pr_open", "checks_pending", "reviewing", "fixing", "ready_for_human_review"].includes(itemState)).length;
      return { schedule: scheduleDryRun({
        runId: state.run.id,
        candidates: workItems.filter(({ state: itemState }) => itemState === "ready_to_build"),
        dependencies: persisted?.dependencies ?? state.analysis.dependencies,
        mergedIssueNumbers: workItems.filter(({ state: itemState }) => itemState === "merged").map(({ issueNumber }) => issueNumber),
        activeImplementationCount,
        evidence: evidence(state.run.input.issueNumbers),
      }) };
    })
    .addNode("reconcile_issues", async (state) => {
      const selected = new Set(state.schedule.selectedIssueNumbers);
      const drift: Array<{ issueNumber: number; field: "identity" | "state" | "labels" | "updated_at" | "plan_fingerprint"; severity: "informational" | "invalidating"; expected: string; observed: string }> = [];
      for (const original of state.issues.filter(({ number }) => selected.has(number))) {
        const current = CanonicalIssueSchema.parse(await providers.githubRead.getIssue(state.run.input.repository, original.number));
        if (current.nodeId !== original.nodeId || current.repository !== original.repository || current.number !== original.number) drift.push({ issueNumber: original.number, field: "identity", severity: "invalidating", expected: `${original.repository}#${original.number}:${original.nodeId}`, observed: `${current.repository}#${current.number}:${current.nodeId}` });
        if (current.state !== original.state || current.state !== "open") drift.push({ issueNumber: original.number, field: "state", severity: "invalidating", expected: "open", observed: current.state });
        if (JSON.stringify([...current.labels].sort()) !== JSON.stringify([...original.labels].sort())) drift.push({ issueNumber: original.number, field: "labels", severity: "invalidating", expected: JSON.stringify([...original.labels].sort()), observed: JSON.stringify([...current.labels].sort()) });
        if (current.updatedAt !== original.updatedAt) drift.push({ issueNumber: original.number, field: "updated_at", severity: "invalidating", expected: original.updatedAt, observed: current.updatedAt });
        const currentPlan = CanonicalPlanSchema.parse(await providers.githubRead.getMarkedPlan(state.run.input.repository, original.number));
        const originalPlan = state.plans[String(original.number)];
        if (currentPlan.bodySha256 !== originalPlan) drift.push({ issueNumber: original.number, field: "plan_fingerprint", severity: "invalidating", expected: originalPlan ?? "missing", observed: currentPlan.bodySha256 });
      }
      const reconciliation = ReconciliationReportSchema.parse({
        version: "reconciliation-report/v1", workflowVersion: WORKFLOW_VERSION,
        providerContractVersion: PROVIDER_CONTRACT_VERSION, policyVersion: "dry-run-scheduling/v1",
        runId: state.run.id, reconciledAt: state.request.occurredAt, drift,
        valid: !drift.some(({ severity }) => severity === "invalidating"), evidence: evidence(state.schedule.selectedIssueNumbers.length > 0 ? state.schedule.selectedIssueNumbers : state.run.input.issueNumbers),
      });
      if (!reconciliation.valid) throw new Error("canonical issue drift invalidated scheduling");
      return { reconciliation };
    })
    .addNode("save_schedule", async (state) => {
      if (repository.persistDryRunScheduling) {
        const ownerId = `scheduler:${state.request.threadId}`;
        const occurredAt = new Date(state.request.occurredAt);
        const acquired = await repository.tryAcquireLease({ aggregateType: "sprint_run", aggregateId: state.run.id, ownerId, expiresAt: new Date(occurredAt.getTime() + 60_000) }, occurredAt);
        if (!acquired) throw new Error("scheduler lease contention");
        await repository.persistDryRunScheduling({ decision: state.schedule, reconciliation: state.reconciliation, expectedRunRevision: state.run.revision });
      }
      return { result: DryRunWorkflowResultSchema.parse({ workflowVersion: WORKFLOW_VERSION, providerContractVersion: PROVIDER_CONTRACT_VERSION,
        runId: state.run.id, threadId: state.request.threadId, status: state.run.state, issueNumbers: state.run.input.issueNumbers,
        analysis: state.analysis, schedule: state.schedule, reconciliation: state.reconciliation }) };
    })
    .addEdge(START, "load_run")
    .addEdge("load_run", "collect_issues")
    .addEdge("collect_issues", "analyze")
    .addEdge("analyze", "persist_analysis")
    .addEdge("persist_analysis", "compute_schedule")
    .addEdge("compute_schedule", "reconcile_issues")
    .addEdge("reconcile_issues", "save_schedule")
    .addEdge("save_schedule", END)
    .compile({
      checkpointer,
      ...(options.interruptAfter ? { interruptAfter: [...options.interruptAfter] } : {}),
    });

  async function invoke(input: Partial<typeof GraphState.State> | null, threadId: string) {
    const output = await graph.invoke(input, { configurable: { thread_id: threadId } });
    if (!output.result) throw new Error("workflow interrupted before producing a result");
    return DryRunWorkflowResultSchema.parse(output.result);
  }

  return {
    execute: async (raw) => {
      const request = DryRunWorkflowRequestSchema.parse(raw);
      return invoke({ request }, request.threadId);
    },
    resume: async (threadId) => invoke(null, threadId),
  };
}
