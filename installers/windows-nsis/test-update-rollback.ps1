param([Parameter(Mandatory=$true)][string]$LockedPayloadRoot)
$ErrorActionPreference = 'Stop'
if ($env:CI -ne 'true' -or -not $env:RUNNER_TEMP) {
  throw 'This unsigned install drill only runs on a disposable CI runner'
}
$runtime = Join-Path $env:LOCALAPPDATA 'OpenApply\runtime'
if (Test-Path -LiteralPath $runtime) { throw 'CI runtime must be absent before the drill' }
$root = Join-Path $env:RUNNER_TEMP ('openapply-update-drill-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root | Out-Null
$candidate = Join-Path $env:LOCALAPPDATA 'OpenApply\candidate-update-sentinel.txt'
$sentinel = 'candidate-state-must-survive-update-and-rollback'
Set-Content -LiteralPath $candidate -Value $sentinel
function Assert-CandidateState {
  if ((Get-Content -LiteralPath $candidate -Raw).Trim() -ne $sentinel) {
    throw 'Candidate state changed during install, update, or rollback'
  }
}
function Invoke-Setup([string]$path, [bool]$expectSuccess) {
  $result = Start-Process -FilePath $path -ArgumentList '/S' -Wait -PassThru
  if (($result.ExitCode -eq 0) -ne $expectSuccess) {
    throw "Unexpected installer result: $($result.ExitCode)"
  }
}
function Invoke-Uninstall {
  $result = Start-Process -FilePath (Join-Path $runtime 'Uninstall.exe') -ArgumentList '/S' -Wait -PassThru
  if ($result.ExitCode -ne 0) { throw "Uninstall failed: $($result.ExitCode)" }
  for ($i = 0; $i -lt 30 -and (Test-Path -LiteralPath (Join-Path $runtime 'node.exe')); $i++) {
    Start-Sleep -Seconds 1
  }
  if (Test-Path -LiteralPath (Join-Path $runtime 'node.exe')) { throw 'Runtime remained after uninstall' }
}
function Assert-Revision([string]$expected) {
  if ((Get-Content -LiteralPath (Join-Path $runtime 'ci-revision.txt') -Raw).Trim() -ne $expected) {
    throw "Runtime revision is not $expected"
  }
  & (Join-Path $runtime 'openapply.cmd') --help | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Runtime $expected cannot start" }
  Assert-CandidateState
}
$oldPayload = Join-Path $root 'old-payload'
$newPayload = Join-Path $root 'new-payload'
Copy-Item -LiteralPath $LockedPayloadRoot -Destination $oldPayload -Recurse
Copy-Item -LiteralPath $LockedPayloadRoot -Destination $newPayload -Recurse
Set-Content -LiteralPath (Join-Path $oldPayload 'ci-revision.txt') -Value 'old'
Set-Content -LiteralPath (Join-Path $newPayload 'ci-revision.txt') -Value 'new'
$oldSetup = Join-Path $root 'old-setup.exe'
$newSetup = Join-Path $root 'new-setup.exe'
& (Join-Path $PSScriptRoot 'build.ps1') -PayloadRoot $oldPayload -OutputPath $oldSetup | Out-Null
& (Join-Path $PSScriptRoot 'build.ps1') -PayloadRoot $newPayload -OutputPath $newSetup | Out-Null
if ((Get-AuthenticodeSignature -LiteralPath $newSetup).Status -eq 'Valid') {
  throw 'Unsigned CI fixture unexpectedly has a trusted signature'
}
$env:OPENAPPLY_WINDOWS_CERT_THUMBPRINT = ''
$env:OPENAPPLY_WINDOWS_TIMESTAMP_URL = ''
$signRejected = $false
try {
  & (Join-Path $PSScriptRoot 'build.ps1') -PayloadRoot $newPayload -OutputPath (Join-Path $root 'forbidden-signed.exe') -Sign | Out-Null
} catch {
  $signRejected = $_.Exception.Message -like '*signing thumbprint*'
}
if (-not $signRejected -or (Test-Path -LiteralPath (Join-Path $root 'forbidden-signed.exe'))) {
  throw 'Build accepted a release without signing credentials'
}
# An empty junction would bypass the old "directory has files" reinstall check.
$external = Join-Path $root 'external-candidate-data'
New-Item -ItemType Directory -Path $external | Out-Null
New-Item -ItemType Junction -Path $runtime -Target $external | Out-Null
Invoke-Setup $oldSetup $false
if (@(Get-ChildItem -LiteralPath $external -Force).Count -ne 0) {
  throw 'Installer wrote through a runtime junction'
}
Remove-Item -LiteralPath $runtime -Force
Invoke-Setup $oldSetup $true
Assert-Revision 'old'
# Until a signed updater exists, an attempted in-place upgrade must fail closed.
Invoke-Setup $newSetup $false
Assert-Revision 'old'
Invoke-Uninstall
Invoke-Setup $newSetup $true
Assert-Revision 'new'
# A rollback drill reinstalls the previous locked runtime without touching data.
Invoke-Uninstall
Invoke-Setup $oldSetup $true
Assert-Revision 'old'
Invoke-Uninstall
Assert-CandidateState
