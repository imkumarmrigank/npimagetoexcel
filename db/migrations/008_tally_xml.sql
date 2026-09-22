-- Tally ERP 9 imports XML: output format, the company name as it is in Tally, and the group
-- each ledger belongs to (for the ledger masters file).
ALTER TABLE tally_settings ADD COLUMN IF NOT EXISTS format TEXT NOT NULL DEFAULT 'xml';
ALTER TABLE tally_settings ADD COLUMN IF NOT EXISTS tally_company TEXT;
ALTER TABLE tally_settings ADD COLUMN IF NOT EXISTS groups JSONB NOT NULL DEFAULT '{}';
