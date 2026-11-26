import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, unlink, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pageIdFromResult, resultText, type BrowserToolClient, type BrowserToolResult } from "../browser/client.js";
import type { CandidateProfile } from "../candidate/schema.js";
import type { DiscoveredJob } from "../types.js";
import type { ResumeSource } from "./jake.js";
import { verifyResumePdf, type VerifiedResumeArtifact } from "./verify-pdf.js";
import { ResumeVisualReviewRequiredError } from "./visual-qa.js";

function requireSuccess(result: BrowserToolResult, step: string): string {
  if (result.isError) throw new Error(`Overleaf ${step} failed`);
  return resultText(result);
}

function controlRef(snapshot: string, role: string, label: string): string {
  const line = snapshot.split("\n").find((entry) => entry.trimStart().startsWith(`- ${role} "${label}"`)
    && /\[ref=e\d+\]/.test(entry));
  const ref = line?.match(/\[ref=(e\d+)\]/)?.[1];
  if (!ref || line?.includes("[disabled]")) throw new Error(`Overleaf ${label} control is unavailable`);
  return ref;
}

function downloadPath(result: BrowserToolResult, downloadsDirectory: string): string {
  const message = requireSuccess(result, "download");
  const path = message.match(/\bto:\s*([^\r\n]+\.pdf)\b/i)?.[1];
  if (!path) throw new Error("Overleaf did not return a PDF download path");
  const absolute = resolve(path);
  if (dirname(absolute) !== resolve(downloadsDirectory) || !basename(absolute).toLowerCase().endsWith(".pdf")) {
    throw new Error("Overleaf downloaded outside the approved directory");
  }
  return absolute;
}

export function assertLocalBrowserEndpoint(endpoint: string): void {
  const url = new URL(endpoint);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || url.username || url.password) {
    throw new Error("BrowserOS endpoint must be local HTTP without embedded credentials");
  }
}

export function assertOverleafProjectUrl(projectUrl: string): void {
  const url = new URL(projectUrl);
  if (url.protocol !== "https:" || url.hostname !== "www.overleaf.com"
    || !/^\/project\/[a-f0-9]{24}$/.test(url.pathname) || url.search || url.hash
    || url.username || url.password) {
    throw new Error("Use a direct HTTPS Overleaf project URL");
  }
}

export async function renderOverleafResume(
  client: BrowserToolClient,
  projectUrl: string,
  job: DiscoveredJob,
  candidate: CandidateProfile,
  source: ResumeSource,
  outputDirectory: string,
  options: { downloadsDirectory?: string; verify?: typeof verifyResumePdf } = {},
): Promise<VerifiedResumeArtifact> {
  assertOverleafProjectUrl(projectUrl);
  if (process.platform === "win32") {
    throw new Error("BrowserOS Overleaf downloads require Windows private artifact support");
  }
  const downloadsDirectory = options.downloadsDirectory ?? join(userInfo().homedir, "Downloads");
  requireSuccess(await client.callTool({ name: "name_session", arguments: {
    name: "resume rendering", category: "dev-tools", summary: "Compile a private role-specific résumé in Overleaf",
  } }), "session");
  const opened = await client.callTool({ name: "tabs", arguments: { action: "new", url: projectUrl } });
  requireSuccess(opened, "open project");
  const page = pageIdFromResult(opened);
  let completed = false;
  try {
    const first = requireSuccess(await client.callTool({ name: "snapshot", arguments: {
      page, mode: "interactive", depth: 3,
    } }), "editor snapshot");
    const editorRef = controlRef(first, "textbox", "Source Editor editing");
    requireSuccess(await client.callTool({ name: "act", arguments: {
      page, kind: "fill", ref: editorRef, value: source.latex, sensitive: true, diff: "none",
    } }), "source update");
    const afterEdit = requireSuccess(await client.callTool({ name: "snapshot", arguments: {
      page, mode: "interactive", depth: 3,
    } }), "compile snapshot");
    const compileRef = controlRef(afterEdit, "button", "Recompile");
    requireSuccess(await client.callTool({ name: "act", arguments: {
      page, kind: "click", ref: compileRef, diff: "none",
    } }), "compile");
    const wait = requireSuccess(await client.callTool({ name: "wait", arguments: {
      page, for: "selector", value: '.compile-button[data-ol-loading="false"]', timeout: 30000,
    } }), "compile wait");
    if (!wait.startsWith("matched")) throw new Error("Overleaf compilation did not finish");
    const compiled = requireSuccess(await client.callTool({ name: "snapshot", arguments: {
      page, mode: "interactive", depth: 3,
    } }), "PDF snapshot");
    const downloadRef = controlRef(compiled, "link", "Download PDF");
    const downloadStartedAt = Date.now();
    const downloaded = downloadPath(await client.callTool({ name: "download", arguments: {
      page, ref: downloadRef,
    } }), downloadsDirectory);
    const handle = await open(downloaded, constants.O_RDONLY | constants.O_NOFOLLOW);
    let bytes: Buffer;
    let downloadedIdentity: { dev: number; ino: number };
    try {
      const file = await handle.stat();
      if (!file.isFile() || file.size < 100 || file.size > 5_000_000
        || file.mtimeMs + 2_000 < downloadStartedAt) {
        throw new Error("Overleaf downloaded an invalid or stale PDF file");
      }
      downloadedIdentity = { dev: file.dev, ino: file.ino };
      bytes = await handle.readFile();
    } finally {
      await handle.close();
    }
    const directory = resolve(outputDirectory);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()
      || (process.getuid && metadata.uid !== process.getuid())
      || (metadata.mode & 0o077) !== 0) {
      throw new Error("Résumé artifact directory must be private to this user");
    }
    const name = createHash("sha256").update(job.id).digest("hex").slice(0, 16);
    const artifactPath = join(directory, `${name}-${randomUUID()}.pdf`);
    await writeFile(artifactPath, bytes, { flag: "wx", mode: 0o600 });
    let artifact: VerifiedResumeArtifact;
    try { artifact = await (options.verify ?? verifyResumePdf)(artifactPath, job, candidate, source); }
    catch (error) {
      if (error instanceof ResumeVisualReviewRequiredError) {
        throw new ResumeVisualReviewRequiredError(error.message, artifactPath);
      }
      throw error;
    }
    const currentDownload = await lstat(downloaded);
    if (currentDownload.isFile() && !currentDownload.isSymbolicLink()
      && currentDownload.dev === downloadedIdentity.dev && currentDownload.ino === downloadedIdentity.ino) {
      await unlink(downloaded);
    }
    completed = true;
    return artifact;
  } finally {
    if (completed) await client.callTool({ name: "tabs", arguments: { action: "close", page } });
  }
}
