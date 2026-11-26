/** Version 1 keeps identifiers opaque and private fields in authenticated payloads. */
export const SQLITE_SCHEMA_VERSION = 1;

export const SQLITE_SCHEMA = `
PRAGMA foreign_keys = ON;
CREATE TABLE schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;
CREATE TABLE sources (
  source_key TEXT PRIMARY KEY CHECK (length(source_key) = 64),
  provider TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  nonce BLOB NOT NULL CHECK (length(nonce) = 12),
  tag BLOB NOT NULL CHECK (length(tag) = 16),
  ciphertext BLOB NOT NULL
) STRICT;
CREATE TABLE jobs (
  job_key TEXT PRIMARY KEY CHECK (length(job_key) = 64),
  source_key TEXT REFERENCES sources(source_key),
  provider TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  source_posted_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'closed', 'unknown')),
  nonce BLOB NOT NULL CHECK (length(nonce) = 12),
  tag BLOB NOT NULL CHECK (length(tag) = 16),
  ciphertext BLOB NOT NULL
) STRICT;
CREATE INDEX jobs_freshness ON jobs(status, source_posted_at, first_seen_at);
CREATE TABLE queue_entries (
  job_key TEXT PRIMARY KEY CHECK (length(job_key) = 64),
  priority INTEGER NOT NULL,
  queued_at TEXT NOT NULL,
  nonce BLOB NOT NULL CHECK (length(nonce) = 12),
  tag BLOB NOT NULL CHECK (length(tag) = 16),
  ciphertext BLOB NOT NULL
) STRICT;
CREATE INDEX queue_entries_priority ON queue_entries(priority, queued_at);
CREATE TABLE applications (
  job_key TEXT PRIMARY KEY CHECK (length(job_key) = 64),
  version INTEGER NOT NULL CHECK (version > 0),
  stage TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  nonce BLOB NOT NULL CHECK (length(nonce) = 12),
  tag BLOB NOT NULL CHECK (length(tag) = 16),
  ciphertext BLOB NOT NULL
) STRICT;
CREATE INDEX applications_stage ON applications(stage, updated_at);
CREATE TABLE application_events (
  id INTEGER PRIMARY KEY,
  job_key TEXT NOT NULL CHECK (length(job_key) = 64),
  event_type TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  nonce BLOB NOT NULL CHECK (length(nonce) = 12),
  tag BLOB NOT NULL CHECK (length(tag) = 16),
  ciphertext BLOB NOT NULL
) STRICT;
CREATE INDEX application_events_job ON application_events(job_key, id);
CREATE TABLE posting_claims (
  url_key TEXT PRIMARY KEY CHECK (length(url_key) = 64),
  job_key TEXT NOT NULL CHECK (length(job_key) = 64),
  claimed_at TEXT NOT NULL
) STRICT;
CREATE TABLE daily_reservations (
  day TEXT NOT NULL,
  job_key TEXT NOT NULL CHECK (length(job_key) = 64),
  reserved_at TEXT NOT NULL,
  PRIMARY KEY (day, job_key)
) STRICT;
CREATE INDEX daily_reservations_day ON daily_reservations(day);
CREATE TABLE retry_counts (
  job_key TEXT PRIMARY KEY CHECK (length(job_key) = 64),
  failures INTEGER NOT NULL CHECK (failures >= 0),
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE handoffs (
  job_key TEXT PRIMARY KEY CHECK (length(job_key) = 64),
  status TEXT NOT NULL CHECK (status IN ('waiting', 'resumed', 'resolved')),
  nonce BLOB NOT NULL CHECK (length(nonce) = 12),
  tag BLOB NOT NULL CHECK (length(tag) = 16),
  ciphertext BLOB NOT NULL
) STRICT;
CREATE TABLE artifacts (
  sha256 TEXT PRIMARY KEY CHECK (length(sha256) = 64),
  job_key TEXT NOT NULL CHECK (length(job_key) = 64),
  created_at TEXT NOT NULL,
  nonce BLOB NOT NULL CHECK (length(nonce) = 12),
  tag BLOB NOT NULL CHECK (length(tag) = 16),
  ciphertext BLOB NOT NULL
) STRICT;
CREATE TABLE legacy_records (
  record_key TEXT PRIMARY KEY CHECK (length(record_key) = 64),
  version INTEGER NOT NULL CHECK (version > 0),
  kind TEXT NOT NULL,
  nonce BLOB NOT NULL CHECK (length(nonce) = 12),
  tag BLOB NOT NULL CHECK (length(tag) = 16),
  ciphertext BLOB NOT NULL
) STRICT;
`;
