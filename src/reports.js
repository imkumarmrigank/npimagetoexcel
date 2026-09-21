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
  const entries = (await db.query('SELECT id, month_id, day, report_date, lines, printed, status, source FROM entries WHERE month_id = ANY($1)', [months.map((m) => m.id)])).rows;
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

const SUM_KEYS = ['HSD', 'HSD_AMT', 'MS', 'MS_AMT', 'LUB', 'COFFEE', 'COLL', 'M', ...EXPENSE_COLS.map((c) => c.key), 'V'];

function emptyAgg() {
  const a = Object.fromEntries(SUM_KEYS.map((k) => [k, 0]));
  return { ...a, days: 0, verified: 0, hsdCost: 0, msCost: 0, costMissingDays: 0, opening: null, closing: null, pexp: new Map() };
}

function addDay(a, d) {
  for (const k of SUM_KEYS) a[k] += n(d.row[k]);
  a.days += 1;
  if (d.status === 'verified') a.verified += 1;
  if (a.opening === null) a.opening = d.row.openingUsed;
  a.closing = d.row.closing;
  const hc = n(d.month.hsd_cost), mc = n(d.month.ms_cost);
  if ((d.row.HSD && !hc) || (d.row.MS && !mc)) a.costMissingDays += 1;
  a.hsdCost += d.row.HSD * hc;
  a.msCost += d.row.MS * mc;
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
    pl: {
      hsdSales: out.HSD_AMT, msSales: out.MS_AMT, lube: out.LUB, coffee: out.COFFEE, sales,
      hsdCost: round2(a.hsdCost), msCost: round2(a.msCost), cogs, gross,
      expenses: out.PEXP, net: round2(gross - out.PEXP), costMissingDays: a.costMissingDays,
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

module.exports = { report, ledger, periodOf };
