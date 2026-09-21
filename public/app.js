const $ = (s) => document.querySelector(s);
const state = { companies: [], companyId: null, months: [], monthId: null, summary: null, meta: null, entry: null, zoom: 1 };

const fmt = (v, d = 2) => (v === null || v === undefined || v === '' || Number(v) === 0 ? '' : Number(v).toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d }));
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const toast = (msg) => { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 3500); };

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: opts.body && !(opts.body instanceof FormData) ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body && !(opts.body instanceof FormData) ? JSON.stringify(opts.body) : opts.body,
  });
  if (res.status === 401 && path !== '/api/login') { $('#loginDlg').showModal(); throw new Error('Please sign in'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// ---------- companies ----------
const company = () => state.companies.find((c) => c.id === state.companyId);
async function loadCompanies(selectId) {
  state.companies = await api('/api/companies');
  const sel = $('#companySelect');
  sel.innerHTML = state.companies.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  const saved = Number(localStorage.getItem('companyId'));
  state.companyId = selectId || (state.companies.find((c) => c.id === saved) ? saved : state.companies[0]?.id) || null;
  const has = !!state.companyId;
  $('#noCompany').classList.toggle('hidden', has);
  for (const id of ['#companySelect', '#companySettingsBtn', '#tabs']) $(id).classList.toggle('hidden', !has);
  const opts = `<option value="">All companies</option>` + state.companies.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  for (const id of ['#repCompany', '#ledCompany']) { $(id).innerHTML = opts; $(id).value = state.companyId || ''; }
  if (!has) {
    for (const id of ['#empty', '#dashboard', '#monthBar', '#reportsView', '#ledgerView']) $(id).classList.add('hidden');
    return;
  }
  sel.value = state.companyId;
  localStorage.setItem('companyId', state.companyId);
  await loadMonths();
  showTab(state.tab || 'sheet');
}

// ---------- sidebar menu ----------
function showTab(tab) {
  state.tab = tab;
  document.querySelectorAll('#tabs [data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  const sheet = tab === 'sheet';
  $('#monthBar').classList.toggle('hidden', !sheet);
  $('#empty').classList.toggle('hidden', !sheet || !!state.monthId);
  $('#dashboard').classList.toggle('hidden', !sheet || !state.monthId);
  $('#reportsView').classList.toggle('hidden', tab !== 'reports');
  $('#ledgerView').classList.toggle('hidden', tab !== 'ledger');
  $('#side').classList.remove('open');
  if (tab === 'reports' && !state.reportLoaded) { state.reportLoaded = true; setRange($('#reportForm'), 'fy'); runReport(); }
  if (tab === 'ledger' && !state.ledgerLoaded) { state.ledgerLoaded = true; setRange($('#ledgerForm'), 'month'); runLedger(); }
}
document.querySelectorAll('#tabs [data-tab]').forEach((b) => { b.onclick = () => showTab(b.dataset.tab); });
$('#menuBtn').onclick = () => $('#side').classList.toggle('open');
$('#sideShade').onclick = () => $('#side').classList.remove('open');
$('#logoutBtn').onclick = async () => { await api('/api/logout', { method: 'POST' }); location.reload(); };
$('#companySelect').onchange = (e) => { state.companyId = Number(e.target.value); state.monthId = null; loadCompanies(state.companyId); };

function openCompany(edit) {
  const f = $('#companyForm');
  f.reset();
  f.dataset.edit = edit ? state.companyId : '';
  $('#companyDlgTitle').textContent = edit ? 'Company settings' : 'New company';
  f.querySelectorAll('.only-edit').forEach((e) => e.classList.toggle('hidden', !edit));
  if (edit) f.name.value = company().name;
  $('#companyDlg').showModal();
}
$('#newCompanyBtn').onclick = () => openCompany(false);
$('#companySettingsBtn').onclick = () => openCompany(true);
$('#companyForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  try {
    const c = f.dataset.edit
      ? await api(`/api/companies/${f.dataset.edit}`, { method: 'PATCH', body: { name: f.name.value } })
      : await api('/api/companies', { method: 'POST', body: { name: f.name.value } });
    $('#companyDlg').close();
    await loadCompanies(c.id);
  } catch (e) { toast(e.message); }
});
$('#deleteCompany').onclick = async () => {
  if (!confirm(`Delete ${company().name} with all its months and images? This cannot be undone.`)) return;
  await api(`/api/companies/${state.companyId}`, { method: 'DELETE' });
  $('#companyDlg').close();
  localStorage.removeItem('companyId');
  await loadCompanies();
};

// ---------- months ----------
async function loadMonths(selectId) {
  state.months = await api(`/api/months?company_id=${state.companyId}`);
  $('#emptyCompany').textContent = company()?.name || '';
  const sel = $('#monthSelect');
  sel.innerHTML = state.months.map((m) => `<option value="${m.id}">${esc(m.title)}</option>`).join('');
  const saved = Number(localStorage.getItem(`monthId:${state.companyId}`));
  state.monthId = selectId || (state.months.find((m) => m.id === saved) ? saved : state.months[0]?.id) || null;
  if (state.monthId) sel.value = state.monthId;
  for (const id of ['#monthSelect', '#monthSettingsBtn', '#exportBtn']) $(id).classList.toggle('hidden', !state.monthId);
  if (state.monthId) await loadSummary();
  showTab(state.tab || 'sheet');
}

async function loadSummary() {
  localStorage.setItem(`monthId:${state.companyId}`, state.monthId);
  state.summary = await api(`/api/months/${state.monthId}/summary`);
  state.reportLoaded = state.ledgerLoaded = false; // figures changed; refresh those views on next visit
  $('#exportBtn').href = `/api/months/${state.monthId}/export.xlsx`;
  renderSummary();
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec'];
function openNewMonth() {
  const f = $('#monthForm');
  f.reset();
  f.dataset.edit = '';
  $('#monthDlgTitle').textContent = 'New month';
  f.querySelectorAll('.only-edit').forEach((e) => e.classList.add('hidden'));
  const now = new Date();
  f.year.value = now.getFullYear();
  f.month.value = now.getMonth() + 1;
  const last = state.months[0];
  f.hsd_rate.value = last?.hsd_rate ?? 99.76;
  f.ms_rate.value = last?.ms_rate ?? 113.77;
  f.title.value = `${company().name}-${MONTHS[now.getMonth()]}-${String(now.getFullYear()).slice(2)}`;
  f.year.disabled = f.month.disabled = false;
  $('#monthDlg').showModal();
}
function openMonthSettings() {
  const m = state.summary.month;
  const f = $('#monthForm');
  f.dataset.edit = m.id;
  $('#monthDlgTitle').textContent = 'Month settings';
  f.querySelectorAll('.only-edit').forEach((e) => e.classList.remove('hidden'));
  for (const k of ['title', 'year', 'month', 'hsd_rate', 'ms_rate', 'total_ob', 'hsd_cost', 'ms_cost']) f[k].value = m[k] ?? '';
  f.year.disabled = f.month.disabled = true;
  $('#monthDlg').showModal();
}
$('#monthForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  const body = Object.fromEntries(['title', 'year', 'month', 'hsd_rate', 'ms_rate', 'total_ob', 'hsd_cost', 'ms_cost'].map((k) => [k, f[k].value]));
  try {
    if (f.dataset.edit) {
      await api(`/api/months/${f.dataset.edit}`, { method: 'PATCH', body });
      $('#monthDlg').close();
      await loadMonths(Number(f.dataset.edit));
    } else {
      const m = await api('/api/months', { method: 'POST', body: { ...body, company_id: state.companyId, year: Number(body.year), month: Number(body.month) } });
      $('#monthDlg').close();
      await loadMonths(m.id);
    }
  } catch (e) { toast(e.message); }
});
$('#deleteMonth').onclick = async () => {
  if (!confirm('Delete this month and all its uploaded images? This cannot be undone.')) return;
  await api(`/api/months/${state.monthId}`, { method: 'DELETE' });
  $('#monthDlg').close();
  localStorage.removeItem(`monthId:${state.companyId}`);
  await loadMonths();
};
$('#newMonthBtn').onclick = openNewMonth;
$('#monthSettingsBtn').onclick = openMonthSettings;
$('#monthSelect').onchange = (e) => { state.monthId = Number(e.target.value); loadSummary(); };

// ---------- dashboard ----------
const badge = (s, text) => `<span class="badge b-${s}">${esc(text || s)}</span>`;
const checkLi = (c) => `<li>${badge(c.status)}<div><div>${esc(c.label)}</div><div class="d">${
  c.detail ? esc(c.detail) : `Image ${fmt(c.expected) || '0'} · Calculated ${fmt(c.actual) || '0'} · Difference ${fmt(c.diff) || '0'}`}</div></div></li>`;

const COLS = [
  ['A', 'Date'], ['B', 'OB', 'openingUsed'], ['C', 'HSD', 'HSD', 'in'], ['D', 'Rate', 'HSD_RATE', 'in'], ['E', 'Amt', 'HSD_AMT', 'in'],
  ['F', 'MS', 'MS', 'in'], ['G', 'Rate', 'MS_RATE', 'in'], ['H', 'Amt', 'MS_AMT', 'in'], ['I', 'Lub', 'LUB', 'in'], ['J', 'Cofee', 'COFFEE', 'in'],
  ['K', 'Collection', 'COLL', 'in'], ['L', 'Total', 'L'], ['M', 'T-Exp', 'M', 'out'], ['N', 'Bank', 'BANK', 'out'], ['O', 'PTM', 'PTM', 'out'],
  ['P', 'UPI', 'UPI', 'out'], ['Q', 'T-Sale', 'TSALE', 'out'], ['R', 'Fleet', 'FLEET', 'out'], ['S', 'R-Babu', 'RBABU', 'out'],
  ['T', 'Ranjit', 'RANJIT', 'out'], ['U', 'Others', 'OTHERS', 'out'], ['V', 'Total', 'V', 'out'], ['W', 'P-Exp', 'PEXP', 'out'],
  ['X', 'Total', 'M', 'out'], ['Y', 'Balance', 'closing'],
];

function renderSummary() {
  const s = state.summary;
  $('#sheetTitle').textContent = s.month.title;
  $('#monthChecks').innerHTML = s.monthChecks.map(checkLi).join('');
  const t = s.totals;
  $('#totalsStrip').innerHTML = [
    ['HSD litres', t.HSD], ['HSD amount', t.HSD_AMT], ['MS litres', t.MS], ['MS amount', t.MS_AMT], ['Collection', t.COLL],
    ['Total expenses', t.M], ['Bank', t.BANK], ['PTM', t.PTM], ['UPI', t.UPI], ['Ranjit', t.RANJIT], ['P-Exp', t.PEXP], ['Closing balance', t.closing],
  ].map(([k, v]) => `<div><span>${k}</span><b>${fmt(v) || '0.00'}</b></div>`).join('');

  const byDay = new Map();
  for (const e of s.entries) if (e.day) (byDay.get(e.day) || byDay.set(e.day, []).get(e.day)).push(e);
  const head = `<thead><tr>${COLS.map(([, h, , g]) => `<th class="${g ? `grp-${g}` : ''}">${h}</th>`).join('')}<th>Status</th></tr></thead>`;
  let body = '';
  const rowHtml = (e, label) => `<tr data-id="${e.id}" class="${e.errors ? 'err' : ''}">${COLS.map(([c, , k]) => `<td>${c === 'A' ? label : fmt(e.row[k])}</td>`).join('')}
    <td class="status">${e.source === 'manual' ? badge('skip', 'manual') : ''} ${badge(e.status, e.status === 'verified' ? 'verified' : 'review')} ${e.errors ? badge('error', `${e.errors} mismatch`) : ''} ${e.warnings ? badge('warn', `${e.warnings} warn`) : ''}</td></tr>`;
  for (let d = 1; d <= s.daysInMonth; d++) {
    const list = byDay.get(d);
    if (!list) body += `<tr class="missing"><td>${d}</td><td colspan="${COLS.length - 1}" style="text-align:left">No image uploaded</td><td class="status">${badge('missing')}</td></tr>`;
    else body += list.map((e) => rowHtml(e, d)).join('');
  }
  for (const e of s.entries.filter((x) => !x.day)) body += rowHtml(e, '?');
  const foot = `<tfoot><tr>${COLS.map(([c, , k]) => {
    if (c === 'A') return '<td>Total</td>';
    if (c === 'B') return `<td>${fmt(t.OB)}</td>`;
    if (c === 'L') return `<td>${fmt(t.inflow)}</td>`;
    if (c === 'Y') return `<td>${fmt(t.closing)}</td>`;
    if (c === 'D' || c === 'G') return '<td></td>';
    return `<td>${fmt(t[k])}</td>`;
  }).join('')}<td></td></tr></tfoot>`;
  $('#sheet').innerHTML = head + `<tbody>${body}</tbody>` + foot;
  $('#sheet').querySelectorAll('tbody tr[data-id]').forEach((tr) => { tr.onclick = () => openReview(Number(tr.dataset.id)); });
}

// ---------- upload ----------
const drop = $('#drop');
['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => uploadFiles([...e.dataTransfer.files].filter((f) => f.type.startsWith('image/'))));
$('#fileInput').onchange = (e) => { uploadFiles([...e.target.files]); e.target.value = ''; };

let uploading = Promise.resolve();
function uploadFiles(files) {
  const monthId = state.monthId;
  for (const file of files) {
    const li = document.createElement('li');
    li.innerHTML = `<span>${esc(file.name)}</span><span class="st muted">waiting…</span>`;
    $('#queue').prepend(li);
    const st = li.querySelector('.st');
    // One at a time: each image takes a while to read and the queue shows progress.
    uploading = uploading.then(async () => {
      st.textContent = 'reading image…';
      const fd = new FormData();
      fd.append('image', file);
      try {
        const r = await api(`/api/months/${monthId}/upload`, { method: 'POST', body: fd });
        if (r.skipped) st.innerHTML = badge('skip', 'skipped') + ' ' + esc(r.reason);
        else st.innerHTML = r.warning ? `${badge('warn', `day ${r.day ?? '?'}`)} ${esc(r.warning)}` : badge('ok', `day ${r.day}`);
        if (monthId === state.monthId) await loadSummary();
      } catch (e) {
        st.innerHTML = badge('error', 'failed') + ' ' + esc(e.message);
      }
    });
  }
}

$('#manualBtn').onclick = async () => {
  const day = Number($('#manualDay').value);
  if (!day) return toast('Enter the day number first');
  const existing = state.summary.entries.find((e) => e.day === day);
  if (existing && !confirm(`Day ${day} already has an entry. Add another one anyway?`)) return openReview(existing.id);
  try {
    const r = await api(`/api/months/${state.monthId}/manual`, { method: 'POST', body: { day } });
    $('#manualDay').value = '';
    await loadSummary();
    await openReview(r.id);
  } catch (e) { toast(e.message); }
};

// ---------- review ----------
const reviewDlg = $('#review');
async function openReview(id) {
  const e = await api(`/api/entries/${id}`);
  state.entry = { ...e, lines: e.lines.map((l) => ({ ...l })), remember: new Set() };
  $('#reviewTitle').textContent = e.day ? `Day ${e.day}` : 'Undated image';
  $('#reviewImg').classList.toggle('hidden', !e.has_image);
  $('#noImg').classList.toggle('hidden', e.has_image);
  $('#imgOpen').classList.toggle('hidden', !e.has_image);
  $('#rReextract').classList.toggle('hidden', !e.has_image);
  if (e.has_image) { $('#reviewImg').src = `/api/entries/${id}/image`; $('#imgOpen').href = `/api/entries/${id}/image`; }
  setZoom(1);
  $('#rDay').value = e.day ?? '';
  $('#rDate').value = e.report_date ?? '';
  $('#rTin').value = e.printed.total_inflow ?? '';
  $('#rTex').value = e.printed.total_expense ?? '';
  $('#rCash').value = e.printed.cash_in_hand ?? '';
  const n = e.notes || {};
  $('#rNotes').textContent = [n.stock_atg && `Stock ATG: ${n.stock_atg}`, n.stock_manual && `Stock manual: ${n.stock_manual}`, n.paytm12 && `PAYTM 12: ${fmt(n.paytm12)}`,
    n.unreadable?.length && `Hard to read: ${n.unreadable.join(', ')}`].filter(Boolean).join(' · ');
  renderLines();
  renderComputed(e.computed);
  if (!reviewDlg.open) reviewDlg.showModal();
}

function colOptions(side, sel) {
  const cols = side === 'in' ? state.meta.inflowCols : state.meta.expenseCols;
  return cols.map((c) => `<option value="${c.key}" ${c.key === sel ? 'selected' : ''}>${esc(c.label)}</option>`).join('');
}
function renderLines() {
  for (const side of ['in', 'out']) {
    const rows = state.entry.lines.filter((l) => l.side === side);
    const head = side === 'in'
      ? '<tr><th>Details</th><th>Unit</th><th>Rate</th><th>Amount</th><th>Column</th><th></th><th></th></tr>'
      : '<tr><th>Particulars</th><th>Amount</th><th>Column</th><th></th><th></th></tr>';
    $(side === 'in' ? '#inLines' : '#outLines').innerHTML = head + rows.map((l) => `
      <tr data-lid="${l.id}" class="${l.manual ? 'changed' : ''}">
        <td><input data-f="label" value="${esc(l.label)}"></td>
        ${side === 'in' ? `<td class="unit"><input data-f="unit" type="number" step="0.01" value="${l.unit ?? ''}"></td><td class="unit"><input data-f="rate" type="number" step="0.01" value="${l.rate ?? ''}"></td>` : ''}
        <td class="num"><input data-f="amount" type="number" step="0.01" value="${l.amount ?? ''}"></td>
        <td><select data-f="col">${colOptions(side, l.col)}</select></td>
        <td>${l.manual ? `<label class="small" title="Use this column for this label on future images"><input type="checkbox" data-remember ${state.entry.remember.has(l.id) ? 'checked' : ''} style="width:auto"> remember</label>` : ''}</td>
        <td><button class="ghost small" data-del title="Remove line">✕</button></td>
      </tr>`).join('');
  }
  liveSums();
}
function lineById(id) { return state.entry.lines.find((l) => l.id === id); }
for (const tbl of ['#inLines', '#outLines']) {
  $(tbl).addEventListener('input', (ev) => {
    const tr = ev.target.closest('tr[data-lid]');
    if (!tr) return;
    const l = lineById(Number(tr.dataset.lid));
    if (ev.target.dataset.remember !== undefined) {
      ev.target.checked ? state.entry.remember.add(l.id) : state.entry.remember.delete(l.id);
      return;
    }
    const f = ev.target.dataset.f;
    l[f] = ev.target.value;
    if (f === 'col') { l.manual = true; renderLines(); } else liveSums();
  });
  $(tbl).addEventListener('click', (ev) => {
    if (ev.target.dataset.del === undefined) return;
    const id = Number(ev.target.closest('tr').dataset.lid);
    state.entry.lines = state.entry.lines.filter((l) => l.id !== id);
    renderLines();
  });
}
document.querySelectorAll('[data-add]').forEach((b) => b.onclick = () => {
  const id = Math.max(0, ...state.entry.lines.map((l) => l.id)) + 1;
  state.entry.lines.push({ id, side: b.dataset.add, label: '', unit: null, rate: null, amount: null, col: null });
  renderLines();
});
function liveSums() {
  const sum = (side) => state.entry.lines.filter((l) => l.side === side).reduce((s, l) => s + (Number(l.amount) || 0), 0);
  const i = sum('in'), o = sum('out');
  $('#liveSums').textContent = `Lines add up to: inflow ${fmt(i) || 0} · expenses ${fmt(o) || 0} · cash in hand ${fmt(i - o) || 0} (Save to re-run the checks)`;
}
function renderComputed(c) {
  $('#rChecks').innerHTML = c ? c.checks.map(checkLi).join('') : '';
  if (!c) { $('#rRow').innerHTML = ''; return; }
  const r = c.row;
  $('#rRow').innerHTML = [['OB', r.openingUsed], ['HSD', r.HSD], ['Rate', r.HSD_RATE], ['MS', r.MS], ['Rate', r.MS_RATE], ['Lub', r.LUB], ['Cofee', r.COFFEE], ['Collection', r.COLL],
    ['T-Exp', r.M], ['Bank', r.BANK], ['PTM', r.PTM], ['UPI', r.UPI], ['T-Sale', r.TSALE], ['Fleet', r.FLEET], ['R-Babu', r.RBABU], ['Ranjit', r.RANJIT], ['Others', r.OTHERS], ['P-Exp', r.PEXP], ['Balance', r.closing]]
    .filter(([, v]) => Number(v)).map(([k, v]) => `<div><b>${k}</b>${fmt(v)}</div>`).join('');
}

async function saveEntry(status) {
  const e = state.entry;
  const num = (v) => (v === '' ? null : Number(v));
  await api(`/api/entries/${e.id}`, {
    method: 'PUT',
    body: {
      day: num($('#rDay').value), report_date: $('#rDate').value, lines: e.lines, status,
      printed: { total_inflow: num($('#rTin').value), total_expense: num($('#rTex').value), cash_in_hand: num($('#rCash').value) },
      remember: [...e.remember],
    },
  });
  await loadSummary();
  await openReview(e.id);
  toast(status === 'verified' ? 'Saved and marked verified' : 'Saved');
}
$('#rSave').onclick = () => saveEntry(state.entry.status).catch((e) => toast(e.message));
$('#rVerify').onclick = async () => {
  const errs = state.summary.entries.find((x) => x.id === state.entry.id)?.errors;
  if (errs && !confirm('This image still has mismatches. Mark it verified anyway?')) return;
  saveEntry('verified').catch((e) => toast(e.message));
};
$('#rDelete').onclick = async () => {
  if (!confirm('Delete this image and its data?')) return;
  await api(`/api/entries/${state.entry.id}`, { method: 'DELETE' });
  reviewDlg.close();
  await loadSummary();
};
$('#rReextract').onclick = async (ev) => {
  if (!confirm('Read the image again? Your edits to this day will be replaced.')) return;
  ev.target.disabled = true; ev.target.textContent = 'Reading…';
  try {
    const r = await api(`/api/entries/${state.entry.id}/reextract`, { method: 'POST' });
    if (r.warning) toast(r.warning);
    await loadSummary(); await openReview(state.entry.id);
  } catch (e) { toast(e.message); } finally { ev.target.disabled = false; ev.target.textContent = 'Re-read image'; }
};
$('#rReclass').onclick = async () => {
  await api(`/api/entries/${state.entry.id}/reclassify`, { method: 'POST' });
  await loadSummary(); await openReview(state.entry.id);
  toast('Rules re-applied (hand-picked columns kept)');
};
function stepDay(dir) {
  const list = state.summary.entries;
  const i = list.findIndex((x) => x.id === state.entry.id);
  const next = list[i + dir];
  if (next) openReview(next.id);
}
$('#prevDay').onclick = () => stepDay(-1);
$('#nextDay').onclick = () => stepDay(1);

function setZoom(z) {
  state.zoom = Math.min(4, Math.max(1, z));
  $('#reviewImg').style.width = `${state.zoom * 100}%`;
}
document.querySelectorAll('[data-zoom]').forEach((b) => b.onclick = () => {
  const d = Number(b.dataset.zoom);
  setZoom(d === 0 ? 1 : state.zoom + d * 0.5);
});

// ---------- rules ----------
async function openRules() {
  const rules = await api(`/api/rules?company_id=${state.companyId}`);
  $('#rulesCompany').textContent = company().name;
  const label = (side, key) => (side === 'in' ? state.meta.inflowCols : state.meta.expenseCols).find((c) => c.key === key)?.label || key;
  $('#rulesTable').innerHTML = '<tr><th>Side</th><th>Priority</th><th>Pattern</th><th>Column</th><th></th></tr>' + rules.map((r) => `
    <tr><td>${r.side === 'in' ? 'Inflow' : 'Expense'}</td><td>${r.priority}</td><td><code>${esc(r.pattern)}</code></td><td>${esc(label(r.side, r.col))}</td>
    <td><button class="ghost small danger" data-rule="${r.id}">Delete</button></td></tr>`).join('');
  $('#rulesTable').querySelectorAll('[data-rule]').forEach((b) => b.onclick = async () => {
    await api(`/api/rules/${b.dataset.rule}`, { method: 'DELETE' });
    openRules();
  });
  syncRuleCols();
  if (!$('#rulesDlg').open) $('#rulesDlg').showModal();
}
function syncRuleCols() {
  const side = $('#ruleForm').side.value;
  $('#ruleCol').innerHTML = colOptions(side);
}
$('#ruleForm').side.onchange = syncRuleCols;
$('#ruleForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  try {
    await api('/api/rules', { method: 'POST', body: { company_id: state.companyId, side: f.side.value, pattern: f.pattern.value, col: f.col.value, priority: Number(f.priority.value) } });
    f.pattern.value = '';
    openRules();
  } catch (e) { toast(e.message); }
});
$('#rulesBtn').onclick = () => openRules().catch((e) => toast(e.message));

// ---------- login + boot ----------
$('#loginForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  try {
    await api('/api/login', { method: 'POST', body: { password: ev.target.password.value } });
    $('#loginDlg').close();
    $('#logoutBtn').classList.remove('hidden');
    boot();
  } catch (e) { $('#loginErr').textContent = e.message; }
});

async function boot() {
  try {
    state.meta = await api('/api/meta');
    $('#ledCol').innerHTML = '<option value="">All columns</option>' + [...state.meta.inflowCols.filter((c) => c.key !== 'OB'), ...state.meta.expenseCols]
      .map((c) => `<option value="${c.key}">${esc(c.label)}</option>`).join('');
    await loadCompanies();
  } catch (e) { if (!$('#loginDlg').open) toast(e.message); }
}
boot();

// ---------- date ranges ----------
const d2 = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function setRange(form, kind) {
  // Anchor on the selected month when there is one, else today.
  const m = state.summary?.month;
  const now = m ? new Date(m.year, m.month - 1, 1) : new Date();
  const y = now.getFullYear(), mo = now.getMonth();
  const fyStart = mo >= 3 ? y : y - 1;
  let from, to;
  if (kind === 'month') { from = new Date(y, mo, 1); to = new Date(y, mo + 1, 0); }
  if (kind === 'quarter') { const q = Math.floor(((mo - 3 + 12) % 12) / 3); from = new Date(fyStart, 3 + q * 3, 1); to = new Date(fyStart, 6 + q * 3, 0); }
  if (kind === 'half') { const h = ((mo - 3 + 12) % 12) < 6 ? 0 : 1; from = new Date(fyStart, 3 + h * 6, 1); to = new Date(fyStart, 9 + h * 6, 0); }
  if (kind === 'fy') { from = new Date(fyStart, 3, 1); to = new Date(fyStart + 1, 2, 31); }
  form.from.value = from ? d2(from) : '';
  form.to.value = to ? d2(to) : '';
}
const qs = (form) => new URLSearchParams([...new FormData(form).entries()].filter(([, v]) => v !== '')).toString();

// ---------- reports ----------
$('#reportForm').addEventListener('submit', (ev) => { ev.preventDefault(); runReport(); });
$('#reportForm').querySelectorAll('[data-range]').forEach((b) => { b.onclick = () => { setRange($('#reportForm'), b.dataset.range); runReport(); }; });

const REP_COLS = [
  ['Days', 'days', 0], ['HSD ltr', 'HSD'], ['HSD sale', 'HSD_AMT'], ['MS ltr', 'MS'], ['MS sale', 'MS_AMT'], ['Lub', 'LUB'], ['Cofee', 'COFFEE'],
  ['Collection', 'COLL'], ['T-Exp', 'M'], ['Bank', 'BANK'], ['PTM', 'PTM'], ['UPI', 'UPI'], ['T-Sale', 'TSALE'], ['Fleet', 'FLEET'],
  ['R-Babu', 'RBABU'], ['Ranjit', 'RANJIT'], ['Others', 'OTHERS'], ['P-Exp', 'PEXP'], ['Opening', 'opening'], ['Closing', 'closing'],
];
const money = (v) => { const s = fmt(v) || '0.00'; return Number(v) < 0 ? `<span class="neg">${s}</span>` : s; };

async function runReport() {
  const form = $('#reportForm');
  const q = qs(form);
  $('#reportXlsx').href = `/api/reports/export.xlsx?${q}`;
  $('#reportOut').innerHTML = '<div class="card muted">Loading…</div>';
  try {
    const r = await api(`/api/reports?${q}`);
    const all = !form.company_id.value;
    const t = r.total;
    if (!r.rows.length) { $('#reportOut').innerHTML = '<div class="card muted">No days entered in this range yet.</div>'; return; }
    const colName = (row) => (all ? `${row.label}<br><span class="muted small">${esc(row.company)}</span>` : row.label);

    const tiles = [['Total sales', t.pl.sales], ['Gross profit', t.pl.gross], ['Operating expenses', t.pl.expenses], ['Net profit', t.pl.net],
      ['HSD litres', t.HSD], ['MS litres', t.MS], ['Deposited (Bank+PTM+UPI)', t.cash.deposits], ['Party / credit', t.cash.parties]]
      .map(([k, v]) => `<div><span>${k}</span><b>${money(v)}</b></div>`).join('');

    const plRow = (label, get, cls = '') => `<tr class="${cls}"><td>${label}</td>${r.rows.map((x) => `<td>${money(get(x.pl))}</td>`).join('')}<td>${money(get(t.pl))}</td></tr>`;
    const costNote = t.pl.costMissingDays
      ? `<div class="note">Purchase cost per litre is missing for ${t.pl.costMissingDays} day(s), so gross profit there counts fuel at zero cost. Set “HSD/MS purchase cost” in each month's settings.</div>` : '';
    const pl = `<div class="card"><h3>Profit &amp; Loss</h3>${costNote}<div class="table-wrap"><table class="pl">
      <thead><tr><th>Particulars</th>${r.rows.map((x) => `<th>${colName(x)}</th>`).join('')}<th>Total</th></tr></thead><tbody>
      ${plRow('HSD sales', (p) => p.hsdSales)}${plRow('MS sales', (p) => p.msSales)}${plRow('Lube', (p) => p.lube)}${plRow('Coffee', (p) => p.coffee)}
      ${plRow('Total sales', (p) => p.sales, 'sub')}
      ${plRow('Less: HSD purchase cost', (p) => p.hsdCost)}${plRow('Less: MS purchase cost', (p) => p.msCost)}
      ${plRow('Gross profit', (p) => p.gross, 'sub')}
      ${plRow('Less: operating expenses (P-Exp)', (p) => p.expenses)}
      ${plRow('Net profit', (p) => p.net, 'net')}
      </tbody></table></div></div>`;

    const summary = `<div class="card"><h3>Summary by ${esc(form.group.selectedOptions[0].text.toLowerCase())}</h3><div class="table-wrap"><table class="sheet">
      <thead><tr><th>Period</th>${all ? '<th>Company</th>' : ''}${REP_COLS.map(([h]) => `<th>${h}</th>`).join('')}</tr></thead>
      <tbody>${r.rows.map((x) => `<tr><td>${esc(x.label)}</td>${all ? `<td style="text-align:left">${esc(x.company)}</td>` : ''}${REP_COLS.map(([, k, d]) => `<td>${fmt(x[k], d ?? 2)}</td>`).join('')}</tr>`).join('')}</tbody>
      <tfoot><tr><td>Total</td>${all ? '<td></td>' : ''}${REP_COLS.map(([, k, d]) => `<td>${k === 'opening' || k === 'closing' ? '' : fmt(t[k], d ?? 2)}</td>`).join('')}</tr></tfoot>
      </table></div></div>`;

    const companies = all && r.companies.length > 1 ? `<div class="card"><h3>Company-wise</h3><div class="table-wrap"><table class="pl">
      <thead><tr><th>Company</th><th>Days</th><th>Sales</th><th>Gross profit</th><th>Op. expenses</th><th>Net profit</th><th>Deposited</th></tr></thead><tbody>
      ${r.companies.map((c) => `<tr><td>${esc(c.company)}</td><td>${c.days}</td><td>${money(c.pl.sales)}</td><td>${money(c.pl.gross)}</td><td>${money(c.pl.expenses)}</td><td>${money(c.pl.net)}</td><td>${money(c.cash.deposits)}</td></tr>`).join('')}
      </tbody></table></div></div>` : '';

    const exp = t.pl.expenseLines;
    const expenses = `<div class="card"><h3>Operating expenses by head</h3><div class="table-wrap" style="max-height:420px"><table class="pl">
      <thead><tr><th>Particulars</th><th>Amount</th><th>Share</th></tr></thead><tbody>
      ${exp.map((e) => `<tr><td>${esc(e.label)}</td><td>${money(e.amount)}</td><td>${t.pl.expenses ? ((e.amount / t.pl.expenses) * 100).toFixed(1) : 0}%</td></tr>`).join('') || '<tr><td colspan="3" class="muted">None</td></tr>'}
      </tbody></table></div></div>`;

    $('#reportOut').innerHTML = `<div class="card"><div class="muted small">${esc(r.from || '')} to ${esc(r.to || '')} · ${t.days} day(s), ${t.verified} verified</div><div class="totals">${tiles}</div></div>${pl}${companies}${summary}${expenses}`;
  } catch (e) { $('#reportOut').innerHTML = `<div class="card err">${esc(e.message)}</div>`; }
}

// ---------- ledger ----------
$('#ledgerForm').addEventListener('submit', (ev) => { ev.preventDefault(); runLedger(); });
async function runLedger() {
  const form = $('#ledgerForm');
  const q = qs(form);
  $('#ledgerXlsx').href = `/api/ledger/export.xlsx?${q}`;
  try {
    const r = await api(`/api/ledger?${q}`);
    const all = !form.company_id.value;
    $('#ledgerSum').innerHTML = [['Entries', r.count, 0], ['Inflow', r.inflow], ['Outflow', r.outflow], ['Net', r.inflow - r.outflow]]
      .map(([k, v, d]) => `<div><span>${k}</span><b>${d === 0 ? v : money(v)}</b></div>`).join('');
    $('#ledgerTable').innerHTML = `<thead><tr><th>Date</th>${all ? '<th>Company</th>' : ''}<th>Particulars</th><th>Column</th><th>Unit</th><th>Rate</th><th>Inflow</th><th>Outflow</th></tr></thead><tbody>
      ${r.rows.map((x) => `<tr data-eid="${x.entryId}"><td>${x.date.split('-').reverse().join('-')}</td>${all ? `<td style="text-align:left">${esc(x.company)}</td>` : ''}<td style="text-align:left">${esc(x.label)}</td><td style="text-align:left">${esc(x.colLabel)}</td><td>${fmt(x.unit)}</td><td>${fmt(x.rate)}</td><td>${x.side === 'in' ? fmt(x.amount) : ''}</td><td>${x.side === 'out' ? fmt(x.amount) : ''}</td></tr>`).join('')
        || `<tr><td colspan="8" class="muted" style="text-align:center">No entries</td></tr>`}</tbody>`;
    $('#ledgerTable').querySelectorAll('tr[data-eid]').forEach((tr) => { tr.onclick = () => openReview(Number(tr.dataset.eid)); });
  } catch (e) { toast(e.message); }
}
