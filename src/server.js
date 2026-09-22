require('dotenv').config();
const crypto = require('crypto');
const path = require('path');
const express = require('express');
const multer = require('multer');
const cookieParser = require('cookie-parser');
const db = require('./db');
const { migrate } = require('./migrate');
const { compileRules, classifyLines, INFLOW_COLS, EXPENSE_COLS, DEFAULT_RULES } = require('./columns');
const { buildMonth } = require('./reconcile');
const { buildWorkbook, buildReportWorkbook, buildLedgerWorkbook, buildCashflowWorkbook, buildReconWorkbook } = require('./excel');
const { report, ledger, issues } = require('./reports');
const tally = require('./tally');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const PASSWORD = process.env.APP_PASSWORD || '';
const SECRET = process.env.SESSION_SECRET || 'dev-secret';

// Set when the database can't be reached at start-up; every page then explains why.
let bootError = null;
app.get('/healthz', (req, res) => res.json({ ok: !bootError, error: bootError }));
app.use((req, res, next) => {
  if (!bootError) return next();
  if (req.path.startsWith('/api/')) return res.status(503).json({ error: `App not ready: ${bootError}` });
  res.status(503).type('html').send(`<!doctype html><meta charset="utf-8"><title>Pump Ledger — setup needed</title>
    <body style="font:16px system-ui;max-width:640px;margin:60px auto;padding:0 16px">
    <h2>Pump Ledger is running, but can't start yet</h2>
    <p style="background:#fdecea;color:#b42318;padding:12px;border-radius:8px">${bootError.replace(/[<>&]/g, '')}</p>
    <p>In Render → this service → <b>Environment</b>, make sure these are set, then redeploy:</p>
    <ul><li><code>DATABASE_URL</code> — Neon connection string</li><li><code>APP_PASSWORD</code> — login password</li>
    <li><code>SESSION_SECRET</code> — any long random text</li><li><code>NODE_ENV</code> = <code>production</code></li></ul></body>`);
});

app.use(express.json({ limit: '2mb' }));
app.use(cookieParser(SECRET));

// --- auth: one shared password, signed cookie ---
const token = () => crypto.createHmac('sha256', SECRET).update(PASSWORD).digest('hex');
app.post('/api/login', (req, res) => {
  if (!PASSWORD || req.body.password === PASSWORD) {
    res.cookie('auth', token(), { signed: true, httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 30 * 864e5 });
    return res.json({ ok: true });
  }
  res.status(401).json({ error: 'Wrong password' });
});
app.post('/api/logout', (req, res) => { res.clearCookie('auth'); res.json({ ok: true }); });
app.use('/api', (req, res, next) => {
  if (!PASSWORD || req.signedCookies.auth === token()) return next();
  res.status(401).json({ error: 'login required' });
});

const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  console.error(e);
  // A duplicate date raced past the check: the database's one-entry-per-day rule caught it.
  if (e.code === '23505' && /entries_one_per_day/.test(e.constraint || e.message)) {
    return res.status(409).json({ error: 'An entry for this date already exists', code: 'duplicate_day' });
  }
  res.status(e.status || 500).json({ error: e.message || 'Server error', ...(e.extra || {}) });
});
const fail = (status, message, extra) => Object.assign(new Error(message), { status, extra });
const dmy = (y, m, d) => `${String(d).padStart(2, '0')}-${String(m).padStart(2, '0')}-${y}`;

async function loadRules(companyId) {
  return compileRules((await db.query('SELECT * FROM rules WHERE company_id = $1', [companyId])).rows);
}
async function getMonth(id) {
  const r = await db.query('SELECT * FROM months WHERE id = $1', [id]);
  if (!r.rowCount) throw fail(404, 'Month not found');
  return r.rows[0];
}
async function monthSummary(month) {
  const entries = (await db.query('SELECT id, day, report_date, image_name, lines, printed, notes, status, source, tally_batch_id FROM entries WHERE month_id = $1', [month.id])).rows;
  return buildMonth(month, entries);
}

app.get('/api/meta', (req, res) => res.json({ inflowCols: INFLOW_COLS, expenseCols: EXPENSE_COLS }));

// --- companies: each has its own months, images and mapping rules ---
app.get('/api/companies', wrap(async (req, res) => {
  res.json((await db.query('SELECT * FROM companies ORDER BY name')).rows);
}));
app.post('/api/companies', wrap(async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) throw fail(400, 'Company name is required');
  const r = await db.query('INSERT INTO companies (name) VALUES ($1) ON CONFLICT (name) DO NOTHING RETURNING *', [name]);
  if (!r.rowCount) throw fail(409, 'A company with that name already exists');
  for (const rule of DEFAULT_RULES) {
    await db.query('INSERT INTO rules (company_id, side, pattern, col, priority) VALUES ($1,$2,$3,$4,$5)', [r.rows[0].id, rule.side, rule.pattern, rule.col, rule.priority]);
  }
  res.json(r.rows[0]);
}));
// Heads left out of this company's P&L (collections not counted as income, Others payments not counted as costs).
app.put('/api/companies/:id/pl-excluded', wrap(async (req, res) => {
  const clean = (list) => JSON.stringify([...new Set((list || []).map((h) => String(h).toUpperCase().replace(/\s+/g, ' ').trim()).filter(Boolean))]);
  const r = await db.query('UPDATE companies SET coll_excluded=$2, others_excluded=$3 WHERE id=$1 RETURNING coll_excluded, others_excluded',
    [req.params.id, clean(req.body.coll), clean(req.body.others)]);
  if (!r.rowCount) throw fail(404, 'Company not found');
  res.json(r.rows[0]);
}));
app.patch('/api/companies/:id', wrap(async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) throw fail(400, 'Company name is required');
  const r = await db.query('UPDATE companies SET name=$2 WHERE id=$1 RETURNING *', [req.params.id, name]);
  res.json(r.rows[0]);
}));
app.delete('/api/companies/:id', wrap(async (req, res) => {
  await db.query('DELETE FROM companies WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

// --- months ---
app.get('/api/months', wrap(async (req, res) => {
  res.json((await db.query('SELECT * FROM months WHERE company_id = $1 ORDER BY year DESC, month DESC', [req.query.company_id])).rows);
}));
app.post('/api/months', wrap(async (req, res) => {
  const { company_id, title, year, month, hsd_rate, ms_rate } = req.body;
  if (!company_id || !title || !year || !month) throw fail(400, 'Company, title, year and month are required');
  const r = await db.query(
    'INSERT INTO months (company_id, title, year, month, hsd_rate, ms_rate) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (company_id, year, month) DO NOTHING RETURNING *',
    [company_id, title, year, month, hsd_rate || null, ms_rate || null],
  );
  if (!r.rowCount) throw fail(409, 'That month already exists for this company');
  res.json(r.rows[0]);
}));
app.patch('/api/months/:id', wrap(async (req, res) => {
  const m = await getMonth(req.params.id);
  const f = { ...m, ...req.body };
  const orNull = (v) => (v === '' || v === undefined || v === null ? null : v);
  const r = await db.query('UPDATE months SET title=$2, hsd_rate=$3, ms_rate=$4, total_ob=$5, hsd_cost=$6, ms_cost=$7 WHERE id=$1 RETURNING *',
    [m.id, f.title, orNull(f.hsd_rate), orNull(f.ms_rate), orNull(f.total_ob), orNull(f.hsd_cost), orNull(f.ms_cost)]);
  res.json(r.rows[0]);
}));
app.delete('/api/months/:id', wrap(async (req, res) => {
  await db.query('DELETE FROM months WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));
app.get('/api/months/:id/summary', wrap(async (req, res) => {
  const month = await getMonth(req.params.id);
  res.json({ month, ...(await monthSummary(month)) });
}));
app.get('/api/months/:id/export.xlsx', wrap(async (req, res) => {
  const month = await getMonth(req.params.id);
  const buf = await buildWorkbook(month, await monthSummary(month));
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${month.title.replace(/[^\w .-]+/g, '_')}.xlsx"`);
  res.send(Buffer.from(buf));
}));

// --- adding days: an uploaded image or a hand-typed day, both start from a blank form ---
const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec'];

function parseDate(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v || '');
  if (!m) throw fail(400, 'Pick a date');
  const [year, mon, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (day < 1 || day > new Date(year, mon, 0).getDate()) throw fail(400, 'That date does not exist');
  return { year, mon, day };
}

// The company's month for a date, created on first use with the last month's rates.
async function monthFor(companyId, year, mon) {
  const company = (await db.query('SELECT * FROM companies WHERE id=$1', [companyId])).rows[0];
  if (!company) throw fail(404, 'Company not found');
  const found = (await db.query('SELECT * FROM months WHERE company_id=$1 AND year=$2 AND month=$3', [company.id, year, mon])).rows[0];
  if (found) return found;
  const last = (await db.query('SELECT hsd_rate, ms_rate, hsd_cost, ms_cost FROM months WHERE company_id=$1 ORDER BY year DESC, month DESC LIMIT 1', [company.id])).rows[0] || {};
  return (await db.query(
    'INSERT INTO months (company_id, title, year, month, hsd_rate, ms_rate, hsd_cost, ms_cost) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (company_id, year, month) DO UPDATE SET title = months.title RETURNING *',
    [company.id, `${company.name}-${MONTH_ABBR[mon - 1]}-${String(year).slice(2)}`, year, mon, last.hsd_rate ?? null, last.ms_rate ?? null, last.hsd_cost ?? null, last.ms_cost ?? null],
  )).rows[0];
}

// Blank form rows: opening cash, HSD, MS, plus the expense heads this company
// uses on at least a third of its recent days, in their usual order.
async function templateLines(month) {
  const recent = (await db.query(
    `SELECT e.lines FROM entries e JOIN months m ON m.id = e.month_id
     WHERE m.company_id = $1 AND e.day IS NOT NULL ORDER BY m.year DESC, m.month DESC, e.day DESC LIMIT 10`, [month.company_id],
  )).rows.map((r) => r.lines);
  const seen = new Map();
  for (const lines of recent) {
    const labels = new Set();
    lines.forEach((l, i) => {
      if (l.side !== 'out' || !l.label) return;
      const key = l.label.toUpperCase().replace(/\s+/g, ' ').trim();
      if (labels.has(key) || /\d{3,}/.test(key)) return; // skip repeats and one-off vehicle numbers
      labels.add(key);
      const s = seen.get(key) || { label: key, col: l.col, count: 0, pos: 0 };
      s.count += 1; s.pos += i;
      seen.set(key, s);
    });
  }
  const common = [...seen.values()].filter((s) => s.count >= Math.max(1, Math.ceil(recent.length / 3))).sort((a, b) => a.pos / a.count - b.pos / b.count);
  const rate = (v) => (v ? Number(v) : null);
  const lines = [
    { side: 'in', label: 'OPENING CASH', rate: null, col: 'OB' },
    { side: 'in', label: 'HSD', rate: rate(month.hsd_rate), col: 'HSD' },
    { side: 'in', label: 'MS', rate: rate(month.ms_rate), col: 'MS' },
    ...(common.length ? common.map((s) => ({ side: 'out', label: s.label, rate: null, col: s.col })) : [{ side: 'out', label: 'PAYTM', rate: null, col: 'PTM' }]),
  ];
  return lines.map((l, i) => ({ id: i + 1, unit: null, amount: null, ...l }));
}

async function createEntry(month, day, file, replace = false) {
  const date = `${String(day).padStart(2, '0')}-${String(month.month).padStart(2, '0')}-${month.year}`;
  const existing = (await db.query('SELECT id, source, tally_batch_id, image IS NOT NULL AS has_image FROM entries WHERE month_id=$1 AND day=$2', [month.id, day])).rows[0];
  // A day typed in by hand gets the uploaded image attached; its figures are kept for checking.
  if (existing && file && !existing.has_image) {
    if (existing.tally_batch_id) throw fail(409, `${date} was already sent to Tally (batch #${existing.tally_batch_id}); unlock it in Tally Export before adding its image.`, { code: 'exported' });
    await db.query(
      "UPDATE entries SET image=$2, image_mime=$3, image_name=$4, image_hash=$5, source='image', status='review', updated_at=now() WHERE id=$1",
      [existing.id, file.buffer, file.mimetype, file.originalname, file.hash]);
    return { id: existing.id, attached: true };
  }
  if (existing) {
    if (!replace) {
      throw fail(409, `Already uploaded for ${date}. Open that day, or choose Replace to swap its image.`,
        { code: 'duplicate_day', existing_id: existing.id, month_id: month.id, date });
    }
    if (existing.tally_batch_id) throw fail(409, `${date} was already sent to Tally (batch #${existing.tally_batch_id}); unlock it in Tally Export before replacing.`, { code: 'exported' });
    await db.query('DELETE FROM entries WHERE id=$1', [existing.id]);
  }
  const lines = JSON.stringify(await templateLines(month));
  const r = file
    ? await db.query(
      `INSERT INTO entries (month_id, day, report_date, image, image_mime, image_name, image_hash, lines, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'image') RETURNING id`,
      [month.id, day, date, file.buffer, file.mimetype, file.originalname, file.hash, lines])
    : await db.query("INSERT INTO entries (month_id, day, report_date, lines, source) VALUES ($1,$2,$3,$4,'manual') RETURNING id", [month.id, day, date, lines]);
  return { id: r.rows[0].id, replaced: !!existing };
}

// Which of these dates already have an entry (checked before uploading, so the user is told at once).
app.post('/api/companies/:id/existing', wrap(async (req, res) => {
  const found = {};
  for (const v of req.body.dates || []) {
    const { year, mon, day } = parseDate(v);
    const r = await db.query(
      `SELECT e.id, e.month_id, e.source, e.image_name, e.status, e.tally_batch_id, e.image IS NOT NULL AS has_image FROM entries e JOIN months m ON m.id = e.month_id
       WHERE m.company_id=$1 AND m.year=$2 AND m.month=$3 AND e.day=$4`, [req.params.id, year, mon, day]);
    if (r.rowCount) found[v] = r.rows[0];
  }
  res.json(found);
}));

// Upload one image for a date. Nothing reads the image on the server; the figures are typed in
// (or read in the browser with the optional offline text reader).
app.post('/api/companies/:id/upload', upload.single('image'), wrap(async (req, res) => {
  if (!req.file) throw fail(400, 'No image');
  if (!/^image\//.test(req.file.mimetype)) throw fail(400, 'Only image files can be uploaded');
  const { year, mon, day } = parseDate(req.body.date);
  const hash = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
  const dup = await db.query(
    'SELECT e.id, e.report_date FROM entries e JOIN months m ON m.id = e.month_id WHERE m.company_id=$1 AND e.image_hash=$2', [req.params.id, hash]);
  if (dup.rowCount) throw fail(409, `This exact image is already uploaded for ${dup.rows[0].report_date || 'another day'}`, { code: 'duplicate_image', existing_id: dup.rows[0].id });
  const month = await monthFor(req.params.id, year, mon);
  const e = await createEntry(month, day, { ...req.file, hash }, req.body.replace === '1');
  res.json({ ...e, month_id: month.id });
}));

// A day typed in without an image.
app.post('/api/companies/:id/manual', wrap(async (req, res) => {
  const { year, mon, day } = parseDate(req.body.date);
  const month = await monthFor(req.params.id, year, mon);
  const e = await createEntry(month, day, null);
  res.json({ ...e, month_id: month.id });
}));

// --- reports across months: company-wise, date range, grouped by period ---
function reportParams(q) {
  const date = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : null);
  return {
    companyId: q.company_id ? Number(q.company_id) : null,
    from: date(q.from),
    to: date(q.to),
    group: ['day', 'week', 'month', 'quarter', 'half', 'year'].includes(q.group) ? q.group : 'month',
    fy: q.fy !== '0',
    col: q.col || null,
    side: q.side === 'in' || q.side === 'out' ? q.side : null,
    q: q.q || '',
  };
}
async function reportTitle(p, kind) {
  const c = p.companyId ? (await db.query('SELECT name FROM companies WHERE id=$1', [p.companyId])).rows[0]?.name : 'All companies';
  return `${c} — ${kind}`;
}
const sendXlsx = (res, name, buf) => {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${name.replace(/[^\w .-]+/g, '_')}.xlsx"`);
  res.send(Buffer.from(buf));
};
app.get('/api/reports', wrap(async (req, res) => res.json(await report(reportParams(req.query)))));
// --- month-end figures for months not kept day by day (typed from the old sheet) ---
const SUMMARY_KEYS = ['opening', 'coffee', 'lub', 'coll', 'bank', 'ptm', 'upi', 'tsale', 'fleet', 'ranjit', 'rbabu', 'others', 'pexp'];
app.get('/api/companies/:id/summaries/:year/:month', wrap(async (req, res) => {
  const r = await db.query('SELECT figures, updated_at FROM month_summaries WHERE company_id=$1 AND year=$2 AND month=$3', [req.params.id, req.params.year, req.params.month]);
  res.json(r.rows[0] || null);
}));
app.put('/api/companies/:id/summaries/:year/:month', wrap(async (req, res) => {
  const b = req.body || {};
  const num = (v) => (v === '' || v === null || v === undefined || Number.isNaN(Number(v)) ? 0 : Number(v));
  const fuel = (list) => (Array.isArray(list) ? list : []).map((x) => ({ units: num(x.units), rate: num(x.rate) })).filter((x) => x.units || x.rate);
  const figures = { ...Object.fromEntries(SUMMARY_KEYS.map((k) => [k, num(b[k])])), hsd: fuel(b.hsd), ms: fuel(b.ms) };
  await db.query(
    `INSERT INTO month_summaries (company_id, year, month, figures) VALUES ($1,$2,$3,$4)
     ON CONFLICT (company_id, year, month) DO UPDATE SET figures = EXCLUDED.figures, updated_at = now()`,
    [req.params.id, req.params.year, req.params.month, JSON.stringify(figures)]);
  res.json({ ok: true, figures });
}));
app.delete('/api/companies/:id/summaries/:year/:month', wrap(async (req, res) => {
  await db.query('DELETE FROM month_summaries WHERE company_id=$1 AND year=$2 AND month=$3', [req.params.id, req.params.year, req.params.month]);
  res.json({ ok: true });
}));

// Month-end figures in the same shape as a report total, so one layout serves both.
function summaryToTotal(f, from, to) {
  const fuel = (list) => (list || []).map((g) => ({ rate: g.rate, units: g.units, amount: Math.round(g.units * g.rate * 100) / 100, from, to }));
  const hsd = fuel(f.hsd), ms = fuel(f.ms);
  const sum = (list, k) => list.reduce((x, g) => x + g[k], 0);
  return {
    days: 0, verified: 0, fromSummary: true, opening: f.opening, firstDate: from, lastDate: to, lastCash: null, gaps: [],
    fuelByRate: { HSD: hsd, MS: ms }, HSD: sum(hsd, 'units'), HSD_AMT: sum(hsd, 'amount'), MS: sum(ms, 'units'), MS_AMT: sum(ms, 'amount'),
    COFFEE: f.coffee, LUB: f.lub, COLL: f.coll, BANK: f.bank, PTM: f.ptm, UPI: f.upi, TSALE: f.tsale, FLEET: f.fleet,
    RANJIT: f.ranjit, RBABU: f.rbabu, OTHERS: f.others, PEXP: f.pexp,
  };
}
app.get('/api/companies/:id/summaries/:year/:month/total', wrap(async (req, res) => {
  const r = await db.query('SELECT figures FROM month_summaries WHERE company_id=$1 AND year=$2 AND month=$3', [req.params.id, req.params.year, req.params.month]);
  if (!r.rowCount) return res.json(null);
  const y = Number(req.params.year), m = Number(req.params.month);
  const pad = (v) => String(v).padStart(2, '0');
  res.json(summaryToTotal(r.rows[0].figures, `${y}-${pad(m)}-01`, `${y}-${pad(m)}-${pad(new Date(y, m, 0).getDate())}`));
}));

// Cash reconciliation title: "Cash reconcillation-August-26" for a whole month, else the dates.
const MONTH_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function reconLabel(from, to) {
  if (!from || !to) return 'All dates';
  const [y, m, d] = from.split('-').map(Number);
  const last = new Date(y, m, 0).getDate();
  if (d === 1 && to === `${from.slice(0, 8)}${String(last).padStart(2, '0')}`) return `${MONTH_FULL[m - 1]}-${String(y).slice(2)}`;
  const f = (v) => v.split('-').reverse().join('-');
  return `${f(from)} to ${f(to)}`;
}
app.get('/api/recon/export.xlsx', wrap(async (req, res) => {
  const p = reportParams(req.query);
  if (!p.companyId) throw fail(400, 'Pick a company');
  const company = (await db.query('SELECT name FROM companies WHERE id=$1', [p.companyId])).rows[0]?.name || '';
  const title = `Cash reconcillation-${reconLabel(p.from, p.to)}`;
  let total = (await report(p)).total;
  // A month kept only as month-end figures (no daily entries) uses those figures.
  if (!total.days && p.from && p.to && /^\d{4}-\d{2}-01$/.test(p.from) && p.to.slice(0, 7) === p.from.slice(0, 7)) {
    const [y, m] = p.from.split('-').map(Number);
    const sm = (await db.query('SELECT figures FROM month_summaries WHERE company_id=$1 AND year=$2 AND month=$3', [p.companyId, y, m])).rows[0];
    if (sm) total = summaryToTotal(sm.figures, p.from, p.to);
  }
  sendXlsx(res, `${company} ${title}`, await buildReconWorkbook(title, total));
}));
app.get('/api/cashflow/export.xlsx', wrap(async (req, res) => {
  const p = reportParams(req.query);
  const title = await reportTitle(p, `Deposits & expenses (${p.group}-wise)`);
  sendXlsx(res, title, await buildCashflowWorkbook(title, await report(p)));
}));
app.get('/api/reports/export.xlsx', wrap(async (req, res) => {
  const p = reportParams(req.query);
  const title = await reportTitle(p, `${p.group}-wise report`);
  sendXlsx(res, title, await buildReportWorkbook(title, await report(p), !p.companyId));
}));
// --- Tally export: only verified days, each day once ---
const templateUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
const rangeOf = (q) => {
  const date = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : null);
  const from = date(q.from), to = date(q.to);
  if (!from || !to || from > to) throw fail(400, 'Pick a From and To date');
  return { from, to };
};
app.get('/api/tally/:cid/settings', wrap(async (req, res) => res.json(await tally.getSettings(Number(req.params.cid)))));
app.post('/api/tally/:cid/template', templateUpload.single('file'), wrap(async (req, res) => {
  if (!req.file || !/\.xlsx$/i.test(req.file.originalname)) throw fail(400, 'Upload the Tally template as an .xlsx file');
  const t = await tally.readTemplate(req.file.buffer);
  const columns = Object.fromEntries(t.headers.map((h) => [h.letter, tally.guessField(h.text)]));
  await db.query(
    `INSERT INTO tally_settings (company_id, template, template_name, sheet, header_row, columns) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (company_id) DO UPDATE SET template=EXCLUDED.template, template_name=EXCLUDED.template_name, sheet=EXCLUDED.sheet,
       header_row=EXCLUDED.header_row, columns=EXCLUDED.columns, updated_at=now()`,
    [req.params.cid, req.file.buffer, req.file.originalname, t.sheet, t.headerRow, JSON.stringify(columns)]);
  res.json(await tally.getSettings(Number(req.params.cid)));
}));
app.delete('/api/tally/:cid/template', wrap(async (req, res) => {
  await db.query("UPDATE tally_settings SET template=NULL, template_name=NULL, sheet=NULL, header_row=NULL, columns='{}' WHERE company_id=$1", [req.params.cid]);
  res.json(await tally.getSettings(Number(req.params.cid)));
}));
app.put('/api/tally/:cid/settings', wrap(async (req, res) => {
  const { columns = {}, ledgers = {}, labels = {}, cash_ledger } = req.body || {};
  const okField = (f) => !f || Object.prototype.hasOwnProperty.call(tally.FIELDS, f);
  if (!Object.values(columns).every(okField)) throw fail(400, 'Unknown field in column mapping');
  const cleanLabels = Object.fromEntries(Object.entries(labels).map(([k, v]) => [k.toUpperCase().replace(/\s+/g, ' ').trim(), String(v || '').trim()]).filter(([k, v]) => k && v));
  await db.query(
    `INSERT INTO tally_settings (company_id, columns, ledgers, labels, cash_ledger) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (company_id) DO UPDATE SET columns=EXCLUDED.columns, ledgers=EXCLUDED.ledgers, labels=EXCLUDED.labels, cash_ledger=EXCLUDED.cash_ledger, updated_at=now()`,
    [req.params.cid, JSON.stringify(columns), JSON.stringify(ledgers), JSON.stringify(cleanLabels), String(cash_ledger || 'Cash').trim() || 'Cash']);
  res.json(await tally.getSettings(Number(req.params.cid)));
}));
app.get('/api/tally/:cid/preview', wrap(async (req, res) => {
  const { from, to } = rangeOf(req.query);
  const pv = await tally.preview(Number(req.params.cid), from, to, req.query.include_errors === '1');
  delete pv.settings;
  res.json(pv);
}));
app.post('/api/tally/:cid/export', wrap(async (req, res) => {
  const { from, to } = rangeOf(req.body || {});
  res.json(await tally.exportBatch(Number(req.params.cid), from, to, !!req.body.include_errors));
}));
app.get('/api/tally/:cid/batches', wrap(async (req, res) => {
  res.json((await db.query(
    `SELECT id, date_from, date_to, array_length(entry_ids, 1) AS days, vouchers, file_name, created_at, voided_at, summary
     FROM tally_batches WHERE company_id=$1 ORDER BY id DESC`, [req.params.cid])).rows);
}));
app.get('/api/tally/batches/:id/file', wrap(async (req, res) => {
  const b = (await db.query('SELECT file, file_name FROM tally_batches WHERE id=$1', [req.params.id])).rows[0];
  if (!b) throw fail(404, 'Batch not found');
  sendXlsx(res, b.file_name.replace(/\.xlsx$/i, ''), b.file);
}));
// Unlock: the days can be corrected and exported again. The user must delete this batch's vouchers in Tally first.
app.post('/api/tally/batches/:id/unlock', wrap(async (req, res) => {
  const b = (await db.query('SELECT id, voided_at FROM tally_batches WHERE id=$1', [req.params.id])).rows[0];
  if (!b) throw fail(404, 'Batch not found');
  if (b.voided_at) throw fail(400, 'This batch is already unlocked');
  await db.query('UPDATE entries SET tally_batch_id=NULL WHERE tally_batch_id=$1', [b.id]);
  await db.query('UPDATE tally_batches SET voided_at=now() WHERE id=$1', [b.id]);
  res.json({ ok: true });
}));

app.get('/api/issues', wrap(async (req, res) => {
  const p = reportParams(req.query);
  if (!p.companyId) throw fail(400, 'Pick a company');
  res.json(await issues(p));
}));
app.get('/api/ledger', wrap(async (req, res) => res.json(await ledger(reportParams(req.query)))));
app.get('/api/ledger/export.xlsx', wrap(async (req, res) => {
  const p = reportParams(req.query);
  const title = await reportTitle(p, 'Ledger');
  sendXlsx(res, title, await buildLedgerWorkbook(title, await ledger(p)));
}));

// --- entries ---
app.get('/api/entries/:id', wrap(async (req, res) => {
  const r = await db.query('SELECT id, month_id, day, report_date, image_name, lines, printed, notes, status, source, tally_batch_id, image IS NOT NULL AS has_image, left(image_hash, 12) AS image_v, (SELECT count(*)::int FROM entry_image_history h WHERE h.entry_id = entries.id) AS old_images FROM entries WHERE id=$1', [req.params.id]);
  if (!r.rowCount) throw fail(404, 'Not found');
  const e = r.rows[0];
  const summary = await monthSummary(await getMonth(e.month_id));
  res.json({ ...e, computed: summary.entries.find((x) => x.id === e.id) });
}));
app.get('/api/entries/:id/image', wrap(async (req, res) => {
  const r = await db.query('SELECT image, image_mime FROM entries WHERE id=$1', [req.params.id]);
  if (!r.rowCount || !r.rows[0].image) throw fail(404, 'No image for this day');
  res.setHeader('Content-Type', r.rows[0].image_mime);
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.send(r.rows[0].image);
}));
// Replace (or add) the image of a day while reviewing it. The typed figures stay; the day goes
// back to review so it is checked against the new image. The old image is kept in history.
app.put('/api/entries/:id/image', upload.single('image'), wrap(async (req, res) => {
  if (!req.file) throw fail(400, 'No image');
  if (!/^image\//.test(req.file.mimetype)) throw fail(400, 'Only image files can be uploaded');
  const cur = (await db.query(
    'SELECT e.id, e.image, e.image_mime, e.image_name, e.image_hash, e.tally_batch_id, m.company_id FROM entries e JOIN months m ON m.id = e.month_id WHERE e.id=$1',
    [req.params.id])).rows[0];
  if (!cur) throw fail(404, 'Not found');
  if (cur.tally_batch_id) throw fail(409, `This day was sent to Tally in batch #${cur.tally_batch_id} and is locked. Unlock it in Tally Export to change it.`, { code: 'exported' });
  const hash = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
  if (hash === cur.image_hash) throw fail(409, 'That is the same image this day already has');
  const dup = await db.query(
    'SELECT e.id, e.report_date FROM entries e JOIN months m ON m.id = e.month_id WHERE m.company_id=$1 AND e.image_hash=$2 AND e.id<>$3',
    [cur.company_id, hash, cur.id]);
  if (dup.rowCount) throw fail(409, `This exact image is already used for ${dup.rows[0].report_date || 'another day'}`, { code: 'duplicate_image', existing_id: dup.rows[0].id });
  if (cur.image) {
    await db.query('INSERT INTO entry_image_history (entry_id, image, image_mime, image_name, image_hash) VALUES ($1,$2,$3,$4,$5)',
      [cur.id, cur.image, cur.image_mime, cur.image_name, cur.image_hash]);
  }
  await db.query(
    "UPDATE entries SET image=$2, image_mime=$3, image_name=$4, image_hash=$5, source='image', status='review', updated_at=now() WHERE id=$1",
    [cur.id, req.file.buffer, req.file.mimetype, req.file.originalname, hash]);
  const versions = (await db.query('SELECT count(*)::int c FROM entry_image_history WHERE entry_id=$1', [cur.id])).rows[0].c;
  res.json({ ok: true, replaced: !!cur.image, previous_versions: versions });
}));

app.put('/api/entries/:id', wrap(async (req, res) => {
  const { day, report_date, lines, printed, status, remember } = req.body;
  const owner = await db.query(
    'SELECT m.company_id, m.year, m.month, e.month_id, e.tally_batch_id, e.day, e.lines, e.printed, e.status FROM entries e JOIN months m ON m.id = e.month_id WHERE e.id = $1', [req.params.id]);
  if (!owner.rowCount) throw fail(404, 'Not found');
  const cur = owner.rows[0];
  const companyId = cur.company_id;
  if (cur.tally_batch_id) throw fail(409, `This day was sent to Tally in batch #${cur.tally_batch_id} and is locked. Unlock it in Tally Export to change it.`, { code: 'exported' });
  if (day && day !== cur.day) {
    const last = new Date(cur.year, cur.month, 0).getDate();
    if (day < 1 || day > last) throw fail(400, `Day must be between 1 and ${last}`);
    const clash = await db.query('SELECT id FROM entries WHERE month_id=$1 AND day=$2 AND id<>$3', [cur.month_id, day, req.params.id]);
    if (clash.rowCount) throw fail(409, `${dmy(cur.year, cur.month, day)} already has an entry — open it instead, or delete one of them.`, { code: 'duplicate_day', existing_id: clash.rows[0].id });
  }
  const rules = await loadRules(companyId);
  const clean = classifyLines((lines || []).map((l, i) => ({
    id: l.id || i + 1,
    side: l.side === 'out' ? 'out' : 'in',
    label: String(l.label || '').trim(),
    unit: l.unit === '' || l.unit === null ? null : Number(l.unit),
    rate: l.rate === '' || l.rate === null ? null : Number(l.rate),
    amount: l.amount === '' || l.amount === null ? null : Number(l.amount),
    col: l.col || null,
    manual: !!l.manual,
  })), rules);
  // A verified day that is changed goes back to review, unless this save is the verification.
  const strip = (ls) => JSON.stringify((ls || []).map(({ side, label, unit, rate, amount, col }) => [side, label, unit, rate, amount, col]));
  const changed = strip(clean) !== strip(cur.lines) || JSON.stringify(printed || {}) !== JSON.stringify(cur.printed || {}) || (day || null) !== cur.day;
  const nextStatus = status === 'verified' && (req.body.verify || !changed) ? 'verified' : 'review';
  await db.query(
    'UPDATE entries SET day=$2, report_date=$3, lines=$4, printed=$5, status=$6, updated_at=now() WHERE id=$1',
    [req.params.id, day || null, report_date || null, JSON.stringify(clean), JSON.stringify(printed || {}), nextStatus],
  );
  // "Remember" turns a hand-assigned line into an exact-label rule for future images.
  for (const l of clean.filter((x) => x.manual && remember?.includes(x.id))) {
    const pattern = `^\\s*${l.label.toUpperCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*')}\\s*$`;
    await db.query('INSERT INTO rules (company_id, side, pattern, col, priority) VALUES ($1,$2,$3,$4,5)', [companyId, l.side, pattern, l.col]);
  }
  res.json({ ok: true, status: nextStatus, reverted: cur.status === 'verified' && nextStatus !== 'verified' });
}));
// Record that an opening-cash difference was checked (from the Errors list or the form).
app.post('/api/entries/:id/accept-ob', wrap(async (req, res) => {
  const r = await db.query('SELECT printed, tally_batch_id FROM entries WHERE id=$1', [req.params.id]);
  if (!r.rowCount) throw fail(404, 'Not found');
  if (r.rows[0].tally_batch_id) throw fail(409, 'This day was sent to Tally and is locked.', { code: 'exported' });
  const diff = Number(req.body.diff);
  if (!Number.isFinite(diff)) throw fail(400, 'Missing difference');
  await db.query('UPDATE entries SET printed = $2, updated_at = now() WHERE id = $1', [req.params.id, JSON.stringify({ ...(r.rows[0].printed || {}), ob_accepted: diff })]);
  res.json({ ok: true });
}));
app.post('/api/entries/:id/reclassify', wrap(async (req, res) => {
  const r = await db.query('SELECT e.lines, e.tally_batch_id, m.company_id FROM entries e JOIN months m ON m.id = e.month_id WHERE e.id=$1', [req.params.id]);
  if (!r.rowCount) throw fail(404, 'Not found');
  if (r.rows[0].tally_batch_id) throw fail(409, 'This day was sent to Tally and is locked.', { code: 'exported' });
  const lines = classifyLines(r.rows[0].lines, await loadRules(r.rows[0].company_id), { force: true });
  await db.query('UPDATE entries SET lines=$2, updated_at=now() WHERE id=$1', [req.params.id, JSON.stringify(lines)]);
  res.json({ ok: true });
}));
app.delete('/api/entries/:id', wrap(async (req, res) => {
  const x = await db.query('SELECT tally_batch_id FROM entries WHERE id=$1', [req.params.id]);
  if (x.rows[0]?.tally_batch_id) throw fail(409, `This day was sent to Tally in batch #${x.rows[0].tally_batch_id}; unlock it in Tally Export before deleting.`, { code: 'exported' });
  await db.query('DELETE FROM entries WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

// --- mapping rules ---
app.get('/api/rules', wrap(async (req, res) => {
  res.json((await db.query('SELECT * FROM rules WHERE company_id = $1 ORDER BY side, priority, id', [req.query.company_id])).rows);
}));
app.post('/api/rules', wrap(async (req, res) => {
  const { company_id, side, pattern, col, priority } = req.body;
  if (!company_id) throw fail(400, 'Company is required');
  try { new RegExp(pattern, 'i'); } catch { throw fail(400, 'Pattern is not a valid regular expression'); }
  const r = await db.query('INSERT INTO rules (company_id, side, pattern, col, priority) VALUES ($1,$2,$3,$4,$5) RETURNING *', [company_id, side, pattern, col, priority ?? 100]);
  res.json(r.rows[0]);
}));
app.delete('/api/rules/:id', wrap(async (req, res) => {
  await db.query('DELETE FROM rules WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

app.use(express.static(path.join(__dirname, '..', 'public')));

// Listen first so the host sees a running service, then migrate; a failure is shown on every page.
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Pump ledger on http://localhost:${port}`));
migrate().catch((e) => {
  bootError = e.message || String(e);
  console.error('Start-up failed:', e);
});
