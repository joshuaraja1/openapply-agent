#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const platforms = ["darwin", "win32", "linux"];
const extensions = { darwin: ".pkg", win32: ".msi", linux: ".tar.gz" };

function regularFile(path) {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Release bundle contains a linked or non-file entry");
}

function command(program, args, env = process.env) {
  const result = spawnSync(program, args, { env, encoding: "utf8", timeout: 30_000, maxBuffer: 65_536 });
  if (result.error || result.status !== 0) throw new Error(`${program} release verification failed`);
  return result.stdout + result.stderr;
}

function verifyNative(platform, file, trusted, run = command) {
  if (platform === "darwin") {
    if (!/^[A-Z0-9]{10}$/.test(trusted.appleTeamId ?? "")) throw new Error("Trusted Apple team ID is required");
    const signature = run("pkgutil", ["--check-signature", file]);
    if (!signature.includes("Signed with a trusted timestamp")
      || !signature.split(/\r?\n/).some((line) =>
        /^\s*1\. Developer ID Installer: .+ \([A-Z0-9]{10}\)\s*$/.test(line)
        && line.includes(`(${trusted.appleTeamId})`))) {
      throw new Error("macOS installer is not signed by the trusted Developer ID Installer");
    }
    run("xcrun", ["stapler", "validate", file]);
    run("spctl", ["--assess", "--type", "install", "--verbose=4", file]);
  } else if (platform === "win32") {
    if (!/^[A-Fa-f0-9]{40}$/.test(trusted.windowsThumbprint ?? "")) {
      throw new Error("Trusted Windows signing certificate thumbprint is required");
    }
    const script = "$s = Get-AuthenticodeSignature -LiteralPath $env:OPENAPPLY_RELEASE_ARTIFACT; " +
      "[pscustomobject]@{Status = [string]$s.Status; Thumbprint = [string]$s.SignerCertificate.Thumbprint} | ConvertTo-Json -Compress";
    const output = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script],
      { ...process.env, OPENAPPLY_RELEASE_ARTIFACT: file });
    const signature = JSON.parse(output);
    if (signature.Status !== "Valid"
      || signature.Thumbprint?.toUpperCase() !== trusted.windowsThumbprint.toUpperCase()) {
      throw new Error("Windows installer has no valid trusted Authenticode signature");
    }
  }
}

/** A release is verified only after the manifest signature, all hashes, and this OS's native signature pass. */
export function verifyReleaseBundle(directory, publicKeyPath, trusted = {}, currentPlatform = process.platform,
  run = command) {
  if (!platforms.includes(currentPlatform)) throw new Error("Unsupported release platform");
  const bundle = resolve(directory);
  const manifestPath = join(bundle, "release-manifest.json");
  const signaturePath = join(bundle, "release-manifest.sig");
  for (const path of [manifestPath, signaturePath, publicKeyPath]) regularFile(path);
  const bytes = readFileSync(manifestPath);
  const signature = readFileSync(signaturePath);
  const keyBytes = readFileSync(publicKeyPath);
  if (!/^[a-f0-9]{64}$/.test(trusted.publicKeySha256 ?? "")
    || createHash("sha256").update(keyBytes).digest("hex") !== trusted.publicKeySha256) {
    throw new Error("Trusted release public-key fingerprint is required");
  }
  const publicKey = createPublicKey(keyBytes);
  if (publicKey.asymmetricKeyType !== "ed25519" || signature.length !== 64
    || !verifySignature(null, bytes, publicKey, signature)) {
    throw new Error("Release manifest signature is invalid");
  }
  const manifest = JSON.parse(bytes.toString("utf8"));
  if (manifest.schemaVersion !== 1 || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(manifest.version ?? "")
    || !Array.isArray(manifest.artifacts) || manifest.artifacts.length !== platforms.length) {
    throw new Error("Release manifest is incomplete");
  }
  const byPlatform = new Map();
  for (const item of manifest.artifacts) {
    if (!platforms.includes(item.platform) || byPlatform.has(item.platform)
      || typeof item.file !== "string" || basename(item.file) !== item.file
      || !item.file.endsWith(extensions[item.platform])
      || !/^[a-f0-9]{64}$/.test(item.sha256 ?? "")) {
      throw new Error("Release manifest has an invalid artifact");
    }
    const path = join(bundle, item.file);
    regularFile(path);
    if (createHash("sha256").update(readFileSync(path)).digest("hex") !== item.sha256) {
      throw new Error("Release artifact hash mismatch");
    }
    byPlatform.set(item.platform, path);
  }
  if (byPlatform.size !== platforms.length) throw new Error("Release manifest lacks a platform");
  verifyNative(currentPlatform, byPlatform.get(currentPlatform), trusted, run);
  return { version: manifest.version, platform: currentPlatform, verified: true };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  if (process.argv.length !== 4) {
    throw new Error("Usage: verify-release-bundle.mjs BUNDLE_DIRECTORY TRUSTED_PUBLIC_KEY_PEM");
  }
  const result = verifyReleaseBundle(process.argv[2], process.argv[3], {
    publicKeySha256: process.env.OPENAPPLY_RELEASE_KEY_SHA256,
    appleTeamId: process.env.OPENAPPLY_APPLE_TEAM_ID,
    windowsThumbprint: process.env.OPENAPPLY_WINDOWS_CERT_THUMBPRINT,
  });
  console.log(JSON.stringify(result));
}
