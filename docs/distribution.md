# Distribution status and update contract

`npm run distribution:smoke` builds the portable npm tarball, checks that it
contains the CLI and public templates without private runtime files, installs
it into a temporary directory, and starts the installed CLI. It also installs
a synthetic prior version, replaces it with the current tarball, and reinstalls
the prior version. Each phase verifies the CLI, public templates, and an isolated
private-state sentinel. CI runs this check on macOS, Windows, and Linux. It
exercises package replacement rather than only `npm pack --dry-run`.

The prior version differs only in package metadata; this smoke cannot prove
compatibility with a genuinely older runtime or database schema. It also does
not exercise failed-update recovery. Those require real versioned artifacts and
state migration fixtures before an updater can ship.

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
The installed CLI is under `runtime/install/package/dist/src/product-cli.js`
inside that directory and runs with the current Node installation. No admin
privileges or global npm installation are needed.

Uninstall checks an OpenApply marker outside the managed `runtime` directory,
so an interrupted removal can be retried, and removes only that directory.
Candidate files, SQLite state, keychain secrets, and the shared
Chromium cache are outside that directory and remain in place. This script
does not create a launcher, register a scheduler, perform upgrades, or verify
release signatures. It uses the locked tarball path below to check dependency
hashes before starting the CLI. The package and its lock are still unsigned.
Use it only for controlled staging with a trusted artifact; do not publish it
as a public installer.

## Locked tarball install for staging

`npm pack` now adds `runtime-package-lock.json` to the portable tarball. From a
source checkout, run `npm run distribution:locked-install -- /absolute/path/to/openapply-agent-0.1.0.tgz /absolute/empty/destination`.
The helper rejects archive paths outside `package/` and archive links, validates
the package against its lock, then runs `npm ci --omit=dev --ignore-scripts` in
the extracted package before starting its CLI and importing runtime/native
dependencies. npm verifies downloaded archive bytes against the lock's
integrity hashes. If extraction or installation fails, the destination is
removed. CI checks this path on macOS, Windows, and Linux, including a separate
synthetic prior-version install that remains runnable for manual rollback and
altered-hash and missing-dependency archives.

The existing portable `npm install <tarball>` smoke remains a compatibility
check; it does not pin transitive dependency resolution. The user-level staging
installer now calls this locked path. The lock itself is inside an unsigned
tarball, so this remains a controlled staging check, not a verified public
release artifact.

## Release signature preflight

`npm run distribution:verify-release -- /absolute/bundle /absolute/trusted-public-key.pem`
fails unless an Ed25519-signed manifest names one macOS `.pkg`, one Windows
`.msi`, and one Linux `.tar.gz`; all three files must match SHA-256 hashes in
that manifest. Keep the signing key outside the repository. Set
`OPENAPPLY_RELEASE_KEY_SHA256` to the SHA-256 fingerprint of the trusted
public-key PEM obtained through a separately trusted channel; the command
refuses an absent or different key. The command then checks the native
signature for **the current OS**: macOS requires a trusted-timestamp Developer
ID Installer signature from `OPENAPPLY_APPLE_TEAM_ID`, a stapled notarization
ticket, and Gatekeeper acceptance; Windows requires a valid Authenticode
signature from `OPENAPPLY_WINDOWS_CERT_THUMBPRINT`. Linux relies on the signed
manifest and artifact hash for this portable tarball. Run the command on all
three operating systems before publishing anything. Synthetic CI fixtures
exercise valid and rejected paths on all three platforms.

The bundle contains `release-manifest.json`, its raw Ed25519 signature in
`release-manifest.sig`, and the three files named by the manifest:

```json
{
  "schemaVersion": 1,
  "version": "0.1.0",
  "artifacts": [
    { "platform": "darwin", "file": "OpenApply.pkg", "sha256": "<64 lowercase hex characters>" },
    { "platform": "win32", "file": "OpenApply.msi", "sha256": "<64 lowercase hex characters>" },
    { "platform": "linux", "file": "OpenApply.tar.gz", "sha256": "<64 lowercase hex characters>" }
  ]
}
```

This preflight does not build or sign the installers, authenticate the identity
of a newly supplied public key, or publish a release. No production release key
is registered, no native macOS/Windows installers are built, and no signed
Linux distribution artifact is produced. Until those exist and verification
passes on real artifacts, a public release remains blocked. A Windows
code-signing certificate or signing service is still needed; do not put its
private material in repository files or CI logs.

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
requires a validated code-signing identity; Linux needs a production
distribution format and signing process. This preflight covers a portable
Linux tarball only. No production signing or packaging is configured by this PR.
