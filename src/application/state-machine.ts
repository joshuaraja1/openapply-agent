import { randomUUID } from "node:crypto";
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
  applying: new Set(["waiting-human", "submit-claimed", "submitted", "blocked"]),
  "submit-claimed": new Set(["submitted", "submission-uncertain"]),
  "submission-uncertain": new Set(["submitted"]),
  "waiting-human": new Set(["applying", "submitted", "blocked"]),
  submitted: new Set(),
  blocked: new Set(["rendered", "applying", "skipped"]),
  skipped: new Set(),
};

export interface ApplicationCheckpoint {
  jobId: string;
  officialUrl: string;
  stage: ApplicationStage;
  artifactPath?: string;
  artifactSha256?: string;
  sourceFingerprint?: string;
  confirmation?: string;
  blocker?: string;
  browserPageId?: number;
  browserPageUrl?: string;
  browserGroupId?: string;
  browserEndpoint?: string;
  resumeUploaded?: boolean;
  packagePath?: string;
  handoffId?: string;
  desktopNotifiedFor?: string;
  emailNotifiedFor?: string;
  updatedAt: string;
}

/** An uncertain final click is a new alert even if an earlier human handoff was notified. */
export function notificationIdentity(checkpoint: ApplicationCheckpoint): string {
  return checkpoint.stage === "submission-uncertain"
    ? `submission-uncertain:${checkpoint.updatedAt}`
    : checkpoint.handoffId ?? checkpoint.updatedAt;
}

export class ApplicationWorkflow {
  constructor(private readonly store: ApplicationStateStore<ApplicationCheckpoint>) {}

  async current(jobId: string): Promise<ApplicationCheckpoint | undefined> {
    return (await this.store.read(jobId))?.state;
  }

  /** Record delivery without changing the application stage or handoff identity. */
  async markNotification(jobId: string, channel: "desktop" | "email",
    expectedHandoffId: string, deliveryMarker = expectedHandoffId): Promise<ApplicationCheckpoint> {
    const current = await this.store.read(jobId);
    if (!current || !["waiting-human", "submission-uncertain"].includes(current.state.stage)
      || notificationIdentity(current.state) !== expectedHandoffId) {
      throw new Error("Notification belongs to a different handoff checkpoint");
    }
    const field = channel === "desktop" ? "desktopNotifiedFor" : "emailNotifiedFor";
    if (current.state[field] === deliveryMarker) return current.state;
    const checkpoint = { ...current.state, [field]: deliveryMarker };
    if (!await this.store.compareAndSwap(jobId, current.version, checkpoint)) {
      throw new Error("Notification checkpoint changed concurrently");
    }
    return checkpoint;
  }

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
    details: Pick<ApplicationCheckpoint, "artifactPath" | "artifactSha256" | "sourceFingerprint" | "confirmation" | "blocker" | "browserPageId" | "browserPageUrl" | "browserGroupId" | "browserEndpoint" | "resumeUploaded" | "packagePath"> = {},
  ): Promise<ApplicationCheckpoint> {
    const current = await this.store.read(jobId);
    if (!current) throw new Error(`Application ${jobId} does not exist`);
    if (!nextStages[current.state.stage].has(stage)) {
      throw new Error(`Invalid application transition ${current.state.stage} -> ${stage}`);
    }
    if (stage === "applying" && (!current.state.artifactPath || !current.state.artifactSha256
      || !current.state.sourceFingerprint)) {
      throw new Error("A verified resume artifact is required before applying");
    }
    if (details.confirmation && stage !== "submitted") {
      throw new Error("Employer confirmation belongs only to a submitted application");
    }
    if ((details.artifactPath || details.artifactSha256 || details.sourceFingerprint) && stage !== "rendered") {
      throw new Error("Resume artifact changes require a rendered checkpoint");
    }
    if (details.browserPageId !== undefined && (!["waiting-human", "submit-claimed"].includes(stage)
      || !Number.isInteger(details.browserPageId)
      || details.browserPageId < 1)) {
      throw new Error("Browser page ID belongs only to a handoff or claimed submission");
    }
    if (details.packagePath && !["waiting-human", "submit-claimed"].includes(stage)) {
      throw new Error("Application package path belongs only to a handoff or claimed submission");
    }
    if ((details.browserGroupId || details.browserEndpoint || details.browserPageUrl)
      && !["waiting-human", "submit-claimed"].includes(stage)) {
      throw new Error("Browser identity belongs only to a handoff or claimed submission");
    }
    if (details.resumeUploaded !== undefined && stage !== "waiting-human") {
      throw new Error("Résumé upload progress belongs only to a human handoff");
    }
    if (stage === "submitted" && !details.confirmation) {
      throw new Error("Submission requires an employer confirmation");
    }
    if (stage === "rendered" && (!details.artifactPath || !details.artifactSha256 || !details.sourceFingerprint)) {
      throw new Error("A verified resume artifact is required before applying");
    }
    if (stage === "rendered" && (!/^[a-f0-9]{64}$/.test(details.artifactSha256!)
      || !/^[a-f0-9]{64}$/.test(details.sourceFingerprint!))) {
      throw new Error("Verified résumé fingerprints must be SHA-256 digests");
    }
    if ((stage === "blocked" || stage === "waiting-human" || stage === "submission-uncertain") && !details.blocker) {
      throw new Error("A blocked application needs an exact reason");
    }
    const checkpoint: ApplicationCheckpoint = {
      ...current.state,
      ...details,
      stage,
      ...(stage === "waiting-human" ? { handoffId: randomUUID() } : {}),
      updatedAt: new Date().toISOString(),
    };
    if (stage === "applying") delete checkpoint.blocker;
    if (!await this.store.compareAndSwap(jobId, current.version, checkpoint)) {
      throw new Error("Application changed concurrently; reload before continuing");
    }
    return checkpoint;
  }
}
