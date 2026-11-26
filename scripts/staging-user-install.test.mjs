import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { test } from "node:test";
import { installStaging, stagingRoot, statusStaging, uninstallStaging } from "./staging-user-install.mjs";

test("user-level staging install and uninstall preserve private state", () => {
  const temporary = mkdtempSync(join(tmpdir(), "openapply-staging-test-"));
  try {
    const result = spawnSync(process.execPath, [process.env.npm_execpath, "pack", "--json",
      "--pack-destination", temporary], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    assert.equal(result.status, 0, result.stderr);
    const tarball = join(temporary, JSON.parse(result.stdout)[0].filename);
    const root = join(temporary, "staging");
    const privateFile = join(temporary, "candidate-private.json");
    writeFileSync(privateFile, "synthetic private state");
    assert.equal(statusStaging(root).installed, false);
    const installed = installStaging(tarball, root);
    assert.equal(installed.version, "0.1.0");
    assert.equal(installed.browserChecked, false);
    assert.equal(statusStaging(root).installed, true);
    assert.throws(() => installStaging(tarball, root), /already exists/);
    assert.deepEqual(uninstallStaging(root), { removed: true, root });
    assert.equal(uninstallStaging(root).removed, false);
    assert.equal(readFileSync(privateFile, "utf8"), "synthetic private state");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("uninstall refuses an unmarked runtime and install cleans failed staging", () => {
  const temporary = mkdtempSync(join(tmpdir(), "openapply-staging-refusal-"));
  try {
    const root = join(temporary, "staging");
    mkdirSync(join(root, "runtime"), { recursive: true });
    writeFileSync(join(root, "runtime", "user.txt"), "keep");
    assert.throws(() => uninstallStaging(root), /unmarked runtime/);
    assert.equal(readFileSync(join(root, "runtime", "user.txt"), "utf8"), "keep");
    rmSync(join(root, "runtime"), { recursive: true });
    const invalid = join(temporary, "invalid.tgz");
    writeFileSync(invalid, "invalid tarball");
    assert.throws(() => installStaging(invalid, root), /failed/);
    assert.equal(existsSync(join(root, "runtime")), false);
    assert.equal(readdirSync(root).filter((name) => name.startsWith(".pending-")).length, 0);
    assert.throws(() => stagingRoot(parse(temporary).root), /dedicated staging directory/);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
