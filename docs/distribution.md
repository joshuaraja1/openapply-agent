# Distribution status and update contract

`npm run distribution:smoke` builds the portable npm tarball, checks that it
contains the CLI and public templates without private runtime files, installs
it into a temporary directory, and starts the installed CLI. CI runs this
check on macOS, Windows, and Linux. It exercises the artifact users would
install rather than only `npm pack --dry-run`.

This is a portable CLI preview. It does not install a browser, configure OS
permissions or schedulers, sign or notarize software, or provide an updater.
It must not be presented as a consumer installer or unattended public release.

## Requirements for a safe updater

An updater must stop scheduled discovery and application workers before
changing executable files; verify a signed release manifest and artifact
digest; preserve the user's private browser profile, keychain secrets, SQLite
database, documents, and artifacts outside the install directory; and start
the new version only after a clean-install smoke succeeds. The previous
verified version must remain available for rollback. Rollback must first
check state compatibility and may require the documented SQLite export path;
an old binary must never run against a newer, incompatible state schema.

Before consumer release, test clean install, update, failed update, rollback,
and uninstall on each supported OS, including browser installation and private
file permissions. macOS requires validated signing and notarization; Windows
requires a validated code-signing identity; Linux needs a chosen signed
package format and verification mechanism. None is configured by this PR.
