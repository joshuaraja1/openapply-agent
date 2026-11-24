import { z } from "zod";
import { AgentBrowser, type BrowserSnapshot } from "../browser/actions.js";
import { launchBrowser, type BrowserRuntime } from "../browser/runtime.js";
import { candidateProfileSchema } from "../candidate/schema.js";
import { sourceSchema } from "../config.js";
import { verifyResumePdf, type VerifiedResumeArtifact } from "../resume/verify-pdf.js";
import { fetchSourceBatch } from "../sources/batch.js";
import type { DiscoveredJob } from "../types.js";
import { applicationHandoffSchema } from "./handoff.js";
import { fillApplicationForm } from "./form-mapper.js";
import { ApplicationWorkflow, type ApplicationCheckpoint } from "./state-machine.js";
import { submitApplication } from "./submit.js";
import type { HumanAnswerApproval } from "./human-answers.js";

export const jobSchema = z.object({
  id: z.string().min(1), provider: z.enum(["greenhouse", "ashby", "workday", "lever", "smartrecruiters", "jsonld"]),
  company: z.string().min(1), title: z.string().min(1), descriptionText: z.string().min(1),
  applicationUrl: z.url(), sourceUrl: z.url(),
  location: z.string().nullable(), department: z.string().nullable(), employmentType: z.string().nullable(),
  workplaceType: z.string().nullable(), compensation: z.string().nullable(), sourcePublishedAt: z.string().nullable(),
  sourceUpdatedAt: z.string().nullable(), firstSeenAt: z.string(), discoveredAt: z.string(),
  isNew: z.boolean(), isFresh: z.boolean(), freshnessBasis: z.enum(["source-published", "first-seen"]),
  matchedKeywords: z.array(z.string()),
});

export const applicationPackageSchema = z.object({
  version: z.literal(1),
  job: jobSchema,
  source: sourceSchema,
  candidate: candidateProfileSchema,
  handoff: applicationHandoffSchema,
  resumeSource: z.object({ latex: z.string().min(1), fingerprint: z.string().length(64),
    renderToken: z.string().length(64), claimIds: z.array(z.string()).min(1) }),
  resumePdfPath: z.string().min(1),
  browserEndpoint: z.url().optional(),
  expectedConfirmation: z.string().min(1).optional(),
});

export type ApplicationPackage = z.infer<typeof applicationPackageSchema>;
export interface RunResult { checkpoint: ApplicationCheckpoint; artifact: VerifiedResumeArtifact }

type BrowserLaunch = (options: { profileDirectory: string; headless: boolean }) => Promise<BrowserRuntime>;
export interface ApplicationBrowserSurface {
  currentUrl(): string;
  navigate(url: string): Promise<BrowserSnapshot>;
  act(ref: string, action: "click" | "fill" | "select" | "upload", value?: string): Promise<BrowserSnapshot>;
  submit(ref: string, expectedConfirmation: string): Promise<string>;
  fillBatch?(actions: import("./form-mapper.js").FormAction[]): Promise<BrowserSnapshot>;
  pageId?(): number | undefined;
  groupId?(): string | undefined;
  attach?(pageId: number, expectedUrl: string, expectedGroupId: string): Promise<BrowserSnapshot>;
}

function stepSignature(page: BrowserSnapshot): string {
  return `${page.url}|${page.title}|${page.controls.map((control) =>
    `${control.tag}:${control.type}:${control.name}`).join("|")}`;
}

export async function validateOfficialPosting(pkg: ApplicationPackage): Promise<boolean> {
  if (pkg.source.provider !== pkg.job.provider || pkg.source.company !== pkg.job.company) return false;
  const batch = await fetchSourceBatch([pkg.source], 5000);
  return batch.jobs.some((official) => official.id === pkg.job.id
    && official.applicationUrl === pkg.job.applicationUrl && official.sourceUrl === pkg.job.sourceUrl
    && official.title === pkg.job.title && official.descriptionText === pkg.job.descriptionText);
}

export function approvedDestinationHost(pkg: ApplicationPackage): string {
  const job = pkg.job;
  const destination = new URL(job.applicationUrl);
  const host = destination.hostname.toLowerCase();
  const independentlyAllowed = pkg.source.allowedApplicationHosts
    .some((allowed) => allowed.toLowerCase() === host)
    || (pkg.source.provider === "jsonld" && new URL(pkg.source.url).protocol === "https:"
      && new URL(pkg.source.url).hostname.toLowerCase() === host);
  if (destination.protocol !== "https:" || destination.username || destination.password
    || new URL(job.sourceUrl).protocol !== "https:"
    || pkg.source.provider !== job.provider || pkg.source.company !== job.company
    || pkg.handoff.jobId !== job.id || pkg.handoff.applicationUrl !== job.applicationUrl
    || !independentlyAllowed
    || !pkg.handoff.allowedDomains.map((domain) => domain.toLowerCase()).includes(host)) {
    throw new Error("Application package does not match its approved employer destination");
  }
  return host;
}

export async function runApplicationPackage(
  input: ApplicationPackage,
  workflow: ApplicationWorkflow,
  profileDirectory: string,
  dependencies: { launch?: BrowserLaunch; verify?: typeof verifyResumePdf;
    validateOfficial?: typeof validateOfficialPosting; approvedJobId?: string; resumedJobId?: string;
    packagePath?: string;
    humanAnswerApproval?: HumanAnswerApproval;
    browserFactory?: (allowedHosts: ReadonlySet<string>, approvedArtifacts: ReadonlyMap<string, string>) =>
      Promise<{ browser: ApplicationBrowserSurface; close(): Promise<void> }> } = {},
): Promise<RunResult> {
  const pkg = applicationPackageSchema.parse(input);
  const job = pkg.job as DiscoveredJob;
  const host = approvedDestinationHost(pkg);
  const current = await workflow.current(job.id);
  if (current && current.officialUrl !== job.applicationUrl) throw new Error("Application ID already belongs to another URL");
  const resumingApproval = current?.stage === "waiting-human"
    && current.blocker === "Final submission approval required"
    && dependencies.approvedJobId === job.id && pkg.handoff.mode === "submit-after-approval"
    && !pkg.handoff.stopConditions.includes("final-submit");
  const resumingHuman = (current?.stage === "waiting-human"
    && current.blocker !== "Final submission approval required" || current?.stage === "applying")
    && dependencies.resumedJobId === job.id && current.browserPageId !== undefined
    && Boolean(dependencies.browserFactory);
  if (resumingHuman && (!current?.browserGroupId || !current.browserEndpoint || !current.browserPageUrl
    || current.browserEndpoint !== pkg.browserEndpoint)) {
    throw new Error("BrowserOS handoff requires the saved tab group and endpoint");
  }
  if (dependencies.approvedJobId && !resumingApproval) {
    throw new Error("Approval requires a matching pending final-approval checkpoint");
  }
  if (dependencies.resumedJobId && !resumingHuman) {
    throw new Error("Human resume requires a matching pending BrowserOS handoff");
  }
  if (dependencies.humanAnswerApproval
    && (!resumingHuman || dependencies.humanAnswerApproval.jobId !== job.id
      || dependencies.humanAnswerApproval.browserPageId !== current?.browserPageId
      || dependencies.humanAnswerApproval.approveFinalSubmission !== true)) {
    throw new Error("Human answer approval does not match this BrowserOS handoff");
  }
  const handoff = resumingHuman && dependencies.humanAnswerApproval
    ? { ...pkg.handoff, mode: "submit-after-approval" as const,
      stopConditions: pkg.handoff.stopConditions.filter((condition) => condition !== "final-submit") }
    : pkg.handoff;
  if (current?.stage === "applying" && current.browserPageId && !resumingHuman) {
    throw new Error("An interrupted BrowserOS handoff requires explicit same-tab resume");
  }
  if (current && !resumingApproval && !resumingHuman
    && !["discovered", "validated", "matched", "tailored", "rendered", "applying"].includes(current.stage)) {
    throw new Error(`Application is ${current.stage}; inspect or resume it before another run`);
  }
  const [isOfficial, artifact] = await Promise.all([
    (dependencies.validateOfficial ?? validateOfficialPosting)(pkg),
    (dependencies.verify ?? verifyResumePdf)(pkg.resumePdfPath, job, pkg.candidate, pkg.resumeSource),
  ]);
  if (!isOfficial) throw new Error("Posting no longer matches the configured official source");
  if (artifact.jobId !== job.id || artifact.sourceFingerprint !== pkg.resumeSource.fingerprint) {
    throw new Error("Verified résumé artifact belongs to another job or source");
  }
  if (current?.artifactPath && (current.artifactPath !== artifact.path
    || current.artifactSha256 !== artifact.pdfSha256
    || current.sourceFingerprint !== artifact.sourceFingerprint)) {
    throw new Error("Application checkpoint belongs to a different résumé artifact or source");
  }
  let checkpoint = current ?? await workflow.create(job.id, job.applicationUrl);
  for (const stage of ["validated", "matched", "tailored"] as const) {
    if (checkpoint.stage === ({ validated: "discovered", matched: "validated", tailored: "matched" } as const)[stage]) {
      checkpoint = await workflow.advance(job.id, stage);
    }
  }
  if (checkpoint.stage === "tailored") checkpoint = await workflow.advance(job.id, "rendered", {
    artifactPath: artifact.path, artifactSha256: artifact.pdfSha256,
    sourceFingerprint: artifact.sourceFingerprint,
  });
  if (checkpoint.stage === "rendered") checkpoint = await workflow.advance(job.id, "applying");
  const runtime: { browser: ApplicationBrowserSurface; close(): Promise<void> } = dependencies.browserFactory
    ? await dependencies.browserFactory(new Set([host]), new Map([[artifact.path, artifact.pdfSha256]]))
    : await (async () => {
      const launched = await (dependencies.launch ?? launchBrowser)({ profileDirectory, headless: false });
      return { browser: new AgentBrowser(launched.context, new Set([host]),
        new Map([[artifact.path, artifact.pdfSha256]])), close: () => launched.close() };
    })();
  let recoveryPageUrl = current?.browserPageUrl;
  let recoveryResumeUploaded = current?.resumeUploaded === true;
  try {
    const browser = runtime.browser;
    if (resumingHuman && !browser.attach) throw new Error("BrowserOS handoff cannot be attached");
    const snapshot = resumingHuman
      ? await browser.attach!(current!.browserPageId!, current!.browserPageUrl!, current!.browserGroupId!)
      : await browser.navigate(job.applicationUrl);
    if (new URL(snapshot.url).protocol !== "https:"
      || new URL(snapshot.url).hostname.toLowerCase() !== host) {
      throw new Error("Application handoff left the approved employer destination");
    }
    recoveryPageUrl = snapshot.url;
    if ((resumingApproval || resumingHuman) && checkpoint.stage === "waiting-human") {
      checkpoint = await workflow.advance(job.id, "applying");
    }
    const formOptions = { allowMissingResume: true,
      ...(resumingHuman && dependencies.humanAnswerApproval
        ? { approvedHumanAnswers: dependencies.humanAnswerApproval.answers } : {}) };
    let resumeUploaded = resumingHuman && current?.resumeUploaded === true;
    let continued = false;
    let page = snapshot;
    let filled = { snapshot, blockers: [] as string[], uploaded: false };
    const visited = new Set<string>();
    for (let step = 0; step < 5; step += 1) {
      filled = await fillApplicationForm(browser, page, pkg.candidate, artifact.path, formOptions);
      resumeUploaded ||= filled.uploaded;
      recoveryResumeUploaded = resumeUploaded;
      const signature = stepSignature(filled.snapshot);
      if (visited.has(signature)) {
        filled.blockers.push("Application step repeated without progress");
        break;
      }
      visited.add(signature);
      if (filled.blockers.length) break;
      const next = filled.snapshot.controls.filter((control) => control.tag === "button"
        && control.type === "button"
        && /^(next|continue|save and continue|continue to next step)$/i.test(control.name.trim()));
      const ambiguousNext = filled.snapshot.controls.some((control) => control.tag === "button"
        && control.type !== "button" && /^(next|continue|save and continue|continue to next step)$/i
          .test(control.name.trim()));
      const final = filled.snapshot.controls.filter((control) => control.type === "submit"
        || /\b(submit|apply now|send application)\b/i.test(control.name));
      if (next.length && final.length) {
        filled.blockers.push("Application has ambiguous continue and submit controls");
        break;
      }
      if (ambiguousNext) {
        filled.blockers.push("Continue control is not explicitly a non-submit button");
        break;
      }
      if (!next.length) break;
      if (next.length !== 1 || step === 4) {
        filled.blockers.push(step === 4 ? "Application exceeded the five-step limit"
          : "Application has ambiguous continue controls");
        break;
      }
      page = await browser.act(next[0]!.ref, "click");
      continued = true;
      if (new URL(page.url).hostname.toLowerCase() !== host) {
        throw new Error("Application left the approved employer destination");
      }
      recoveryPageUrl = page.url;
      if (stepSignature(page) === signature) {
        filled = { snapshot: page, blockers: ["Continue did not advance the application"], uploaded: false };
        break;
      }
    }
    const pageId = browser.pageId?.();
    const groupId = browser.groupId?.();
    if (pageId && (!groupId || !pkg.browserEndpoint)) {
      throw new Error("BrowserOS application needs a stable tab group and endpoint for recovery");
    }
    const pageDetails = { ...(pageId ? { browserPageId: pageId } : {}),
      ...(pageId ? { browserPageUrl: filled.snapshot.url } : {}),
      ...(groupId ? { browserGroupId: groupId } : {}),
      ...(pageId && pkg.browserEndpoint ? { browserEndpoint: pkg.browserEndpoint } : {}),
      resumeUploaded,
      ...(dependencies.packagePath ? { packagePath: dependencies.packagePath } : {}) };
    if (!filled.blockers.length && !resumeUploaded) {
      filled.blockers.push("Verified résumé was not uploaded on any application step");
    }
    if (filled.blockers.length) {
      checkpoint = await workflow.advance(job.id, "waiting-human", {
        blocker: filled.blockers.join("; "), ...pageDetails,
      });
    } else if (handoff.mode === "prepare" || handoff.stopConditions.includes("final-submit")) {
      checkpoint = await workflow.advance(job.id, "waiting-human", {
        blocker: "Final submission approval required", ...pageDetails,
      });
    } else if (!pkg.expectedConfirmation) {
      checkpoint = await workflow.advance(job.id, "waiting-human", {
        blocker: "Expected employer confirmation text is not configured", ...pageDetails,
      });
    } else {
      const submitControls = filled.snapshot.controls.filter((control) => control.type === "submit"
        || /\b(submit|apply now|send application)\b/i.test(control.name));
      if (submitControls.length !== 1) {
        checkpoint = await workflow.advance(job.id, "waiting-human", {
          blocker: "Final submit control is missing or ambiguous", ...pageDetails,
        });
      } else {
        await submitApplication(workflow, browser, job.id, submitControls[0]!.ref,
          pkg.expectedConfirmation, handoff, pkg.browserEndpoint,
          continued || resumingHuman ? filled.snapshot.url : undefined);
        checkpoint = (await workflow.current(job.id))!;
      }
    }
    return { checkpoint, artifact };
  } catch (error) {
    const latest = await workflow.current(job.id);
    if (latest?.stage === "applying" && (resumingApproval || resumingHuman
      || runtime.browser.pageId?.()) && recoveryPageUrl) {
      const pageId = runtime.browser.pageId?.() ?? current?.browserPageId;
      const groupId = runtime.browser.groupId?.() ?? current?.browserGroupId;
      await workflow.advance(job.id, "waiting-human", {
        blocker: current?.blocker ?? "Human handoff needs another review",
        ...(pageId ? { browserPageId: pageId, browserPageUrl: recoveryPageUrl } : {}),
        ...(groupId ? { browserGroupId: groupId } : {}),
        ...(pkg.browserEndpoint ? { browserEndpoint: pkg.browserEndpoint } : {}),
        resumeUploaded: recoveryResumeUploaded,
        ...(current?.packagePath ? { packagePath: current.packagePath } : {}),
      });
    }
    throw error;
  } finally {
    await runtime.close();
  }
}
