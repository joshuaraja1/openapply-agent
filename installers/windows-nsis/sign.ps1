param([Parameter(Mandatory=$true)][string]$ExecutablePath)
$ErrorActionPreference = 'Stop'
$thumbprint = $env:OPENAPPLY_WINDOWS_CERT_THUMBPRINT
$timestamp = $env:OPENAPPLY_WINDOWS_TIMESTAMP_URL
if ($thumbprint -notmatch '^[A-Fa-f0-9]{40}$' -or $timestamp -notmatch '^https://') {
  throw 'A Windows signing thumbprint and HTTPS timestamp URL are required'
}
$path = [System.IO.Path]::GetFullPath($ExecutablePath)
if (-not (Test-Path -LiteralPath $path -PathType Leaf) -or
    [System.IO.Path]::GetExtension($path) -ne '.exe') { throw 'An EXE file is required' }
$signTool = Get-Command signtool.exe -ErrorAction Stop
$existing = Get-AuthenticodeSignature -LiteralPath $path
if ($existing.Status -eq 'Valid') {
  if ($existing.SignerCertificate.Thumbprint.ToUpperInvariant() -ne $thumbprint.ToUpperInvariant()) {
    throw 'Existing signature has an unexpected certificate'
  }
  Write-Output $path
  exit 0
}
& $signTool.Source sign /sha1 $thumbprint /fd SHA256 /tr $timestamp /td SHA256 $path
if ($LASTEXITCODE -ne 0) { throw 'Authenticode signing failed' }
$signature = Get-AuthenticodeSignature -LiteralPath $path
if ($signature.Status -ne 'Valid' -or
    $signature.SignerCertificate.Thumbprint.ToUpperInvariant() -ne $thumbprint.ToUpperInvariant()) {
  throw 'Executable did not validate against expected certificate'
}
Write-Output $path
