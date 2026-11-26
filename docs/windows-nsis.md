# Windows NSIS installer path

NSIS 3.13 is the maintained compiler used for the Windows EXE path. The
[official license](https://nsis.sourceforge.io/License) permits commercial
use of the zlib compressor, which this installer selects. The
[official download page](https://nsis.sourceforge.io/Download) lists 3.13.
The staging CI pins Chocolatey's `nsis` package to 3.13.0 and uses a locked
OpenApply npm tarball plus a bundled Node executable.

The installer requests user privileges and writes only the executable
runtime under `%LOCALAPPDATA%\OpenApply\runtime`. It rejects an existing
runtime until a verified updater is implemented. The generated uninstaller
requires an install marker and removes only that runtime folder; candidate
data and secrets remain outside it. Windows CI builds an unsigned EXE, runs
the installed CLI, checks reinstall rejection, uninstalls, and verifies a
candidate-data sentinel survives.

`installers/windows-nsis/build.ps1` accepts `-Sign` only when a valid
certificate thumbprint and HTTPS timestamp endpoint are provided in
`OPENAPPLY_WINDOWS_CERT_THUMBPRINT` and
`OPENAPPLY_WINDOWS_TIMESTAMP_URL`. It signs both the NSIS uninstaller and the
outer installer through `signtool.exe`, then checks Authenticode. Keep the
certificate and its private key in the Windows certificate store or a
managed signing service. Never commit it to this repository. The release
bundle verifier also accepts a signed Windows `.exe` and checks its trusted
certificate thumbprint and signed manifest hash.

This is still staging. The unsigned CI run does not establish that the
signing service is available, that the installed uninstaller is signed on a
clean machine, or that updates and rollback preserve compatible state. A
signed clean install, failed update, rollback, and uninstall drill remain
release gates. A browser runtime and first-run desktop UX are not bundled by
this CLI installer.
