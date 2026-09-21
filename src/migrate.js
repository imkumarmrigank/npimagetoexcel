require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('./db');

// Each file in db/migrations runs once, in name order.
async function migrate() {
  if (!pool) throw new Error('DATABASE_URL is not set. Add it under Environment in Render (your Neon connection string).');
  await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  const done = new Set((await pool.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  const dir = path.join(__dirname, '..', 'db', 'migrations');
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    if (done.has(file)) continue;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(fs.readFileSync(path.join(dir, file), 'utf8'));
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log('migrated', file);
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
}

if (require.main === module) {
  migrate().then(() => pool.end()).catch((e) => { console.error(e); process.exit(1); });
}
module.exports = { migrate };
