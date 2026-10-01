import type { MaterialFailure, MaterialResult, ScenarioStepInput, ScenarioStopReason } from "../../../../shared/contracts";

export interface ScenarioStepPort {
  addStep(materialId: string, step: ScenarioStepInput): Promise<MaterialResult>;
  stop(materialId: string, reason: ScenarioStopReason): Promise<MaterialResult>;
  finishing(materialId: string): void;
  problem(reason: MaterialFailure): void;
}

export class ScenarioStepQueue {
  readonly materialId: string;
  private readonly port: ScenarioStepPort;
  private tail: Promise<void> = Promise.resolve();
  private closed = false;
  private finished: Promise<void> | null = null;

  constructor(materialId: string, port: ScenarioStepPort) {
    this.materialId = materialId;
    this.port = port;
  }

  get finishing(): boolean {
    return this.finished !== null;
  }

  enqueue(step: () => Promise<ScenarioStepInput | null>): Promise<boolean> {
    if (this.finished) return Promise.resolve(false);
    const saved = this.tail.then(() => this.save(step));
    this.tail = saved.then(() => undefined);
    return saved;
  }

  finish(reason: ScenarioStopReason): Promise<void> {
    if (this.finished) return this.finished;
    this.finished = this.tail.then(async () => {
      const result = await this.port.stop(this.materialId, reason);
      if (!result.ok && result.reason !== "unavailable") this.port.problem(result.reason);
    }).catch(() => this.port.problem("unreadable"));
    this.port.finishing(this.materialId);
    return this.finished;
  }

  private async save(step: () => Promise<ScenarioStepInput | null>): Promise<boolean> {
    if (this.closed) return false;
    try {
      const input = await step();
      if (!input) return false;
      const result = await this.port.addStep(this.materialId, input);
      if (result.ok) return true;
      if (result.reason === "quota" || result.reason === "unavailable") {
        this.closed = true;
        void this.finish(result.reason === "quota" ? "limit" : "stopped");
      } else {
        this.port.problem(result.reason);
      }
    } catch {
      this.port.problem("unreadable");
    }
    return false;
  }
}
