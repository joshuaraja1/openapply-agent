import { z } from "zod";
import { AgentBrowser } from "../browser/actions.js";
import { launchBrowser, type BrowserRuntime } from "../browser/runtime.js";
import { candidateProfileSchema } from "../candidate/schema.js";
import { verifyResumePdf, type VerifiedResumeArtifact } from "../resume/verify-pdf.js";
import type { DiscoveredJob } from "../types.js";
import { applicationHandoffSchema } from "./handoff.js";
import { fillApplicationForm } from "./form-mapper.js";
import { ApplicationWorkflow, type ApplicationCheckpoint } from "./state-machine.js";
import { submitApplication } from "./submit.js";

const jobSchema = z.object({
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

export async function runApplicationPackage(
  input: ApplicationPackage,
  workflow: ApplicationWorkflow,
  profileDirectory: string,
  dependencies: { launch?: BrowserLaunch; verify?: typeof verifyResumePdf } = {},
): Promise<RunResult> {
  const pkg = applicationPackageSchema.parse(input);
  const job = pkg.job as DiscoveredJob;
  const host = new URL(job.applicationUrl).hostname.toLowerCase();
  if (new URL(job.applicationUrl).protocol !== "https:" || pkg.handoff.jobId !== job.id
    || pkg.handoff.applicationUrl !== job.applicationUrl
    || !pkg.handoff.allowedDomains.map((domain) => domain.toLowerCase()).includes(host)) {
    throw new Error("Application package does not match its approved employer destination");
  }
  const current = await workflow.current(job.id);
  if (current && current.officialUrl !== job.applicationUrl) throw new Error("Application ID already belongs to another URL");
  if (current && !["discovered", "validated", "matched", "tailored", "rendered", "applying"].includes(current.stage)) {
    throw new Error(`Application is ${current.stage}; inspect or resume it before another run`);
  }
  const artifact = await (dependencies.verify ?? verifyResumePdf)(
    pkg.resumePdfPath, job, pkg.candidate, pkg.resumeSource,
  );
  if (artifact.jobId !== job.id || artifact.sourceFingerprint !== pkg.resumeSource.fingerprint) {
    throw new Error("Verified résumé artifact belongs to another job or source");
  }
  if (current?.artifactPath && current.artifactPath !== artifact.path) {
    throw new Error("Application checkpoint belongs to a different résumé artifact");
  }
  let checkpoint = current ?? await workflow.create(job.id, job.applicationUrl);
  for (const stage of ["validated", "matched", "tailored"] as const) {
    if (checkpoint.stage === ({ validated: "discovered", matched: "validated", tailored: "matched" } as const)[stage]) {
      checkpoint = await workflow.advance(job.id, stage);
    }
  }
  if (checkpoint.stage === "tailored") checkpoint = await workflow.advance(job.id, "rendered", { artifactPath: artifact.path });
  if (checkpoint.stage === "rendered") checkpoint = await workflow.advance(job.id, "applying");
  const runtime = await (dependencies.launch ?? launchBrowser)({ profileDirectory, headless: false });
  try {
    const browser = new AgentBrowser(runtime.context, new Set([host]), new Map([[artifact.path, artifact.pdfSha256]]));
    const snapshot = await browser.navigate(job.applicationUrl);
    const filled = await fillApplicationForm(browser, snapshot, pkg.candidate, artifact.path);
    if (filled.blockers.length) {
      checkpoint = await workflow.advance(job.id, "waiting-human", { blocker: filled.blockers.join("; ") });
    } else if (pkg.handoff.mode === "prepare") {
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
