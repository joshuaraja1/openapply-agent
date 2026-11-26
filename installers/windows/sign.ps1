param(
  [Parameter(Mandatory=$true)][string]$MsiPath,
  [Parameter(Mandatory=$true)][string]$CertificateThumbprint,
  [Parameter(Mandatory=$true)][string]$TimestampUrl
)
$ErrorActionPreference = 'Stop'
if ($CertificateThumbprint -notmatch '^[A-Fa-f0-9]{40}$') { throw 'A SHA-1 certificate thumbprint is required' }
$path = [System.IO.Path]::GetFullPath($MsiPath)
if (-not (Test-Path -LiteralPath $path -PathType Leaf) -or [System.IO.Path]::GetExtension($path) -ne '.msi') { throw 'MSI file is required' }
if (-not $TimestampUrl.StartsWith('https://')) { throw 'HTTPS timestamp URL is required' }
$signTool = Get-Command signtool.exe -ErrorAction Stop
& $signTool.Source sign /sha1 $CertificateThumbprint /fd SHA256 /tr $TimestampUrl /td SHA256 $path
if ($LASTEXITCODE -ne 0) { throw 'Authenticode signing failed' }
$signature = Get-AuthenticodeSignature -LiteralPath $path
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Thumbprint.ToUpperInvariant() -ne $CertificateThumbprint.ToUpperInvariant()) {
  throw 'Signed MSI did not validate against expected certificate'
}
Write-Output $path
