#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import { installLockedTarball } from "./locked-tarball-install.mjs";

const markerName = ".openapply-staging.json";
const npmCli = process.env.npm_execpath;
const windowsAclScript = `
$ErrorActionPreference = 'Stop'
$path = $env:OPENAPPLY_STAGING_ACL_PATH
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$item = [System.IO.DirectoryInfo]::new($path)
if (-not $item.Exists -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) { throw 'Unsafe staging directory' }
$acl = $item.GetAccessControl()
if ($env:OPENAPPLY_STAGING_ACL_ACTION -eq 'ancestor') {
  $allowed = @($identity.Value, 'S-1-5-18', 'S-1-5-32-544')
  $write = [System.Security.AccessControl.FileSystemRights]::Write -bor
    [System.Security.AccessControl.FileSystemRights]::Modify -bor
    [System.Security.AccessControl.FileSystemRights]::Delete -bor
    [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor
    [System.Security.AccessControl.FileSystemRights]::TakeOwnership
  foreach ($rule in @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))) {
    if ($rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and
      $rule.IdentityReference.Value -notin $allowed -and
      ($rule.FileSystemRights -band $write) -ne 0) { throw 'Shared staging ancestor' }
  }
  return
}
if ($env:OPENAPPLY_STAGING_ACL_ACTION -eq 'secure') {
  $acl.SetAccessRuleProtection($true, $false)
  $acl.SetOwner($identity)
  foreach ($rule in @($acl.GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier]))) {
    [void]$acl.RemoveAccessRuleAll($rule)
  }
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
    $identity, [System.Security.AccessControl.FileSystemRights]::FullControl,
    [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
      [System.Security.AccessControl.InheritanceFlags]::ObjectInherit,
    [System.Security.AccessControl.PropagationFlags]::None,
    [System.Security.AccessControl.AccessControlType]::Allow)
  [void]$acl.AddAccessRule($rule)
  $item.SetAccessControl($acl)
  $acl = $item.GetAccessControl()
}
$rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
if (-not $acl.AreAccessRulesProtected -or $rules.Count -ne 1 -or
  $rules[0].IdentityReference.Value -ne $identity.Value -or
  $rules[0].AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or
  ($rules[0].FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -ne
    [System.Security.AccessControl.FileSystemRights]::FullControl -or
  $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $identity.Value) {
  throw 'Shared staging directory ACL'
}`;

function windowsPrivateRoot(root, action) {
  const env = { ...process.env, OPENAPPLY_STAGING_ACL_PATH: root,
    OPENAPPLY_STAGING_ACL_ACTION: action };
  delete env.PSModulePath;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand",
    Buffer.from(windowsAclScript, "utf16le").toString("base64")], {
    env, encoding: "utf8", timeout: 15_000, maxBuffer: 16_384,
  });
  if (result.error || result.status !== 0) throw new Error("Staging root has an unsafe Windows ACL");
}

function defaultRoot() {
  if (platform() === "win32") return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "OpenApply", "staging");
  if (platform() === "darwin") return join(homedir(), "Library", "Application Support", "OpenApply", "staging");
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "openapply", "staging");
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${basename(command)} ${args[0]} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

function managedRuntime(root) {
  const runtime = join(root, "runtime");
  const marker = join(root, markerName);
  if (!existsSync(marker)) {
    if (existsSync(runtime)) throw new Error("Refusing to alter an unmarked runtime");
    return undefined;
  }
  if (!lstatSync(marker).isFile()) throw new Error("Staging marker is not a regular file");
  const metadata = JSON.parse(readFileSync(marker, "utf8"));
  if (metadata.kind !== "openapply-user-staging" || typeof metadata.version !== "string"
    || !/^[a-f0-9]{64}$/.test(metadata.tarballSha256)) throw new Error("Invalid staging marker");
  if (existsSync(runtime)) {
    if (!lstatSync(runtime).isDirectory()) throw new Error("Staging runtime is not a regular directory");
    const entries = readdirSync(runtime).sort();
    if (entries.some((entry) => !["install", "node_modules", "package.json"].includes(entry))) {
      throw new Error(`Runtime contains unexpected files: ${entries.join(", ")}; inspect before uninstalling`);
    }
  }
  return { runtime, marker, metadata };
}

export function stagingRoot(arg) {
  const root = resolve(arg ?? defaultRoot());
  const localData = resolve(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"));
  if (root === parse(root).root || root === resolve(homedir()) || root === resolve(process.cwd())) {
    throw new Error("Choose a dedicated staging directory");
  }
  if (platform() === "win32") {
    if (!root.toLowerCase().startsWith(`${localData.toLowerCase()}${sep}`)) {
      throw new Error("Windows staging root must be inside the user's LocalAppData");
    }
  }
  for (let path = root; ; path = dirname(path)) {
    const info = lstatSync(path, { throwIfNoEntry: false });
    if (info) {
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Staging path contains a link or non-directory");
      if (platform() !== "win32") {
        if (path === root && ((process.getuid && info.uid !== process.getuid())
          || (info.mode & 0o077) !== 0)) throw new Error("Staging root must be owner-only");
        if (path !== root && (info.mode & 0o022) !== 0 && (info.mode & 0o1000) === 0) {
          throw new Error("Staging ancestor is writable by another user without a sticky bit");
        }
      }
    }
    if (path === parse(path).root) break;
  }
  if (platform() === "win32") {
    for (let path = dirname(root); path.toLowerCase().startsWith(localData.toLowerCase()); path = dirname(path)) {
      if (existsSync(path)) windowsPrivateRoot(path, "ancestor");
      if (path.toLowerCase() === localData.toLowerCase()) break;
    }
    if (existsSync(root)) windowsPrivateRoot(root, "assert");
  }
  return root;
}

export function installStaging(tarballPath, rootArg, withBrowser = false) {
  if (!npmCli) throw new Error("Run through npm so its CLI path is available");
  const tarball = resolve(tarballPath);
  if (!isAbsolute(tarballPath) || !statSync(tarball).isFile() || !tarball.endsWith(".tgz")) {
    throw new Error("Pass an absolute local .tgz package path");
  }
  const root = stagingRoot(rootArg);
  const existed = existsSync(root);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (!existed) {
    if (platform() === "win32") windowsPrivateRoot(root, "secure");
    else stagingRoot(root);
  }
  if (existsSync(join(root, "runtime")) || existsSync(join(root, markerName))) {
    throw new Error("A staging runtime already exists; uninstall it first");
  }
  const stage = join(root, `.pending-${randomUUID()}`);
  mkdirSync(stage, { mode: 0o700 });
  try {
    const installed = installLockedTarball(tarball, join(stage, "install"));
    const cli = join(installed.packageRoot, "dist", "src", "product-cli.js");
    if (!statSync(cli).isFile()) throw new Error("Installed package has no OpenApply CLI");
    if (!run(process.execPath, [cli, "--help"]).includes("  browser:install")) {
      throw new Error("Installed OpenApply CLI did not start");
    }
    if (withBrowser) {
      run(process.execPath, [cli, "browser:install"]);
      run(process.execPath, [cli, "browser:doctor"]);
    }
    writeFileSync(join(root, markerName), JSON.stringify({ kind: "openapply-user-staging",
      version: installed.version, tarballSha256: installed.tarballSha256, browserChecked: withBrowser }), { mode: 0o600, flag: "wx" });
    try { renameSync(stage, join(root, "runtime")); }
    catch (error) { unlinkSync(join(root, markerName)); throw error; }
    return { version: installed.version, root, browserChecked: withBrowser };
  } finally {
    if (existsSync(stage)) rmSync(stage, { recursive: true, force: true });
  }
}

export function uninstallStaging(rootArg) {
  const root = stagingRoot(rootArg);
  const managed = managedRuntime(root);
  if (!managed) return { removed: false, root };
  if (existsSync(managed.runtime)) rmSync(managed.runtime, { recursive: true });
  unlinkSync(managed.marker);
  return { removed: true, root };
}

export function statusStaging(rootArg) {
  const root = stagingRoot(rootArg);
  const managed = managedRuntime(root);
  return managed ? { installed: existsSync(managed.runtime), root, ...managed.metadata }
    : { installed: false, root };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const [command, ...args] = process.argv.slice(2);
  const rootIndex = args.indexOf("--root");
  const root = rootIndex >= 0 ? args[rootIndex + 1] : undefined;
  if (rootIndex >= 0 && !root) throw new Error("--root needs a directory");
  if (command === "install") console.log(JSON.stringify(installStaging(args[0], root, args.includes("--with-browser"))));
  else if (command === "uninstall") console.log(JSON.stringify(uninstallStaging(root)));
  else if (command === "status") console.log(JSON.stringify(statusStaging(root)));
  else throw new Error("Usage: staging-user-install.mjs install <absolute-tarball> [--root DIR] [--with-browser] | status [--root DIR] | uninstall [--root DIR]");
}
