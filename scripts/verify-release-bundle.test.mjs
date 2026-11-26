import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { verifyReleaseBundle } from "./verify-release-bundle.mjs";

const fixtures = [
  ["darwin", "OpenApply.pkg"],
  ["win32", "OpenApply.msi"],
  ["linux", "OpenApply.tar.gz"],
];
const teamId = "ABCDEFGHIJ";
const thumbprint = "A".repeat(40);

function bundle() {
  const root = mkdtempSync(join(tmpdir(), "openapply-release-gate-"));
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const keyPath = join(root, "trusted-public.pem");
  const keyBytes = publicKey.export({ type: "spki", format: "pem" });
  writeFileSync(keyPath, keyBytes);
  const trusted = { publicKeySha256: createHash("sha256").update(keyBytes).digest("hex") };
  const artifacts = fixtures.map(([platform, file]) => {
    const bytes = Buffer.from(`synthetic ${platform} artifact`);
    writeFileSync(join(root, file), bytes);
    return { platform, file, sha256: createHash("sha256").update(bytes).digest("hex") };
  });
  function writeManifest(manifest = { schemaVersion: 1, version: "0.1.0", artifacts }) {
    const bytes = Buffer.from(JSON.stringify(manifest));
    writeFileSync(join(root, "release-manifest.json"), bytes);
    writeFileSync(join(root, "release-manifest.sig"), sign(null, bytes, privateKey));
  }
  writeManifest();
  return { root, keyPath, keyBytes, trusted, artifacts, writeManifest };
}

test("a signed manifest and complete artifact hashes are required on every platform", () => {
  const fixture = bundle();
  try {
    const called = [];
    const run = (program, args) => {
      called.push([program, args]);
      if (program === "pkgutil") return `Signed with a trusted timestamp\n1. Developer ID Installer: OpenApply (${teamId})`;
      if (program === "powershell.exe") return JSON.stringify({ Status: "Valid", Thumbprint: thumbprint });
      return "accepted";
    };
    for (const platform of ["darwin", "win32", "linux"]) {
      assert.deepEqual(verifyReleaseBundle(fixture.root, fixture.keyPath,
        { ...fixture.trusted, appleTeamId: teamId, windowsThumbprint: thumbprint }, platform, run),
      { version: "0.1.0", platform,
        artifactSha256: fixture.artifacts.find((item) => item.platform === platform).sha256,
        verified: true });
    }
    assert.deepEqual(called.map(([program]) => program),
      ["pkgutil", "xcrun", "spctl", "powershell.exe"]);
    const output = join(fixture.root, "verified");
    const retained = verifyReleaseBundle(fixture.root, fixture.keyPath,
      fixture.trusted, "linux", run, output);
    assert.equal(retained.verifiedDirectory, output);
    assert.deepEqual(readFileSync(retained.artifactPath), Buffer.from("synthetic linux artifact"));
    assert.throws(() => verifyReleaseBundle(fixture.root, fixture.keyPath,
      fixture.trusted, "linux", run, output), /new absolute directory/);
    writeFileSync(join(fixture.root, "OpenApply.tar.gz"), "tampered");
    assert.deepEqual(readFileSync(retained.artifactPath), Buffer.from("synthetic linux artifact"));
    assert.throws(() => verifyReleaseBundle(fixture.root, fixture.keyPath, fixture.trusted, "linux", run),
      /artifact hash mismatch/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("manifest signature, platform coverage, and native identity failures block release", () => {
  const fixture = bundle();
  try {
    const original = Buffer.from("synthetic darwin artifact");
    const mutateSource = (program, args) => {
      if (program === "pkgutil") {
        writeFileSync(join(fixture.root, "OpenApply.pkg"), "changed source path");
        assert.deepEqual(readFileSync(args[1]), original);
        return `Signed with a trusted timestamp\n1. Developer ID Installer: OpenApply (${teamId})`;
      }
      return "accepted";
    };
    assert.equal(verifyReleaseBundle(fixture.root, fixture.keyPath,
      { ...fixture.trusted, appleTeamId: teamId }, "darwin", mutateSource).verified, true);
    writeFileSync(join(fixture.root, "OpenApply.pkg"), original);
    const mutateDuringNativeCheck = (program, args) => {
      if (program === "pkgutil") {
        writeFileSync(args[1], "changed after hash");
        return `Signed with a trusted timestamp\n1. Developer ID Installer: OpenApply (${teamId})`;
      }
      return "accepted";
    };
    const rejectedOutput = join(fixture.root, "rejected");
    assert.throws(() => verifyReleaseBundle(fixture.root, fixture.keyPath,
      { ...fixture.trusted, appleTeamId: teamId }, "darwin", mutateDuringNativeCheck, rejectedOutput),
    /changed during signature verification/);
    assert.equal(existsSync(rejectedOutput), false);
    assert.equal(readdirSync(fixture.root).some((name) => name.startsWith("openapply-release-")), false);
    const run = (program) => program === "pkgutil"
      ? `Signed with a trusted timestamp\n1. Developer ID Installer: Other (ZZZZZZZZZZ)`
      : JSON.stringify({ Status: "UnknownError", Thumbprint: thumbprint });
    assert.throws(() => verifyReleaseBundle(fixture.root, fixture.keyPath,
      { ...fixture.trusted, appleTeamId: teamId }, "darwin", run), /not signed by the trusted/);
    const spoofedName = (program) => program === "pkgutil"
      ? `Signed with a trusted timestamp\n1. Developer ID Installer: Fake (${teamId}) (ZZZZZZZZZZ)`
      : "accepted";
    assert.throws(() => verifyReleaseBundle(fixture.root, fixture.keyPath,
      { ...fixture.trusted, appleTeamId: teamId }, "darwin", spoofedName), /not signed by the trusted/);
    assert.throws(() => verifyReleaseBundle(fixture.root, fixture.keyPath,
      { ...fixture.trusted, windowsThumbprint: thumbprint }, "win32", run), /no valid trusted/);
    assert.throws(() => verifyReleaseBundle(fixture.root, fixture.keyPath,
      fixture.trusted, "darwin", run), /Trusted Apple team ID/);
    assert.throws(() => verifyReleaseBundle(fixture.root, fixture.keyPath,
      fixture.trusted, "win32", run), /Trusted Windows signing/);
    fixture.writeManifest({ schemaVersion: 1, version: "0.1.0",
      artifacts: fixture.artifacts.filter((item) => item.platform !== "linux") });
    assert.throws(() => verifyReleaseBundle(fixture.root, fixture.keyPath, fixture.trusted, "linux", run),
      /manifest is incomplete/);
    const otherKey = generateKeyPairSync("ed25519").publicKey;
    writeFileSync(fixture.keyPath, otherKey.export({ type: "spki", format: "pem" }));
    assert.throws(() => verifyReleaseBundle(fixture.root, fixture.keyPath, fixture.trusted, "linux", run),
      /fingerprint is required/);
    writeFileSync(fixture.keyPath, fixture.keyBytes);
    writeFileSync(join(fixture.root, "release-manifest.json"), "{}");
    assert.throws(() => verifyReleaseBundle(fixture.root, fixture.keyPath, fixture.trusted, "linux", run),
      /signature is invalid/);
    assert.throws(() => verifyReleaseBundle(fixture.root, fixture.keyPath, {}, "linux", run),
      /fingerprint is required/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
