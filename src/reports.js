const db = require('./db');
const { buildMonth } = require('./reconcile');
const { EXPENSE_COLS, INFLOW_COLS, n, round2 } = require('./columns');

const pad = (v) => String(v).padStart(2, '0');
const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

// Indian financial year runs April–March; FY 2026-27 = Apr 2026 … Mar 2027.
function periodOf(y, m, d, group, fy) {
  const fyStart = fy ? (m >= 4 ? y : y - 1) : y;
  const pos = fy ? (m - 4 + 12) % 12 : m - 1; // 0-based month within the year
  const yLabel = fy ? `FY ${fyStart}-${String(fyStart + 1).slice(2)}` : String(y);
  switch (group) {
    case 'day': return { key: iso(y, m, d), label: `${pad(d)}-${pad(m)}-${y}` };
    case 'week': { // Monday to Sunday
      const start = new Date(Date.UTC(y, m - 1, d));
      start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
      const end = new Date(start); end.setUTCDate(end.getUTCDate() + 6);
      const f = (t) => `${pad(t.getUTCDate())}-${pad(t.getUTCMonth() + 1)}`;
      return { key: start.toISOString().slice(0, 10), label: `${f(start)} to ${f(end)}-${end.getUTCFullYear()}` };
    }
    case 'month': return { key: `${y}-${pad(m)}`, label: new Date(y, m - 1, 1).toLocaleString('en-IN', { month: 'short', year: 'numeric' }) };
    case 'quarter': { const q = Math.floor(pos / 3) + 1; return { key: `${fyStart}-Q${q}`, label: `Q${q} ${yLabel}` }; }
    case 'half': { const h = pos < 6 ? 1 : 2; return { key: `${fyStart}-H${h}`, label: `H${h} ${yLabel}` }; }
    default: return { key: String(fyStart), label: yLabel };
  }
}

// Every dated day in range, with its computed sheet row (carry-forward needs the whole month).
async function loadDays({ companyId, from, to }) {
  const params = [];
  let where = 'TRUE';
  if (companyId) { params.push(companyId); where += ` AND m.company_id = $${params.length}`; }
  if (from) { params.push(from.slice(0, 7) + '-01'); where += ` AND make_date(m.year, m.month, 1) >= $${params.length}::date`; }
  if (to) { params.push(to); where += ` AND make_date(m.year, m.month, 1) <= $${params.length}::date`; }
  const months = (await db.query(`SELECT m.*, c.name AS company FROM months m JOIN companies c ON c.id = m.company_id WHERE ${where} ORDER BY m.year, m.month`, params)).rows;
  if (!months.length) return [];
  const entries = (await db.query('SELECT id, month_id, day, report_date, lines, printed, status, source, tally_batch_id FROM entries WHERE month_id = ANY($1)', [months.map((m) => m.id)])).rows;
  const days = [];
  const lines = new Map(entries.map((e) => [e.id, e.lines]));
  for (const month of months) {
    const s = buildMonth(month, entries.filter((e) => e.month_id === month.id));
    for (const e of s.entries) {
      if (!e.day) continue;
      const date = iso(month.year, month.month, e.day);
      if ((from && date < from) || (to && date > to)) continue;
      days.push({ ...e, date, month, lines: lines.get(e.id) || [] });
    }
  }
  return days.sort((a, b) => a.date.localeCompare(b.date) || a.month.company.localeCompare(b.month.company));
}

// Dealer commission published by PPAC (Government of India), effective 1 Dec 2024:
// fixed Rs per kilolitre + a percentage of the product billable price. The billable price is not
// on the daily reports, so it is taken as a share of the selling rate; this makes it an estimate.
const DEALER_COMMISSION = {
  effective: '2024-12-01',
  source: 'https://ppac.gov.in/prices/dealers-distributors-commission-on-petrol-diesel-pds-kerosene-domestic-lpg',
  billableShare: 0.6,
  MS: { perKl: 3144.03, pct: 0.870 },
  HSD: { perKl: 2332.51, pct: 0.266 },
};
function estimatedMargin(fuel, rate) {
  const c = DEALER_COMMISSION[fuel];
  return c.perKl / 1000 + (c.pct / 100) * n(rate) * DEALER_COMMISSION.billableShare;
}
const estimatedCost = (fuel, rate) => (n(rate) ? n(rate) - estimatedMargin(fuel, rate) : 0);

const SUM_KEYS = ['HSD', 'HSD_AMT', 'MS', 'MS_AMT', 'LUB', 'COFFEE', 'COLL', 'M', ...EXPENSE_COLS.map((c) => c.key), 'V'];

function emptyAgg() {
  const a = Object.fromEntries(SUM_KEYS.map((k) => [k, 0]));
  return { ...a, days: 0, verified: 0, hsdCost: 0, msCost: 0, estimatedDays: 0, opening: null, closing: null, firstDate: null, lastDate: null, lastCash: null, pexp: new Map(), prevCash: null, gaps: [], fuel: { HSD: new Map(), MS: new Map() } };
}

function addDay(a, d) {
  for (const k of SUM_KEYS) a[k] += n(d.row[k]);
  a.days += 1;
  if (d.status === 'verified') a.verified += 1;
  if (a.opening === null) { a.opening = d.row.openingUsed; a.firstDate = d.date; }
  a.closing = d.row.closing;
  a.lastDate = d.date;
  a.lastCash = d.row.CASH ?? null;
  // Why the printed cash in hand drifts from the worked-out balance: every day adds
  // (its opening − the previous day's cash in hand) + (its printed cash − its own rows' result).
  const calc = n(d.row.inflowLinesTotal) - n(d.row.M);
  const cash = d.row.CASH === null || d.row.CASH === undefined ? calc : n(d.row.CASH);
  if (a.prevCash !== null) {
    const o = round2(n(d.row.OB) - a.prevCash);
    if (Math.abs(o) >= 0.01) a.gaps.push({ date: d.date, kind: 'opening', amount: o, company: d.month.company });
  }
  const e = round2(cash - calc);
  if (Math.abs(e) >= 0.01) a.gaps.push({ date: d.date, kind: 'day', amount: e, company: d.month.company });
  a.prevCash = cash;
  // Purchase cost per litre: the month's actual figure when entered, otherwise the
  // standard dealer commission (PPAC) taken off that day's selling rate — an estimate.
  const hc = n(d.month.hsd_cost), mc = n(d.month.ms_cost);
  const estimated = (d.row.HSD && !hc) || (d.row.MS && !mc);
  if (estimated) a.estimatedDays += 1;
  a.hsdCost += d.row.HSD * (hc || estimatedCost('HSD', d.row.HSD_RATE));
  a.msCost += d.row.MS * (mc || estimatedCost('MS', d.row.MS_RATE));
  // Fuel sold at each rate (the rate can change between dates): units × that day's rate.
  for (const fuel of ['HSD', 'MS']) {
    const units = n(d.row[fuel]);
    if (!units) continue;
    const rate = n(d.row[`${fuel}_RATE`]);
    const g = a.fuel[fuel].get(rate) || { rate, units: 0, amount: 0, from: d.date, to: d.date };
    g.units += units; g.amount += n(d.row[`${fuel}_AMT`]); g.to = d.date;
    a.fuel[fuel].set(rate, g);
  }
  for (const l of d.lines) {
    if (l.side !== 'out' || l.col !== 'PEXP') continue;
    const key = String(l.label || '').toUpperCase().replace(/\s+/g, ' ').trim() || '(no label)';
    a.pexp.set(key, (a.pexp.get(key) || 0) + n(l.amount));
  }
}

function finish(a) {
  const out = {};
  for (const k of SUM_KEYS) out[k] = round2(a[k]);
  const sales = round2(out.HSD_AMT + out.MS_AMT + out.LUB + out.COFFEE);
  const cogs = round2(a.hsdCost + a.msCost);
  const gross = round2(sales - cogs);
  return {
    ...out,
    days: a.days,
    verified: a.verified,
    opening: round2(n(a.opening)),
    closing: round2(n(a.closing)),
    firstDate: a.firstDate,
    lastDate: a.lastDate,
    lastCash: a.lastCash === null ? null : round2(n(a.lastCash)),
    gaps: a.gaps,
    fuelByRate: Object.fromEntries(['HSD', 'MS'].map((f) => [f, [...a.fuel[f].values()].sort((x, y) => x.from.localeCompare(y.from))
      .map((g) => ({ rate: g.rate, units: round2(g.units), amount: round2(g.amount), from: g.from, to: g.to }))])),
    pl: {
      hsdSales: out.HSD_AMT, msSales: out.MS_AMT, lube: out.LUB, coffee: out.COFFEE, sales,
      hsdCost: round2(a.hsdCost), msCost: round2(a.msCost), cogs, gross,
      expenses: out.PEXP, net: round2(gross - out.PEXP), costMissingDays: 0, estimatedDays: a.estimatedDays, commission: DEALER_COMMISSION,
      expenseLines: [...a.pexp.entries()].map(([label, amount]) => ({ label, amount: round2(amount) })).sort((x, y) => y.amount - x.amount),
    },
    cash: {
      deposits: round2(out.BANK + out.PTM + out.UPI),
      parties: round2(out.TSALE + out.FLEET + out.RBABU + out.RANJIT + out.OTHERS),
      collection: out.COLL,
    },
  };
}

async function report({ companyId, from, to, group = 'month', fy = true }) {
  const days = await loadDays({ companyId, from, to });
  const periods = new Map();
  const total = emptyAgg();
  const byCompany = new Map();
  for (const d of days) {
    const p = periodOf(Number(d.date.slice(0, 4)), Number(d.date.slice(5, 7)), Number(d.date.slice(8, 10)), group, fy);
    // With "all companies" each period gets one row per company.
    const key = companyId ? p.key : `${p.key}|${d.month.company}`;
    if (!periods.has(key)) periods.set(key, { key: p.key, label: p.label, company: d.month.company, agg: emptyAgg() });
    addDay(periods.get(key).agg, d);
    addDay(total, d);
    if (!byCompany.has(d.month.company)) byCompany.set(d.month.company, emptyAgg());
    addDay(byCompany.get(d.month.company), d);
  }
  return {
    group,
    fy,
    from: from || (days[0] && days[0].date) || null,
    to: to || (days.length && days[days.length - 1].date) || null,
    rows: [...periods.values()].sort((a, b) => a.key.localeCompare(b.key) || a.company.localeCompare(b.company)).map((p) => ({ key: p.key, label: p.label, company: p.company, ...finish(p.agg) })),
    companies: [...byCompany.entries()].map(([company, agg]) => ({ company, ...finish(agg) })),
    total: finish(total),
  };
}

// Line-by-line ledger: every inflow/expense line on every day, filterable.
async function ledger({ companyId, from, to, col, side, q }) {
  const days = await loadDays({ companyId, from, to });
  const needle = String(q || '').trim().toUpperCase();
  const colLabel = Object.fromEntries([...INFLOW_COLS, ...EXPENSE_COLS].map((c) => [c.key, c.label]));
  const rows = [];
  for (const d of days) {
    for (const l of d.lines) {
      if (l.col === 'OB' && col !== 'OB') continue; // opening cash is a balance, not a movement
      if (side && l.side !== side) continue;
      if (col && l.col !== col) continue;
      if (needle && !String(l.label || '').toUpperCase().includes(needle)) continue;
      rows.push({
        date: d.date, company: d.month.company, entryId: d.id, side: l.side, label: l.label, col: l.col,
        colLabel: colLabel[l.col] || l.col, unit: l.unit, rate: l.rate, amount: round2(n(l.amount)),
      });
    }
  }
  const inflow = round2(rows.filter((r) => r.side === 'in').reduce((s, r) => s + r.amount, 0));
  const outflow = round2(rows.filter((r) => r.side === 'out').reduce((s, r) => s + r.amount, 0));
  return { rows, inflow, outflow, count: rows.length };
}

// Every open problem in a range, worked out fresh each time, so fixed ones disappear.
async function issues({ companyId, from, to }) {
  const days = await loadDays({ companyId, from, to });
  const out = { checks: [], missing: [], undated: [], unverified: [] };
  for (const d of days) {
    for (const c of d.checks) {
      if (c.status === 'error' || c.status === 'warn') {
        out.checks.push({ date: d.date, entryId: d.id, company: d.month.company, check: c, lines: d.lines, checks: d.checks, locked: !!d.tally_batch_id });
      }
    }
    if (d.status !== 'verified') out.unverified.push({ date: d.date, entryId: d.id, company: d.month.company, errors: d.errors, warnings: d.warnings });
  }
  // Missing days: in each month of the range, up to today (future days are not missing yet).
  const params = [companyId];
  const months = (await db.query('SELECT m.*, c.name AS company FROM months m JOIN companies c ON c.id = m.company_id WHERE m.company_id = $1 ORDER BY m.year, m.month', params)).rows;
  const today = new Date().toISOString().slice(0, 10);
  const have = new Set(days.map((d) => `${d.month.id}:${d.date}`));
  for (const m of months) {
    const last = new Date(m.year, m.month, 0).getDate();
    for (let day = 1; day <= last; day++) {
      const date = iso(m.year, m.month, day);
      if ((from && date < from) || (to && date > to) || date > today) continue;
      if (!have.has(`${m.id}:${date}`)) out.missing.push({ date, monthId: m.id, company: m.company });
    }
    const undated = (await db.query('SELECT id, image_name FROM entries WHERE month_id=$1 AND day IS NULL', [m.id])).rows;
    for (const u of undated) out.undated.push({ entryId: u.id, monthId: m.id, image: u.image_name, company: m.company });
  }
  return out;
}

module.exports = { report, ledger, periodOf, issues, estimatedMargin, DEALER_COMMISSION };
