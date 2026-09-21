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
const { extractLedger, toEntry } = require('./extract');
const { buildWorkbook, buildReportWorkbook, buildLedgerWorkbook, buildCashflowWorkbook } = require('./excel');
const { report, ledger } = require('./reports');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const PASSWORD = process.env.APP_PASSWORD || '';
const SECRET = process.env.SESSION_SECRET || 'dev-secret';

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
  res.status(e.status || 500).json({ error: e.message || 'Server error' });
});
const fail = (status, message) => Object.assign(new Error(message), { status });

async function loadRules(companyId) {
  return compileRules((await db.query('SELECT * FROM rules WHERE company_id = $1', [companyId])).rows);
}
async function getMonth(id) {
  const r = await db.query('SELECT * FROM months WHERE id = $1', [id]);
  if (!r.rowCount) throw fail(404, 'Month not found');
  return r.rows[0];
}
async function monthSummary(month) {
  const entries = (await db.query('SELECT id, day, report_date, image_name, lines, printed, notes, status, source FROM entries WHERE month_id = $1', [month.id])).rows;
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

// --- upload: one image per request so each gets its own progress + error ---
async function readInto(month, buffer, rules) {
  const result = toEntry(await extractLedger(buffer));
  const lines = classifyLines(result.lines, rules);
  let day = null;
  let warning = null;
  if (result.date) {
    if (result.date.m === month.month && result.date.y === month.year) day = result.date.d;
    else warning = `Image is dated ${result.report_date}, not this month — set the day manually`;
  }
  return { ...result, lines, day, warning };
}

app.post('/api/months/:id/upload', upload.single('image'), wrap(async (req, res) => {
  const month = await getMonth(req.params.id);
  if (!req.file) throw fail(400, 'No image');
  const hash = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
  const dup = await db.query('SELECT id, day FROM entries WHERE month_id=$1 AND image_hash=$2', [month.id, hash]);
  if (dup.rowCount) {
    return res.json({ skipped: true, reason: `Same image already uploaded (day ${dup.rows[0].day ?? '?'})`, id: dup.rows[0].id });
  }
  const x = await readInto(month, req.file.buffer, await loadRules(month.company_id));
  const r = await db.query(
    `INSERT INTO entries (month_id, day, report_date, image, image_mime, image_name, image_hash, lines, printed, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, day`,
    [month.id, x.day, x.report_date, req.file.buffer, req.file.mimetype, req.file.originalname, hash,
      JSON.stringify(x.lines), JSON.stringify(x.printed), JSON.stringify(x.notes)],
  );
  const clash = x.day ? await db.query('SELECT count(*)::int c FROM entries WHERE month_id=$1 AND day=$2', [month.id, x.day]) : null;
  res.json({
    id: r.rows[0].id,
    day: x.day,
    warning: x.warning || (clash && clash.rows[0].c > 1 ? `Day ${x.day} now has more than one image — review and delete the extra one` : null),
  });
}));

// --- manual entry: a day typed in without an image ---
// By date for a company: creates that month first if it doesn't exist yet.
const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec'];
app.post('/api/companies/:id/manual', wrap(async (req, res) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(req.body.date || '');
  if (!m) throw fail(400, 'Pick a date');
  const [year, mon, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const company = (await db.query('SELECT * FROM companies WHERE id=$1', [req.params.id])).rows[0];
  if (!company) throw fail(404, 'Company not found');
  let month = (await db.query('SELECT * FROM months WHERE company_id=$1 AND year=$2 AND month=$3', [company.id, year, mon])).rows[0];
  if (!month) {
    const last = (await db.query('SELECT hsd_rate, ms_rate, hsd_cost, ms_cost FROM months WHERE company_id=$1 ORDER BY year DESC, month DESC LIMIT 1', [company.id])).rows[0] || {};
    month = (await db.query(
      'INSERT INTO months (company_id, title, year, month, hsd_rate, ms_rate, hsd_cost, ms_cost) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
      [company.id, `${company.name}-${MONTH_ABBR[mon - 1]}-${String(year).slice(2)}`, year, mon, last.hsd_rate ?? null, last.ms_rate ?? null, last.hsd_cost ?? null, last.ms_cost ?? null],
    )).rows[0];
  }
  res.json({ month_id: month.id, id: await createManual(month, day) });
}));
app.post('/api/months/:id/manual', wrap(async (req, res) => {
  const month = await getMonth(req.params.id);
  res.json({ id: await createManual(month, Number(req.body.day)) });
}));
async function createManual(month, day) {
  const last = new Date(month.year, month.month, 0).getDate();
  if (!day || day < 1 || day > last) throw fail(400, `Day must be between 1 and ${last}`);
  const lines = [
    { id: 1, side: 'in', label: 'OPENING CASH', unit: null, rate: null, amount: null, col: 'OB' },
    { id: 2, side: 'in', label: 'HSD', unit: null, rate: month.hsd_rate ? Number(month.hsd_rate) : null, amount: null, col: 'HSD' },
    { id: 3, side: 'in', label: 'MS', unit: null, rate: month.ms_rate ? Number(month.ms_rate) : null, amount: null, col: 'MS' },
    { id: 4, side: 'out', label: 'PAYTM', unit: null, rate: null, amount: null, col: 'PTM' },
  ];
  const date = `${String(day).padStart(2, '0')}-${String(month.month).padStart(2, '0')}-${month.year}`;
  const r = await db.query(
    "INSERT INTO entries (month_id, day, report_date, lines, source) VALUES ($1,$2,$3,$4,'manual') RETURNING id",
    [month.id, day, date, JSON.stringify(lines)],
  );
  return r.rows[0].id;
}

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
app.get('/api/ledger', wrap(async (req, res) => res.json(await ledger(reportParams(req.query)))));
app.get('/api/ledger/export.xlsx', wrap(async (req, res) => {
  const p = reportParams(req.query);
  const title = await reportTitle(p, 'Ledger');
  sendXlsx(res, title, await buildLedgerWorkbook(title, await ledger(p)));
}));

// --- entries ---
app.get('/api/entries/:id', wrap(async (req, res) => {
  const r = await db.query('SELECT id, month_id, day, report_date, image_name, lines, printed, notes, status, source, image IS NOT NULL AS has_image FROM entries WHERE id=$1', [req.params.id]);
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
app.put('/api/entries/:id', wrap(async (req, res) => {
  const { day, report_date, lines, printed, status, remember } = req.body;
  const owner = await db.query('SELECT m.company_id FROM entries e JOIN months m ON m.id = e.month_id WHERE e.id = $1', [req.params.id]);
  if (!owner.rowCount) throw fail(404, 'Not found');
  const companyId = owner.rows[0].company_id;
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
  await db.query(
    'UPDATE entries SET day=$2, report_date=$3, lines=$4, printed=$5, status=$6, updated_at=now() WHERE id=$1',
    [req.params.id, day || null, report_date || null, JSON.stringify(clean), JSON.stringify(printed || {}), status === 'verified' ? 'verified' : 'review'],
  );
  // "Remember" turns a hand-assigned line into an exact-label rule for future images.
  for (const l of clean.filter((x) => x.manual && remember?.includes(x.id))) {
    const pattern = `^\\s*${l.label.toUpperCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*')}\\s*$`;
    await db.query('INSERT INTO rules (company_id, side, pattern, col, priority) VALUES ($1,$2,$3,$4,5)', [companyId, l.side, pattern, l.col]);
  }
  res.json({ ok: true });
}));
app.post('/api/entries/:id/reextract', wrap(async (req, res) => {
  const r = await db.query('SELECT e.image, e.month_id FROM entries e WHERE id=$1', [req.params.id]);
  if (!r.rowCount) throw fail(404, 'Not found');
  if (!r.rows[0].image) throw fail(400, 'This day was entered by hand; there is no image to read');
  const month = await getMonth(r.rows[0].month_id);
  const x = await readInto(month, r.rows[0].image, await loadRules(month.company_id));
  await db.query('UPDATE entries SET day=$2, report_date=$3, lines=$4, printed=$5, notes=$6, status=$7, updated_at=now() WHERE id=$1',
    [req.params.id, x.day, x.report_date, JSON.stringify(x.lines), JSON.stringify(x.printed), JSON.stringify(x.notes), 'review']);
  res.json({ ok: true, warning: x.warning });
}));
app.post('/api/entries/:id/reclassify', wrap(async (req, res) => {
  const r = await db.query('SELECT e.lines, m.company_id FROM entries e JOIN months m ON m.id = e.month_id WHERE e.id=$1', [req.params.id]);
  if (!r.rowCount) throw fail(404, 'Not found');
  const lines = classifyLines(r.rows[0].lines, await loadRules(r.rows[0].company_id), { force: true });
  await db.query('UPDATE entries SET lines=$2, updated_at=now() WHERE id=$1', [req.params.id, JSON.stringify(lines)]);
  res.json({ ok: true });
}));
app.delete('/api/entries/:id', wrap(async (req, res) => {
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

const port = process.env.PORT || 3000;
migrate().then(() => app.listen(port, () => console.log(`Pump ledger on http://localhost:${port}`)))
  .catch((e) => { console.error(e); process.exit(1); });
