import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { rollbackVerifiedSelection, stageVerifiedBundle, verifiedSelectionStatus }
  from "./stage-verified-bundle.mjs";

function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "openapply-verified-stage-"));
  const bundle = join(root, "bundle");
  mkdirSync(bundle, { mode: 0o700 });
  const staged = join(root, "staged");
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const key = join(root, "trusted.pem");
  const keyBytes = publicKey.export({ type: "spki", format: "pem" });
  writeFileSync(key, keyBytes);
  const fingerprint = createHash("sha256").update(keyBytes).digest("hex");
  function writeVersion(version) {
    const artifacts = [["darwin", "OpenApply.pkg"], ["win32", "OpenApply.msi"],
      ["linux", "OpenApply.tar.gz"]].map(([platform, file]) => {
      const bytes = Buffer.from(`synthetic ${version} ${platform}`);
      writeFileSync(join(bundle, file), bytes);
      return { platform, file, sha256: createHash("sha256").update(bytes).digest("hex") };
    });
    const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1, version, artifacts }));
    writeFileSync(join(bundle, "release-manifest.json"), manifest);
    writeFileSync(join(bundle, "release-manifest.sig"), sign(null, manifest, privateKey));
  }
  writeVersion("0.1.0");
  return { root, bundle, staged, key, fingerprint, writeVersion };
}

test("stages signed bytes without activation and rolls selection back after re-verification", () => {
  const f = fixture();
  try {
    const first = stageVerifiedBundle(f.bundle, f.key, f.fingerprint, f.staged, "linux");
    assert.equal(first.activated, false);
    assert.equal(first.version, "0.1.0");
    f.writeVersion("0.2.0");
    const second = stageVerifiedBundle(f.bundle, f.key, f.fingerprint, f.staged, "linux");
    assert.equal(second.previous, first.selected);
    assert.deepEqual(verifiedSelectionStatus(f.staged),
      { kind: "openapply-verified-selection-v1", current: second.selected,
        previous: first.selected, activated: false });
    const restored = rollbackVerifiedSelection(f.key, f.fingerprint, f.staged, "linux");
    assert.equal(restored.selected, first.selected);
    assert.equal(restored.activated, false);
    assert.equal(verifiedSelectionStatus(f.staged).current, first.selected);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("failed signature and tampered previous bytes leave the selected release unchanged", () => {
  const f = fixture();
  try {
    const first = stageVerifiedBundle(f.bundle, f.key, f.fingerprint, f.staged, "linux");
    f.writeVersion("0.2.0");
    const second = stageVerifiedBundle(f.bundle, f.key, f.fingerprint, f.staged, "linux");
    const before = readFileSync(join(f.staged, "selection.json"), "utf8");
    writeFileSync(join(f.staged, "bundles", first.selected, "verified", "OpenApply.tar.gz"), "tampered");
    assert.throws(() => rollbackVerifiedSelection(f.key, f.fingerprint, f.staged, "linux"), /hash mismatch/);
    assert.equal(readFileSync(join(f.staged, "selection.json"), "utf8"), before);
    writeFileSync(join(f.bundle, "release-manifest.sig"), Buffer.alloc(64));
    assert.throws(() => stageVerifiedBundle(f.bundle, f.key, f.fingerprint, f.staged, "linux"),
      /signature is invalid/);
    assert.equal(readFileSync(join(f.staged, "selection.json"), "utf8"), before);
    assert.equal(readdirSync(join(f.staged, "bundles")).some((entry) => entry.startsWith(".pending-")), false);
    assert.equal(existsSync(join(f.staged, ".selection-lock")), false);
    assert.equal(second.activated, false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("requires a trusted key, Linux staging, and a private destination", () => {
  const f = fixture();
  try {
    assert.throws(() => stageVerifiedBundle(f.bundle, f.key, "0".repeat(64), f.staged, "linux"),
      /fingerprint is required/);
    assert.throws(() => stageVerifiedBundle(f.bundle, f.key, f.fingerprint, f.staged, "darwin"),
      /Linux only/);
    assert.throws(() => stageVerifiedBundle(f.bundle, f.key, f.fingerprint, "relative", "linux"),
      /absolute/);
    assert.equal(existsSync(f.staged), false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
