# Distribution status and update contract

`npm run distribution:smoke` builds the portable npm tarball, checks that it
contains the CLI and public templates without private runtime files, installs
it into a temporary directory, and starts the installed CLI. CI runs this
check on macOS, Windows, and Linux. It exercises the artifact users would
install rather than only `npm pack --dry-run`.

This is a portable CLI preview. It does not install a browser, configure OS
permissions or schedulers, sign or notarize software, or provide an updater.
It must not be presented as a consumer installer or unattended public release.

## Unsigned user-level staging install

From a source checkout, run `npm ci`, then `npm pack`. Install the resulting
absolute `.tgz` path with `npm run distribution:staging -- install /absolute/path/to/openapply-agent-0.1.0.tgz`.
Add `--with-browser` to install Chromium into Playwright's user cache and run
`browser:doctor`; without it, the install records that browser readiness was not
checked. Use `npm run distribution:staging -- status` to inspect the staged
version and `npm run distribution:staging -- uninstall` to remove it.

The default install directory is user-owned: `~/Library/Application Support/OpenApply/staging`
on macOS, `%LOCALAPPDATA%/OpenApply/staging` on Windows, and
`$XDG_DATA_HOME/openapply/staging` (or `~/.local/share/openapply/staging`) on Linux.
For isolated tests, append `--root /absolute/test/directory` to each command.
An existing root must be owned by the current user with owner-only Unix
permissions or a protected owner-only Windows ACL. Windows custom roots must
stay inside the current user's LocalAppData. Linked path components and unsafe
shared ancestors are rejected.
The installed CLI is under `runtime/node_modules/openapply-agent/dist/src/product-cli.js`
inside that directory and runs with the current Node installation. No admin
privileges or global npm installation are needed.

Uninstall checks an OpenApply marker outside the managed `runtime` directory,
so an interrupted removal can be retried, and removes only that directory.
Candidate files, SQLite state, keychain secrets, and the shared
Chromium cache are outside that directory and remain in place. This script
does not create a launcher, register a scheduler, perform upgrades, or verify
release signatures or dependency integrity independently of npm registry
resolution. Use it only for controlled staging and testing; do not publish it
as a public installer.

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
