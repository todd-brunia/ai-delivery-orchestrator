import type { SprintRunRepository } from "../persistence/index.js";
import type { GitHubExecutionIntent, GitHubReadPort } from "../providers/v1/index.js";
import { advanceAcceptedImplementationDispatch } from "./dispatch-transition.js";

export interface DispatchAcceptanceHandler {
  reconcile(intent: GitHubExecutionIntent, completedAt: string): Promise<void>;
}

/** Rechecks GitHub after a completed mutation receipt; transport success alone is never acceptance. */
export function createDispatchAcceptanceHandler(repository: SprintRunRepository, github: GitHubReadPort): DispatchAcceptanceHandler {
  return {
    async reconcile(intent, completedAt) {
      if (intent.type !== "dispatch_workflow" || intent.actorRole !== "builder") return;
      const runId = intent.inputs.run_id;
      const workItemId = intent.inputs.work_item_id;
      if (!runId || !workItemId) throw new Error("implementation dispatch intent is missing its run identity");
      const run = await repository.getRun(runId);
      const workItem = run?.workItems.find((item) => item.id === workItemId && item.issueNumber === intent.issueNumber);
      if (!workItem) throw new Error("implementation dispatch work item is unavailable");
      const workflowRuns = await github.getWorkflowRuns(intent.repository, intent.ref);
      await advanceAcceptedImplementationDispatch({ repository, workItem, intent, acceptedAt: completedAt, workflowRuns });
    },
  };
}
