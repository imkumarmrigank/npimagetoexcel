-- One entry per date per company month: duplicates are impossible at the database level.
CREATE UNIQUE INDEX IF NOT EXISTS entries_one_per_day ON entries (month_id, day) WHERE day IS NOT NULL;

-- Month-end figures for months kept outside the daily sheet (e.g. August before this system).
CREATE TABLE IF NOT EXISTS month_summaries (
  company_id INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  year INT NOT NULL,
  month INT NOT NULL CHECK (month BETWEEN 1 AND 12),
  figures JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, year, month)
);

-- Tally: the company's own import template and ledger names, and every batch sent.
CREATE TABLE IF NOT EXISTS tally_settings (
  company_id INT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  template BYTEA,
  template_name TEXT,
  sheet TEXT,
  header_row INT,
  columns JSONB NOT NULL DEFAULT '{}',   -- template column letter -> field
  ledgers JSONB NOT NULL DEFAULT '{}',   -- sheet column key -> {ledger, voucher}
  labels JSONB NOT NULL DEFAULT '{}',    -- particulars label -> ledger name
  cash_ledger TEXT NOT NULL DEFAULT 'Cash',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tally_batches (
  id SERIAL PRIMARY KEY,
  company_id INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  date_from DATE,
  date_to DATE,
  entry_ids INT[] NOT NULL,
  vouchers INT NOT NULL,
  file BYTEA NOT NULL,
  file_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE entries ADD COLUMN IF NOT EXISTS tally_batch_id INT REFERENCES tally_batches(id) ON DELETE SET NULL;
