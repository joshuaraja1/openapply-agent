import { z } from "zod";
import { AgentBrowser } from "../browser/actions.js";
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
  expectedConfirmation: z.string().min(1).optional(),
});

export type ApplicationPackage = z.infer<typeof applicationPackageSchema>;
export interface RunResult { checkpoint: ApplicationCheckpoint; artifact: VerifiedResumeArtifact }

type BrowserLaunch = (options: { profileDirectory: string; headless: boolean }) => Promise<BrowserRuntime>;

async function validateOfficialPosting(pkg: ApplicationPackage): Promise<boolean> {
  if (pkg.source.provider !== pkg.job.provider || pkg.source.company !== pkg.job.company) return false;
  const batch = await fetchSourceBatch([pkg.source], 5000);
  return batch.jobs.some((official) => official.id === pkg.job.id
    && official.applicationUrl === pkg.job.applicationUrl && official.sourceUrl === pkg.job.sourceUrl
    && official.title === pkg.job.title && official.descriptionText === pkg.job.descriptionText);
}

export async function runApplicationPackage(
  input: ApplicationPackage,
  workflow: ApplicationWorkflow,
  profileDirectory: string,
  dependencies: { launch?: BrowserLaunch; verify?: typeof verifyResumePdf;
    validateOfficial?: typeof validateOfficialPosting; approvedJobId?: string } = {},
): Promise<RunResult> {
  const pkg = applicationPackageSchema.parse(input);
  const job = pkg.job as DiscoveredJob;
  const destination = new URL(job.applicationUrl);
  const host = destination.hostname.toLowerCase();
  const independentlyAllowed = pkg.source.allowedApplicationHosts
    .some((allowed) => allowed.toLowerCase() === host)
    || (pkg.source.provider === "jsonld" && new URL(pkg.source.url).protocol === "https:"
      && new URL(pkg.source.url).hostname.toLowerCase() === host);
  if (destination.protocol !== "https:" || destination.username || destination.password
    || new URL(job.sourceUrl).protocol !== "https:"
    || pkg.source.provider !== job.provider || pkg.source.company !== job.company
    || pkg.handoff.jobId !== job.id
    || pkg.handoff.applicationUrl !== job.applicationUrl
    || !independentlyAllowed
    || !pkg.handoff.allowedDomains.map((domain) => domain.toLowerCase()).includes(host)) {
    throw new Error("Application package does not match its approved employer destination");
  }
  const current = await workflow.current(job.id);
  if (current && current.officialUrl !== job.applicationUrl) throw new Error("Application ID already belongs to another URL");
  const resumingApproval = current?.stage === "waiting-human"
    && current.blocker === "Final submission approval required"
    && dependencies.approvedJobId === job.id && pkg.handoff.mode === "submit-after-approval"
    && !pkg.handoff.stopConditions.includes("final-submit");
  if (dependencies.approvedJobId && !resumingApproval) {
    throw new Error("Approval requires a matching pending final-approval checkpoint");
  }
  if (current && !resumingApproval
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
  if (resumingApproval) checkpoint = await workflow.advance(job.id, "applying");
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
  const runtime = await (dependencies.launch ?? launchBrowser)({ profileDirectory, headless: false });
  try {
    const browser = new AgentBrowser(runtime.context, new Set([host]), new Map([[artifact.path, artifact.pdfSha256]]));
    const snapshot = await browser.navigate(job.applicationUrl);
    const filled = await fillApplicationForm(browser, snapshot, pkg.candidate, artifact.path);
    if (filled.blockers.length) {
      checkpoint = await workflow.advance(job.id, "waiting-human", { blocker: filled.blockers.join("; ") });
    } else if (pkg.handoff.mode === "prepare" || pkg.handoff.stopConditions.includes("final-submit")) {
      checkpoint = await workflow.advance(job.id, "waiting-human", { blocker: "Final submission approval required" });
    } else if (!pkg.expectedConfirmation) {
      checkpoint = await workflow.advance(job.id, "waiting-human", { blocker: "Expected employer confirmation text is not configured" });
    } else {
      const submitControls = filled.snapshot.controls.filter((control) => control.type === "submit"
        || /\b(submit|apply now|send application)\b/i.test(control.name));
      if (submitControls.length !== 1) {
        checkpoint = await workflow.advance(job.id, "waiting-human", { blocker: "Final submit control is missing or ambiguous" });
      } else {
        await submitApplication(workflow, browser, job.id, submitControls[0]!.ref,
          pkg.expectedConfirmation, pkg.handoff);
        checkpoint = (await workflow.current(job.id))!;
      }
    }
    return { checkpoint, artifact };
  } finally {
    await runtime.close();
  }
}
