import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { assertPackageManifest } from "./assert-package.mjs";

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("Run this smoke with npm run distribution:smoke");

const root = mkdtempSync(join(tmpdir(), "openapply-distribution-"));
const source = process.cwd();
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
  // A synthetic prior release exercises npm's replacement and rollback paths
  // without needing access to a real release or a user's private state.
  const priorSource = join(root, "prior-release");
  mkdirSync(priorSource);
  const priorPackage = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
  priorPackage.version = "0.0.0";
  delete priorPackage.scripts;
  writeFileSync(join(priorSource, "package.json"), JSON.stringify(priorPackage));
  const priorLock = JSON.parse(readFileSync(join(source, "package-lock.json"), "utf8"));
  priorLock.version = "0.0.0";
  priorLock.packages[""].version = "0.0.0";
  writeFileSync(join(priorSource, "runtime-package-lock.json"), JSON.stringify(priorLock));
  for (const path of ["dist", "templates", "examples", "docs", "README.md", "LICENSE"]) {
    cpSync(join(source, path), join(priorSource, path), { recursive: true });
  }
  const prior = JSON.parse(run(["pack", "--json", "--pack-destination", root], { cwd: priorSource }));
  assertPackageManifest(prior);
  const priorTarball = join(root, prior[0].filename);

  const prefix = join(root, "install");
  const privateState = join(root, "private-state.json");
  const marker = JSON.stringify({ fixture: "private state must survive package replacement" });
  writeFileSync(privateState, marker);
  const install = (archive, version) => {
    run(["install", "--prefix", prefix, "--no-audit", "--no-fund", "--ignore-scripts",
      "--no-package-lock", archive]);
    const installed = join(prefix, "node_modules", "openapply-agent");
    const packageJson = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
    if (packageJson.version !== version) throw new Error(`Expected installed version ${version}`);
    if (readFileSync(privateState, "utf8") !== marker) throw new Error("Package replacement changed private state");
    for (const file of ["templates/user/01-candidate-profile.md", "templates/resume/main.tex"]) {
      if (!statSync(join(installed, file)).isFile()) throw new Error(`Installed package is missing ${file}`);
    }
    const cli = spawnSync(process.execPath, [join(installed, "dist/src/product-cli.js"), "--help"], {
      encoding: "utf8", maxBuffer: 1024 * 1024,
    });
    if (cli.error) throw cli.error;
    const requiredCommands = ["autopilot", "queue:run", "application:run",
      "resume:render", "secret:put", "oauth:connect"];
    const listedCommands = new Set(cli.stdout.split("\n").map((line) => line.trim()));
    if (cli.status !== 0 || requiredCommands.some((command) => !listedCommands.has(command))) {
      throw new Error(`Installed CLI failed: ${cli.stderr || cli.stdout}`);
    }
    return installed;
  };
  install(priorTarball, "0.0.0");
  const installed = install(tarball, manifest.version);
  // Exercise the built module from a directory unrelated to the repository or
  // installation. This catches CWD-relative template reads in packaged runs.
  const foreignDirectory = join(root, "foreign-working-directory");
  mkdirSync(foreignDirectory);
  const templatePath = join(installed, "templates", "resume", "main.tex");
  const expectedHash = createHash("sha256").update(readFileSync(templatePath)).digest("hex");
  const modulePath = join(installed, "dist", "src", "resume", "bundled-template.js");
  const check = spawnSync(process.execPath, ["--input-type=module", "--eval", `
    import { createHash } from "node:crypto";
    import { pathToFileURL } from "node:url";
    const { readBundledJakeTemplate } = await import(pathToFileURL(process.argv[1]).href);
    process.stdout.write(createHash("sha256")
      .update(await readBundledJakeTemplate()).digest("hex"));
  `, modulePath], { cwd: foreignDirectory, encoding: "utf8", maxBuffer: 1024 * 1024 });
  if (check.error) throw check.error;
  if (check.status !== 0 || check.stdout !== expectedHash) {
    throw new Error(`Installed resume template resolution failed outside the package: ${check.stderr || check.stdout}`);
  }
  const cleanEnvironment = Object.fromEntries(Object.entries(process.env)
    .filter(([name]) => !name.startsWith("OPENAPPLY_")));
  for (const [command, expected] of [
    ["secret:put", "Set OPENAPPLY_SECRET_REF"],
    ["oauth:connect", "Set OPENAPPLY_AUTH_POLICY"],
    ["resume:render", "Set OPENAPPLY_RENDER_INPUT"],
  ]) {
    const invoked = spawnSync(process.execPath,
      [join(installed, "dist/src/product-cli.js"), command],
      { cwd: foreignDirectory, encoding: "utf8", env: cleanEnvironment, maxBuffer: 1024 * 1024 });
    if (invoked.error) throw invoked.error;
    if (invoked.status === 0 || !(invoked.stderr + invoked.stdout).includes(expected)) {
      throw new Error(`Installed ${command} did not reach its input validation`);
    }
  }
  install(priorTarball, "0.0.0");
  console.log(`Portable package ${manifest.version} installs, upgrades, and rolls back on ${process.platform}`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
