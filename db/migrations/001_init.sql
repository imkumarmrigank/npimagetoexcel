CREATE TABLE IF NOT EXISTS months (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  year INT NOT NULL,
  month INT NOT NULL CHECK (month BETWEEN 1 AND 12),
  hsd_rate NUMERIC,
  ms_rate NUMERIC,
  total_ob NUMERIC,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (year, month)
);

CREATE TABLE IF NOT EXISTS entries (
  id SERIAL PRIMARY KEY,
  month_id INT NOT NULL REFERENCES months(id) ON DELETE CASCADE,
  day INT,
  report_date TEXT,
  image BYTEA NOT NULL,
  image_mime TEXT NOT NULL,
  image_name TEXT,
  image_hash TEXT NOT NULL,
  lines JSONB NOT NULL DEFAULT '[]',
  printed JSONB NOT NULL DEFAULT '{}',
  notes JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'review',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (month_id, image_hash)
);
CREATE INDEX IF NOT EXISTS entries_month_day ON entries (month_id, day);

CREATE TABLE IF NOT EXISTS rules (
  id SERIAL PRIMARY KEY,
  side TEXT NOT NULL CHECK (side IN ('in', 'out')),
  pattern TEXT NOT NULL,
  col TEXT NOT NULL,
  priority INT NOT NULL DEFAULT 100,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS schema_seed (key TEXT PRIMARY KEY);
