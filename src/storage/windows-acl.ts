import { execFile } from "node:child_process";
import { lstat, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

// The path is supplied through the child environment, not interpolated into PowerShell.
const aclScript = `
$ErrorActionPreference = 'Stop'
$path = $env:OPENAPPLY_ACL_PATH
$token = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$identity = $token.User
if ([System.IO.Directory]::Exists($path)) {
  $item = [System.IO.DirectoryInfo]::new($path)
  $isDirectory = $true
} elseif ([System.IO.File]::Exists($path)) {
  $item = [System.IO.FileInfo]::new($path)
  $isDirectory = $false
} else { throw 'Private path is missing' }
if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { throw 'Reparse points are not private files' }
$acl = $item.GetAccessControl()
if ($env:OPENAPPLY_ACL_ACTION -eq 'secure') {
  $acl.SetAccessRuleProtection($true, $false)
  $acl.SetOwner($identity)
  foreach ($rule in @($acl.GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier]))) {
    [void]$acl.RemoveAccessRuleAll($rule)
  }
  $inheritance = [System.Security.AccessControl.InheritanceFlags]::None
  if ($isDirectory) {
    $inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
      [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
  }
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
    $identity, [System.Security.AccessControl.FileSystemRights]::FullControl,
    $inheritance, [System.Security.AccessControl.PropagationFlags]::None,
    [System.Security.AccessControl.AccessControlType]::Allow)
  [void]$acl.AddAccessRule($rule)
  $item.SetAccessControl($acl)
  $acl = $item.GetAccessControl()
}
if (-not $acl.AreAccessRulesProtected -and $env:OPENAPPLY_ACL_ACTION -ne 'seal-inherited') {
  throw 'Private path inherits access rules'
}
function Assert-OwnerOnlyRules($security) {
  $rules = @($security.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
  if ($rules.Count -ne 1 -or $rules[0].IdentityReference.Value -ne $identity.Value -or
    $rules[0].AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or
    ($rules[0].FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -ne
      [System.Security.AccessControl.FileSystemRights]::FullControl) {
    throw 'Private path has non-owner access rules'
  }
}
Assert-OwnerOnlyRules $acl
if ($env:OPENAPPLY_ACL_ACTION -eq 'seal-inherited' -and
  $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $identity.Value) {
  $administrators = [System.Security.Principal.SecurityIdentifier]::new(
    [System.Security.Principal.WellKnownSidType]::BuiltinAdministratorsSid, $null)
  $principal = [System.Security.Principal.WindowsPrincipal]::new($token)
  if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $administrators.Value -or
    -not $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Private path has an unrelated owner'
  }
  # DACL has already passed the sole-current-user check. Change owner only.
  $acl.SetOwner($identity)
  $item.SetAccessControl($acl)
  $acl = $item.GetAccessControl()
  Assert-OwnerOnlyRules $acl
}
if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $identity.Value) {
  throw 'Private path is not owned by the current user'
}
`;

async function runAcl(path: string, action: "secure" | "assert" | "seal-inherited"): Promise<void> {
  if (process.platform !== "win32") throw new Error("Windows ACL checks require Windows");
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !(metadata.isFile() || metadata.isDirectory())) {
    throw new Error("Private path must be a regular file or directory");
  }
  const env: NodeJS.ProcessEnv = { ...process.env, OPENAPPLY_ACL_PATH: path, OPENAPPLY_ACL_ACTION: action };
  // A PowerShell 7 parent can pass an incompatible module path to Windows PowerShell 5.
  delete env.PSModulePath;
  try {
    await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand",
      Buffer.from(aclScript, "utf16le").toString("base64")], {
      env,
      timeout: 15_000, maxBuffer: 16_384,
    });
  } catch {
    throw new Error("Windows private path ACL is unsafe or could not be checked");
  }
}

export const secureWindowsPrivatePath = (path: string): Promise<void> => runAcl(path, "secure");
export const assertWindowsPrivatePath = (path: string): Promise<void> => runAcl(path, "assert");
/** Validate an inherited owner-only DACL, then normalize an elevated admin owner. */
export async function sealWindowsPrivateChildPath(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Private child must be a regular file");
  await assertWindowsPrivatePath(dirname(path));
  await runAcl(path, "seal-inherited");
}

/** Create one directory privately, or reject an existing directory with a shared ACL. */
export async function ensureWindowsPrivateDirectory(path: string): Promise<void> {
  if (process.platform !== "win32") throw new Error("Windows ACL checks require Windows");
  try {
    await mkdir(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    await assertWindowsPrivatePath(path);
    return;
  }
  await secureWindowsPrivatePath(path);
}
