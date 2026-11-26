#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { installLockedTarball } from "./locked-tarball-install.mjs";

const installPath = "/Applications/OpenApply";
const packageId = "xyz.openapplyagent.cli";

function command(program, args) {
  const result = spawnSync(program, args, { encoding: "utf8", timeout: 600_000, maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`${basename(program)} ${args[0]} failed: ${result.stderr || result.stdout || result.error?.message}`);
  return result.stdout;
}

function nativeFiles(root) {
  const files = [];
  const visit = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const next = join(path, entry.name);
      if (entry.isDirectory()) visit(next);
      else if (entry.isFile() && /\.(?:node|dylib)$/.test(entry.name)) files.push(next);
    }
  };
  visit(root);
  return files.sort();
}

function identities(options) {
  const team = options.teamId;
  if (!/^[A-Z0-9]{10}$/.test(team ?? "")) throw new Error("Apple team ID is required");
  for (const [kind, identity] of [["Application", options.appIdentity], ["Installer", options.installerIdentity]]) {
    if (typeof identity !== "string" || !identity.startsWith(`Developer ID ${kind}: `)
      || !identity.endsWith(` (${team})`)) throw new Error(`Developer ID ${kind} identity must match the trusted Apple team`);
  }
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(options.notaryProfile ?? "")) throw new Error("A Keychain notary profile is required");
}

function standaloneNode(binary, run) {
  if (!isAbsolute(binary) || !lstatSync(binary).isFile()) throw new Error("Use an absolute regular Node binary");
  const version = run(binary, ["--version"]).trim();
  const match = /^v(\d+)\.(\d+)\./.exec(version);
  if (!match || Number(match[1]) < 22 || (Number(match[1]) === 22 && Number(match[2]) < 13)) {
    throw new Error("Bundled Node must be version 22.13 or later");
  }
  const libraries = run("otool", ["-L", binary]).split(/\r?\n/).slice(1)
    .map((line) => line.trim().split(" (")[0]).filter(Boolean);
  if (!libraries.length || libraries.some((path) => !path.startsWith("/System/Library/") && !path.startsWith("/usr/lib/"))) {
    throw new Error("Bundled Node has external dynamic libraries; use a standalone Node distribution");
  }
}

/** Build an owner-independent CLI PKG; unsigned mode exists only for structural CI smoke. */
export function buildMacOSPkg(tarballPath, outputPath, options = {}, run = command, install = installLockedTarball) {
  if (process.platform !== "darwin") throw new Error("macOS PKG builds require macOS");
  if (!isAbsolute(tarballPath) || !tarballPath.endsWith(".tgz") || !lstatSync(tarballPath).isFile()) {
    throw new Error("Pass an absolute regular npm tarball");
  }
  if (!isAbsolute(outputPath) || !outputPath.endsWith(".pkg")
    || lstatSync(outputPath, { throwIfNoEntry: false })) {
    throw new Error("Output must be a new absolute .pkg path");
  }
  const parent = lstatSync(dirname(outputPath));
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error("PKG output parent is unsafe");
  if (!options.unsignedSmoke) identities(options);
  const scratch = mkdtempSync(join(tmpdir(), "openapply-macos-pkg-"));
  const payload = join(scratch, "payload");
  const appRoot = join(payload, installPath);
  const unsigned = join(scratch, "unsigned.pkg");
  const signed = join(scratch, "signed.pkg");
  try {
    const installed = install(tarballPath, join(scratch, "locked"));
    const version = installed.version;
    if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) throw new Error("Invalid package version");
    mkdirSync(join(appRoot, "bin"), { recursive: true, mode: 0o755 });
    cpSync(installed.packageRoot, join(appRoot, "runtime", "package"), { recursive: true, dereference: false });
    const configuredNode = options.nodeBinary ?? process.execPath;
    if (!isAbsolute(configuredNode)) throw new Error("Use an absolute Node binary path");
    const sourceNode = resolve(configuredNode);
    standaloneNode(sourceNode, run);
    const node = join(appRoot, "bin", "node");
    copyFileSync(sourceNode, node);
    chmodSync(node, 0o755);
    const launcher = join(appRoot, "bin", "openapply");
    writeFileSync(launcher, `#!/bin/sh\nset -eu\nexec "${installPath}/bin/node" "${installPath}/runtime/package/dist/src/product-cli.js" "$@"\n`, { mode: 0o755 });
    run(node, [join(appRoot, "runtime", "package", "dist", "src", "product-cli.js"), "--help"]);
    if (!options.unsignedSmoke) {
      for (const file of [...nativeFiles(join(appRoot, "runtime")), node]) {
        run("codesign", ["--force", "--options", "runtime", "--timestamp", "--sign", options.appIdentity, file]);
        run("codesign", ["--verify", "--strict", "--verbose=2", file]);
      }
    }
    run("pkgbuild", ["--root", payload, "--identifier", packageId, "--version", version,
      "--install-location", "/", "--ownership", "recommended", unsigned]);
    let artifact = unsigned;
    if (!options.unsignedSmoke) {
      run("productsign", ["--sign", options.installerIdentity, unsigned, signed]);
      artifact = signed;
      const signature = run("pkgutil", ["--check-signature", artifact]);
      if (!signature.includes("Signed with a trusted timestamp")
        || !signature.split(/\r?\n/).some((line) =>
          /^\s*1\. Developer ID Installer: .+ \(([A-Z0-9]{10})\)\s*$/.exec(line)?.[1] === options.teamId)) {
        throw new Error("PKG signature does not match the trusted Developer ID Installer");
      }
      const submission = JSON.parse(run("xcrun", ["notarytool", "submit", artifact,
        "--keychain-profile", options.notaryProfile, "--wait", "--output-format", "json"]));
      if (submission.status !== "Accepted") throw new Error("Apple notarization was not accepted");
      run("xcrun", ["stapler", "staple", artifact]);
      run("xcrun", ["stapler", "validate", artifact]);
      run("spctl", ["--assess", "--type", "install", artifact]);
    }
    renameSync(artifact, outputPath);
    return { outputPath, version, signedAndNotarized: !options.unsignedSmoke };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  if (process.argv.length < 4 || process.argv.length > 5 || (process.argv[4] && process.argv[4] !== "--unsigned-smoke")) {
    throw new Error("Usage: build-macos-pkg.mjs ABSOLUTE_TARBALL NEW_ABSOLUTE_PKG [--unsigned-smoke]");
  }
  const result = buildMacOSPkg(process.argv[2], process.argv[3], {
    unsignedSmoke: process.argv[4] === "--unsigned-smoke",
    nodeBinary: process.env.OPENAPPLY_MAC_NODE_BINARY,
    teamId: process.env.OPENAPPLY_APPLE_TEAM_ID,
    appIdentity: process.env.OPENAPPLY_MAC_APP_IDENTITY,
    installerIdentity: process.env.OPENAPPLY_MAC_INSTALLER_IDENTITY,
    notaryProfile: process.env.OPENAPPLY_MAC_NOTARY_PROFILE,
  });
  console.log(JSON.stringify(result));
}
