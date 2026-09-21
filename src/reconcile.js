const { computeRow, n, round2 } = require('./columns');

const TOL = 1; // rupees; printed reports round to the paisa, photos can blur a digit

function check(id, label, expected, actual, level = 'error') {
  if (expected === null || expected === undefined || expected === '') {
    return { id, label, status: 'skip', detail: 'Not printed on the image' };
  }
  const diff = round2(n(actual) - n(expected));
  return {
    id,
    label,
    status: Math.abs(diff) <= TOL ? 'ok' : level,
    expected: round2(n(expected)),
    actual: round2(n(actual)),
    diff,
  };
}

// Checks for a single image. `prevClosing` is the computed closing balance of
// the previous day (the sheet carries it into the next day's OB).
function entryChecks(entry, row, month, prevClosing, dupDay) {
  const p = entry.printed || {};
  const checks = [];

  if (!entry.day) {
    checks.push({ id: 'date', label: 'Report date', status: 'error', detail: 'No date found — set the day manually' });
  } else if (dupDay) {
    checks.push({ id: 'date', label: 'Report date', status: 'error', detail: `Another image is also dated day ${entry.day}` });
  } else {
    checks.push({ id: 'date', label: 'Report date', status: 'ok', detail: entry.report_date || `Day ${entry.day}` });
  }

  checks.push(check('inflow', 'Total inflow = sum of inflow lines', p.total_inflow, row.inflowLinesTotal));
  checks.push(check('expense', 'Total expenses = sum of expense lines', p.total_expense, row.M));

  for (const [col, name] of [['HSD', 'HSD'], ['MS', 'MS']]) {
    const line = entry.lines.find((l) => l.side === 'in' && l.col === col);
    if (line && n(line.amount)) {
      checks.push(check(`${col}_amt`, `${name} units × rate = amount`, line.amount, row[`${col}_AMT`]));
    }
  }

  const computedCash = round2(row.inflowLinesTotal - row.M);
  checks.push(check('cash', 'Cash in hand = inflow − expenses', p.cash_in_hand, computedCash));

  if (prevClosing !== null && prevClosing !== undefined) {
    checks.push(check('ob', 'Opening cash = previous day closing', row.OB, prevClosing, 'warn'));
  }
  return checks;
}

function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

// Everything the dashboard and the Excel export need for one month.
function buildMonth(month, entries) {
  const byDay = new Map();
  for (const e of entries) {
    if (!e.day) continue;
    if (!byDay.has(e.day)) byDay.set(e.day, []);
    byDay.get(e.day).push(e);
  }

  const total = daysInMonth(month.year, month.month);
  const out = [];
  let prevClosing = null;
  let prevDay = null;
  let first = true;

  const sorted = entries.slice().sort((a, b) => (a.day || 99) - (b.day || 99) || a.id - b.id);
  for (const e of sorted) {
    const row = computeRow(e.lines || [], month);
    const dupDay = e.day && byDay.get(e.day).length > 1;
    // Sheet rule: day 1's OB comes from the image, later days carry forward.
    const openingUsed = first || prevClosing === null ? row.OB : prevClosing;
    const L = round2(openingUsed + row.HSD_AMT + row.MS_AMT + row.LUB + row.COFFEE + row.COLL);
    const closing = round2(L - row.M);
    const consecutive = !first && e.day && prevDay === e.day - 1;
    const checks = entryChecks(e, row, month, consecutive ? prevClosing : null, dupDay);
    out.push({
      id: e.id,
      day: e.day,
      report_date: e.report_date,
      image_name: e.image_name,
      source: e.source || 'image',
      status: e.status,
      row: { ...row, openingUsed, L, closing },
      checks,
      errors: checks.filter((c) => c.status === 'error').length,
      warnings: checks.filter((c) => c.status === 'warn').length,
    });
    if (e.day) { prevClosing = closing; prevDay = e.day; first = false; }
  }

  const dated = out.filter((d) => d.day);
  const present = new Set(dated.map((d) => d.day));
  const missing = [];
  for (let d = 1; d <= total; d++) if (!present.has(d)) missing.push(d);

  const sum = (k) => round2(dated.reduce((s, d) => s + n(d.row[k]), 0));
  const keys = ['HSD', 'HSD_AMT', 'MS', 'MS_AMT', 'LUB', 'COFFEE', 'COLL', 'M', 'BANK', 'PTM', 'UPI', 'TSALE', 'FLEET', 'RBABU', 'RANJIT', 'OTHERS', 'V', 'PEXP'];
  const totals = Object.fromEntries(keys.map((k) => [k, sum(k)]));
  const openingOB = dated.length ? dated[0].row.OB : 0;
  totals.OB = openingOB;
  totals.inflow = round2(openingOB + totals.HSD_AMT + totals.MS_AMT + totals.LUB + totals.COFFEE + totals.COLL);
  totals.closing = round2(totals.inflow - totals.M);
  const lastClosing = dated.length ? dated[dated.length - 1].row.closing : 0;

  const monthChecks = [
    { id: 'days', label: `All ${total} days uploaded`, status: missing.length ? 'warn' : 'ok', detail: missing.length ? `Missing: ${missing.join(', ')}` : `${present.size} days` },
    { id: 'undated', label: 'Every image has a date', status: out.some((d) => !d.day) ? 'error' : 'ok', detail: `${out.filter((d) => !d.day).length} without a date` },
    { id: 'dups', label: 'One image per day', status: [...byDay.values()].some((v) => v.length > 1) ? 'error' : 'ok', detail: [...byDay.entries()].filter(([, v]) => v.length > 1).map(([d]) => `Day ${d}`).join(', ') || 'No duplicates' },
    { id: 'imgchecks', label: 'All image checks pass', status: out.some((d) => d.errors) ? 'error' : 'ok', detail: `${out.filter((d) => d.errors).length} image(s) with mismatches` },
    { id: 'verified', label: 'All images verified', status: out.every((d) => d.status === 'verified') && out.length ? 'ok' : 'warn', detail: `${out.filter((d) => d.status === 'verified').length} of ${out.length} verified` },
    { id: 'balance', label: 'Month closing = last day closing', status: Math.abs(totals.closing - lastClosing) <= TOL ? 'ok' : 'warn', detail: `Totals row ${totals.closing.toFixed(2)} vs day ${dated.length ? dated[dated.length - 1].day : '-'} ${lastClosing.toFixed(2)}` },
  ];

  return { daysInMonth: total, entries: out, missing, totals, monthChecks };
}

module.exports = { buildMonth, daysInMonth };
