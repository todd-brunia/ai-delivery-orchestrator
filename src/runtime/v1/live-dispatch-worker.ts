import type { GitHubMutationOutboxConsumer } from "../../providers/v1/index.js";
import type { RuntimeGenerationControl } from "./queue-consumer.js";

/** Bounded worker facade: drain prevents every new mutation-outbox claim. */
export class LiveDispatchWorker {
  constructor(private readonly control: RuntimeGenerationControl, private readonly consumer: GitHubMutationOutboxConsumer) {}

  async drainOnce(limit = 10): Promise<readonly { id: string; outcome: "completed" | "retry" | "blocked" }[]> {
    if (!this.control.mayClaim) return [];
    return this.consumer.consume(limit);
  }
}
