import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildMacOSPkg } from "./build-macos-pkg.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "openapply-pkg-test-"));
  const tarball = join(root, "fixture.tgz");
  const output = join(root, "OpenApply.pkg");
  writeFileSync(tarball, "synthetic fixture");
  const install = (_tarball, destination) => {
    const packageRoot = join(destination, "package");
    mkdirSync(join(packageRoot, "dist", "src"), { recursive: true });
    writeFileSync(join(packageRoot, "dist", "src", "product-cli.js"), "console.log('OpenApply fixture');\n");
    writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "openapply-agent", version: "0.1.0", type: "module" }));
    return { packageRoot, version: "0.1.0" };
  };
  return { root, tarball, output, install };
}

test("builds a real unsigned macOS PKG containing the CLI and bundled Node", { skip: process.platform !== "darwin" }, () => {
  const f = fixture();
  try {
    const result = buildMacOSPkg(f.tarball, f.output, {
      unsignedSmoke: true, nodeBinary: process.env.OPENAPPLY_MAC_TEST_NODE ?? process.execPath,
    }, undefined, f.install);
    assert.deepEqual(result, { outputPath: f.output, version: "0.1.0", signedAndNotarized: false });
    const expanded = join(f.root, "expanded");
    const unpack = spawnSync("pkgutil", ["--expand", f.output, expanded], { encoding: "utf8" });
    assert.equal(unpack.status, 0, unpack.stderr);
    const metadata = readFileSync(join(expanded, "PackageInfo"), "utf8");
    assert.match(metadata, /identifier="xyz\.openapplyagent\.cli"/);
    assert.match(metadata, /install-location="\/"/);
    assert.match(metadata, /version="0\.1\.0"/);
    const files = spawnSync("pkgutil", ["--payload-files", f.output], { encoding: "utf8" });
    assert.equal(files.status, 0, files.stderr);
    assert.match(files.stdout, /Applications\/OpenApply\/bin\/node/);
    assert.match(files.stdout, /Applications\/OpenApply\/bin\/openapply/);
    assert.match(files.stdout, /Applications\/OpenApply\/runtime\/package\/dist\/src\/product-cli\.js/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("rejects signed builds without exact team identities and a Keychain notary profile", { skip: process.platform !== "darwin" }, () => {
  const f = fixture();
  try {
    assert.throws(() => buildMacOSPkg(f.tarball, f.output, {}, undefined, f.install), /Apple team ID/);
    assert.throws(() => buildMacOSPkg(f.tarball, f.output, {
      teamId: "ABCDEFGHIJ", appIdentity: "Developer ID Application: Example (ABCDEFGHIJ)",
      installerIdentity: "Developer ID Installer: Example (KLMNOPQRST)", notaryProfile: "openapply",
    }, undefined, f.install), /Installer identity/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("rejects a notarization result other than Accepted before publishing", { skip: process.platform !== "darwin" }, () => {
  const f = fixture();
  const called = [];
  const run = (program, args) => {
    called.push([program, args[0]]);
    if (program === "pkgbuild" || program === "productsign") writeFileSync(args.at(-1), "synthetic pkg");
    if (args[0] === "--version") return "v22.20.0\n";
    if (program === "otool") return "node:\n  /usr/lib/libSystem.B.dylib (compatibility version 1.0.0)\n";
    if (program === "pkgutil") return "Signed with a trusted timestamp\n  1. Developer ID Installer: Example (ABCDEFGHIJ)\n";
    if (program === "xcrun" && args[0] === "notarytool") return JSON.stringify({ status: "Invalid" });
    return "";
  };
  try {
    assert.throws(() => buildMacOSPkg(f.tarball, f.output, {
      teamId: "ABCDEFGHIJ", appIdentity: "Developer ID Application: Example (ABCDEFGHIJ)",
      installerIdentity: "Developer ID Installer: Example (ABCDEFGHIJ)", notaryProfile: "openapply",
    }, run, f.install), /notarization was not accepted/);
    assert.ok(called.some(([program]) => program === "productsign"));
    assert.ok(!called.some(([program, arg]) => program === "spctl" || arg === "staple"));
    assert.throws(() => readFileSync(f.output), /ENOENT/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("publishes only after signed PKG notarization and Gatekeeper acceptance", { skip: process.platform !== "darwin" }, () => {
  const f = fixture();
  const called = [];
  const run = (program, args) => {
    called.push([program, args[0]]);
    if (program === "pkgbuild" || program === "productsign") writeFileSync(args.at(-1), "synthetic pkg");
    if (args[0] === "--version") return "v22.20.0\n";
    if (program === "otool") return "node:\n  /usr/lib/libSystem.B.dylib (compatibility version 1.0.0)\n";
    if (program === "pkgutil") return "Signed with a trusted timestamp\n  1. Developer ID Installer: Example (ABCDEFGHIJ)\n";
    if (program === "xcrun" && args[0] === "notarytool") return JSON.stringify({ status: "Accepted" });
    return "";
  };
  try {
    const result = buildMacOSPkg(f.tarball, f.output, {
      teamId: "ABCDEFGHIJ", appIdentity: "Developer ID Application: Example (ABCDEFGHIJ)",
      installerIdentity: "Developer ID Installer: Example (ABCDEFGHIJ)", notaryProfile: "openapply",
    }, run, f.install);
    assert.equal(result.signedAndNotarized, true);
    assert.equal(readFileSync(f.output, "utf8"), "synthetic pkg");
    assert.ok(called.some(([program, arg]) => program === "xcrun" && arg === "stapler"));
    assert.ok(called.some(([program]) => program === "spctl"));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("rejects a build Node linked to external libraries", { skip: process.platform !== "darwin" }, () => {
  const f = fixture();
  const run = (program, args) => {
    if (args[0] === "--version") return "v25.5.0\n";
    if (program === "otool") return "node:\n  @rpath/libnode.dylib (compatibility version 1.0.0)\n";
    return "";
  };
  try {
    assert.throws(() => buildMacOSPkg(f.tarball, f.output, { unsignedSmoke: true }, run, f.install),
      /external dynamic libraries/);
    assert.throws(() => readFileSync(f.output), /ENOENT/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
