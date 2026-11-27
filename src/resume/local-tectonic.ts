import { randomUUID } from "node:crypto";
import { execFile, type ExecFileOptions } from "node:child_process";
import { chmod, lstat, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { CandidateProfile } from "../candidate/schema.js";
import type { DiscoveredJob } from "../types.js";
import { readBundledJakeTemplate } from "./bundled-template.js";
import { createJakeResumeSource, type ResumeSource } from "./jake.js";
import { verifyResumePdf, type VerifiedResumeArtifact } from "./verify-pdf.js";

const execute = promisify(execFile);
const MAX_SOURCE_BYTES = 200_000;
const MAX_PDF_BYTES = 5_000_000;
const MAX_DIAGNOSTIC_BYTES = 64_000;
const RENDER_TIMEOUT_MS = 20_000;

export interface LocalTectonicOptions {
  /** Trusted deployment config, never supplied by a candidate or queue body. */
  binary: string;
  /** Prepopulated trusted offline cache; never a candidate-controlled path. */
  cacheDirectory: string;
  /** Test seam for timeout/error checks; production uses execFile. */
  execute?: (binary: string, args: string[], options: ExecFileOptions) => Promise<unknown>;
}

/** Render Jake source offline in a private directory, then verify the PDF for
 * the exact job and approved claims before returning its path. */
export async function renderLocalJakePdf(source: ResumeSource, job: DiscoveredJob,
  candidate: CandidateProfile, privateWorkDirectory: string,
  options: LocalTectonicOptions): Promise<VerifiedResumeArtifact> {
  if (!isAbsolute(options.binary) || !isAbsolute(options.cacheDirectory)
    || !isAbsolute(privateWorkDirectory)
    || !/^[a-f0-9]{64}$/.test(source.renderToken)
    || Buffer.byteLength(source.latex, "utf8") > MAX_SOURCE_BYTES) {
    throw new Error("Hosted résumé render inputs are invalid");
  }
  const expected = createJakeResumeSource(await readBundledJakeTemplate(), job, candidate);
  if (source.latex !== expected.latex || source.fingerprint !== expected.fingerprint
    || source.renderToken !== expected.renderToken
    || JSON.stringify(source.claimIds) !== JSON.stringify(expected.claimIds)) {
    throw new Error("Hosted résumé source differs from approved Jake output");
  }
  const work = resolve(privateWorkDirectory);
  const directory = await lstat(work);
  if (!directory.isDirectory() || directory.isSymbolicLink()
    || await realpath(work) !== work
    || (process.platform !== "win32" && (directory.mode & 0o077) !== 0)) {
    throw new Error("Hosted résumé work directory is not private");
  }
  const binary = resolve(options.binary);
  const executable = await lstat(binary);
  if (!executable.isFile() || executable.isSymbolicLink()) {
    throw new Error("Hosted TeX executable is unavailable");
  }
  const cache = await lstat(resolve(options.cacheDirectory));
  if (!cache.isDirectory() || cache.isSymbolicLink()) {
    throw new Error("Hosted TeX offline cache is unavailable");
  }
  const stage = await mkdtemp(join(work, ".resume-render-"));
  const output = join(work, `resume-${randomUUID()}.pdf`);
  try {
    const input = join(stage, "main.tex");
    await writeFile(input, source.latex, { flag: "wx", mode: 0o600 });
    try {
      const env: NodeJS.ProcessEnv = { HOME: stage,
        XDG_CACHE_HOME: resolve(options.cacheDirectory),
        TECTONIC_CACHE_DIR: resolve(options.cacheDirectory),
        PATH: "/usr/bin:/bin", SOURCE_DATE_EPOCH: "0" };
      await (options.execute ?? execute)(binary,
        ["--untrusted", "--only-cached", "-Z", "deterministic-mode",
          "--outdir", stage, input], {
          cwd: stage, timeout: RENDER_TIMEOUT_MS, maxBuffer: MAX_DIAGNOSTIC_BYTES,
          env,
        });
    } catch {
      throw new Error("Hosted résumé compiler failed or timed out");
    }
    const rendered = join(stage, "main.pdf");
    const file = await lstat(rendered);
    if (!file.isFile() || file.isSymbolicLink() || file.size < 100 || file.size > MAX_PDF_BYTES) {
      throw new Error("Hosted résumé compiler produced an invalid PDF file");
    }
    const magic = await readFile(rendered);
    if (!magic.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
      throw new Error("Hosted résumé compiler did not produce a PDF");
    }
    await chmod(rendered, 0o600);
    // The stage lives under the work directory, so rename is atomic on the
    // same filesystem and no partially copied PDF is ever exposed.
    await rename(rendered, output);
    const final = await lstat(output);
    if (!final.isFile() || final.isSymbolicLink() || final.size !== file.size
      || !output.startsWith(`${work}${sep}`)) {
      throw new Error("Hosted résumé PDF left its private work directory");
    }
    return await verifyResumePdf(output, job, candidate, source);
  } catch (error) {
    await rm(output, { force: true }).catch(() => {});
    throw error;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
