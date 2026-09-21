const { Pool } = require('pg');

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');

const pool = new Pool({
  connectionString: url,
  ssl: /localhost|127\.0\.0\.1|\/tmp/.test(url) ? false : { rejectUnauthorized: false },
  max: 5,
});

module.exports = { pool, query: (text, params) => pool.query(text, params) };
