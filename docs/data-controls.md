# Local state export and deletion

`state:control` handles the application, quota, retry, posting-claim, and email-code ledgers, plus the configured discovery state and pending queue. It works with the active encrypted SQLite store or the legacy encrypted files. The export is **readable JSON containing private application data**. It does not contain the OS encryption key, saved browser cookies, account passwords, OAuth tokens, onboarding files, generated PDFs, or other files outside these state paths. Keep the export private; deleting application state does not delete those other data stores or revoke connected accounts.

Stop scheduled and manual OpenApply workers before deletion or restore. Current-version commands hold the workflow lease, but older releases must also be stopped. Set `OPENAPPLY_QUEUE_CONFIG` to the private queue configuration, `OPENAPPLY_STATE_EXPORT` to a new absolute JSON path, and `OPENAPPLY_STATE_ARCHIVE` to a new absolute archive directory. The export and archive should be on a private filesystem. Do not put the export inside the archive.

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
