param(
  [Parameter(Mandatory=$true)][string]$PayloadRoot,
  [Parameter(Mandatory=$true)][string]$OutputPath,
  [Parameter(Mandatory=$true)][string]$Version
)
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSEdition -ne 'Core' -and $PSVersionTable.PSVersion.Major -lt 5) { throw 'PowerShell 5 or later is required' }
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw 'Use a three-part MSI version' }
$payload = [System.IO.Path]::GetFullPath($PayloadRoot)
$output = [System.IO.Path]::GetFullPath($OutputPath)
if (-not (Test-Path -LiteralPath (Join-Path $payload 'node.exe') -PathType Leaf) -or
    -not (Test-Path -LiteralPath (Join-Path $payload 'package\dist\src\product-cli.js') -PathType Leaf) -or
    -not (Test-Path -LiteralPath (Join-Path $payload 'package\runtime-package-lock.json') -PathType Leaf)) {
  throw 'Payload must contain node.exe and a locked, built OpenApply package'
}
if (Test-Path -LiteralPath $output) { throw 'Output MSI already exists' }
$wix = Get-Command wix -ErrorAction Stop
$toolVersion = (& $wix.Source --version).Trim()
if ($LASTEXITCODE -ne 0 -or $toolVersion -notmatch '^5\.0\.2(?:\+[A-Za-z0-9]+)?$') { throw "WiX 5.0.2 is required, found $toolVersion" }
$source = Join-Path $PSScriptRoot 'OpenApply.wxs'
& $wix.Source build -arch x64 -d "AppVersion=$Version" -bindpath "Payload=$payload" -pdbtype none -out $output $source
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $output -PathType Leaf)) { throw 'WiX MSI build failed' }
Write-Output $output
