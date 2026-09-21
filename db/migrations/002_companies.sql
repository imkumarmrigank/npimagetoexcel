CREATE TABLE IF NOT EXISTS companies (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE months ADD COLUMN IF NOT EXISTS company_id INT REFERENCES companies(id) ON DELETE CASCADE;
ALTER TABLE rules ADD COLUMN IF NOT EXISTS company_id INT REFERENCES companies(id) ON DELETE CASCADE;

-- Months created before companies existed belong to the first company.
INSERT INTO companies (name)
SELECT 'Bajrang Petroleum Sonho' WHERE EXISTS (SELECT 1 FROM months WHERE company_id IS NULL)
ON CONFLICT (name) DO NOTHING;
UPDATE months SET company_id = (SELECT min(id) FROM companies) WHERE company_id IS NULL;
UPDATE rules SET company_id = (SELECT min(id) FROM companies) WHERE company_id IS NULL;
DELETE FROM rules WHERE company_id IS NULL;

ALTER TABLE months DROP CONSTRAINT IF EXISTS months_year_month_key;
ALTER TABLE months ALTER COLUMN company_id SET NOT NULL;
ALTER TABLE rules ALTER COLUMN company_id SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS months_company_year_month ON months (company_id, year, month);
CREATE INDEX IF NOT EXISTS rules_company ON rules (company_id);
DROP TABLE IF EXISTS schema_seed;
