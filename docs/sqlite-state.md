# Local SQLite state, version 1

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

The only unencrypted workflow fields are operational indexes such as provider, stage, status, timestamps, count, and hashes. Payloads use AES-256-GCM with a fresh nonce and authentication tag. A keyed HMAC keeps record identifiers and URLs out of the SQLite file. The existing application-state key is supplied by the caller and stays in the OS secret store. No key is written to SQLite.

## Staged migration and rollback

`stageSqliteMigration` requires an inactive workflow, verifies private file permissions, reads the current encrypted application state, and builds a new private SQLite file. It copies every record and version, including deletion tombstones, into `legacy_records`; it does **not** change the active store or delete the old file. Publication fails if the target already exists. The source digest is checked again before publication.

`readStagedRecords` decrypts and validates the copy for parity checks. `rollbackStagedMigration` requires an inactive workflow, the same key, the original source digest, valid staged records, and no writes in any operational table. It removes only the staged database. A changed source or database needs manual reconciliation rather than automatic deletion.

This PR defines the storage contract and a reversible **pre-activation** migration. It does not route the scheduler or application queue through SQLite. The activation PR must implement the encrypted SQLite state adapter, a one-time cutover lock, and a recovery or export path for any data written after cutover. No application may use the new database until that work and cross-platform tests pass.

The current migration uses SQLite's delete journal mode, so there is one durable database file to publish and remove. If a later runtime uses WAL, it must keep the `-wal` and `-shm` files private and checkpoint them as part of backup, export, and rollback.
