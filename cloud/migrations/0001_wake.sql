CREATE TABLE IF NOT EXISTS wake (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
  issued_at TEXT NOT NULL
);
INSERT OR IGNORE INTO wake (id, generation, issued_at) VALUES (1, 0, '1970-01-01T00:00:00.000Z');
