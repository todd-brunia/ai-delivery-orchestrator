export interface IdleObservation {
  readonly observedAt: Date;
  readonly wakeGeneration: number;
  readonly commandDepth: number;
  readonly callbackDepth: number;
  readonly pendingOutbox: number;
  readonly activeLeases: number;
  readonly runnableWork: number;
}

const isIdle = (value: IdleObservation) =>
  value.commandDepth === 0 && value.callbackDepth === 0 && value.pendingOutbox === 0 &&
  value.activeLeases === 0 && value.runnableWork === 0;

export function mayScaleToZero(first: IdleObservation, second: IdleObservation): boolean {
  return isIdle(first) && isIdle(second) &&
    first.wakeGeneration === second.wakeGeneration &&
    second.observedAt.getTime() > first.observedAt.getTime();
}

export class DrainController {
  #draining = false;
  begin(): void { this.#draining = true; }
  mayClaim(): boolean { return !this.#draining; }
  get draining(): boolean { return this.#draining; }
}
