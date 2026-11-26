import { lstat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { BrowserContext } from "playwright";
import { z } from "zod";
import { verifyResumePdf } from "../resume/verify-pdf.js";
import { readPrivateFile } from "../storage/private-path.js";
import type { DiscoveredJob } from "../types.js";
import { applicationPackageSchema, approvedDestinationHost, type ApplicationPackage } from "./runner.js";
import { ApplicationWorkflow } from "./state-machine.js";

const ownedAttestationSchema = z.object({ version: z.literal(1), jobId: z.string().min(1),
  officialUrl: z.url(), preSubmitUrl: z.url(), confirmationUrl: z.url(),
  packagePath: z.string().refine(isAbsolute),
  browserProfileDirectory: z.string().refine(isAbsolute), artifactSha256: z.string().regex(/^[a-f0-9]{64}$/),
  expectedConfirmation: z.string().min(1), attestCorrectJob: z.literal(true) });
export type OwnedConfirmationAttestation = z.infer<typeof ownedAttestationSchema>;

export async function loadOwnedConfirmationAttestation(path: string): Promise<OwnedConfirmationAttestation> {
  if (!isAbsolute(path)) throw new Error("Use an absolute private attestation path");
  return ownedAttestationSchema.parse(JSON.parse(await readPrivateFile(path)));
}

/** Inspect only already-open profile tabs. Never navigate or click on an uncertain submission. */
export async function confirmOwnedSubmission(input: ApplicationPackage, packagePath: string,
  workflow: ApplicationWorkflow,
  attestation: OwnedConfirmationAttestation, profileDirectory: string,
  launch: (profileDirectory: string) => Promise<{ context: Pick<BrowserContext, "pages">;
    close(): Promise<void> }>, verify: typeof verifyResumePdf = verifyResumePdf): Promise<void> {
  const pkg = applicationPackageSchema.parse(input);
  const host = approvedDestinationHost(pkg);
  const approved = ownedAttestationSchema.parse(attestation);
  const checkpoint = await workflow.current(pkg.job.id);
  if (pkg.browserRuntime !== "owned" || pkg.browserEndpoint || !pkg.expectedConfirmation
    || !checkpoint || checkpoint.stage !== "submission-uncertain"
    || checkpoint.jobId !== pkg.job.id || checkpoint.officialUrl !== pkg.job.applicationUrl
    || !checkpoint.browserPageUrl || !checkpoint.ownedProfileDirectory || !checkpoint.packagePath
    || checkpoint.browserPageId || checkpoint.browserEndpoint) {
    throw new Error("No matching uncertain owned-browser application awaits confirmation");
  }
  if (approved.jobId !== pkg.job.id || approved.officialUrl !== pkg.job.applicationUrl
    || approved.preSubmitUrl !== checkpoint.browserPageUrl
    || !isAbsolute(packagePath) || resolve(approved.packagePath) !== resolve(checkpoint.packagePath)
    || resolve(packagePath) !== resolve(checkpoint.packagePath)
    || approved.expectedConfirmation !== pkg.expectedConfirmation
    || resolve(approved.browserProfileDirectory) !== resolve(checkpoint.ownedProfileDirectory)
    || resolve(profileDirectory) !== resolve(checkpoint.ownedProfileDirectory)) {
    throw new Error("Owned confirmation belongs to another job, page, or browser profile");
  }
  const artifact = await verify(pkg.resumePdfPath, pkg.job as DiscoveredJob, pkg.candidate, pkg.resumeSource);
  if (checkpoint.artifactPath !== artifact.path || checkpoint.artifactSha256 !== artifact.pdfSha256
    || checkpoint.sourceFingerprint !== artifact.sourceFingerprint
    || approved.artifactSha256 !== artifact.pdfSha256) {
    throw new Error("Owned confirmation belongs to a different résumé artifact");
  }
  // launchBrowser normally creates missing profiles; reconciliation must never do so.
  const profile = await lstat(profileDirectory).catch(() => undefined);
  if (!profile?.isDirectory() || profile.isSymbolicLink()) {
    throw new Error("Saved owned-browser profile is missing; inspect the employer portal manually");
  }
  const runtime = await launch(profileDirectory);
  try {
    const matches = runtime.context.pages().filter((page) => page.url() === approved.confirmationUrl);
    if (matches.length !== 1) throw new Error("Exact employer confirmation tab is missing or ambiguous");
    const page = matches[0]!;
    const url = new URL(page.url());
    if (url.protocol !== "https:" || url.hostname.toLowerCase() !== host || url.username || url.password) {
      throw new Error("Employer confirmation left the approved destination");
    }
    const body = await page.locator("body").innerText();
    const normalized = body.toLowerCase().replace(/\s+/g, " ");
    const requisition = pkg.job.id.split(":").at(-1)?.toLowerCase();
    const pathSegments = url.pathname.split("/").map((part) => decodeURIComponent(part).toLowerCase());
    if (!requisition || !/^[a-z0-9_-]{6,}$/.test(requisition)
      || (!pathSegments.includes(requisition)
        && !new RegExp(`(^|[^a-z0-9_-])${requisition}([^a-z0-9_-]|$)`, "i").test(body))
      || !normalized.includes(pkg.job.title.toLowerCase())
      || !normalized.includes(pkg.job.company.toLowerCase())) {
      throw new Error("Confirmation page does not identify the exact requisition, company, and role");
    }
    const statuses = page.locator("h1, h2, h3, [role='alert'], [role='status']");
    let confirmationVisible = false;
    for (let index = 0; index < await statuses.count(); index += 1) {
      const status = statuses.nth(index);
      if (await status.isVisible() && (await status.innerText()).includes(pkg.expectedConfirmation.trim())) {
        confirmationVisible = true;
        break;
      }
    }
    if (!confirmationVisible || page.url() !== approved.confirmationUrl) {
      throw new Error("Employer confirmation is not visibly present in the exact saved tab");
    }
    await workflow.advance(pkg.job.id, "submitted", { confirmation: pkg.expectedConfirmation.trim() });
  } finally {
    await runtime.close();
  }
}
