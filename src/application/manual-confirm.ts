import type { NeoApplicationBrowser } from "../browser/neo-application.js";
import { verifyResumePdf } from "../resume/verify-pdf.js";
import type { DiscoveredJob } from "../types.js";
import { ApplicationWorkflow } from "./state-machine.js";
import { applicationPackageSchema, approvedDestinationHost, type ApplicationPackage } from "./runner.js";

export async function confirmManualSubmission(
  input: ApplicationPackage, workflow: ApplicationWorkflow,
  browser: Pick<NeoApplicationBrowser, "inspectHandoff">,
  verify: typeof verifyResumePdf = verifyResumePdf,
): Promise<void> {
  const pkg = applicationPackageSchema.parse(input);
  approvedDestinationHost(pkg);
  const checkpoint = await workflow.current(pkg.job.id);
  if (!checkpoint || !["waiting-human", "applying", "submit-claimed", "submission-uncertain"].includes(checkpoint.stage)
    || checkpoint.officialUrl !== pkg.job.applicationUrl || !checkpoint.browserPageId
    || !pkg.expectedConfirmation) {
    throw new Error("No matching BrowserOS application awaits confirmation");
  }
  const artifact = await verify(pkg.resumePdfPath, pkg.job as DiscoveredJob, pkg.candidate, pkg.resumeSource);
  if (checkpoint.artifactPath !== artifact.path || checkpoint.artifactSha256 !== artifact.pdfSha256
    || checkpoint.sourceFingerprint !== artifact.sourceFingerprint) {
    throw new Error("Manual confirmation belongs to a different résumé artifact");
  }
  const page = await browser.inspectHandoff(checkpoint.browserPageId);
  const expected = pkg.expectedConfirmation.trim();
  const confirmationInStatus = page.visibleText.split("\n").some((line) =>
    /^\s*- (heading|alert|status)\b/i.test(line) && line.includes(expected));
  if (!page.visibleText.includes(expected)
    || (page.url === pkg.job.applicationUrl && !confirmationInStatus)) {
    throw new Error("Employer confirmation is not visible in the saved application tab");
  }
  await workflow.advance(pkg.job.id, "submitted", { confirmation: expected });
}
