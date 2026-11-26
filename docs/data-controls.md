# Local state export and deletion

The token-protected local setup screen also exposes these four actions under
**Local state controls** when `OPENAPPLY_QUEUE_CONFIG` is set. It uses fixed
private paths at `~/.openapply-agent/state-export.json` and
`~/.openapply-agent/removed-state`; the browser cannot choose a filesystem
path. Type the displayed phrase for each operation. Export is idempotent only
when the contents match; it refuses to replace a different backup. Quarantine
requires a current export. Stop all OpenApply workers first, including older
versions that may not use the workflow lease. The screen shows whether the
export and archive exist without returning their paths or contents over HTTP.
Purging the archive leaves the JSON export, onboarding files, browser profile,
artifacts, OS secrets, and account grants in place.

`state:control` handles the application, quota, retry, posting-claim, and email-code ledgers, plus the configured discovery state and pending queue. It works with the active encrypted SQLite store or the legacy encrypted files. The export is **readable JSON containing private application data**. It does not contain the OS encryption key, saved browser cookies, account passwords, OAuth tokens, onboarding files, generated PDFs, or other files outside these state paths. Keep the export private; deleting application state does not delete those other data stores or revoke connected accounts.

Stop scheduled and manual OpenApply workers before deletion or restore. Current-version commands hold the workflow lease, but older releases must also be stopped. Set `OPENAPPLY_QUEUE_CONFIG` to the private queue configuration, `OPENAPPLY_STATE_EXPORT` to a new absolute JSON path, and `OPENAPPLY_STATE_ARCHIVE` to a new absolute archive directory. The export and archive should be on a private filesystem. Do not put the export inside the archive.
The archive must be on the same filesystem as every configured state file;
cross-device moves and hardlinks are refused. If queue or discovery state is on
another volume, move it to the same volume under the private setup before using
this command.

```sh
npm run state:control -- export
npm run state:control -- delete --confirm-inactive --confirm-delete
```

The delete phase first compares the live state to the export, then moves the known state files into the private archive. It refuses a stale export, unsafe file permissions, path collisions, or an existing SQLite journal/WAL sidecar. A partially interrupted move can be retried with `restore`; it never overwrites newer state:

```sh
npm run state:control -- restore --confirm-inactive
```

After checking the export and confirming that rollback is no longer needed, permanently remove the complete archive:

```sh
npm run state:control -- purge --confirm-inactive --confirm-permanent-delete
```

Purge is irreversible. The exported JSON remains at the chosen path until the user deletes it. This command is a state-only control; full product deletion must also cover browser profiles, local input and output files, OS-stored credentials, and any connected account grants. No operation prints candidate data or secret values to stdout.
An interrupted purge can be retried with the same explicit confirmation; it
removes only remaining files listed in the validated archive manifest.
