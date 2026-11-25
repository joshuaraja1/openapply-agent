import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);

// The path is supplied through the child environment, not interpolated into PowerShell.
const aclScript = `
$ErrorActionPreference = 'Stop'
$path = $env:OPENAPPLY_ACL_PATH
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$item = Get-Item -LiteralPath $path -ErrorAction Stop
if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { throw 'Reparse points are not private files' }
$acl = Get-Acl -LiteralPath $path
if ($env:OPENAPPLY_ACL_ACTION -eq 'secure') {
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($rule in @($acl.GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier]))) {
    [void]$acl.RemoveAccessRuleAll($rule)
  }
  $inheritance = [System.Security.AccessControl.InheritanceFlags]::None
  if ($item.PSIsContainer) {
    $inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
      [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
  }
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
    $identity, [System.Security.AccessControl.FileSystemRights]::FullControl,
    $inheritance, [System.Security.AccessControl.PropagationFlags]::None,
    [System.Security.AccessControl.AccessControlType]::Allow)
  [void]$acl.AddAccessRule($rule)
  Set-Acl -LiteralPath $path -AclObject $acl
  $acl = Get-Acl -LiteralPath $path
}
if (-not $acl.AreAccessRulesProtected) { throw 'Private path inherits access rules' }
$rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
if ($rules.Count -ne 1 -or $rules[0].IdentityReference.Value -ne $identity.Value -or
  $rules[0].AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or
  -not ($rules[0].FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl)) {
  throw 'Private path has non-owner access rules'
}
if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $identity.Value) {
  throw 'Private path is not owned by the current user'
}
`;

async function runAcl(path: string, action: "secure" | "assert"): Promise<void> {
  if (process.platform !== "win32") throw new Error("Windows ACL checks require Windows");
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !(metadata.isFile() || metadata.isDirectory())) {
    throw new Error("Private path must be a regular file or directory");
  }
  try {
    await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand",
      Buffer.from(aclScript, "utf16le").toString("base64")], {
      env: { ...process.env, OPENAPPLY_ACL_PATH: path, OPENAPPLY_ACL_ACTION: action },
      timeout: 15_000, maxBuffer: 16_384,
    });
  } catch {
    throw new Error("Windows private path ACL is unsafe or could not be checked");
  }
}

export const secureWindowsPrivatePath = (path: string): Promise<void> => runAcl(path, "secure");
export const assertWindowsPrivatePath = (path: string): Promise<void> => runAcl(path, "assert");
