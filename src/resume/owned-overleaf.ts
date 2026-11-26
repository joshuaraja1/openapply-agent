import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdtemp, open, rm, unlink, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { join, resolve } from "node:path";
import type { BrowserRuntime } from "../browser/runtime.js";
import { launchBrowser } from "../browser/runtime.js";
import type { CandidateProfile } from "../candidate/schema.js";
import type { DiscoveredJob } from "../types.js";
import type { ResumeSource } from "./jake.js";
import { assertOverleafProjectUrl } from "./overleaf.js";
import { verifyResumePdf, type VerifiedResumeArtifact } from "./verify-pdf.js";
import { ResumeVisualReviewRequiredError } from "./visual-qa.js";
import { assertSameFileIdentity, ensurePrivateDirectory } from "../storage/private-path.js";
import { sealWindowsPrivateChildPath, secureWindowsPrivatePath }
  from "../storage/windows-acl.js";

type Launch = (options: { profileDirectory: string; headless: boolean }) => Promise<BrowserRuntime>;
const maxPdfBytes = 5_000_000;

/** Compile through the user's persistent local browser session. */
export async function renderOwnedOverleafResume(
  projectUrl: string, job: DiscoveredJob, candidate: CandidateProfile, source: ResumeSource,
  outputDirectory: string,
  options: { launch?: Launch; verify?: typeof verifyResumePdf; profileDirectory?: string } = {},
): Promise<VerifiedResumeArtifact> {
  assertOverleafProjectUrl(projectUrl);
  const directory = resolve(outputDirectory);
  await ensurePrivateDirectory(directory);
  const runtime = await (options.launch ?? launchBrowser)({
    profileDirectory: options.profileDirectory ?? join(userInfo().homedir, ".openapply-agent", "browser-profile"),
    headless: false,
  });
  let artifactPath: string | undefined;
  let downloadDirectory: string | undefined;
  let verified = false;
  let needsVisualReview = false;
  try {
    await runtime.context.route("**/*", async (route) => {
      if (route.request().isNavigationRequest()) {
        let target: URL;
        try { target = new URL(route.request().url()); }
        catch { await route.abort(); return; }
        if (target.origin !== "https://www.overleaf.com") { await route.abort(); return; }
      }
      await route.fallback();
    });
    const page = await runtime.context.newPage();
    downloadDirectory = await mkdtemp(join(directory, ".openapply-download-"));
    if (process.platform === "win32") await secureWindowsPrivatePath(downloadDirectory);
    const cdp = await runtime.context.newCDPSession(page);
    await cdp.send("Browser.setDownloadBehavior", {
      behavior: "allowAndName", downloadPath: downloadDirectory, eventsEnabled: true,
    });
    let downloadGuid: string | undefined;
    let settle: ((path: string) => void) | undefined;
    let fail: ((error: Error) => void) | undefined;
    const completed = new Promise<string>((resolve, reject) => { settle = resolve; fail = reject; });
    void completed.catch(() => {});
    cdp.on("Browser.downloadWillBegin", (event: { guid: string }) => {
      if (downloadGuid) {
        void cdp.send("Browser.cancelDownload", { guid: event.guid }).catch(() => {});
        fail?.(new Error("Unexpected concurrent browser download"));
      } else downloadGuid = event.guid;
    });
    cdp.on("Browser.downloadProgress", (progress: { guid: string; receivedBytes: number;
      totalBytes: number; state: string; filePath?: string }) => {
      if (progress.guid !== downloadGuid) return;
      if (progress.receivedBytes > maxPdfBytes || progress.totalBytes > maxPdfBytes) {
        void cdp.send("Browser.cancelDownload", { guid: progress.guid }).catch(() => {});
        fail?.(new Error("Overleaf PDF download exceeded its transfer budget"));
      } else if (progress.state === "canceled") {
        fail?.(new Error("Overleaf PDF download was canceled"));
      } else if (progress.state === "completed") {
        if (!progress.filePath) fail?.(new Error("Browser did not provide the downloaded PDF path"));
        else settle?.(progress.filePath);
      }
    });
    await page.goto(projectUrl, { waitUntil: "domcontentloaded", timeout: 15_000 });
    if (new URL(page.url()).origin !== "https://www.overleaf.com") {
      throw new Error("Overleaf project left the approved origin");
    }
    const editor = page.getByRole("textbox", { name: "Source Editor editing", exact: true });
    await editor.waitFor({ state: "visible", timeout: 15_000 });
    if (await editor.count() !== 1) throw new Error("Overleaf source editor is unavailable");
    await editor.fill(source.latex);
    const compile = page.getByRole("button", { name: "Recompile", exact: true });
    await compile.waitFor({ state: "visible", timeout: 15_000 });
    if (await compile.count() !== 1) throw new Error("Overleaf compile control is unavailable");
    await page.evaluate(() => {
      const button = document.querySelector(".compile-button");
      if (!button) throw new Error("Overleaf compile control is unavailable");
      const observer = new MutationObserver((changes) => {
        if (changes.some((change) => change.oldValue === "true")
          || button.getAttribute("data-ol-loading") === "true") {
          button.setAttribute("data-openapply-compile-started", "true");
          observer.disconnect();
        }
      });
      observer.observe(button, { attributes: true, attributeFilter: ["data-ol-loading"], attributeOldValue: true });
    });
    await compile.click();
    await page.locator('.compile-button[data-openapply-compile-started="true"]').waitFor({ timeout: 5_000 });
    await page.locator('.compile-button[data-ol-loading="false"]').waitFor({ timeout: 30_000 });
    const downloadLink = page.getByRole("link", { name: "Download PDF", exact: true });
    await downloadLink.waitFor({ state: "visible", timeout: 15_000 });
    if (await downloadLink.count() !== 1) throw new Error("Overleaf PDF download is unavailable");
    await Promise.all([
      page.waitForEvent("download", { timeout: 15_000 }), downloadLink.click(),
    ]);
    const timeout = setTimeout(() => {
      if (downloadGuid) void cdp.send("Browser.cancelDownload", { guid: downloadGuid }).catch(() => {});
      fail?.(new Error("Overleaf PDF download timed out"));
    }, 30_000);
    let downloadedPath: string;
    try {
      downloadedPath = await completed;
    } finally { clearTimeout(timeout); }
    if (!downloadGuid || downloadedPath !== join(downloadDirectory, downloadGuid)) {
      throw new Error("Browser downloaded the PDF outside the private directory");
    }
    const handle = await open(downloadedPath, "r");
    let bytes: Buffer;
    try {
      const pinned = await handle.stat();
      if (process.platform === "win32") await sealWindowsPrivateChildPath(downloadedPath);
      const downloaded = await lstat(downloadedPath);
      if (!downloaded.isFile() || downloaded.isSymbolicLink() || downloaded.size < 100
        || downloaded.size > maxPdfBytes || !pinned.isFile()) {
        throw new Error("Overleaf downloaded an invalid PDF");
      }
      assertSameFileIdentity(pinned, downloaded);
      bytes = await handle.readFile();
      if (bytes.length !== downloaded.size) throw new Error("Overleaf PDF changed during verification");
    } finally { await handle.close(); }
    const name = createHash("sha256").update(job.id).digest("hex").slice(0, 16);
    artifactPath = join(directory, `${name}-${randomUUID()}.pdf`);
    await writeFile(artifactPath, bytes, { flag: "wx", mode: 0o600 });
    if (process.platform === "win32") await secureWindowsPrivatePath(artifactPath);
    let artifact: VerifiedResumeArtifact;
    try { artifact = await (options.verify ?? verifyResumePdf)(artifactPath, job, candidate, source); }
    catch (error) {
      if (error instanceof ResumeVisualReviewRequiredError) {
        needsVisualReview = true;
        throw new ResumeVisualReviewRequiredError(error.message, artifactPath);
      }
      throw error;
    }
    if (artifact.path !== artifactPath || artifact.jobId !== job.id
      || artifact.sourceFingerprint !== source.fingerprint
      || artifact.pdfSha256 !== createHash("sha256").update(bytes).digest("hex")) {
      throw new Error("Verified résumé artifact belongs to another job or source");
    }
    verified = true;
    return artifact;
  } finally {
    try { await runtime.close(); }
    finally {
      if (!verified && !needsVisualReview && artifactPath) await unlink(artifactPath).catch(() => {});
      if (downloadDirectory) await rm(downloadDirectory, { recursive: true, force: true });
    }
  }
}
