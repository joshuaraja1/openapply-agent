import { lstat, readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";
import type { NeoApplicationBrowser } from "../browser/neo-application.js";
import { verifyResumePdf } from "../resume/verify-pdf.js";
import type { DiscoveredJob } from "../types.js";
import { ApplicationWorkflow } from "./state-machine.js";
import { applicationPackageSchema, approvedDestinationHost, type ApplicationPackage } from "./runner.js";

const attestationSchema = z.object({ version: z.literal(1), jobId: z.string().min(1),
  browserPageId: z.number().int().positive(), confirmationUrl: z.url(),
  expectedConfirmation: z.string().min(1), attestCorrectJob: z.literal(true) });
export type ManualConfirmationAttestation = z.infer<typeof attestationSchema>;

export async function loadManualAttestation(path: string): Promise<ManualConfirmationAttestation> {
  if (process.platform === "win32" || !isAbsolute(path)) throw new Error("Use an absolute private attestation path");
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid())
    || (info.mode & 0o077) !== 0) throw new Error("Confirmation attestation must be private");
  return attestationSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

export async function confirmManualSubmission(
  input: ApplicationPackage, workflow: ApplicationWorkflow,
  browser: Pick<NeoApplicationBrowser, "inspectHandoff">,
  attestation: ManualConfirmationAttestation,
  verify: typeof verifyResumePdf = verifyResumePdf,
): Promise<void> {
  const pkg = applicationPackageSchema.parse(input);
  const approvedHost = approvedDestinationHost(pkg);
  const checkpoint = await workflow.current(pkg.job.id);
  if (!checkpoint || !["waiting-human", "applying", "submit-claimed", "submission-uncertain"].includes(checkpoint.stage)
    || checkpoint.officialUrl !== pkg.job.applicationUrl || !checkpoint.browserPageId
    || !checkpoint.browserGroupId || !checkpoint.browserEndpoint
    || checkpoint.browserEndpoint !== pkg.browserEndpoint
    || !pkg.expectedConfirmation) {
    throw new Error("No matching BrowserOS application awaits confirmation");
  }
  const approved = attestationSchema.parse(attestation);
  if (approved.jobId !== pkg.job.id || approved.browserPageId !== checkpoint.browserPageId
    || approved.expectedConfirmation !== pkg.expectedConfirmation) {
    throw new Error("Confirmation attestation belongs to another job or tab");
  }
  const artifact = await verify(pkg.resumePdfPath, pkg.job as DiscoveredJob, pkg.candidate, pkg.resumeSource);
  if (checkpoint.artifactPath !== artifact.path || checkpoint.artifactSha256 !== artifact.pdfSha256
    || checkpoint.sourceFingerprint !== artifact.sourceFingerprint) {
    throw new Error("Manual confirmation belongs to a different résumé artifact");
  }
  const page = await browser.inspectHandoff(checkpoint.browserPageId, checkpoint.browserGroupId);
  const pageUrl = new URL(page.url);
  if (pageUrl.protocol !== "https:" || pageUrl.hostname.toLowerCase() !== approvedHost) {
    throw new Error("Employer confirmation page left the approved destination");
  }
  if (pageUrl.href !== approved.confirmationUrl) throw new Error("Confirmation page changed after attestation");
  const expected = pkg.expectedConfirmation.trim();
  const confirmationInStatus = page.visibleText.split("\n").some((line) =>
    /^\s*- (heading|alert|status)\b/i.test(line) && line.includes(expected));
  if (!confirmationInStatus) {
    throw new Error("Employer confirmation is not visible in the saved application tab");
  }
  await workflow.advance(pkg.job.id, "submitted", { confirmation: expected });
}
