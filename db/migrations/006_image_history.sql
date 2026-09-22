-- When a day's image is replaced, the previous image is kept here rather than lost.
CREATE TABLE IF NOT EXISTS entry_image_history (
  id SERIAL PRIMARY KEY,
  entry_id INT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  image BYTEA NOT NULL,
  image_mime TEXT,
  image_name TEXT,
  image_hash TEXT,
  replaced_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS entry_image_history_entry ON entry_image_history (entry_id);
