#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const platforms = ["darwin", "win32", "linux"];
const extensions = { darwin: [".pkg"], win32: [".msi", ".exe"], linux: [".tar.gz"] };

function regularFile(path) {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Release bundle contains a linked or non-file entry");
}

function command(program, args, env = process.env) {
  const result = spawnSync(program, args, { env, encoding: "utf8", timeout: 30_000, maxBuffer: 65_536 });
  if (result.error || result.status !== 0) throw new Error(`${program} release verification failed`);
  return result.stdout + result.stderr;
}

function protectWindowsCopyDirectory(path, run = command) {
  if (process.platform !== "win32") return;
  const script = `
$ErrorActionPreference = 'Stop'
$item = [System.IO.DirectoryInfo]::new($env:OPENAPPLY_RELEASE_COPY_PATH)
$owner = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = $item.GetAccessControl()
$acl.SetAccessRuleProtection($true, $false)
$acl.SetOwner($owner)
foreach ($rule in @($acl.GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier]))) {
  [void]$acl.RemoveAccessRuleAll($rule)
}
$rights = [System.Security.AccessControl.FileSystemRights]::FullControl
$inherit = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
  [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
  $owner, $rights, $inherit, [System.Security.AccessControl.PropagationFlags]::None,
  [System.Security.AccessControl.AccessControlType]::Allow)
[void]$acl.AddAccessRule($rule)
$item.SetAccessControl($acl)
$actual = $item.GetAccessControl()
$rules = @($actual.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
if (-not $actual.AreAccessRulesProtected -or $rules.Count -ne 1 -or
  $rules[0].IdentityReference.Value -ne $owner.Value -or
  $rules[0].AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or
  ($rules[0].FileSystemRights -band $rights) -ne $rights -or
  $actual.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $owner.Value) {
  throw 'Unsafe release-copy ACL'
}
`;
  run("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64")],
  { ...process.env, OPENAPPLY_RELEASE_COPY_PATH: path });
}

function verifyNative(platform, file, trusted, run = command) {
  if (platform === "darwin") {
    if (!/^[A-Z0-9]{10}$/.test(trusted.appleTeamId ?? "")) throw new Error("Trusted Apple team ID is required");
    const signature = run("pkgutil", ["--check-signature", file]);
    if (!signature.includes("Signed with a trusted timestamp")
      || !signature.split(/\r?\n/).some((line) => {
        const match = /^\s*1\. Developer ID Installer: .+ \(([A-Z0-9]{10})\)\s*$/.exec(line);
        return match?.[1] === trusted.appleTeamId;
      })) {
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
  run = command, verifiedOutputDir) {
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
  if (verifiedOutputDir && (!isAbsolute(verifiedOutputDir) || existsSync(verifiedOutputDir))) {
    throw new Error("Verified output must be a new absolute directory");
  }
  const output = verifiedOutputDir && resolve(verifiedOutputDir);
  if (output) {
    const parent = lstatSync(dirname(output));
    if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error("Verified output parent is unsafe");
  }
  const staging = mkdtempSync(join(output ? dirname(output) : tmpdir(), "openapply-release-"));
  let retained = false;
  try {
    protectWindowsCopyDirectory(staging);
    if (output) {
      writeFileSync(join(staging, "release-manifest.json"), bytes, { flag: "wx", mode: 0o600 });
      writeFileSync(join(staging, "release-manifest.sig"), signature, { flag: "wx", mode: 0o600 });
    }
    const byPlatform = new Map();
    for (const item of manifest.artifacts) {
      if (!platforms.includes(item.platform) || byPlatform.has(item.platform)
        || typeof item.file !== "string" || basename(item.file) !== item.file
        || !extensions[item.platform].some((extension) => item.file.endsWith(extension))
        || !/^[a-f0-9]{64}$/.test(item.sha256 ?? "")) {
        throw new Error("Release manifest has an invalid artifact");
      }
      const path = join(bundle, item.file);
      regularFile(path);
      // Hash and native-check the same private copy, even if the source path changes.
      const copy = join(staging, item.file);
      copyFileSync(path, copy);
      if (createHash("sha256").update(readFileSync(copy)).digest("hex") !== item.sha256) {
        throw new Error("Release artifact hash mismatch");
      }
      byPlatform.set(item.platform, { path: copy, sha256: item.sha256 });
    }
    if (byPlatform.size !== platforms.length) throw new Error("Release manifest lacks a platform");
    const current = byPlatform.get(currentPlatform);
    verifyNative(currentPlatform, current.path, trusted, run);
    for (const item of byPlatform.values()) {
      if (createHash("sha256").update(readFileSync(item.path)).digest("hex") !== item.sha256) {
        throw new Error("Release artifact changed during signature verification");
      }
    }
    if (output) {
      renameSync(staging, output);
      retained = true;
    }
    return { version: manifest.version, platform: currentPlatform,
      artifactSha256: current.sha256, verified: true,
      ...(output ? { verifiedDirectory: output,
        artifactPath: join(output, manifest.artifacts.find((item) =>
          item.platform === currentPlatform).file) } : {}) };
  } finally {
    if (!retained) rmSync(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  if (process.argv.length !== 5) {
    throw new Error("Usage: verify-release-bundle.mjs BUNDLE_DIRECTORY TRUSTED_PUBLIC_KEY_PEM NEW_VERIFIED_OUTPUT_DIRECTORY");
  }
  const result = verifyReleaseBundle(process.argv[2], process.argv[3], {
    publicKeySha256: process.env.OPENAPPLY_RELEASE_KEY_SHA256,
    appleTeamId: process.env.OPENAPPLY_APPLE_TEAM_ID,
    windowsThumbprint: process.env.OPENAPPLY_WINDOWS_CERT_THUMBPRINT,
  }, process.platform, command, process.argv[4]);
  console.log(JSON.stringify(result));
}
