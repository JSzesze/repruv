CREATE TABLE IF NOT EXISTS usage_daily (
  day TEXT NOT NULL,
  event_name TEXT NOT NULL,
  outcome TEXT NOT NULL DEFAULT '',
  cache_status TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL DEFAULT '',
  status_code INTEGER NOT NULL DEFAULT 0,
  event_count INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  words INTEGER NOT NULL DEFAULT 0,
  markdown_bytes INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (
    day,
    event_name,
    outcome,
    cache_status,
    source,
    provider,
    status_code
  )
) WITHOUT ROWID;

