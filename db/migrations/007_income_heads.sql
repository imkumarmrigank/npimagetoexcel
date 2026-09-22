-- P&L choices per company. Collections (cash received that isn't a fuel/lube/coffee sale) count as
-- income, and "Others" payments count as costs, unless a head is listed here as left out.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS coll_excluded JSONB NOT NULL DEFAULT '[]';
ALTER TABLE companies ADD COLUMN IF NOT EXISTS others_excluded JSONB NOT NULL DEFAULT '[]';
