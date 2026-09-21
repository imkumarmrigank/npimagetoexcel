-- An unlocked (voided) batch stays on record, but its days can be edited and exported again.
ALTER TABLE tally_batches ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ;
ALTER TABLE tally_batches ADD COLUMN IF NOT EXISTS summary JSONB;
