// Tally export: turns verified days into vouchers laid out in the company's own Tally import
// template. A day goes to Tally once: exporting locks it, and only an explicit unlock frees it.
const ExcelJS = require('exceljs');
const db = require('./db');
const { buildMonth } = require('./reconcile');
const { n, round2 } = require('./columns');

// Fields a template column can be filled with.
const FIELDS = {
  date: 'Date',
  voucher_type: 'Voucher type',
  voucher_no: 'Voucher number',
  dr_ledger: 'Debit ledger',
  cr_ledger: 'Credit ledger',
  ledger: 'Ledger (one per row, with Dr/Cr)',
  drcr: 'Dr / Cr',
  amount: 'Amount',
  debit: 'Debit amount',
  credit: 'Credit amount',
  qty: 'Quantity (litres)',
  rate: 'Rate',
  narration: 'Narration',
  particulars: 'Particulars (as on the image)',
  company: 'Company',
};

// Guess a field from a template heading.
function guessField(h) {
  const t = String(h || '').toLowerCase().replace(/[^a-z/ ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  if (/^(voucher )?date|^dt$/.test(t)) return 'date';
  if (/voucher ?type|vch ?type/.test(t)) return 'voucher_type';
  if (/voucher ?(no|number)|vch ?no|ref/.test(t)) return 'voucher_no';
  if (/(debit|dr) ?ledger|by ledger|ledger dr/.test(t)) return 'dr_ledger';
  if (/(credit|cr) ?ledger|to ledger|ledger cr/.test(t)) return 'cr_ledger';
  if (/^dr ?\/ ?cr$|^dr cr$|debit ?\/ ?credit|^type$/.test(t)) return 'drcr';
  // Amount headings first: "Ledger Amount" is an amount, not a ledger.
  if (/^debit|dr amount|^dr$|debit amount/.test(t)) return 'debit';
  if (/^credit|cr amount|^cr$|credit amount/.test(t)) return 'credit';
  if (/amount|amt|value/.test(t)) return 'amount';
  if (/ledger|account/.test(t)) return 'ledger';
  if (/qty|quantity|litre|ltr/.test(t)) return 'qty';
  if (/rate|price/.test(t)) return 'rate';
  if (/narration|remark|description|note/.test(t)) return 'narration';
  if (/particular/.test(t)) return 'particulars';
  if (/company/.test(t)) return 'company';
  return '';
}

// Default Tally ledger and voucher type for each sheet column.
const DEFAULT_LEDGERS = {
  HSD: { ledger: 'HSD Sales', voucher: 'Sales' },
  MS: { ledger: 'MS Sales', voucher: 'Sales' },
  LUB: { ledger: 'Lubricant Sales', voucher: 'Sales' },
  COFFEE: { ledger: 'Coffee Sales', voucher: 'Sales' },
  COLL: { ledger: '', voucher: 'Receipt' }, // blank = use the particulars as the ledger
  BANK: { ledger: 'Bank', voucher: 'Contra' },
  PTM: { ledger: 'Paytm', voucher: 'Contra' },
  UPI: { ledger: 'SBI UPI', voucher: 'Contra' },
  TSALE: { ledger: 'Tanker Sale', voucher: 'Payment' },
  FLEET: { ledger: 'Fleet', voucher: 'Payment' },
  RBABU: { ledger: 'Rajeshwar Babu', voucher: 'Payment' },
  RANJIT: { ledger: 'Ranjit Ji', voucher: 'Payment' },
  OTHERS: { ledger: '', voucher: 'Payment' },
  PEXP: { ledger: '', voucher: 'Payment' },
};

// Tally group each column's ledgers go under, for the ledger masters file (Tally's built-in groups).
const DEFAULT_GROUPS = {
  HSD: 'Sales Accounts', MS: 'Sales Accounts', LUB: 'Sales Accounts', COFFEE: 'Sales Accounts',
  COLL: 'Sundry Debtors', BANK: 'Bank Accounts', PTM: 'Bank Accounts', UPI: 'Bank Accounts',
  TSALE: 'Sundry Debtors', FLEET: 'Sundry Debtors', RBABU: 'Sundry Debtors', RANJIT: 'Sundry Debtors',
  OTHERS: 'Sundry Debtors', PEXP: 'Indirect Expenses',
};
const TALLY_GROUPS = ['Sales Accounts', 'Direct Incomes', 'Indirect Incomes', 'Bank Accounts', 'Cash-in-Hand', 'Sundry Debtors',
  'Sundry Creditors', 'Indirect Expenses', 'Direct Expenses', 'Loans & Advances (Asset)', 'Loans (Liability)', 'Current Liabilities', 'Suspense A/c'];

async function readTemplate(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.worksheets[0];
  if (!ws) throw Object.assign(new Error('The Excel file has no sheets'), { status: 400 });
  // Header row: the first row with at least two text cells.
  let headerRow = null;
  for (let r = 1; r <= Math.min(ws.rowCount, 30) && !headerRow; r++) {
    const texts = [];
    ws.getRow(r).eachCell((c) => { if (typeof c.text === 'string' && c.text.trim() && Number.isNaN(Number(c.text))) texts.push(c.text); });
    if (texts.length >= 2) headerRow = r;
  }
  if (!headerRow) throw Object.assign(new Error('Could not find a row of column headings in the first 30 rows'), { status: 400 });
  const headers = [];
  ws.getRow(headerRow).eachCell((c, col) => { if (String(c.text || '').trim()) headers.push({ col, letter: ws.getColumn(col).letter, text: String(c.text).trim() }); });
  return { sheet: ws.name, headerRow, headers };
}

async function getSettings(companyId) {
  const r = await db.query('SELECT company_id, template IS NOT NULL AS has_template, template, template_name, sheet, header_row, columns, ledgers, labels, cash_ledger, format, tally_company, groups FROM tally_settings WHERE company_id=$1', [companyId]);
  const s = r.rows[0] || { company_id: companyId, has_template: false, template: null, columns: {}, ledgers: {}, labels: {}, cash_ledger: 'Cash', format: 'xml', tally_company: null, groups: {} };
  let headers = [];
  if (s.template) {
    try { headers = (await readTemplate(s.template)).headers; } catch { headers = []; }
  }
  const { template, ...rest } = s;
  return { ...rest, format: s.format || 'xml', headers, ledgers: { ...DEFAULT_LEDGERS, ...(s.ledgers || {}) }, groups: { ...DEFAULT_GROUPS, ...(s.groups || {}) }, fields: FIELDS, tallyGroups: TALLY_GROUPS };
}

const pad = (v) => String(v).padStart(2, '0');

// Days in range with their status and lines (whole months are loaded so balances match the sheet).
async function daysInRange(companyId, from, to) {
  const months = (await db.query(
    `SELECT m.*, c.name AS company FROM months m JOIN companies c ON c.id = m.company_id
     WHERE m.company_id=$1 AND make_date(m.year, m.month, 1) >= date_trunc('month', $2::date) AND make_date(m.year, m.month, 1) <= $3::date
     ORDER BY m.year, m.month`, [companyId, from, to])).rows;
  if (!months.length) return [];
  const entries = (await db.query('SELECT id, month_id, day, report_date, lines, printed, status, source, tally_batch_id FROM entries WHERE month_id = ANY($1)', [months.map((m) => m.id)])).rows;
  const out = [];
  for (const m of months) {
    const s = buildMonth(m, entries.filter((e) => e.month_id === m.id));
    for (const e of s.entries) {
      if (!e.day) continue;
      const date = `${m.year}-${pad(m.month)}-${pad(e.day)}`;
      if (date < from || date > to) continue;
      const raw = entries.find((x) => x.id === e.id);
      out.push({ ...e, date, month: m, lines: raw.lines, tally_batch_id: raw.tally_batch_id });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

// One voucher per ledger line of a day (opening cash is a balance, not a voucher).
function vouchersFor(day, settings, prefix) {
  const cash = settings.cash_ledger || 'Cash';
  const list = [];
  let seq = 0;
  const [y, m, d] = day.date.split('-');
  for (const l of day.lines) {
    if (l.col === 'OB') continue;
    const amount = round2(n(l.amount));
    if (!amount) continue;
    const conf = settings.ledgers[l.col] || DEFAULT_LEDGERS[l.col] || { ledger: '', voucher: l.side === 'in' ? 'Receipt' : 'Payment' };
    const labelKey = String(l.label || '').toUpperCase().replace(/\s+/g, ' ').trim();
    const ledger = (settings.labels || {})[labelKey] || conf.ledger || labelKey || (l.side === 'in' ? 'Sundry Receipts' : 'Sundry Expenses');
    const inflow = l.side === 'in';
    seq += 1;
    list.push({
      entryId: day.id,
      col: l.col,
      date: day.date,
      voucher_type: conf.voucher || (inflow ? 'Receipt' : 'Payment'),
      voucher_no: `${prefix}-${y}${m}${d}-${pad(seq)}`,
      dr_ledger: inflow ? cash : ledger,
      cr_ledger: inflow ? ledger : cash,
      amount,
      qty: l.col === 'HSD' || l.col === 'MS' ? n(l.unit) || null : null,
      rate: l.col === 'HSD' || l.col === 'MS' ? n(l.rate) || null : null,
      particulars: l.label,
      narration: `${l.label} — daily report ${d}-${m}-${y}`,
      company: day.month.company,
    });
  }
  return list;
}

function prefixFor(name) {
  const p = String(name || 'CO').split(/\s+/).filter(Boolean).map((w) => w[0]).join('').toUpperCase().slice(0, 4);
  return p || 'CO';
}

// What would go to Tally for a range, and what is left out and why.
async function preview(companyId, from, to, includeErrors) {
  const settings = await getSettings(companyId);
  const company = (await db.query('SELECT name FROM companies WHERE id=$1', [companyId])).rows[0]?.name;
  const days = await daysInRange(companyId, from, to);
  const included = [], unverified = [], exported = [], withErrors = [];
  for (const d of days) {
    if (d.tally_batch_id) exported.push({ date: d.date, entryId: d.id, batch: d.tally_batch_id });
    else if (d.status !== 'verified') unverified.push({ date: d.date, entryId: d.id, errors: d.errors });
    else if (d.errors && !includeErrors) withErrors.push({ date: d.date, entryId: d.id, errors: d.errors });
    else included.push(d);
  }
  const prefix = prefixFor(company);
  const vouchers = included.flatMap((d) => vouchersFor(d, settings, prefix));
  const debit = round2(vouchers.reduce((s, v) => s + v.amount, 0));
  // Ledger names used, so the user can see and correct them before export.
  const ledgers = {};
  for (const v of vouchers) for (const k of [v.dr_ledger, v.cr_ledger]) ledgers[k] = (ledgers[k] || 0) + 1;
  return { company, settings, included: included.map((d) => ({ date: d.date, entryId: d.id })), unverified, exported, withErrors, vouchers, totals: { vouchers: vouchers.length, debit, credit: debit }, ledgers };
}

// Write vouchers into the user's template (or a plain default layout).
async function buildFile(settings, template, vouchers) {
  const wb = new ExcelJS.Workbook();
  let ws, headerRow, columns;
  if (template) {
    await wb.xlsx.load(template);
    ws = wb.getWorksheet(settings.sheet) || wb.worksheets[0];
    headerRow = settings.header_row || 1;
    columns = settings.columns || {};
    // Clear any sample rows under the headings.
    for (let r = ws.rowCount; r > headerRow; r--) ws.spliceRows(r, 1);
  } else {
    ws = wb.addWorksheet('Tally Vouchers');
    const def = [['A', 'Date', 'date'], ['B', 'Voucher Type', 'voucher_type'], ['C', 'Voucher No', 'voucher_no'], ['D', 'Debit Ledger', 'dr_ledger'],
      ['E', 'Credit Ledger', 'cr_ledger'], ['F', 'Amount', 'amount'], ['G', 'Quantity', 'qty'], ['H', 'Rate', 'rate'], ['I', 'Narration', 'narration']];
    headerRow = 1;
    columns = Object.fromEntries(def.map(([c, , f]) => [c, f]));
    def.forEach(([c, h]) => { ws.getCell(`${c}1`).value = h; ws.getCell(`${c}1`).font = { bold: true }; });
    ws.columns = def.map(([, h]) => ({ width: h === 'Narration' ? 50 : h.includes('Ledger') ? 24 : 14 }));
  }
  const used = Object.values(columns);
  // A template with a single ledger column gets two rows per voucher (debit line, then credit line).
  const twoLine = used.includes('ledger') && !used.includes('dr_ledger');
  const toDate = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
  let r = headerRow + 1;
  const put = (v, side) => {
    for (const [letter, field] of Object.entries(columns)) {
      if (!field) continue;
      const cell = ws.getCell(`${letter}${r}`);
      let val = null;
      switch (field) {
        case 'date': val = toDate(v.date); cell.numFmt = 'dd-mm-yyyy'; break;
        case 'ledger': val = side === 'cr' ? v.cr_ledger : v.dr_ledger; break;
        case 'drcr': val = side === 'cr' ? 'Cr' : 'Dr'; break;
        case 'debit': val = !twoLine || side === 'dr' ? v.amount : null; break;
        case 'credit': val = !twoLine || side === 'cr' ? v.amount : null; break;
        default: val = v[field] ?? null;
      }
      cell.value = val;
    }
    r += 1;
  };
  for (const v of vouchers) {
    if (twoLine) { put(v, 'dr'); put(v, 'cr'); } else put(v, null);
  }
  return wb.xlsx.writeBuffer();
}

// --- Tally ERP 9 XML (Gateway of Tally > Import of Data) ---
// Non-ASCII characters become numeric entities, so the file imports whatever Tally's code page.
const xml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]))
  .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, (c) => `&#${c.codePointAt(0)};`);
const amt = (v) => (Math.round(v * 100) / 100).toFixed(2);
function envelope(reportName, company, body) {
  return `<ENVELOPE>
 <HEADER>
  <TALLYREQUEST>Import Data</TALLYREQUEST>
 </HEADER>
 <BODY>
  <IMPORTDATA>
   <REQUESTDESC>
    <REPORTNAME>${reportName}</REPORTNAME>
${company ? `    <STATICVARIABLES>\n     <SVCURRENTCOMPANY>${xml(company)}</SVCURRENTCOMPANY>\n    </STATICVARIABLES>\n` : ''}   </REQUESTDESC>
   <REQUESTDATA>
${body}
   </REQUESTDATA>
  </IMPORTDATA>
 </BODY>
</ENVELOPE>
`;
}
// One accounting voucher per ledger line: Tally shows a debit as a negative amount with
// ISDEEMEDPOSITIVE Yes, and a credit as a positive amount with ISDEEMEDPOSITIVE No.
function buildXml(settings, vouchers) {
  const body = vouchers.map((v) => {
    const date = v.date.replace(/-/g, '');
    const qty = v.qty ? ` (${v.qty} ltr @ ${v.rate})` : '';
    return `    <TALLYMESSAGE xmlns:UDF="TallyUDF">
     <VOUCHER VCHTYPE="${xml(v.voucher_type)}" ACTION="Create" OBJVIEW="Accounting Voucher View">
      <DATE>${date}</DATE>
      <EFFECTIVEDATE>${date}</EFFECTIVEDATE>
      <VOUCHERTYPENAME>${xml(v.voucher_type)}</VOUCHERTYPENAME>
      <VOUCHERNUMBER>${xml(v.voucher_no)}</VOUCHERNUMBER>
      <PERSISTEDVIEW>Accounting Voucher View</PERSISTEDVIEW>
      <ISINVOICE>No</ISINVOICE>
      <NARRATION>${xml(`${v.particulars}${qty} - daily report ${v.date.split('-').reverse().join('-')} - ${v.voucher_no}`)}</NARRATION>
      <ALLLEDGERENTRIES.LIST>
       <LEDGERNAME>${xml(v.dr_ledger)}</LEDGERNAME>
       <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
       <AMOUNT>-${amt(v.amount)}</AMOUNT>
      </ALLLEDGERENTRIES.LIST>
      <ALLLEDGERENTRIES.LIST>
       <LEDGERNAME>${xml(v.cr_ledger)}</LEDGERNAME>
       <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
       <AMOUNT>${amt(v.amount)}</AMOUNT>
      </ALLLEDGERENTRIES.LIST>
     </VOUCHER>
    </TALLYMESSAGE>`;
  }).join('\n');
  return Buffer.from(envelope('Vouchers', settings.tally_company, body), 'utf8');
}
// Ledger masters for every ledger the vouchers use (Tally's own "Cash" ledger is left alone).
function ledgerList(settings, vouchers) {
  const cash = settings.cash_ledger || 'Cash';
  const map = new Map();
  for (const v of vouchers) {
    for (const name of [v.dr_ledger, v.cr_ledger]) {
      if (name === cash || map.has(name)) continue;
      map.set(name, { name, group: settings.groups[v.col] || DEFAULT_GROUPS[v.col] || 'Suspense A/c', col: v.col });
    }
  }
  return [...map.values()].sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name));
}
function buildMastersXml(settings, vouchers) {
  const body = ledgerList(settings, vouchers).map((l) => `    <TALLYMESSAGE xmlns:UDF="TallyUDF">
     <LEDGER NAME="${xml(l.name)}" ACTION="Create">
      <NAME.LIST>
       <NAME>${xml(l.name)}</NAME>
      </NAME.LIST>
      <PARENT>${xml(l.group)}</PARENT>
      <ISBILLWISEON>No</ISBILLWISEON>
      <AFFECTSSTOCK>No</AFFECTSSTOCK>
     </LEDGER>
    </TALLYMESSAGE>`).join('\n');
  return Buffer.from(envelope('All Masters', settings.tally_company, body), 'utf8');
}

// Ledger masters for every verified day in a range (sent to Tally already or not).
async function mastersFile(companyId, from, to) {
  const settings = await getSettings(companyId);
  const company = (await db.query('SELECT name FROM companies WHERE id=$1', [companyId])).rows[0]?.name;
  const days = (await daysInRange(companyId, from, to)).filter((d) => d.status === 'verified');
  const vouchers = days.flatMap((d) => vouchersFor(d, settings, prefixFor(company)));
  return { company, ledgers: ledgerList(settings, vouchers), file: buildMastersXml(settings, vouchers) };
}

// Create a batch: lock the days first (only ones still unlocked), then build the file from exactly those.
async function exportBatch(companyId, from, to, includeErrors) {
  const pv = await preview(companyId, from, to, includeErrors);
  if (!pv.included.length) throw Object.assign(new Error('Nothing to export: no verified days in this range that have not been sent already'), { status: 400 });
  const ids = pv.included.map((d) => d.entryId);
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const b = await client.query(
      `INSERT INTO tally_batches (company_id, date_from, date_to, entry_ids, vouchers, file, file_name, summary)
       VALUES ($1,$2,$3,$4,$5,'\\x',$6,$7) RETURNING id`,
      [companyId, from, to, ids, pv.totals.vouchers, 'pending.xlsx', JSON.stringify({ totals: pv.totals, days: pv.included.map((d) => d.date) })]);
    const batchId = b.rows[0].id;
    const locked = await client.query('UPDATE entries SET tally_batch_id=$1 WHERE id = ANY($2) AND tally_batch_id IS NULL AND status = $3 RETURNING id', [batchId, ids, 'verified']);
    if (locked.rowCount !== ids.length) throw Object.assign(new Error('Some days changed or were exported by someone else while preparing. Refresh and try again.'), { status: 409 });
    const asXml = (pv.settings.format || 'xml') === 'xml';
    let file;
    if (asXml) file = buildXml(pv.settings, pv.vouchers);
    else {
      const tpl = (await client.query('SELECT template FROM tally_settings WHERE company_id=$1', [companyId])).rows[0]?.template || null;
      file = Buffer.from(await buildFile(pv.settings, tpl, pv.vouchers));
    }
    const name = `${pv.company} Tally vouchers ${from} to ${to} (batch ${batchId}).${asXml ? 'xml' : 'xlsx'}`.replace(/[^\w .()-]+/g, '_');
    await client.query('UPDATE tally_batches SET file=$2, file_name=$3 WHERE id=$1', [batchId, file, name]);
    await client.query('COMMIT');
    return { batchId, name, vouchers: pv.totals.vouchers, days: ids.length };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { FIELDS, DEFAULT_LEDGERS, DEFAULT_GROUPS, TALLY_GROUPS, guessField, readTemplate, getSettings, preview, buildFile, buildXml, buildMastersXml, ledgerList, mastersFile, exportBatch };
