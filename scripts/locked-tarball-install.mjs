import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, unlinkSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateRuntimeLock } from "./pack-runtime-lock.mjs";

const npmCli = process.env.npm_execpath;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${basename(command)} ${args[0]} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

/** Extract a trusted local tarball and use its locked hashes before starting any package code. */
export function installLockedTarball(tarballPath, destination) {
  if (!npmCli) throw new Error("Run through npm so its CLI path is available");
  if (!isAbsolute(tarballPath) || !tarballPath.endsWith(".tgz") || !statSync(tarballPath).isFile()) {
    throw new Error("A local absolute .tgz path is required");
  }
  const target = resolve(destination);
  if (existsSync(target)) throw new Error("Locked install destination already exists");
  mkdirSync(target, { mode: 0o700 });
  try {
    // Validate and extract the same private copy, even if the caller's path changes.
    const archive = join(target, "artifact.tgz");
    copyFileSync(tarballPath, archive);
    const listing = run("tar", ["-tzf", archive]).trim().split(/\r?\n/);
    const safe = (path) => path.startsWith("package/") && !path.includes("\\")
      && !path.split("/").includes("..") && !path.includes("\0");
    if (!listing.length || listing.some((path) => !safe(path))) throw new Error("Unsafe package archive path");
    const verbose = run("tar", ["-tvzf", archive]).trim().split(/\r?\n/);
    if (verbose.length !== listing.length || verbose.some((line) => !/^[-d]/.test(line))) {
      throw new Error("Package archive contains a link or unsupported entry");
    }
    run("tar", ["-xzf", archive, "-C", target]);
    unlinkSync(archive);
    const packageRoot = join(target, "package");
    const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
    const lockFile = join(packageRoot, "runtime-package-lock.json");
    const lock = JSON.parse(readFileSync(lockFile, "utf8"));
    validateRuntimeLock(pkg, lock);
    copyFileSync(lockFile, join(packageRoot, "package-lock.json"));
    run(process.execPath, [npmCli, "ci", "--prefix", packageRoot, "--omit=dev",
      "--ignore-scripts", "--no-audit", "--no-fund", "--fetch-retries=0"]);
    const cli = join(packageRoot, "dist", "src", "product-cli.js");
    if (!run(process.execPath, [cli, "--help"]).includes("  autopilot")) {
      throw new Error("Locked OpenApply CLI did not start");
    }
    run(process.execPath, ["--input-type=module", "-e",
      "await Promise.all(['playwright','@napi-rs/canvas','@napi-rs/keyring','@modelcontextprotocol/sdk/client/index.js'].map(name => import(name)))"],
    { cwd: packageRoot });
    return { packageRoot, version: pkg.version };
  } catch (error) {
    rmSync(target, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.length !== 4) throw new Error("Usage: locked-tarball-install.mjs ABSOLUTE_TARBALL DESTINATION");
  console.log(JSON.stringify(installLockedTarball(process.argv[2], process.argv[3])));
}
