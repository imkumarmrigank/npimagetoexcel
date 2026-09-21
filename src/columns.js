// Column layout of the monthly reconciliation sheet (same as the shared Excel).
// `key` is what a ledger line is mapped to; `xl` is the Excel column letter.
const INFLOW_COLS = [
  { key: 'OB', label: 'OB (Opening cash)', xl: 'B' },
  { key: 'HSD', label: 'HSD', xl: 'C' },
  { key: 'MS', label: 'MS', xl: 'F' },
  { key: 'LUB', label: 'Lub', xl: 'I' },
  { key: 'COFFEE', label: 'Cofee', xl: 'J' },
  { key: 'COLL', label: 'Collection', xl: 'K' },
];

const EXPENSE_COLS = [
  { key: 'BANK', label: 'Bank', xl: 'N' },
  { key: 'PTM', label: 'PTM', xl: 'O' },
  { key: 'UPI', label: 'UPI', xl: 'P' },
  { key: 'TSALE', label: 'T-Sale', xl: 'Q' },
  { key: 'FLEET', label: 'Fleet', xl: 'R' },
  { key: 'RBABU', label: 'R-Babu', xl: 'S' },
  { key: 'RANJIT', label: 'Ranjit', xl: 'T' },
  { key: 'OTHERS', label: 'Others', xl: 'U' },
  { key: 'PEXP', label: 'P-Exp (petty)', xl: 'W' },
];

const VEHICLE = '\\b[A-Z]{2}\\s?\\d{1,2}\\s?[A-Z]{1,3}\\s?\\d{3,5}\\b';

// First match (lowest priority number) wins. Anything unmatched falls to
// Collection (inflow) or P-Exp (expense), which is how the sheet treats it.
const DEFAULT_RULES = [
  { side: 'in', priority: 10, pattern: 'OPE?N?ING|OPNING', col: 'OB' },
  { side: 'in', priority: 20, pattern: '^\\s*HSD\\b', col: 'HSD' },
  { side: 'in', priority: 30, pattern: '^\\s*MS\\b|PETROL', col: 'MS' },
  { side: 'in', priority: 40, pattern: 'LUBE?|MOBIL|SOLER', col: 'LUB' },
  { side: 'in', priority: 50, pattern: 'CO?FF?EE', col: 'COFFEE' },
  { side: 'out', priority: 10, pattern: 'BANK', col: 'BANK' },
  { side: 'out', priority: 20, pattern: 'HSDPC|TANK\\s*SEL', col: 'TSALE' },
  { side: 'out', priority: 30, pattern: 'FLEET', col: 'FLEET' },
  { side: 'out', priority: 40, pattern: 'RAJESHWAR|R[\\s.-]*BABU|POCLAIN', col: 'RBABU' },
  { side: 'out', priority: 50, pattern: `RANJ(I|EE)T|SANJ(IV|U)|FORTUNER|${VEHICLE}`, col: 'RANJIT' },
  { side: 'out', priority: 60, pattern: 'PAYTM|\\bPTM\\b', col: 'PTM' },
  { side: 'out', priority: 70, pattern: '\\bUPI\\b|\\bSBI\\b', col: 'UPI' },
  { side: 'out', priority: 80, pattern: '\\bCS[PF]\\b|DR\\.?\\s*SAHAB|NITESH|CYBER|GAS\\s*AGEN|DIPAK', col: 'OTHERS' },
];

const FALLBACK = { in: 'COLL', out: 'PEXP' };
const VALID = { in: new Set(INFLOW_COLS.map((c) => c.key)), out: new Set(EXPENSE_COLS.map((c) => c.key)) };

function compileRules(rows) {
  return rows
    .slice()
    .sort((a, b) => a.priority - b.priority || a.id - b.id)
    .map((r) => {
      try { return { ...r, re: new RegExp(r.pattern, 'i') }; } catch { return null; }
    })
    .filter(Boolean);
}

function classify(side, label, compiled) {
  const text = String(label || '').toUpperCase();
  const hit = compiled.find((r) => r.side === side && r.re.test(text));
  return hit ? hit.col : FALLBACK[side];
}

// Fill in `col` for lines that don't have a valid one yet. Lines the user
// assigned by hand keep their column.
function classifyLines(lines, compiled, { force = false } = {}) {
  return lines.map((l) => {
    if (VALID[l.side]?.has(l.col) && !(force && !l.manual)) return l;
    return { ...l, col: classify(l.side, l.label, compiled), manual: false };
  });
}

const n = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? 0 : Number(v));
const round2 = (v) => Math.round(v * 100) / 100;

// One day's Excel row, computed the same way the sheet's formulas do.
function computeRow(lines, month) {
  const row = { OB: 0, HSD: 0, HSD_RATE: n(month.hsd_rate), MS: 0, MS_RATE: n(month.ms_rate), LUB: 0, COFFEE: 0, COLL: 0 };
  for (const c of EXPENSE_COLS) row[c.key] = 0;
  let expenseTotal = 0;
  let inflowLinesTotal = 0;

  for (const l of lines) {
    if (l.side === 'in') {
      inflowLinesTotal += n(l.amount);
      if (l.col === 'HSD' || l.col === 'MS') {
        const rate = n(l.rate) || row[`${l.col}_RATE`];
        const units = n(l.unit) || (rate ? n(l.amount) / rate : 0);
        row[l.col] += units;
        if (rate) row[`${l.col}_RATE`] = rate;
      } else {
        row[l.col] = (row[l.col] || 0) + n(l.amount);
      }
    } else {
      expenseTotal += n(l.amount);
      if (l.col !== 'PEXP') row[l.col] = (row[l.col] || 0) + n(l.amount);
    }
  }

  row.HSD = round2(row.HSD);
  row.MS = round2(row.MS);
  row.HSD_AMT = round2(row.HSD * row.HSD_RATE);
  row.MS_AMT = round2(row.MS * row.MS_RATE);
  row.M = round2(expenseTotal);
  row.V = round2(['BANK', 'PTM', 'UPI', 'TSALE', 'FLEET', 'RBABU', 'RANJIT', 'OTHERS'].reduce((s, k) => s + row[k], 0));
  row.PEXP = round2(row.M - row.V);
  row.inflowLinesTotal = round2(inflowLinesTotal);
  return row;
}

module.exports = { INFLOW_COLS, EXPENSE_COLS, DEFAULT_RULES, FALLBACK, compileRules, classify, classifyLines, computeRow, n, round2 };
