import { resolve } from "node:path";
import type { BrowserContext, Page } from "playwright";
import { verifyResumePdf } from "../resume/verify-pdf.js";
import type { DiscoveredJob } from "../types.js";
import { hasStableRequisitionPath } from "./requisition.js";
import { applicationPackageSchema, type ApplicationPackage } from "./runner.js";
import { ApplicationWorkflow } from "./state-machine.js";

const receiptSelector = 'h1:visible, h2:visible, h3:visible, [role="status"]:visible, [role="alert"]:visible';

function exactToken(text: string, token: string): boolean {
  const lower = text.toLowerCase();
  const needle = token.toLowerCase();
  let start = 0;
  while ((start = lower.indexOf(needle, start)) !== -1) {
    const before = lower[start - 1];
    const after = lower[start + needle.length];
    if ((!before || !/[a-z0-9_-]/.test(before)) && (!after || !/[a-z0-9_-]/.test(after))) return true;
    start += needle.length;
  }
  return false;
}

function phrase(text: string, expected: string): boolean {
  return text.toLocaleLowerCase().replace(/\s+/g, " ").includes(
    expected.toLocaleLowerCase().replace(/\s+/g, " ").trim());
}

function exactRoleLine(text: string, company: string, role: string): boolean {
  const lines = text.toLocaleLowerCase().split("\n").map((line) => line.trim().replace(/\s+/g, " "));
  const title = role.toLocaleLowerCase().trim().replace(/\s+/g, " ");
  const employer = company.toLocaleLowerCase().trim().replace(/\s+/g, " ");
  return lines.some((line) => line === title || line === `${employer} — ${title}`
    || line === `${employer} - ${title}` || line === `${title} at ${employer}`
    || line === `you applied to ${title} at ${employer}`);
}

/** Inspect an already-open employer receipt. This function never navigates or clicks. */
export async function inspectOwnedReceipt(
  context: Pick<BrowserContext, "pages">, pkg: ApplicationPackage, preSubmitUrl?: string,
): Promise<string> {
  if (!hasStableRequisitionPath(pkg.job) || !pkg.expectedConfirmation) {
    throw new Error("This job lacks a stable requisition or configured receipt phrase");
  }
  const reference = pkg.job.id.split(":").at(-1)!;
  const original = new URL(pkg.job.applicationUrl);
  const matches: Page[] = [];
  for (const page of context.pages()) {
    if (page.isClosed()) continue;
    let receipt: URL;
    try { receipt = new URL(page.url()); } catch { continue; }
    if (receipt.protocol !== "https:" || receipt.origin !== original.origin
      || receipt.username || receipt.password) continue;
    if (preSubmitUrl && receipt.pathname === new URL(preSubmitUrl).pathname) continue;
    const body = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
    if (body.length > 50_000) continue;
    const pathParts = receipt.pathname.split("/").map((part) => {
      try { return decodeURIComponent(part).toLowerCase(); } catch { return ""; }
    });
    if (!phrase(body, pkg.job.company) || !exactRoleLine(body, pkg.job.company, pkg.job.title)
      || (!pathParts.includes(reference.toLowerCase()) && !exactToken(body, reference))) continue;
    const receiptLines = await page.locator(receiptSelector).allInnerTexts().catch(() => []);
    if (!receiptLines.some((line) => phrase(line, pkg.expectedConfirmation!))) continue;
    if (page.url() !== receipt.href) continue;
    matches.push(page);
  }
  if (matches.length !== 1) {
    throw new Error(matches.length ? "More than one job-bound employer receipt is open"
      : "No job-bound employer receipt is visible in the owned browser");
  }
  return matches[0]!.url();
}

/** A candidate-assisted fallback after tab loss; no uncertain claim is ever resubmitted. */
export async function confirmOwnedSubmission(
  input: ApplicationPackage, workflow: ApplicationWorkflow,
  context: Pick<BrowserContext, "pages">, packagePath: string,
  attestedCorrectAccount: boolean,
  verify: typeof verifyResumePdf = verifyResumePdf,
): Promise<string> {
  const pkg = applicationPackageSchema.parse(input);
  const checkpoint = await workflow.current(pkg.job.id);
  if (pkg.browserRuntime !== "owned" || !attestedCorrectAccount
    || !checkpoint || checkpoint.stage !== "submission-uncertain"
    || checkpoint.officialUrl !== pkg.job.applicationUrl
    || !checkpoint.packagePath || resolve(checkpoint.packagePath) !== resolve(packagePath)
    || !checkpoint.browserPageUrl
    || !checkpoint.artifactPath || !checkpoint.artifactSha256 || !checkpoint.sourceFingerprint) {
    throw new Error("No matching owned-browser uncertain submission awaits verification");
  }
  const artifact = await verify(pkg.resumePdfPath, pkg.job as DiscoveredJob,
    pkg.candidate, pkg.resumeSource);
  if (checkpoint.artifactPath !== artifact.path
    || checkpoint.artifactSha256 !== artifact.pdfSha256
    || checkpoint.sourceFingerprint !== artifact.sourceFingerprint) {
    throw new Error("Employer receipt belongs to a different résumé artifact");
  }
  const receiptUrl = await inspectOwnedReceipt(context, pkg, checkpoint.browserPageUrl);
  await workflow.advance(pkg.job.id, "submitted", {
    confirmation: `${pkg.expectedConfirmation!.trim()} (${receiptUrl})`,
  });
  return receiptUrl;
}
