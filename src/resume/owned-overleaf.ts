import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { join, resolve } from "node:path";
import type { BrowserRuntime } from "../browser/runtime.js";
import { launchBrowser } from "../browser/runtime.js";
import type { CandidateProfile } from "../candidate/schema.js";
import type { DiscoveredJob } from "../types.js";
import type { ResumeSource } from "./jake.js";
import { assertOverleafProjectUrl } from "./overleaf.js";
import { verifyResumePdf, type VerifiedResumeArtifact } from "./verify-pdf.js";

type Launch = (options: { profileDirectory: string; headless: boolean }) => Promise<BrowserRuntime>;
const maxPdfBytes = 5_000_000;

/** Compile through the user's persistent local browser session. */
export async function renderOwnedOverleafResume(
  projectUrl: string, job: DiscoveredJob, candidate: CandidateProfile, source: ResumeSource,
  outputDirectory: string,
  options: { launch?: Launch; verify?: typeof verifyResumePdf; profileDirectory?: string } = {},
): Promise<VerifiedResumeArtifact> {
  assertOverleafProjectUrl(projectUrl);
  if (process.platform === "win32") throw new Error("Owned Overleaf output needs Windows artifact ACL support");
  const directory = resolve(outputDirectory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()
    || (process.getuid && metadata.uid !== process.getuid()) || (metadata.mode & 0o077) !== 0) {
    throw new Error("Résumé artifact directory must be private to this user");
  }
  const runtime = await (options.launch ?? launchBrowser)({
    profileDirectory: options.profileDirectory ?? join(userInfo().homedir, ".openapply-agent", "browser-profile"),
    headless: false,
  });
  let artifactPath: string | undefined;
  let downloadDirectory: string | undefined;
  let verified = false;
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
    await compile.click();
    await page.locator('.compile-button[data-ol-loading="true"]').waitFor({ timeout: 5_000 });
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
    const downloaded = await lstat(downloadedPath);
    if (!downloaded.isFile() || downloaded.isSymbolicLink() || downloaded.size < 100
      || downloaded.size > maxPdfBytes) throw new Error("Overleaf downloaded an invalid PDF");
    const bytes = await readFile(downloadedPath);
    if (bytes.length !== downloaded.size) throw new Error("Overleaf PDF changed during verification");
    const name = createHash("sha256").update(job.id).digest("hex").slice(0, 16);
    artifactPath = join(directory, `${name}-${randomUUID()}.pdf`);
    await writeFile(artifactPath, bytes, { flag: "wx", mode: 0o600 });
    const artifact = await (options.verify ?? verifyResumePdf)(artifactPath, job, candidate, source);
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
      if (!verified && artifactPath) await unlink(artifactPath).catch(() => {});
      if (downloadDirectory) await rm(downloadDirectory, { recursive: true, force: true });
    }
  }
}
