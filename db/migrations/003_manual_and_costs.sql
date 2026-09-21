-- Days can be typed in without an image.
ALTER TABLE entries ALTER COLUMN image DROP NOT NULL;
ALTER TABLE entries ALTER COLUMN image_mime DROP NOT NULL;
ALTER TABLE entries ALTER COLUMN image_hash DROP NOT NULL;
ALTER TABLE entries ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'image';

-- Optional purchase cost per litre, so profit & loss can show gross margin.
ALTER TABLE months ADD COLUMN IF NOT EXISTS hsd_cost NUMERIC;
ALTER TABLE months ADD COLUMN IF NOT EXISTS ms_cost NUMERIC;
