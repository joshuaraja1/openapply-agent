import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { installLockedTarball } from "./locked-tarball-install.mjs";

function command(program, args, options = {}) {
  const result = spawnSync(program, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, ...options });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

test("packed CLI installs only from its integrity-checked lock", () => {
  const root = mkdtempSync(join(tmpdir(), "openapply-locked-package-"));
  try {
    const manifest = JSON.parse(command(process.execPath, [process.env.npm_execpath,
      "pack", "--json", "--pack-destination", root]))[0];
    assert.ok(manifest.files.some((file) => file.path === "runtime-package-lock.json"));
    const archive = join(root, manifest.filename);
    const installed = installLockedTarball(archive, join(root, "good"));
    assert.equal(installed.version, manifest.version);
    const installedLock = JSON.parse(readFileSync(join(installed.packageRoot, "package-lock.json"), "utf8"));
    const sourceLock = JSON.parse(readFileSync("package-lock.json", "utf8"));
    assert.equal(installedLock.packages["node_modules/zod"].integrity,
      sourceLock.packages["node_modules/zod"].integrity);

    command("tar", ["-xzf", archive, "-C", root]);
    const packagePath = join(root, "package", "package.json");
    const tamperedLockPath = join(root, "package", "runtime-package-lock.json");
    const priorPackage = JSON.parse(readFileSync(packagePath, "utf8"));
    priorPackage.version = "0.0.0";
    writeFileSync(packagePath, JSON.stringify(priorPackage));
    const priorLock = JSON.parse(readFileSync(tamperedLockPath, "utf8"));
    priorLock.version = "0.0.0";
    priorLock.packages[""].version = "0.0.0";
    writeFileSync(tamperedLockPath, JSON.stringify(priorLock));
    command("tar", ["-czf", join(root, "prior.tgz"), "-C", root, "package"]);
    const prior = installLockedTarball(join(root, "prior.tgz"), join(root, "prior"));
    assert.equal(prior.version, "0.0.0");
    assert.equal(JSON.parse(readFileSync(join(prior.packageRoot, "package.json"), "utf8")).version, "0.0.0");

    command("tar", ["-xzf", archive, "-C", root]);
    const lock = JSON.parse(readFileSync(tamperedLockPath, "utf8"));
    lock.packages["node_modules/zod"].integrity = `sha512-${Buffer.alloc(64).toString("base64")}`;
    writeFileSync(tamperedLockPath, JSON.stringify(lock));
    command("tar", ["-czf", join(root, "bad-integrity.tgz"), "-C", root, "package"]);
    assert.throws(() => installLockedTarball(join(root, "bad-integrity.tgz"), join(root, "bad")),
      /EINTEGRITY|integrity checksum failed/);
    assert.equal(existsSync(join(root, "bad")), false);

    delete lock.packages["node_modules/zod"].resolved;
    delete lock.packages["node_modules/zod"].integrity;
    writeFileSync(tamperedLockPath, JSON.stringify(lock));
    command("tar", ["-czf", join(root, "unpinned.tgz"), "-C", root, "package"]);
    assert.throws(() => installLockedTarball(join(root, "unpinned.tgz"), join(root, "unpinned")),
      /no registry SHA-512 integrity/);
    assert.equal(existsSync(join(root, "unpinned")), false);

    delete lock.packages["node_modules/zod"];
    writeFileSync(tamperedLockPath, JSON.stringify(lock));
    command("tar", ["-czf", join(root, "missing-dependency.tgz"), "-C", root, "package"]);
    assert.throws(() => installLockedTarball(join(root, "missing-dependency.tgz"), join(root, "missing")));
    assert.equal(existsSync(join(root, "missing")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
