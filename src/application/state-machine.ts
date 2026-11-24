import type { ApplicationStateStore } from "../storage/contracts.js";

export type ApplicationStage =
  | "discovered"
  | "validated"
  | "matched"
  | "tailored"
  | "rendered"
  | "applying"
  | "submit-claimed"
  | "submission-uncertain"
  | "waiting-human"
  | "submitted"
  | "blocked"
  | "skipped";

const nextStages: Record<ApplicationStage, ReadonlySet<ApplicationStage>> = {
  discovered: new Set(["validated", "skipped"]),
  validated: new Set(["matched", "skipped"]),
  matched: new Set(["tailored", "skipped"]),
  tailored: new Set(["rendered", "blocked"]),
  rendered: new Set(["applying", "blocked"]),
  applying: new Set(["waiting-human", "submit-claimed", "blocked"]),
  "submit-claimed": new Set(["submitted", "submission-uncertain"]),
  "submission-uncertain": new Set(["submitted"]),
  "waiting-human": new Set(["applying", "blocked"]),
  submitted: new Set(),
  blocked: new Set(["rendered", "applying", "skipped"]),
  skipped: new Set(),
};

export interface ApplicationCheckpoint {
  jobId: string;
  officialUrl: string;
  stage: ApplicationStage;
  artifactPath?: string;
  confirmation?: string;
  blocker?: string;
  updatedAt: string;
}

export class ApplicationWorkflow {
  constructor(private readonly store: ApplicationStateStore<ApplicationCheckpoint>) {}

  async create(jobId: string, officialUrl: string): Promise<ApplicationCheckpoint> {
    const checkpoint: ApplicationCheckpoint = {
      jobId, officialUrl, stage: "discovered", updatedAt: new Date().toISOString(),
    };
    const version = await this.store.compareAndSwap(jobId, undefined, checkpoint);
    if (!version) throw new Error(`Application ${jobId} already exists`);
    return checkpoint;
  }

  async advance(
    jobId: string,
    stage: ApplicationStage,
    details: Pick<ApplicationCheckpoint, "artifactPath" | "confirmation" | "blocker"> = {},
  ): Promise<ApplicationCheckpoint> {
    const current = await this.store.read(jobId);
    if (!current) throw new Error(`Application ${jobId} does not exist`);
    if (!nextStages[current.state.stage].has(stage)) {
      throw new Error(`Invalid application transition ${current.state.stage} -> ${stage}`);
    }
    if (stage === "applying" && !current.state.artifactPath) {
      throw new Error("A verified resume artifact is required before applying");
    }
    if (details.confirmation && stage !== "submitted") {
      throw new Error("Employer confirmation belongs only to a submitted application");
    }
    if (details.artifactPath && stage !== "rendered") {
      throw new Error("Resume artifact changes require a rendered checkpoint");
    }
    if (stage === "submitted" && !details.confirmation) {
      throw new Error("Submission requires an employer confirmation");
    }
    if (stage === "rendered" && !details.artifactPath) {
      throw new Error("A verified resume artifact is required before applying");
    }
    if ((stage === "blocked" || stage === "waiting-human" || stage === "submission-uncertain") && !details.blocker) {
      throw new Error("A blocked application needs an exact reason");
    }
    const checkpoint: ApplicationCheckpoint = {
      ...current.state,
      ...details,
      stage,
      updatedAt: new Date().toISOString(),
    };
    if (stage === "applying") delete checkpoint.blocker;
    if (!await this.store.compareAndSwap(jobId, current.version, checkpoint)) {
      throw new Error("Application changed concurrently; reload before continuing");
    }
    return checkpoint;
  }
}
