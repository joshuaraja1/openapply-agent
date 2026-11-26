import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { test } from "node:test";
import { installStaging, stagingRoot, statusStaging, uninstallStaging } from "./staging-user-install.mjs";

test("user-level staging install and uninstall preserve private state", () => {
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), "openapply-staging-test-")));
  try {
    const result = spawnSync(process.execPath, [process.env.npm_execpath, "pack", "--json",
      "--pack-destination", temporary], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    assert.equal(result.status, 0, result.stderr);
    const packed = JSON.parse(result.stdout)[0];
    const tarball = join(temporary, packed.filename);
    const root = join(temporary, "staging");
    const privateFile = join(temporary, "candidate-private.json");
    writeFileSync(privateFile, "synthetic private state");
    assert.equal(statusStaging(root).installed, false);
    const installed = installStaging(tarball, root);
    assert.equal(installed.version, packed.version);
    assert.equal(installed.browserChecked, false);
    assert.equal(statusStaging(root).installed, true);
    assert.throws(() => installStaging(tarball, root), /already exists/);
    rmSync(join(root, "runtime", "node_modules"), { recursive: true });
    assert.equal(existsSync(join(root, ".openapply-staging.json")), true);
    assert.deepEqual(uninstallStaging(root), { removed: true, root });
    assert.equal(uninstallStaging(root).removed, false);
    assert.equal(readFileSync(privateFile, "utf8"), "synthetic private state");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("uninstall refuses an unmarked runtime and install cleans failed staging", () => {
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), "openapply-staging-refusal-")));
  try {
    const root = join(temporary, "staging");
    const invalid = join(temporary, "invalid.tgz");
    writeFileSync(invalid, "invalid tarball");
    assert.throws(() => installStaging(invalid, root), /failed/);
    mkdirSync(join(root, "runtime"), { recursive: true });
    writeFileSync(join(root, "runtime", "user.txt"), "keep");
    assert.throws(() => uninstallStaging(root), /unmarked runtime/);
    assert.equal(readFileSync(join(root, "runtime", "user.txt"), "utf8"), "keep");
    rmSync(join(root, "runtime"), { recursive: true });
    assert.throws(() => installStaging(invalid, root), /failed/);
    assert.equal(existsSync(join(root, "runtime")), false);
    assert.equal(existsSync(join(root, ".openapply-staging.json")), false);
    assert.equal(readdirSync(root).filter((name) => name.startsWith(".pending-")).length, 0);
    assert.throws(() => stagingRoot(parse(temporary).root), /dedicated staging directory/);
    if (process.platform !== "win32") {
      chmodSync(root, 0o777);
      assert.throws(() => statusStaging(root), /owner-only/);
      chmodSync(root, 0o700);
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
