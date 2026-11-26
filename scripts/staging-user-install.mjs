#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { basename, isAbsolute, join, parse, resolve } from "node:path";

const markerName = ".openapply-staging.json";
const npmCli = process.env.npm_execpath;

function defaultRoot() {
  if (platform() === "win32") return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "OpenApply", "staging");
  if (platform() === "darwin") return join(homedir(), "Library", "Application Support", "OpenApply", "staging");
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "openapply", "staging");
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${basename(command)} ${args[0]} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

function managedRuntime(root) {
  const runtime = join(root, "runtime");
  if (!existsSync(runtime)) return undefined;
  if (!lstatSync(runtime).isDirectory()) throw new Error("Staging runtime is not a regular directory");
  const marker = join(runtime, markerName);
  if (!existsSync(marker) || !lstatSync(marker).isFile()) throw new Error("Refusing to alter an unmarked runtime");
  const metadata = JSON.parse(readFileSync(marker, "utf8"));
  if (metadata.kind !== "openapply-user-staging" || typeof metadata.version !== "string"
    || !/^[a-f0-9]{64}$/.test(metadata.tarballSha256)) throw new Error("Invalid staging marker");
  const entries = readdirSync(runtime).sort();
  if (entries.some((entry) => ![markerName, "node_modules", "package.json"].includes(entry))) {
    throw new Error(`Runtime contains unexpected files: ${entries.join(", ")}; inspect before uninstalling`);
  }
  return { runtime, metadata };
}

export function stagingRoot(arg) {
  const root = resolve(arg ?? defaultRoot());
  if (root === parse(root).root || root === resolve(homedir()) || root === resolve(process.cwd())) {
    throw new Error("Choose a dedicated staging directory");
  }
  if (existsSync(root) && !lstatSync(root).isDirectory()) throw new Error("Staging root is not a regular directory");
  return root;
}

export function installStaging(tarballPath, rootArg, withBrowser = false) {
  if (!npmCli) throw new Error("Run through npm so its CLI path is available");
  const tarball = resolve(tarballPath);
  if (!isAbsolute(tarballPath) || !statSync(tarball).isFile() || !tarball.endsWith(".tgz")) {
    throw new Error("Pass an absolute local .tgz package path");
  }
  const root = stagingRoot(rootArg);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (existsSync(join(root, "runtime"))) throw new Error("A staging runtime already exists; uninstall it first");
  const stage = join(root, `.pending-${randomUUID()}`);
  mkdirSync(stage, { mode: 0o700 });
  try {
    run(process.execPath, [npmCli, "install", "--prefix", stage, "--ignore-scripts", "--no-audit",
      "--no-fund", "--no-package-lock", tarball]);
    const installed = join(stage, "node_modules", "openapply-agent");
    const manifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
    const cli = join(installed, "dist", "src", "product-cli.js");
    if (!statSync(cli).isFile()) throw new Error("Installed package has no OpenApply CLI");
    if (!run(process.execPath, [cli, "--help"]).includes("  browser:install")) {
      throw new Error("Installed OpenApply CLI did not start");
    }
    if (withBrowser) {
      run(process.execPath, [cli, "browser:install"]);
      run(process.execPath, [cli, "browser:doctor"]);
    }
    const tarballSha256 = createHash("sha256").update(readFileSync(tarball)).digest("hex");
    writeFileSync(join(stage, markerName), JSON.stringify({ kind: "openapply-user-staging",
      version: manifest.version, tarballSha256, browserChecked: withBrowser }), { mode: 0o600, flag: "wx" });
    renameSync(stage, join(root, "runtime"));
    return { version: manifest.version, root, browserChecked: withBrowser };
  } finally {
    if (existsSync(stage)) rmSync(stage, { recursive: true, force: true });
  }
}

export function uninstallStaging(rootArg) {
  const root = stagingRoot(rootArg);
  const managed = managedRuntime(root);
  if (!managed) return { removed: false, root };
  rmSync(managed.runtime, { recursive: true });
  return { removed: true, root };
}

export function statusStaging(rootArg) {
  const root = stagingRoot(rootArg);
  const managed = managedRuntime(root);
  return managed ? { installed: true, root, ...managed.metadata } : { installed: false, root };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const [command, ...args] = process.argv.slice(2);
  const rootIndex = args.indexOf("--root");
  const root = rootIndex >= 0 ? args[rootIndex + 1] : undefined;
  if (rootIndex >= 0 && !root) throw new Error("--root needs a directory");
  if (command === "install") console.log(JSON.stringify(installStaging(args[0], root, args.includes("--with-browser"))));
  else if (command === "uninstall") console.log(JSON.stringify(uninstallStaging(root)));
  else if (command === "status") console.log(JSON.stringify(statusStaging(root)));
  else throw new Error("Usage: staging-user-install.mjs install <absolute-tarball> [--root DIR] [--with-browser] | status [--root DIR] | uninstall [--root DIR]");
}
