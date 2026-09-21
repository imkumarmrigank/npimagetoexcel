const { Pool } = require('pg');

const url = process.env.DATABASE_URL;

// Without a database the server still starts, so the page can say what is missing.
const pool = url
  ? new Pool({
    connectionString: url,
    ssl: /localhost|127\.0\.0\.1|\/tmp/.test(url) ? false : { rejectUnauthorized: false },
    max: 5,
  })
  : null;

function query(text, params) {
  if (!pool) throw Object.assign(new Error('DATABASE_URL is not set'), { status: 503 });
  return pool.query(text, params);
}

module.exports = { pool, query };
