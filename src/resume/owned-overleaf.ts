import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, unlink, writeFile } from "node:fs/promises";
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
    await page.goto(projectUrl, { waitUntil: "domcontentloaded", timeout: 15_000 });
    if (new URL(page.url()).origin !== "https://www.overleaf.com") {
      throw new Error("Overleaf project left the approved origin");
    }
    const editor = page.getByRole("textbox", { name: "Source Editor editing", exact: true });
    if (await editor.count() !== 1) throw new Error("Overleaf source editor is unavailable");
    await editor.fill(source.latex);
    const compile = page.getByRole("button", { name: "Recompile", exact: true });
    if (await compile.count() !== 1) throw new Error("Overleaf compile control is unavailable");
    await compile.click();
    await page.locator('.compile-button[data-ol-loading="false"]').waitFor({ timeout: 30_000 });
    const downloadLink = page.getByRole("link", { name: "Download PDF", exact: true });
    if (await downloadLink.count() !== 1) throw new Error("Overleaf PDF download is unavailable");
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 15_000 }), downloadLink.click(),
    ]);
    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of stream) {
      const bytes = Buffer.from(chunk as Uint8Array);
      size += bytes.length;
      if (size > 5_000_000) throw new Error("Overleaf PDF exceeds the artifact size limit");
      chunks.push(bytes);
    }
    if (size < 100) throw new Error("Overleaf downloaded an invalid PDF");
    const bytes = Buffer.concat(chunks);
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
    finally { if (!verified && artifactPath) await unlink(artifactPath).catch(() => {}); }
  }
}
