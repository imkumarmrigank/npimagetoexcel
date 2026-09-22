const path = require('path');
const ExcelJS = require('exceljs');

const TEMPLATE = path.join(__dirname, '..', 'templates', 'ledger-template.xlsx');

// Input cells per day row; everything else in the template is a formula and is kept.
const INPUTS = {
  C: 'HSD', D: 'HSD_RATE', F: 'MS', G: 'MS_RATE', I: 'LUB', J: 'COFFEE', K: 'COLL',
  M: 'M', N: 'BANK', O: 'PTM', P: 'UPI', Q: 'TSALE', R: 'FLEET', S: 'RBABU', T: 'RANJIT', U: 'OTHERS',
};
const ALWAYS = new Set(['D', 'G']); // rates are filled on every row, like the original sheet

async function buildWorkbook(month, summary) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(TEMPLATE);
  const ws = wb.worksheets[0];
  ws.getCell('A1').value = month.title;

  const byDay = new Map(summary.entries.filter((e) => e.day).map((e) => [e.day, e]));

  for (let day = 1; day <= 31; day++) {
    const r = day + 2;
    const e = byDay.get(day);
    const inMonth = day <= summary.daysInMonth;
    ws.getCell(`A${r}`).value = inMonth ? day : null;
    for (const [col, key] of Object.entries(INPUTS)) {
      let v = e ? e.row[key] : null;
      if (!e && ALWAYS.has(col) && inMonth) v = Number(key === 'HSD_RATE' ? month.hsd_rate : month.ms_rate) || null;
      ws.getCell(`${col}${r}`).value = v || null;
    }
  }

  const first = summary.entries.find((e) => e.day);
  ws.getCell('B3').value = first ? first.row.OB : null;
  ws.getCell('B35').value = month.total_ob !== null && month.total_ob !== undefined ? Number(month.total_ob) : (first ? first.row.OB : null);

  // Formula results cached from the template would be stale; make Excel recalc on open.
  wb.calcProperties = { ...(wb.calcProperties || {}), fullCalcOnLoad: true };
  ws.eachRow((row) => row.eachCell((cell) => {
    if (cell.type === ExcelJS.ValueType.Formula) cell.value = { formula: cell.formula };
  }));

  return wb.xlsx.writeBuffer();
}

module.exports = { buildWorkbook };

// --- report and ledger exports (plain tables) ---
const REPORT_COLS = [
  ['Days', 'days'], ['HSD ltr', 'HSD'], ['HSD sale', 'HSD_AMT'], ['MS ltr', 'MS'], ['MS sale', 'MS_AMT'], ['Lub', 'LUB'], ['Cofee', 'COFFEE'],
  ['Collection', 'COLL'], ['T-Exp', 'M'], ['Bank', 'BANK'], ['PTM', 'PTM'], ['UPI', 'UPI'], ['T-Sale', 'TSALE'], ['Fleet', 'FLEET'],
  ['R-Babu', 'RBABU'], ['Ranjit', 'RANJIT'], ['Others', 'OTHERS'], ['P-Exp', 'PEXP'], ['Opening', 'opening'], ['Closing', 'closing'],
];

function styleHeader(row) {
  row.font = { bold: true };
  row.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE9EEF5' } }; });
}

async function buildReportWorkbook(title, rep, withCompany) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Summary');
  ws.addRow([title]).font = { bold: true, size: 13 };
  ws.addRow([`${rep.from || ''} to ${rep.to || ''}`]);
  const head = ['Period', ...(withCompany ? ['Company'] : []), ...REPORT_COLS.map((c) => c[0])];
  styleHeader(ws.addRow(head));
  for (const r of rep.rows) ws.addRow([r.label, ...(withCompany ? [r.company] : []), ...REPORT_COLS.map(([, k]) => r[k] || null)]);
  const t = ws.addRow(['Total', ...(withCompany ? [''] : []), ...REPORT_COLS.map(([, k]) => (k === 'opening' || k === 'closing' ? null : rep.total[k] || null))]);
  t.font = { bold: true };
  ws.columns.forEach((c, i) => { c.width = i === 0 ? 16 : 13; if (i > 0) c.numFmt = '#,##0.00'; });

  const pl = wb.addWorksheet('Profit & Loss');
  pl.addRow([`${title} — Profit & Loss`]).font = { bold: true, size: 13 };
  pl.addRow([`${rep.from || ''} to ${rep.to || ''}`]);
  if (rep.total.pl.estimatedDays) {
    const c = rep.total.pl.commission;
    pl.addRow([`ESTIMATED for ${rep.total.pl.estimatedDays} day(s): fuel cost = selling rate − standard dealer commission (PPAC, from ${c.effective}: MS Rs ${c.MS.perKl}/KL + ${c.MS.pct}%, HSD Rs ${c.HSD.perKl}/KL + ${c.HSD.pct}% of billable price, taken as ${Math.round(c.billableShare * 100)}% of selling rate). Enter actual purchase costs for exact figures.`]).font = { italic: true, color: { argb: 'FF9A6200' } };
  }
  styleHeader(pl.addRow(['Particulars', ...rep.rows.map((r) => (withCompany ? `${r.label} ${r.company}` : r.label)), 'Total']));
  const line = (label, get, bold) => {
    const row = pl.addRow([label, ...rep.rows.map((r) => get(r.pl)), get(rep.total.pl)]);
    if (bold) row.font = { bold: true };
  };
  line('HSD sales', (p) => p.hsdSales);
  line('MS sales', (p) => p.msSales);
  line('Lube', (p) => p.lube);
  line('Coffee', (p) => p.coffee);
  line('Total sales', (p) => p.sales, true);
  line('Less: HSD purchase cost', (p) => p.hsdCost);
  line('Less: MS purchase cost', (p) => p.msCost);
  line('Gross profit', (p) => p.gross, true);
  line('Less: operating expenses (P-Exp)', (p) => p.expenses);
  line('Net profit', (p) => p.net, true);
  pl.addRow([]);
  styleHeader(pl.addRow(['Operating expenses (whole period)', 'Amount']));
  for (const e of rep.total.pl.expenseLines) pl.addRow([e.label, e.amount]);
  pl.columns.forEach((c, i) => { c.width = i === 0 ? 36 : 16; if (i > 0) c.numFmt = '#,##0.00'; });
  return wb.xlsx.writeBuffer();
}

async function buildLedgerWorkbook(title, led) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Ledger');
  ws.addRow([title]).font = { bold: true, size: 13 };
  styleHeader(ws.addRow(['Date', 'Company', 'Particulars', 'Column', 'Unit', 'Rate', 'Inflow', 'Outflow']));
  for (const r of led.rows) {
    ws.addRow([r.date, r.company, r.label, r.colLabel, r.unit, r.rate, r.side === 'in' ? r.amount : null, r.side === 'out' ? r.amount : null]);
  }
  ws.addRow(['Total', '', '', '', '', '', led.inflow, led.outflow]).font = { bold: true };
  ws.columns.forEach((c, i) => { c.width = [12, 24, 40, 16, 10, 10, 14, 14][i]; if (i >= 4) c.numFmt = '#,##0.00'; });
  return wb.xlsx.writeBuffer();
}

module.exports.buildReportWorkbook = buildReportWorkbook;
module.exports.buildLedgerWorkbook = buildLedgerWorkbook;

// Deposits (Bank/PTM/UPI), party payments and operating expenses by head, one column per period.
async function buildCashflowWorkbook(title, rep) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Deposits & Expenses');
  ws.addRow([title]).font = { bold: true, size: 13 };
  ws.addRow([`${rep.from || ''} to ${rep.to || ''}`]);
  const periods = rep.rows;
  const section = (name, items) => {
    ws.addRow([]);
    styleHeader(ws.addRow([name, ...periods.map((p) => p.label), 'Total']));
    for (const [label, get] of items) ws.addRow([label, ...periods.map((p) => get(p) || null), get(rep.total) || null]);
  };
  section('Deposits', [['Bank', (r) => r.BANK], ['PTM (Paytm)', (r) => r.PTM], ['UPI', (r) => r.UPI], ['Total deposits', (r) => r.cash.deposits]]);
  section('Party payments', [['T-Sale', (r) => r.TSALE], ['Fleet', (r) => r.FLEET], ['R-Babu', (r) => r.RBABU], ['Ranjit', (r) => r.RANJIT], ['Others', (r) => r.OTHERS], ['Total party payments', (r) => r.cash.parties]]);
  const heads = rep.total.pl.expenseLines.map((e) => e.label);
  const amt = (r, h) => r.pl.expenseLines.find((e) => e.label === h)?.amount;
  section('Operating expenses (P-Exp)', [...heads.map((h) => [h, (r) => amt(r, h)]), ['Total operating expenses', (r) => r.PEXP]]);
  ws.eachRow((row) => { if (/^Total/.test(String(row.getCell(1).value))) row.font = { bold: true }; });
  ws.columns.forEach((c, i) => { c.width = i === 0 ? 34 : 15; if (i > 0) c.numFmt = '#,##0.00'; });
  return wb.xlsx.writeBuffer();
}
module.exports.buildCashflowWorkbook = buildCashflowWorkbook;

// Cash reconciliation for a date range, laid out like the user's month-end sheet.
async function buildReconWorkbook(title, t) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Cash reconciliation');
  ws.getCell('A1').value = title;
  ws.getCell('A1').font = { bold: true, size: 13 };
  const head = ws.getRow(2);
  ['', 'Unit', 'Rate', 'Amount', '', 'Particulars', 'Amount'].forEach((v, i) => { head.getCell(i + 1).value = v || null; });
  head.font = { bold: true };

  // One row per selling rate, so a mid-month price change is shown as it happened.
  const fuelRows = (fuel) => {
    const list = (t.fuelByRate && t.fuelByRate[fuel]) || [];
    if (!list.length) return [[fuel, null, null, null]];
    return list.map((g) => [list.length > 1 ? `${fuel} (${g.from.split('-').reverse().join('-')} to ${g.to.split('-').reverse().join('-')})` : fuel, g.units, g.rate, null]);
  };
  const left = [
    ['Opening Cash', null, null, t.opening],
    ...fuelRows('HSD'),
    ...fuelRows('MS'),
    ['Coffee', null, null, t.COFFEE || null],
    ['Lubricant', null, null, t.LUB || null],
    ['Collection', null, null, t.COLL || null],
  ];
  const right = [
    ['Bank', t.BANK], ['PTM', t.PTM], ['UPI', t.UPI], ['Tankar Sale', t.TSALE],
    ...(t.FLEET ? [['Fleet', t.FLEET]] : []),
    ['Ranjit Ji', t.RANJIT], ['Rajeshwar Babu', t.RBABU], ['Others', t.OTHERS], ['Pump Expenses', t.PEXP],
  ];
  const rows = Math.max(left.length, right.length) + 2;
  for (let i = 0; i < rows; i++) {
    const r = 3 + i;
    const l = left[i];
    if (l) {
      ws.getCell(`A${r}`).value = l[0];
      ws.getCell(`B${r}`).value = l[1];
      ws.getCell(`C${r}`).value = l[2];
      // HSD/MS amount = units × rate, as in the daily sheet
      ws.getCell(`D${r}`).value = l[1] && l[2] ? { formula: `ROUND(B${r}*C${r},2)` } : l[3];
    }
    const g = right[i];
    if (g) { ws.getCell(`F${r}`).value = g[0]; ws.getCell(`G${r}`).value = g[1] || null; }
  }
  const last = 3 + rows - 1;
  const tr = last + 2;
  ws.getCell(`A${tr}`).value = 'Total';
  ws.getCell(`D${tr}`).value = { formula: `SUM(D3:D${last})` };
  ws.getCell(`F${tr}`).value = 'Total';
  ws.getCell(`G${tr}`).value = { formula: `SUM(G3:G${last})` };
  ws.getRow(tr).font = { bold: true };
  ws.getCell(`F${tr + 2}`).value = 'Cash Balance';
  ws.getCell(`G${tr + 2}`).value = { formula: `D${tr}-G${tr}` };
  ws.getCell(`F${tr + 2}`).font = ws.getCell(`G${tr + 2}`).font = { bold: true };
  if (t.lastCash !== null && t.lastCash !== undefined) {
    ws.getCell(`F${tr + 3}`).value = `Cash in hand on image (${t.lastDate})`;
    ws.getCell(`G${tr + 3}`).value = t.lastCash;
    ws.getCell(`F${tr + 4}`).value = 'Difference';
    ws.getCell(`G${tr + 4}`).value = { formula: `G${tr + 3}-G${tr + 2}` };
  }
  for (let r = 2; r <= last; r++) for (const c of ['A', 'B', 'C', 'D', 'F', 'G']) ws.getCell(`${c}${r}`).border = { top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' } };
  ws.columns = [{ width: 16 }, { width: 12 }, { width: 10 }, { width: 16 }, { width: 3 }, { width: 30 }, { width: 16 }];
  for (const c of ['B', 'C', 'D', 'G']) ws.getColumn(c).numFmt = '0.00';
  wb.calcProperties = { fullCalcOnLoad: true };
  return wb.xlsx.writeBuffer();
}
module.exports.buildReconWorkbook = buildReconWorkbook;
