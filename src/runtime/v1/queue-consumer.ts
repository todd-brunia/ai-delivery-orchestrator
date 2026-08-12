export interface QueueDelivery {
  readonly deliveryId: string;
  readonly body: unknown;
  readonly receiveCount: number;
}
export interface QueueDisposition {
  complete(deliveryId: string): Promise<void>;
  retry(deliveryId: string, category: string): Promise<void>;
  deadLetter(deliveryId: string, evidence: { category: string; receiveCount: number }): Promise<void>;
}

export class BoundedQueueConsumer {
  constructor(private readonly maxReceiveCount = 5) {}
  async consume(delivery: QueueDelivery, process: (body: unknown) => Promise<void>, disposition: QueueDisposition): Promise<"completed" | "retry" | "dead_letter"> {
    try {
      await process(delivery.body);
      await disposition.complete(delivery.deliveryId);
      return "completed";
    } catch (error) {
      const category = error instanceof Error && error.name === "ZodError" ? "invalid_contract" : "processing_failed";
      if (delivery.receiveCount >= this.maxReceiveCount) {
        await disposition.deadLetter(delivery.deliveryId, { category, receiveCount: delivery.receiveCount });
        return "dead_letter";
      }
      await disposition.retry(delivery.deliveryId, category);
      return "retry";
    }
  }
}

export class RuntimeGenerationControl {
  #generation = 0;
  #draining = false;
  get generation(): number { return this.#generation; }
  get mayClaim(): boolean { return !this.#draining; }
  wake(expectedGeneration: number): number {
    if (expectedGeneration !== this.#generation) throw new Error("stale wake generation");
    this.#draining = false;
    return ++this.#generation;
  }
  drain(expectedGeneration: number): number {
    if (expectedGeneration !== this.#generation) throw new Error("stale drain generation");
    this.#draining = true;
    return this.#generation;
  }
}
