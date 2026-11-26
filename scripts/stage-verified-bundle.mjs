#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { platform } from "node:os";
import { stagingRoot } from "./staging-user-install.mjs";
import { verifyReleaseBundle } from "./verify-release-bundle.mjs";

const kind = "openapply-verified-selection-v1";
const idPattern = /^[0-9a-f-]{36}$/;

function privateRoot(rootArg) {
  if (!rootArg || !isAbsolute(rootArg)) throw new Error("Use a dedicated absolute release-staging root");
  const root = stagingRoot(rootArg);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  stagingRoot(root);
  return root;
}

function privateDirectory(path) {
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
    throw new Error("Release-staging directory is unsafe");
  }
}

function selection(root) {
  const path = join(root, "selection.json");
  if (!existsSync(path)) return { kind, current: null, previous: null };
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
    throw new Error("Release selection must be a private regular file");
  }
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (value.kind !== kind || ![value.current, value.previous].every((id) => id === null || idPattern.test(id))) {
    throw new Error("Release selection is invalid");
  }
  return value;
}

function withLock(root, task) {
  const lock = join(root, ".selection-lock");
  try { mkdirSync(lock, { mode: 0o700 }); }
  catch { throw new Error("Release staging is already active; inspect the lock before retrying"); }
  try { return task(); }
  finally { rmdirSync(lock); }
}

function saveSelection(root, value) {
  const temporary = join(root, `.selection-${randomUUID()}`);
  try {
    writeFileSync(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 });
    renameSync(temporary, join(root, "selection.json"));
  } finally { if (existsSync(temporary)) rmSync(temporary); }
}

function revision(root, id) {
  if (!idPattern.test(id)) throw new Error("Invalid release revision ID");
  privateDirectory(join(root, "bundles"));
  privateDirectory(join(root, "bundles", id));
  const directory = join(root, "bundles", id, "verified");
  privateDirectory(directory);
  return directory;
}

/** Selects verified bytes for a future installer; it never activates or executes them. */
export function stageVerifiedBundle(bundle, publicKeyPath, trustedKeySha256, rootArg,
  currentPlatform = platform()) {
  if (currentPlatform !== "linux") throw new Error("This staging slice currently supports Linux only");
  if (!isAbsolute(bundle) || !isAbsolute(publicKeyPath)
    || !/^[a-f0-9]{64}$/.test(trustedKeySha256 ?? "")) {
    throw new Error("Use absolute bundle/key paths and a trusted public-key fingerprint");
  }
  const keyInfo = lstatSync(publicKeyPath);
  if (!keyInfo.isFile() || keyInfo.isSymbolicLink()
    || createHash("sha256").update(readFileSync(publicKeyPath)).digest("hex") !== trustedKeySha256) {
    throw new Error("Trusted release public-key fingerprint is required");
  }
  const root = privateRoot(rootArg);
  return withLock(root, () => {
    const before = selection(root);
    const bundles = join(root, "bundles");
    mkdirSync(bundles, { recursive: true, mode: 0o700 });
    privateDirectory(bundles);
    const id = randomUUID();
    const pending = join(bundles, `.pending-${id}`);
    mkdirSync(pending, { mode: 0o700 });
    let retained = false;
    try {
      const result = verifyReleaseBundle(resolve(bundle), resolve(publicKeyPath),
        { publicKeySha256: trustedKeySha256 }, "linux", undefined, join(pending, "verified"));
      const artifact = basename(result.artifactPath);
      writeFileSync(join(pending, "metadata.json"), JSON.stringify({ kind, id,
        version: result.version, artifact, sha256: result.artifactSha256 }), { flag: "wx", mode: 0o600 });
      renameSync(pending, join(bundles, id));
      retained = true;
      try { saveSelection(root, { kind, current: id, previous: before.current }); }
      catch (error) { rmSync(join(bundles, id), { recursive: true, force: true }); throw error; }
      return { selected: id, previous: before.current, version: result.version,
        artifactSha256: result.artifactSha256, activated: false };
    } finally { if (!retained) rmSync(pending, { recursive: true, force: true }); }
  });
}

/** Restores the prior verified selection; it never downgrades a live runtime or state. */
export function rollbackVerifiedSelection(publicKeyPath, trustedKeySha256, rootArg,
  currentPlatform = platform()) {
  if (currentPlatform !== "linux") throw new Error("This staging slice currently supports Linux only");
  if (!isAbsolute(publicKeyPath) || !/^[a-f0-9]{64}$/.test(trustedKeySha256 ?? "")) {
    throw new Error("Use an absolute trusted key path and fingerprint");
  }
  const root = privateRoot(rootArg);
  return withLock(root, () => {
    const before = selection(root);
    if (!before.previous) throw new Error("No previous verified bundle is available");
    const previous = revision(root, before.previous);
    const checked = verifyReleaseBundle(previous, resolve(publicKeyPath),
      { publicKeySha256: trustedKeySha256 }, "linux");
    const metadataPath = join(root, "bundles", before.previous, "metadata.json");
    const metadataInfo = lstatSync(metadataPath);
    if (!metadataInfo.isFile() || metadataInfo.isSymbolicLink() || (metadataInfo.mode & 0o077) !== 0) {
      throw new Error("Previous release metadata is unsafe");
    }
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
    if (metadata.kind !== kind || metadata.id !== before.previous
      || metadata.sha256 !== checked.artifactSha256 || metadata.version !== checked.version) {
      throw new Error("Previous release metadata does not match verified bytes");
    }
    saveSelection(root, { kind, current: before.previous, previous: before.current });
    return { selected: before.previous, previous: before.current, version: checked.version, activated: false };
  });
}

export function verifiedSelectionStatus(rootArg) {
  if (!rootArg || !isAbsolute(rootArg)) throw new Error("Use a dedicated absolute release-staging root");
  const root = stagingRoot(rootArg);
  return { ...selection(root), activated: false };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const [action, ...args] = process.argv.slice(2);
  const trusted = process.env.OPENAPPLY_RELEASE_KEY_SHA256;
  if (action === "stage" && args.length === 3) {
    console.log(JSON.stringify(stageVerifiedBundle(args[0], args[1], trusted, args[2])));
  } else if (action === "rollback" && args.length === 2) {
    console.log(JSON.stringify(rollbackVerifiedSelection(args[0], trusted, args[1])));
  } else if (action === "status" && args.length === 1) {
    console.log(JSON.stringify(verifiedSelectionStatus(args[0])));
  } else throw new Error("Usage: stage-verified-bundle.mjs stage BUNDLE PUBLIC_KEY ROOT | rollback PUBLIC_KEY ROOT | status ROOT");
}
