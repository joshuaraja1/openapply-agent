param(
  [Parameter(Mandatory=$true)][string]$PayloadRoot,
  [Parameter(Mandatory=$true)][string]$OutputPath,
  [switch]$Sign
)
$ErrorActionPreference = 'Stop'
$payload = [System.IO.Path]::GetFullPath($PayloadRoot)
$output = [System.IO.Path]::GetFullPath($OutputPath)
if (-not (Test-Path -LiteralPath (Join-Path $payload 'node.exe') -PathType Leaf) -or
    -not (Test-Path -LiteralPath (Join-Path $payload 'package\dist\src\product-cli.js') -PathType Leaf) -or
    -not (Test-Path -LiteralPath (Join-Path $payload 'package\runtime-package-lock.json') -PathType Leaf)) {
  throw 'Payload must contain node.exe and a locked, built OpenApply package'
}
if (Test-Path -LiteralPath $output) { throw 'Output installer already exists' }
$compiler = Get-Command makensis.exe -ErrorAction SilentlyContinue
$binary = if ($compiler) { $compiler.Source } else {
  Join-Path ${env:ProgramFiles(x86)} 'NSIS\makensis.exe'
}
if (-not (Test-Path -LiteralPath $binary -PathType Leaf)) { throw 'NSIS compiler was not found' }
$versionOutput = (& $binary -VERSION | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $versionOutput -notmatch '^v3\.13(?:\.|$)') {
  throw "NSIS 3.13 is required, found $versionOutput"
}
$launcher = Join-Path $payload 'openapply.cmd'
if (Test-Path -LiteralPath $launcher) { throw 'Payload already contains an OpenApply launcher' }
Set-Content -LiteralPath $launcher -Encoding Ascii -Value '@echo off', '"%~dp0node.exe" "%~dp0package\dist\src\product-cli.js" %*'
$script = Join-Path $PSScriptRoot 'OpenApply.nsi'
$args = @('/V2', "/DPAYLOAD_ROOT=$payload", "/DOUTPUT_FILE=$output")
if ($Sign) {
  if ($env:OPENAPPLY_WINDOWS_CERT_THUMBPRINT -notmatch '^[A-Fa-f0-9]{40}$' -or
      $env:OPENAPPLY_WINDOWS_TIMESTAMP_URL -notmatch '^https://') {
    throw 'A Windows signing thumbprint and HTTPS timestamp URL are required'
  }
  $args += "/DSIGN_SCRIPT=$(Join-Path $PSScriptRoot 'sign.ps1')"
}
$args += $script
try {
  & $binary @args
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $output -PathType Leaf)) {
    throw 'NSIS installer build failed'
  }
  if ($Sign) {
    & (Join-Path $PSScriptRoot 'sign.ps1') $output
    if ($LASTEXITCODE -ne 0) { throw 'Signed installer verification failed' }
  }
  Write-Output $output
} finally {
  Remove-Item -LiteralPath $launcher -ErrorAction SilentlyContinue
}
