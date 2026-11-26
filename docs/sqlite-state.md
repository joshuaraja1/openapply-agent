# Local SQLite state and migration

OpenApply's first database is a **local, per-user SQLite file**. It does not require a hosted database or account. The browser profile, OS keychain entries, candidate source documents, and rendered PDFs remain separate private files. SQLite tracks discovery and application workflow state; it is not a place to store browser cookies or raw passwords. The migration uses Node's built-in SQLite module so installation does not require a C++ build toolchain; Node 22 still marks this module experimental, so the runtime cutover requires compatibility checks before release.

## Schema boundary

| Table | Purpose | Identifiers and sensitive data |
| --- | --- | --- |
| `schema_meta` | Schema version and migration provenance | No candidate data |
| `sources` | Configured discovery sources | HMAC source key; source details encrypted |
| `jobs` | Deduplicated postings and freshness | HMAC job key; description and URL encrypted |
| `queue_entries` | Pending job order and matching package | HMAC job key; brief and handoff encrypted |
| `applications` | Current stage and optimistic version | HMAC job key; checkpoint encrypted |
| `application_events` | Append-only stage/history records | HMAC job key; event payload encrypted |
| `posting_claims` | Duplicate submission guard | HMAC URL and job keys |
| `daily_reservations` | Per-day application quota reservations | HMAC job key |
| `retry_counts` | Recovery and backoff | HMAC job key |
| `handoffs` | Pending human actions | HMAC job key; answers and context encrypted |
| `artifacts` | PDF provenance | PDF hash and HMAC job key; path encrypted |
| `legacy_records` | Lossless copy of current encrypted state, including tombstones | HMAC record key; full record encrypted |
| `state_records` (version 2) | Active encrypted workflow records with namespace and optimistic version | HMAC record key; full record encrypted |

The only unencrypted workflow fields are operational indexes such as provider, stage, status, timestamps, count, and hashes. Payloads use AES-256-GCM with a fresh nonce and authentication tag. A keyed HMAC keeps record identifiers and URLs out of the SQLite file. The existing application-state key is supplied by the caller and stays in the OS secret store. No key is written to SQLite.

## Staged migration and rollback

`stageSqliteMigration` requires an inactive workflow, verifies private file permissions, reads the current encrypted application state, and builds a new private SQLite file. It copies every record and version, including deletion tombstones, into `legacy_records`; it does **not** change the active store or delete the old file. Publication fails if the target already exists. The source digest is checked again before publication.

`readStagedRecords` decrypts and validates the copy for parity checks. `rollbackStagedMigration` requires an inactive workflow, the same key, the original source digest, valid staged records, and no writes in any operational table. It removes only the staged database. A changed source or database needs manual reconciliation rather than automatic deletion.

The runtime cutover copies the application, quota, retry, posting-claim, and email-code ledgers plus the private discovery state and pending queue into encrypted `state_records`. These records use a namespace, keyed identifier, version, fresh nonce, authentication tag, and encrypted payload. No old file is removed during activation. The active database is `$HOME/.openapply-agent/state.sqlite`; discovery, queue, application, and status commands automatically use it only after the metadata says `active`. A staged database leaves all commands on the old files.

Stop the scheduled discovery and application workers before cutover. Set `OPENAPPLY_QUEUE_CONFIG` to the private queue configuration, then run `npm run state:cutover -- --confirm-inactive` (or `openapply state:cutover --confirm-inactive`). The command stages the application file if needed, checks the source files again, and commits the copies and active marker together. The flag records the operator's confirmation that no workflow process is running; the command cannot independently prove that. Keep the old files as a rollback copy.

Current-version discovery, application, status, scheduled autopilot, and cutover commands hold a private process lease for their full run. Cutover and rollback fail if another command holds it, and workers cannot start while maintenance holds it. Stop older OpenApply releases before maintenance because they do not use this lease. If a process crashes and leaves `$HOME/.openapply-agent/workflow.lock`, inspect that no worker remains and stop the scheduler before removing the empty lock directory manually; never remove a live process's lock.

After cutover, discovery and queue commands require the same discovery-state and queue paths used at cutover. A path mismatch stops the command before it reads or writes SQLite state. Run discovery through `autopilot`, or set `OPENAPPLY_STATE` and `OPENAPPLY_OUTPUT` to the paths in `OPENAPPLY_QUEUE_CONFIG` when invoking it directly.

If the active database needs to be reverted, stop the workers and run `npm run state:cutover -- --rollback --confirm-inactive`. It exports current SQLite records, including tombstones and versions, back to private legacy files, verifies parity, then marks SQLite `rolled-back`. If export fails midway, SQLite stays active and the export can be retried. The database remains on disk for inspection; cutover cannot be repeated over it without moving it to an archival private path first. Run only one release's workers during and after migration: older OpenApply versions do not understand the active marker.

The normalized `jobs`, `queue_entries`, `applications`, and other operational tables remain reserved for later adapters. The first active runtime stores complete encrypted records in `state_records` so existing workflow behavior and optimistic version checks survive the cutover. This keeps the storage transition separate from changes to discovery and application logic.

The current migration uses SQLite's delete journal mode, so there is one durable database file to publish and remove. If a later runtime uses WAL, it must keep the `-wal` and `-shm` files private and checkpoint them as part of backup, export, and rollback.
