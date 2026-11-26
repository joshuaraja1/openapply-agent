import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";
import { assertPackageManifest } from "./assert-package.mjs";

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("Run this smoke with npm run distribution:smoke");

const root = mkdtempSync(join(tmpdir(), "openapply-distribution-"));
const run = (args, options = {}) => {
  const result = spawnSync(process.execPath, [npmCli, ...args], {
    encoding: "utf8", maxBuffer: 16 * 1024 * 1024, ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`npm ${args[0]} failed (${result.status}): ${result.stderr || result.stdout}`);
  }
  return result.stdout;
};

try {
  const packed = JSON.parse(run(["pack", "--json", "--pack-destination", root]));
  if (packed.length !== 1 || !packed[0]?.filename || !Array.isArray(packed[0]?.files)) {
    throw new Error("npm pack returned an invalid manifest");
  }
  const manifest = packed[0];
  assertPackageManifest(packed);

  if (basename(manifest.filename) !== manifest.filename) throw new Error("Invalid npm tarball filename");
  const tarball = join(root, manifest.filename);
  if (!statSync(tarball).isFile()) throw new Error("npm pack did not create a tarball");
  const prefix = join(root, "install");
  run(["install", "--prefix", prefix, "--no-audit", "--no-fund", "--ignore-scripts", tarball]);
  const installed = join(prefix, "node_modules", "openapply-agent");
  const packageJson = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
  if (packageJson.version !== manifest.version) throw new Error("Installed version differs from tarball");
  for (const file of ["templates/user/01-candidate-profile.md", "templates/resume/main.tex"]) {
    if (!statSync(join(installed, file)).isFile()) throw new Error(`Installed package is missing ${file}`);
  }
  const cli = spawnSync(process.execPath, [join(installed, "dist/src/product-cli.js"), "--help"], {
    encoding: "utf8", maxBuffer: 1024 * 1024,
  });
  if (cli.error) throw cli.error;
  if (cli.status !== 0 || !cli.stdout.includes("  autopilot")) {
    throw new Error(`Installed CLI failed: ${cli.stderr || cli.stdout}`);
  }
  console.log(`Portable package ${manifest.version} installs and runs on ${process.platform}`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
