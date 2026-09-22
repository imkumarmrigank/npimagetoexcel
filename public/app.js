const $ = (s) => document.querySelector(s);
const state = { companies: [], companyId: null, months: [], monthId: null, summary: null, meta: null, entry: null, zoom: 1 };

const fmt = (v, d = 2) => (v === null || v === undefined || v === '' || Number(v) === 0 ? '' : Number(v).toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d }));
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// "2,12,316.22", "₹ 1,000", "212316.22" → number; "" → null; anything else → NaN (shown red, never saved).
function parseAmount(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return v;
  const t = String(v).replace(/[₹,\s]/g, '').replace(/^Rs\.?/i, '');
  if (t === '') return null;
  return /^-?\d*\.?\d+$/.test(t) ? Number(t) : NaN;
}
// What a figure box shows: what was typed (if any), else the stored number.
const shownNum = (l, f) => (l._raw && l._raw[f] !== undefined ? l._raw[f] : l[f] ?? '');
const toast = (msg) => { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 3500); };

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: opts.body && !(opts.body instanceof FormData) ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body && !(opts.body instanceof FormData) ? JSON.stringify(opts.body) : opts.body,
  });
  if (res.status === 401 && path !== '/api/login') { $('#loginDlg').showModal(); throw new Error('Please sign in'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { data, status: res.status });
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
    for (const id of ['#empty', '#dashboard', '#monthBar', '#reportsView', '#ledgerView', '#cashView', '#reconView', '#errorsView', '#tallyView', '#dashView']) $(id).classList.add('hidden');
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
  $('#cashView').classList.toggle('hidden', tab !== 'cash');
  $('#reconView').classList.toggle('hidden', tab !== 'recon');
  $('#errorsView').classList.toggle('hidden', tab !== 'errors');
  $('#dashView').classList.toggle('hidden', tab !== 'dash');
  if (tab === 'dash') { if (!$('#dashForm').from.value) setRange($('#dashForm'), 'month'); runDash(); }
  $('#tallyView').classList.toggle('hidden', tab !== 'tally');
  if (tab === 'tally') openTally();
  if (tab === 'errors') runErrors();
  if (tab === 'recon' && !state.reconLoaded) { state.reconLoaded = true; if (!$('#reconForm').from.value) reconRange('month'); runRecon(); }
  if (tab === 'cash' && !state.cashLoaded) { state.cashLoaded = true; if (!$('#cashForm').from.value) setRange($('#cashForm'), 'month'); runCash(); }
  $('#ledgerView').classList.toggle('hidden', tab !== 'ledger');
  $('#side').classList.remove('open');
  if (tab === 'reports' && !state.reportLoaded) { state.reportLoaded = true; setRange($('#reportForm'), 'fy'); runReport(); }
  if (tab === 'ledger' && !state.ledgerLoaded) { state.ledgerLoaded = true; setRange($('#ledgerForm'), 'month'); runLedger(); }
}
document.querySelectorAll('#tabs [data-tab]').forEach((b) => { b.onclick = () => showTab(b.dataset.tab); });
$('#menuBtn').onclick = () => $('#side').classList.toggle('open');
$('#sideShade').onclick = () => $('#side').classList.remove('open');
$('#logoutBtn').onclick = async () => { await api('/api/logout', { method: 'POST' }); location.reload(); };
$('#companySelect').onchange = (e) => {
  state.companyId = Number(e.target.value);
  state.monthId = null;
  state.cashLoaded = state.reportLoaded = state.ledgerLoaded = state.reconLoaded = false; // other views follow the new company
  loadCompanies(state.companyId);
};

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
  state.reportLoaded = state.ledgerLoaded = state.cashLoaded = state.reconLoaded = false; // figures changed; refresh those views on next visit
  refreshErrCount();
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
  ['X', 'Total', 'M', 'out'], ['Y', 'Balance', 'closing'], ['Z', 'Closing balance (report)', 'CASH'],
];

function renderSummary() {
  const s = state.summary;
  $('#sheetTitle').textContent = s.month.title;
  $('#monthChecks').innerHTML = s.monthChecks.map((c) => checkLi(c) + (c.status !== 'ok' && MONTH_FIX[c.id] ? `<li class="hint-li"><span></span><div class="d">↳ ${MONTH_FIX[c.id]}</div></li>` : '')).join('');
  const t = s.totals;
  $('#totalsStrip').innerHTML = [
    ['HSD litres', t.HSD], ['HSD amount', t.HSD_AMT], ['MS litres', t.MS], ['MS amount', t.MS_AMT], ['Collection', t.COLL],
    ['Total expenses', t.M], ['Bank', t.BANK], ['PTM', t.PTM], ['UPI', t.UPI], ['Ranjit', t.RANJIT], ['P-Exp', t.PEXP], ['Closing balance', t.closing],
  ].map(([k, v]) => `<div><span>${k}</span><b>${fmt(v) || '0.00'}</b></div>`).join('');

  const byDay = new Map();
  for (const e of s.entries) if (e.day) (byDay.get(e.day) || byDay.set(e.day, []).get(e.day)).push(e);
  const head = `<thead><tr>${COLS.map(([, h, , g]) => `<th class="${g ? `grp-${g}` : ''}">${h}</th>`).join('')}<th>Status</th></tr></thead>`;
  let body = '';
  const badCells = (e) => {
    const bad = new Set();
    for (const c of e.checks) {
      if (c.status !== 'error') continue;
      if (c.id === 'inflow') ['L'].forEach((x) => bad.add(x));
      if (c.id === 'expense') ['M', 'X'].forEach((x) => bad.add(x));
      if (c.id === 'cash') bad.add('Z');
      if (c.id === 'HSD_amt') ['C', 'E'].forEach((x) => bad.add(x));
      if (c.id === 'MS_amt') ['F', 'H'].forEach((x) => bad.add(x));
      if (c.id === 'date') bad.add('A');
    }
    return bad;
  };
  const rowHtml = (e, label) => { const bad = badCells(e); return `<tr data-id="${e.id}" class="${e.errors ? 'err' : ''}" title="${e.errors ? esc(e.checks.filter((c) => c.status === 'error').map((c) => c.label).join('; ')) : ''}">${COLS.map(([c, , k]) => `<td class="${bad.has(c) ? 'cell-bad' : ''}">${c === 'A' ? label : fmt(e.row[k])}</td>`).join('')}
    <td class="status">${e.source === 'manual' ? badge('skip', 'manual') : ''} ${badge(e.status, e.status === 'verified' ? 'verified' : 'review')} ${e.errors ? badge('error', `${e.errors} mismatch`) : ''} ${e.warnings ? badge('warn', `${e.warnings} warn`) : ''}</td></tr>`; };
  for (let d = 1; d <= s.daysInMonth; d++) {
    const list = byDay.get(d);
    if (!list) body += `<tr class="missing"><td>${d}</td><td colspan="${COLS.length - 1}" style="text-align:left">No image uploaded <button class="small" data-manual="${d}">Enter manually</button></td><td class="status">${badge('missing')}</td></tr>`;
    else body += list.map((e) => rowHtml(e, d)).join('');
  }
  for (const e of s.entries.filter((x) => !x.day)) body += rowHtml(e, '?');
  const foot = `<tfoot><tr>${COLS.map(([c, , k]) => {
    if (c === 'A') return '<td>Total</td>';
    if (c === 'B') return `<td>${fmt(t.OB)}</td>`;
    if (c === 'L') return `<td>${fmt(t.inflow)}</td>`;
    if (c === 'Y') return `<td>${fmt(t.closing)}</td>`;
    if (c === 'Z') return '<td></td>';
    if (c === 'D' || c === 'G') return '<td></td>';
    return `<td>${fmt(t[k])}</td>`;
  }).join('')}<td></td></tr></tfoot>`;
  $('#sheet').innerHTML = head + `<tbody>${body}</tbody>` + foot;
  $('#sheet').querySelectorAll('tbody tr[data-id]').forEach((tr) => { tr.onclick = () => openReview(Number(tr.dataset.id)); });
  const pad = (v) => String(v).padStart(2, '0');
  $('#sheet').querySelectorAll('[data-manual]').forEach((b) => { b.onclick = () => enterManually(`${s.month.year}-${pad(s.month.month)}-${pad(b.dataset.manual)}`); });
  // Suggest the first missing day of this month for the manual box.
  if (s.missing.length) {
    $('#manualDate').value = `${s.month.year}-${pad(s.month.month)}-${pad(s.missing[0])}`;
    if (!$('#uploadDate').value) $('#uploadDate').value = $('#manualDate').value;
  }
}

// ---------- upload ----------
const drop = $('#drop');
['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => uploadFiles([...e.dataTransfer.files].filter((f) => f.type.startsWith('image/'))));
$('#fileInput').onchange = (e) => { uploadFiles([...e.target.files]); e.target.value = ''; };

let uploading = Promise.resolve();
async function uploadFiles(files) {
  const start = $('#uploadDate').value;
  if (!start) return toast('Pick the date of the image first');
  if (!files.length) return;
  const companyId = state.companyId;
  const [y, m, d] = start.split('-').map(Number);
  const dates = files.map((_, i) => d2(new Date(y, m - 1, d + i)));
  // Tell the user at once which dates are already taken, before anything is uploaded.
  let taken = {};
  try { taken = await api(`/api/companies/${companyId}/existing`, { method: 'POST', body: { dates } }); } catch (e) { return toast(e.message); }
  let lastId = null, lastMonth = null, uploaded = 0, lastAttached = false;

  const send = (file, date, st, replace) => {
    uploading = uploading.then(async () => {
      st.textContent = 'uploading…';
      const fd = new FormData();
      fd.append('image', file);
      fd.append('date', date);
      if (replace) fd.append('replace', '1');
      try {
        const r = await api(`/api/companies/${companyId}/upload`, { method: 'POST', body: fd });
        st.innerHTML = r.attached
          ? `${badge('ok', 'attached')} added to the figures typed for this date — check them against the image`
          : badge('ok', r.replaced ? 'replaced' : 'saved') + ' type the figures';
        lastId = r.id; lastMonth = r.month_id; lastAttached = !!r.attached; uploaded++;
      } catch (e) {
        st.innerHTML = `${badge('error', e.data?.code === 'duplicate_image' ? 'same image' : 'not saved')} ${esc(e.message)}`
          + (e.data?.existing_id ? ` <button class="small" data-open="${e.data.existing_id}">Open</button>` : '');
        st.querySelector('[data-open]')?.addEventListener('click', () => openReview(Number(e.data.existing_id)));
      }
    });
    return uploading;
  };

  files.forEach((file, i) => {
    const date = dates[i];
    const li = document.createElement('li');
    li.innerHTML = `<span>${esc(file.name)} → ${date.split('-').reverse().join('-')}</span><span class="st muted">waiting…</span>`;
    $('#queue').prepend(li);
    const st = li.querySelector('.st');
    const ex = taken[date];
    // A typed-in day without an image: the upload attaches to it (figures kept).
    if (ex && !ex.has_image && !ex.tally_batch_id) {
      st.innerHTML = `${badge('ok', 'typed day')} will be attached to the figures already typed for this date…`;
      send(file, date, st, false);
      return;
    }
    if (ex) {
      const locked = !!ex.tally_batch_id;
      st.innerHTML = `${badge('warn', 'already uploaded')} ${date.split('-').reverse().join('-')} already has ${ex.source === 'manual' ? 'a typed entry' : 'an image'}${ex.status === 'verified' ? ' (verified)' : ''}.
        <button class="small" data-open>Open</button>${locked ? ' <span class="muted small">sent to Tally — locked</span>' : ' <button class="small danger" data-replace>Replace</button>'}`;
      st.querySelector('[data-open]').onclick = () => openReview(ex.id);
      const rb = st.querySelector('[data-replace]');
      if (rb) rb.onclick = async () => {
        if (!confirm(`Replace the entry for ${date.split('-').reverse().join('-')}? Its figures will be deleted and you will type them again from this image.`)) return;
        await send(file, date, st, true);
        await afterUpload();
      };
      return;
    }
    send(file, date, st, false);
  });

  async function afterUpload() {
    if (companyId !== state.companyId) return;
    if (lastMonth) await loadMonths(lastMonth); else if (state.monthId) await loadSummary();
    if (lastId && uploaded === 1) {
      await openReview(lastId);
      if (!lastAttached) fillFromImage({ auto: true }); // a typed day keeps its figures
    }
  }
  uploading = uploading.then(async () => {
    await afterUpload();
    $('#uploadDate').value = d2(new Date(y, m - 1, d + files.length));
  });
}

async function enterManually(date) {
  if (!date) return toast('Pick a date first');
  const [y, m, d] = date.split('-').map(Number);
  const m0 = state.summary?.month;
  if (m0 && m0.year === y && m0.month === m) {
    const existing = state.summary.entries.find((e) => e.day === d);
    if (existing) { toast(`${date.split('-').reverse().join('-')} already has an entry — opening it`); return openReview(existing.id); }
  }
  try {
    const r = await api(`/api/companies/${state.companyId}/manual`, { method: 'POST', body: { date } });
    await loadMonths(r.month_id);
    await openReview(r.id);
  } catch (e) {
    toast(e.message);
    if (e.data?.existing_id) openReview(Number(e.data.existing_id));
  }
}
$('#manualBtn').onclick = () => enterManually($('#manualDate').value);

// ---------- why a check failed, and how to fix it ----------
const MONTH_FIX = {
  days: 'Upload the image for each missing day, or use “Enter manually” on that day’s row if you have no image.',
  undated: 'Open the image marked “?” in the sheet and set its Day.',
  dups: 'Two entries share a date. Open that day, check which image is right, and delete the other (or fix its day).',
  imgchecks: 'Open each row with a red bar and follow “Why and how to fix” at the bottom of the form.',
  verified: 'After a day’s figures match its image, press “Save & mark verified”.',
  balance: 'Usually caused by an undated or duplicate day; fix those first.',
};

// Clues from the size of a difference: which row, a misread digit, or swapped digits.
function diffClues(diff, lines) {
  const a = Math.abs(diff);
  const clues = [];
  const same = lines.filter((l) => Math.abs(Math.abs(Number(l.amount) || 0) - a) <= 1);
  if (same.length) clues.push(`It equals the row “${same[0].label}” (${fmt(same[0].amount)}) — that row may be missing from, or counted twice in, the image’s total.`);
  if (a >= 1000 && a % 1000 < 1) clues.push(`It is almost exactly ${fmt(Math.round(a / 1000) * 1000, 0)} — typically one digit of one amount is different (e.g. 19,999 vs 39,999). Compare the thousands digits of each row with the image.`);
  const whole = Math.round(a);
  if (whole >= 9 && whole % 9 === 0 && Math.abs(a - whole) < 0.01) clues.push('It divides exactly by 9 — often two digits were swapped (e.g. 45 ↔ 54) in one amount.');
  if (a < 1.5) clues.push('It is under ₹1.50 — probably rounding on the image; you can mark the day verified.');
  return clues;
}

// The next day's opening cash tells which side is right: if it equals this day's closing balance,
// the closing balance is right and a row (or the printed total) is wrong.
function closingClues(c, e) {
  const day = Number(e.day ?? state.entry?.day);
  const next = state.summary?.entries.find((x) => x.day === day + 1);
  if (!next || !Number.isFinite(Number(c.expected))) return [];
  const ob = Number(next.row.OB);
  if (Math.abs(ob - c.expected) <= 1.5) {
    return [`Day ${day + 1} opens with ${fmt(ob)}, the same as this closing balance — so the closing balance is right, and a row here is wrong by ${fmt(Math.abs(c.diff))} (or a row is missing). Compare each row with the image, or with your Excel.`];
  }
  if (Math.abs(ob - c.actual) <= 1.5) {
    return [`Day ${day + 1} opens with ${fmt(ob)}, which matches what the rows give — so the rows are right and the closing balance on the report is wrong. Correct “Closing balance (cash in hand)”.`];
  }
  return [];
}

function explain(c, e) {
  const d = Math.abs(c.diff ?? 0);
  const side = (s) => e.lines.filter((l) => l.side === s);
  switch (c.id) {
    case 'date':
      return { why: c.detail || 'The day is missing or used twice.', fix: 'Set the correct Day (it is printed on the image). If this image is a duplicate of another day, delete it.' };
    case 'inflow':
      return {
        why: `The inflow rows add up to ${fmt(c.actual)}, but the image’s Total Inflow is ${fmt(c.expected)} (difference ${fmt(d)}). Either a row is missing or typed wrong here, or the image’s own total is wrong.`,
        fix: 'Compare every inflow row with the image and correct the amount, or add the missing row with “+ line”. If every row matches the image exactly, the image’s total is wrong: write the correct total in “Printed total inflow”, or mark the day verified to accept it.',
        clues: diffClues(c.diff, side('in')),
      };
    case 'expense':
      return {
        why: `The expense rows add up to ${fmt(c.actual)}, but the image’s Total Expenses is ${fmt(c.expected)} (difference ${fmt(d)}). ${c.actual < c.expected ? 'Something is missing here or an amount is lower than on the image' : 'An amount here is higher than on the image, or a row is repeated'} — or the image’s own total is wrong.`,
        fix: 'Go down the expense list against the image. Correct any amount, add a missing row with “+ line”, or remove a repeated one. If all rows match the image exactly, the mistake is in the image’s total: correct “Printed total expenses” (or mark verified after checking with the pump).',
        clues: diffClues(c.diff, side('out')),
      };
    case 'cash':
      return {
        why: `Inflow − expenses from the rows gives ${fmt(c.actual)}, but the report's closing balance (cash in hand) is ${fmt(c.expected)} (difference ${fmt(d)}).`,
        fix: e.computed?.checks.some((x) => (x.id === 'inflow' || x.id === 'expense') && x.status === 'error')
          ? 'This follows from the inflow/expense mismatch above — fix that first and this usually clears.'
          : 'The rows balance but the closing balance does not: check “Closing balance (cash in hand)” against the report, or the cash actually counted at the end of the day. The next day’s opening cash should match it.',
        clues: closingClues(c, e),
      };
    case 'HSD_amt':
    case 'MS_amt': {
      const fuel = c.id === 'HSD_amt' ? 'HSD' : 'MS';
      return {
        why: `${fuel} units × rate gives ${fmt(c.actual)}, but the amount is ${fmt(c.expected)} (difference ${fmt(d)}).`,
        fix: `Check the ${fuel} units and rate against the image (this month’s rate is ${fmt(fuel === 'HSD' ? state.summary?.month?.hsd_rate : state.summary?.month?.ms_rate) || 'not set'}). The sheet uses units × rate, so the units must be right.`,
      };
    }
    case 'ob':
      return {
        why: `${c.detail}. The day should open with the cash the previous day ended with.`,
        fix: 'If the opening cash was typed or read wrong, correct it to match the image. If the image really shows this (cash added or taken out overnight, or rounding), press “Accept difference”.',
      };
    default:
      return null;
  }
}

function renderHowFix(computed) {
  const box = $('#howFix');
  const items = (computed?.checks || []).filter((c) => c.status === 'error' || c.status === 'warn').map((c) => ({ c, x: explain(c, state.entry) })).filter((i) => i.x);
  box.classList.toggle('hidden', !items.length);
  box.innerHTML = items.length
    ? `<h4>Why and how to fix</h4>${items.map(({ c, x }) => `<div class="fix-item ${c.status}">
        <div class="fix-title">${badge(c.status)} ${esc(c.label)}</div>
        <div><b>Why:</b> ${esc(x.why)}</div>
        <div><b>How to fix:</b> ${esc(x.fix)}</div>
        ${x.clues?.length ? `<ul>${x.clues.map((k) => `<li>${esc(k)}</li>`).join('')}</ul>` : ''}
      </div>`).join('')}`
    : '';
}

// ---------- review ----------
const reviewDlg = $('#review');
async function openReview(id) {
  const e = await api(`/api/entries/${id}`);
  state.entry = { ...e, lines: e.lines.map((l) => ({ ...l })), remember: new Set() };
  $('#reviewTitle').textContent = (e.day ? `Day ${e.day}` : 'Undated image') + (e.status === 'verified' ? ' ✓ verified' : '');
  // Days already sent to Tally are read-only until unlocked in Tally Export.
  const locked = !!e.tally_batch_id;
  $('#lockNote').classList.toggle('hidden', !locked);
  $('#lockNote').textContent = locked ? `Sent to Tally in batch #${e.tally_batch_id} — read-only. To change it, unlock the batch in Tally Export (you must then import the corrected day into Tally again).` : '';
  document.querySelectorAll('#review .review-data input, #review .review-data select, #review .review-data button').forEach((el) => { el.disabled = false; });
  $('#reviewImg').classList.toggle('hidden', !e.has_image);
  $('#noImg').classList.toggle('hidden', e.has_image);
  $('#imgOpen').classList.toggle('hidden', !e.has_image);
  $('#rOcr').classList.toggle('hidden', !e.has_image);
  $('#rOcr').textContent = 'Read image again';
  $('#readNote').classList.add('hidden');
  if (e.has_image) { const u = `/api/entries/${id}/image?v=${e.image_v || ''}`; $('#reviewImg').src = u; $('#imgOpen').href = u; }
  $('#rReplace').textContent = e.has_image ? 'Replace image' : 'Add image';
  $('#rReplace').title = e.has_image
    ? `Upload a better or corrected image for this day. The figures you typed are kept.${e.old_images ? ` (${e.old_images} earlier image(s) kept on record)` : ''}`
    : 'Attach the image for this day. The figures you typed are kept.';
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
  clearTimeout(recheckTimer);
  $('#unsavedNote').classList.add('hidden');
  renderComputed(e.computed);
  if (locked) document.querySelectorAll('#review .review-data input, #review .review-data select, #review .review-data button:not(#prevDay):not(#nextDay):not([onclick])').forEach((el) => { el.disabled = true; });
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
        ${side === 'in' ? `<td class="unit"><input data-f="unit" type="text" inputmode="decimal" autocomplete="off" value="${esc(shownNum(l, 'unit'))}"></td><td class="unit"><input data-f="rate" type="text" inputmode="decimal" autocomplete="off" value="${esc(shownNum(l, 'rate'))}"></td>` : ''}
        <td class="num"><input data-f="amount" type="text" inputmode="decimal" autocomplete="off" value="${esc(shownNum(l, 'amount'))}"></td>
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
    if (['unit', 'rate', 'amount'].includes(f)) {
      // Keep what was typed on screen; store the number it means ("2,12,316.22" → 212316.22).
      const x = parseAmount(ev.target.value);
      l._raw = { ...(l._raw || {}), [f]: ev.target.value };
      l._bad = { ...(l._bad || {}), [f]: Number.isNaN(x) };
      l[f] = Number.isNaN(x) ? null : x;
      ev.target.classList.toggle('bad', Number.isNaN(x));
    } else l[f] = ev.target.value;
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
  $('#liveSums').textContent = `Lines add up to: inflow ${fmt(i) || 0} · expenses ${fmt(o) || 0} · closing balance ${fmt(i - o) || 0}`;
  liveCheck(i, o);
  scheduleRecheck();
}

// Re-run the full checks on the unsaved figures shortly after typing stops, so "Why and how to
// fix", the check list and the opening-cash warning all clear as soon as the figures are right.
let recheckTimer = null;
let recheckSeq = 0;
function scheduleRecheck() {
  clearTimeout(recheckTimer);
  const e = state.entry;
  if (!e || e.tally_batch_id) return;
  recheckTimer = setTimeout(async () => {
    const seq = ++recheckSeq;
    const num = (v) => { const x = parseAmount(v); return Number.isNaN(x) ? null : x; };
    try {
      const r = await api(`/api/entries/${e.id}/check`, {
        method: 'POST',
        body: {
          day: num($('#rDay').value), lines: e.lines,
          printed: { ...(e.printed || {}), total_inflow: num($('#rTin').value), total_expense: num($('#rTex').value), cash_in_hand: num($('#rCash').value) },
        },
      });
      if (seq !== recheckSeq || state.entry !== e) return; // a newer check or another day is showing
      e.computed = r.computed;
      renderComputed(r.computed);
      const dirty = true;
      $('#unsavedNote').classList.toggle('hidden', !dirty);
      liveCheck(...['in', 'out'].map((side) => e.lines.filter((l) => l.side === side).reduce((s2, l) => s2 + (Number(l.amount) || 0), 0)));
    } catch { /* checking is a convenience; saving still validates */ }
  }, 450);
}

// Paint mismatched fields red as the user types, so they can see what to fix.
const TOL = 1;
function liveCheck(sumIn, sumOut) {
  const e = state.entry;
  const val = (id) => { const x = parseAmount($(id).value); if (Number.isNaN(x)) $(id).classList.add('bad'); return Number.isNaN(x) ? null : x; };
  const problems = [];
  document.querySelectorAll('#review .bad, #review .bad-soft, #review .warn').forEach((el) => el.classList.remove('bad', 'bad-soft', 'warn'));
  for (const l of e.lines) for (const [f, isBad] of Object.entries(l._bad || {})) if (isBad) document.querySelector(`tr[data-lid="${l.id}"] input[data-f="${f}"]`)?.classList.add('bad');
  const hint = (id, text, warn) => { $(id).textContent = text || ''; $(id).classList.toggle('warn', !!warn); };
  const amountInputs = (side) => [...document.querySelectorAll(`#${side}Lines tr[data-lid] input[data-f="amount"]`)];
  const rowInputs = (id) => [...document.querySelectorAll(`tr[data-lid="${id}"] input`)];

  const day = val('#rDay');
  const dayBad = !day || (state.summary && state.summary.entries.some((x) => x.id !== e.id && x.day === day));
  if (dayBad) { $('#rDay').classList.add('bad'); problems.push(!day ? 'Day is missing' : `Another image is also day ${day}`); }
  hint('#hDay', dayBad ? (!day ? 'Set the day' : 'Duplicate day') : '');

  const cmp = (id, hintId, printed, calc, label, side) => {
    if (printed === null) { hint(hintId, ''); return; }
    const diff = Math.round((calc - printed) * 100) / 100;
    if (Math.abs(diff) <= TOL) { hint(hintId, ''); return; }
    $(id).classList.add('bad');
    if (side) amountInputs(side).forEach((el) => el.classList.add('bad-soft'));
    hint(hintId, `Lines give ${fmt(calc) || '0.00'} (off by ${fmt(diff)})`);
    problems.push(`${label}: image ${fmt(printed)}, lines ${fmt(calc) || '0.00'}, difference ${fmt(diff)}`);
  };
  cmp('#rTin', '#hTin', val('#rTin'), sumIn, 'Total inflow', 'in');
  cmp('#rTex', '#hTex', val('#rTex'), sumOut, 'Total expenses', 'out');
  cmp('#rCash', '#hCash', val('#rCash'), sumIn - sumOut, 'Closing balance');

  // HSD / MS: units × rate must equal the amount on the same row.
  for (const l of e.lines.filter((x) => x.side === 'in' && (x.col === 'HSD' || x.col === 'MS'))) {
    const u = Number(l.unit), r = Number(l.rate), a = Number(l.amount);
    if (!u || !r || !a) continue;
    const diff = Math.round((u * r - a) * 100) / 100;
    if (Math.abs(diff) > TOL) {
      rowInputs(l.id).filter((el) => el.dataset.f !== 'label').forEach((el) => el.classList.add('bad'));
      problems.push(`${l.label}: ${fmt(u)} × ${fmt(r)} = ${fmt(u * r)}, but amount is ${fmt(a)}`);
    }
  }

  // Opening cash vs the previous day's closing balance: a warning the user can accept once checked.
  const ob = e.computed?.checks.find((c) => c.id === 'ob' && c.status === 'warn');
  const obLine = e.lines.find((l) => l.side === 'in' && l.col === 'OB');
  if (ob && obLine) document.querySelector(`tr[data-lid="${obLine.id}"] input[data-f="amount"]`)?.classList.add('warn');

  const box = $('#fixList');
  box.classList.toggle('hidden', !problems.length && !e.computed?.errors);
  box.classList.toggle('ok', !problems.length);
  box.innerHTML = problems.length
    ? `<b>${problems.length} thing(s) to fix</b> — red fields don't add up:<ul>${problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>`
    : '<b>All figures on this image now add up.</b> Save to confirm.';

  const warn = $('#warnList');
  warn.classList.toggle('hidden', !ob);
  if (ob) {
    warn.innerHTML = `<b>Opening cash differs from the previous day</b> (amber field)<div>${esc(ob.detail)}.</div>
      <div class="small">If this is expected (cash added or taken out overnight, rounding), accept it; otherwise correct the opening cash.</div>
      <button type="button" class="small" id="acceptOb">Accept difference of ${fmt(-ob.diff) || '0.00'}</button>`;
    $('#acceptOb').onclick = async () => {
      try { await api(`/api/entries/${e.id}/accept-ob`, { method: 'POST', body: { diff: ob.diff } }); if (state.monthId) await loadSummary(); await openReview(e.id); toast('Difference accepted'); } catch (err) { toast(err.message); }
    };
  }
}
for (const id of ['#rTin', '#rTex', '#rCash', '#rDay']) $(id).addEventListener('input', () => liveSums());
function renderComputed(c) {
  $('#rChecks').innerHTML = c ? c.checks.map(checkLi).join('') : '';
  if (!c) { $('#rRow').innerHTML = ''; return; }
  const r = c.row;
  renderHowFix(c);
  $('#rRow').innerHTML = [['OB', r.openingUsed], ['HSD', r.HSD], ['Rate', r.HSD_RATE], ['MS', r.MS], ['Rate', r.MS_RATE], ['Lub', r.LUB], ['Cofee', r.COFFEE], ['Collection', r.COLL],
    ['T-Exp', r.M], ['Bank', r.BANK], ['PTM', r.PTM], ['UPI', r.UPI], ['T-Sale', r.TSALE], ['Fleet', r.FLEET], ['R-Babu', r.RBABU], ['Ranjit', r.RANJIT], ['Others', r.OTHERS], ['P-Exp', r.PEXP], ['Balance (worked out)', r.closing], ['Closing balance (report)', r.CASH]]
    .filter(([, v]) => Number(v)).map(([k, v]) => `<div><b>${k}</b>${fmt(v)}</div>`).join('');
}

async function saveEntry(status, { verify = false, close = false } = {}) {
  const e = state.entry;
  // Never save a figure that couldn't be read: point at it instead.
  const badLine = e.lines.find((l) => l._bad && Object.values(l._bad).some(Boolean));
  const badPrinted = [['#rTin', 'Printed total inflow'], ['#rTex', 'Printed total expenses'], ['#rCash', 'Closing balance (cash in hand)']]
    .find(([id]) => Number.isNaN(parseAmount($(id).value)));
  if (badLine || badPrinted) {
    const what = badPrinted ? badPrinted[1] : `${badLine.label || 'a row'} (${Object.keys(badLine._bad).filter((k) => badLine._bad[k]).join(', ')})`;
    if (badPrinted) $(badPrinted[0]).classList.add('bad');
    toast(`Not saved — “${what}” is not a number. Type digits only, e.g. 212316.22 or 2,12,316.22.`);
    return false;
  }
  const lines = e.lines.map(({ _raw, _bad, ...l }) => l);
  const r = await api(`/api/entries/${e.id}`, {
    method: 'PUT',
    body: {
      day: parseAmount($('#rDay').value), report_date: $('#rDate').value, lines, status, verify,
      printed: { ...(e.printed || {}), total_inflow: parseAmount($('#rTin').value), total_expense: parseAmount($('#rTex').value), cash_in_hand: parseAmount($('#rCash').value) },
      remember: [...e.remember],
    },
  });
  if (state.monthId) await loadSummary();
  const saved = state.summary?.entries.find((x) => x.id === e.id);
  const left = saved ? saved.errors : 0;
  const msg = r.status === 'verified' ? 'Saved and marked verified.'
    : r.reverted ? 'Saved. The figures changed, so this day is back to “review”.' : 'Saved.';
  const tail = left ? ` ${left} mismatch(es) still open on this day — see Errors.` : saved?.warnings ? ' Figures add up; an opening-cash warning is still open.' : ' All figures add up.';
  if (close) { reviewDlg.close(); } else await openReview(e.id);
  toast(msg + tail);
  return true;
}
$('#rSave').onclick = () => saveEntry(state.entry.status, { close: true }).catch((e) => toast(e.message));
$('#rVerify').onclick = async () => {
  const errs = state.summary.entries.find((x) => x.id === state.entry.id)?.errors;
  if (errs && !confirm('This image still has mismatches. Mark it verified anyway?')) return;
  saveEntry('verified', { verify: true, close: true }).catch((e) => toast(e.message));
};
$('#rDelete').onclick = async () => {
  if (!confirm('Delete this image and its data?')) return;
  await api(`/api/entries/${state.entry.id}`, { method: 'DELETE' });
  reviewDlg.close();
  await loadSummary();
};
// Replace / add the day's image from the review form; figures stay, the day goes back to review.
$('#rReplace').onclick = () => { $('#replaceFile').value = ''; $('#replaceFile').click(); };
$('#replaceFile').onchange = async (ev) => {
  const file = ev.target.files[0];
  const e = state.entry;
  if (!file || !e) return;
  const had = e.has_image;
  if (!confirm(`${had ? 'Replace this day’s image' : 'Add this image to the day'} with “${file.name}”?\n\nThe figures already typed are kept — check them against the new image. The day goes back to “review”.${had ? '\nThe old image is kept on record.' : ''}`)) return;
  const fd = new FormData();
  fd.append('image', file);
  const btn = $('#rReplace');
  btn.disabled = true; btn.textContent = 'Uploading…';
  try {
    await api(`/api/entries/${e.id}/image`, { method: 'PUT', body: fd });
    if (state.monthId) await loadSummary();
    await openReview(e.id);
    toast(had ? 'Image replaced — reading its figures…' : 'Image added — reading its figures…');
    fillFromImage({ auto: true });
  } catch (err) {
    toast(err.message);
  } finally { btn.disabled = false; btn.textContent = state.entry?.has_image ? 'Replace image' : 'Add image'; }
};

// Read the day's image with the offline text reader (Tesseract, in this browser — no AI) and put what
// it finds into the form. Nothing is saved: the user checks against the image, then saves.
// auto = run by itself after an upload/replace; a poor read then leaves the figures as they were.
async function fillFromImage({ auto = false } = {}) {
  const e = state.entry;
  if (!e || !e.has_image || e.tally_batch_id) return;
  const btn = $('#rOcr');
  btn.disabled = true;
  $('#readNote').classList.remove('hidden');
  $('#readNote').textContent = 'Reading the image in this browser (free offline reader, no AI)…';
  try {
    const mo = state.summary?.month || {};
    const r = await readLedgerText(`/api/entries/${e.id}/image?v=${e.image_v || ''}`, (p) => { btn.textContent = p; $('#readNote').textContent = `${p} — the figures will appear here for you to check.`; }, { hsd: Number(mo.hsd_rate), ms: Number(mo.ms_rate) });
    if (state.entry !== e) return; // another day was opened meanwhile
    // Fuel rows: the month's rate is known, so a misread rate or unit is repaired from the amount.
    const rateFor = { HSD: Number(mo.hsd_rate), MS: Number(mo.ms_rate) };
    for (const l of r.lines) {
      const up = l.label.trim().toUpperCase();
      const fuel = l.side === 'in' && /^(HSD|MS)\b/.test(up) ? (up.startsWith('HSD') ? 'HSD' : 'MS') : null;
      const known = fuel && rateFor[fuel];
      if (!known || !l.amount) continue;
      if (!l.rate || Math.abs(l.rate - known) > 3) l.rate = known;
      if (!l.unit || Math.abs(l.unit * l.rate - l.amount) > 1) l.unit = Math.round((l.amount / l.rate) * 100) / 100;
    }
    // Only trust a read that clearly found the report's anchor rows: at least two of opening cash,
    // HSD and MS with an amount, plus some expenses. Photos of a screen often read as noise.
    const anchors = [/^(OPE?N?ING|OPNING)\b/, /^HSD\b/, /^MS\b/]
      .filter((re) => r.lines.some((l) => l.side === 'in' && re.test(l.label.trim().toUpperCase()) && Number(l.amount) > 0)).length;
    const usable = anchors >= 2 && r.lines.filter((l) => l.side === 'out').length >= 2;
    if (!usable) {
      $('#readNote').textContent = `The reader couldn't read this image clearly, so the figures were left as they were. Photos of a computer screen usually can't be read — please type or correct the figures from the image (the red marks show what doesn't add up yet).`;
      if (!auto) toast('Could not read enough rows from this image — please type them in');
      return;
    }
    const m = state.summary?.month;
    if (r.date && m && r.date.m === m.month && r.date.y === m.year) $('#rDay').value = r.date.d;
    if (r.date) $('#rDate').value = r.date.text;
    for (const [id, v] of [['#rTin', r.printed.total_inflow], ['#rTex', r.printed.total_expense], ['#rCash', r.printed.cash_in_hand]]) if (v !== null) $(id).value = v;
    // Let the server apply the company's mapping rules (which column each row goes to), without saving.
    const num = (v) => { const x = parseAmount(v); return Number.isNaN(x) ? null : x; };
    const checked = await api(`/api/entries/${e.id}/check`, {
      method: 'POST',
      body: { day: num($('#rDay').value), lines: r.lines.map((l, i) => ({ ...l, id: i + 1, col: null })),
        printed: { ...(e.printed || {}), total_inflow: num($('#rTin').value), total_expense: num($('#rTex').value), cash_in_hand: num($('#rCash').value) } },
    });
    if (state.entry !== e) return;
    e.lines = checked.lines;
    e.computed = checked.computed;
    renderLines();
    renderComputed(checked.computed);
    $('#unsavedNote').classList.remove('hidden');
    $('#readNote').textContent = `Filled ${r.lines.length} rows from the image. Check every figure against the image (red = doesn't add up), correct anything misread, then Save.`;
    toast(`Read ${r.lines.length} rows from the image — check them, then Save`);
  } catch (err) {
    $('#readNote').textContent = `The reader could not run (${err.message}). Please type the figures from the image.`;
    if (!auto) toast(`Text reader failed: ${err.message}`);
  } finally { btn.disabled = false; btn.textContent = 'Read image again'; }
}
$('#rOcr').onclick = async () => {
  const e = state.entry;
  const typed = e.lines.some((l) => l.col !== 'OB' && l.amount !== null && l.amount !== '');
  if (typed && !confirm('Replace the figures on this form with what the reader finds in the image? (Nothing is saved until you press Save.)')) return;
  fillFromImage();
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

// ---------- date ranges ----------
const d2 = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
// Show which quick-range button is in use; typing your own dates clears it.
function markRange(form, kind) {
  form.querySelectorAll('[data-range]').forEach((b) => {
    const on = b.dataset.range === kind;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  });
}
document.querySelectorAll('form').forEach((form) => {
  if (!form.querySelector('[data-range]')) return;
  for (const n of ['from', 'to']) form[n]?.addEventListener('input', () => markRange(form, null));
});

function setRange(form, kind) {
  markRange(form, kind);
  // Anchor on the selected month when there is one, else today.
  const m = state.summary?.month;
  const now = m ? new Date(m.year, m.month - 1, 1) : new Date();
  const y = now.getFullYear(), mo = now.getMonth();
  const fyStart = mo >= 3 ? y : y - 1;
  let from, to;
  if (kind === 'today') { from = to = new Date(); }
  if (kind === 'week') { const t = new Date(); from = new Date(t.getFullYear(), t.getMonth(), t.getDate() - ((t.getDay() + 6) % 7)); to = new Date(from.getFullYear(), from.getMonth(), from.getDate() + 6); }
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
// Profit green, loss red (with the word, so it reads the same without colour).
const pnl = (v) => { const x = Number(v) || 0; return `<span class="${x < 0 ? 'loss' : 'profit'}">${fmt(Math.abs(x)) || '0.00'} ${x < 0 ? 'Loss' : 'Profit'}</span>`; };

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

    // Purchase cost: the month's actual figure where entered, else the standard PPAC dealer commission (estimated).
    const est = t.pl.estimatedDays;
    const estTag = est ? ' <span class="badge b-warn" title="Uses the standard dealer commission — enter your actual cost or margin for exact figures">estimated</span>' : '';
    const tiles = [['Total sales', money(t.pl.sales)], ['Gross profit / loss' + estTag, pnl(t.pl.gross)],
      ['Operating expenses', money(t.pl.expenses)], ['Net profit / loss' + estTag, pnl(t.pl.net)],
      ['HSD litres', money(t.HSD)], ['MS litres', money(t.MS)], ['Deposited (Bank+PTM+UPI)', money(t.cash.deposits)], ['Party / credit', money(t.cash.parties)]]
      .map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('');

    const cell = (p, v, profit) => (profit ? pnl(v) : money(v));
    const plRow = (label, get, cls = '', profit = false) => `<tr class="${cls}"><td>${label}</td>${r.rows.map((x) => `<td>${cell(x.pl, get(x.pl), profit)}</td>`).join('')}<td>${cell(t.pl, get(t.pl), profit)}</td></tr>`;
    const c = t.pl.commission;
    const costNote = !est ? '' : `<div class="note"><b>Estimated for ${est} day(s):</b> the daily reports only show the selling rate, so the fuel cost is worked out from the
      standard dealer commission published by <a href="${esc(c.source)}" target="_blank" rel="noopener">PPAC, Government of India</a> (from ${c.effective.split('-').reverse().join('-')}):
      MS ₹${c.MS.perKl}/KL + ${c.MS.pct}%, HSD ₹${c.HSD.perKl}/KL + ${c.HSD.pct}% of the product billable price (taken as ${Math.round(c.billableShare * 100)}% of the selling rate).
      That is about ₹${(c.MS.perKl / 1000 + (c.MS.pct / 100) * 113.77 * c.billableShare).toFixed(2)}/L on MS and ₹${(c.HSD.perKl / 1000 + (c.HSD.pct / 100) * 99.76 * c.billableShare).toFixed(2)}/L on HSD at this month's rates.
      ${form.company_id.value ? 'For exact profit, enter your actual purchase cost or margin per litre below (from the purchase invoices).' : 'Pick one company to enter its actual purchase costs.'}</div>
      ${form.company_id.value ? '<div id="costEditor"></div>' : ''}`;
    // Expandable rows: a ＋ opens the item-wise lines under a total, with an amount per period.
    // Collections and "Others" payments have a tick per head to count it in the P&L or leave it out.
    const one = !!form.company_id.value;
    const collOut = new Set(one ? (company()?.coll_excluded || []) : []);
    const othersOut = new Set(one ? (company()?.others_excluded || []) : []);
    const itemAmt = (p, list, label) => (list(p).find((i) => i.label === label) || {}).amount || 0;
    const groupRows = (id, label, total, list, toggle = null) => {
      const items = list(t.pl);
      if (!items.length) return plRow(label, total);
      return `<tr class="group" data-group="${id}"><td><button type="button" class="expand" data-toggle="${id}" aria-expanded="false" title="Show item-wise">＋</button> ${label} <span class="muted small">(${items.length} items)</span></td>
        ${r.rows.map((x) => `<td>${money(total(x.pl))}</td>`).join('')}<td>${money(total(t.pl))}</td></tr>
        ${items.map((it) => `<tr class="item hidden" data-parent="${id}"><td>${esc(it.label)}${toggle && one
          ? ` <label class="small inc-toggle"><input type="checkbox" data-pl="${toggle.kind}" data-head="${esc(it.label)}" ${toggle.checked(it.label) ? 'checked' : ''}> ${toggle.text}</label>` : ''}</td>
          ${r.rows.map((x) => `<td>${fmt(itemAmt(x.pl, list, it.label)) || ''}</td>`).join('')}<td>${fmt(it.amount)}</td></tr>`).join('')}`;
    };
    const sumOf = (list) => list.reduce((x, c) => x + c.amount, 0);
    const collIn = (p) => p.collectionLines.filter((c) => !collOut.has(c.label));
    const collLeft = (p) => p.collectionLines.filter((c) => collOut.has(c.label));
    const othIn = (p) => p.othersLines.filter((c) => !othersOut.has(c.label));
    const othLeft = (p) => p.othersLines.filter((c) => othersOut.has(c.label));
    const collToggle = { kind: 'coll', text: 'count as income', checked: (h) => !collOut.has(h) };
    const othToggle = { kind: 'others', text: 'count as cost', checked: (h) => !othersOut.has(h) };
    const otherIncomeRows = groupRows('coll', 'Add: collection income (tank sell / CSP / other)', (p) => sumOf(collIn(p)), collIn, collToggle);
    const otherPaymentRows = groupRows('oth', 'Less: other payments (Others — returns, CSP paid out…)', (p) => sumOf(othIn(p)), othIn, othToggle);
    const leftOut = collLeft(t.pl).length + othLeft(t.pl).length;
    const pl = `<div class="card"><h3>Profit &amp; Loss</h3>${costNote}<div class="table-wrap"><table class="pl">
      <thead><tr><th>Particulars</th>${r.rows.map((x) => `<th>${colName(x)}</th>`).join('')}<th>Total</th></tr></thead><tbody>
      ${plRow('HSD sales', (p) => p.hsdSales)}${plRow('MS sales', (p) => p.msSales)}${plRow('Lube', (p) => p.lube)}${plRow('Coffee', (p) => p.coffee)}
      ${plRow('Total sales', (p) => p.sales, 'sub')}
      ${plRow('Less: HSD purchase cost', (p) => p.hsdCost)}${plRow('Less: MS purchase cost', (p) => p.msCost)}
      ${plRow('Gross profit / loss', (p) => p.gross, 'sub', true)}
      ${otherIncomeRows}
      ${groupRows('pexp', 'Less: operating expenses (P-Exp)', (p) => p.expenses, (p) => p.expenseLines)}
      ${otherPaymentRows}
      ${plRow('Net profit / loss', (p) => p.net, 'net', true)}
      </tbody>
      <tbody class="memo">
      <tr class="memo-head"><td colspan="${r.rows.length + 2}">Collections and “Others” payments ${leftOut ? `— ${leftOut} head(s) left out of profit` : 'are counted in profit'}
        <button type="button" class="small ghost" id="whyColl">How this works</button></td></tr>
      <tr class="memo-why hidden"><td colspan="${r.rows.length + 2}">
        <b>Collection</b> (tank sell, CSP, Cyber, Nitesh, money from parties…) is counted as income. Money that goes back out under the
        <b>Others</b> column (Cyber return, Nitesh return, CSP paid out, gas agency, Dr Sahab…) is counted as a cost, so money that only passes
        through the pump doesn't show as profit. Open either line with ＋ and untick a head to leave it out — for example a loan received, or
        its repayment. Your choice is saved for this company.</td></tr>
      ${collLeft(t.pl).length ? groupRows('collx', 'Collections left out of profit', (p) => sumOf(collLeft(p)), collLeft, collToggle) : ''}
      ${othLeft(t.pl).length ? groupRows('othx', '“Others” payments left out of profit', (p) => sumOf(othLeft(p)), othLeft, othToggle) : ''}
      </tbody></table></div></div>`;

    const summary = `<div class="card"><h3>Summary by ${esc(form.group.selectedOptions[0].text.toLowerCase())}</h3><div class="table-wrap"><table class="sheet">
      <thead><tr><th>Period</th>${all ? '<th>Company</th>' : ''}${REP_COLS.map(([h]) => `<th>${h}</th>`).join('')}</tr></thead>
      <tbody>${r.rows.map((x) => `<tr><td>${esc(x.label)}</td>${all ? `<td style="text-align:left">${esc(x.company)}</td>` : ''}${REP_COLS.map(([, k, d]) => `<td>${fmt(x[k], d ?? 2)}</td>`).join('')}</tr>`).join('')}</tbody>
      <tfoot><tr><td>Total</td>${all ? '<td></td>' : ''}${REP_COLS.map(([, k, d]) => `<td>${k === 'opening' || k === 'closing' ? '' : fmt(t[k], d ?? 2)}</td>`).join('')}</tr></tfoot>
      </table></div></div>`;

    const companies = all && r.companies.length > 1 ? `<div class="card"><h3>Company-wise</h3><div class="table-wrap"><table class="pl">
      <thead><tr><th>Company</th><th>Days</th><th>Sales</th><th>Gross profit</th><th>Op. expenses</th><th>Net profit</th><th>Deposited</th></tr></thead><tbody>
      ${r.companies.map((c) => `<tr><td>${esc(c.company)}</td><td>${c.days}</td><td>${money(c.pl.sales)}</td><td>${cell(c.pl, c.pl.gross, true)}</td><td>${money(c.pl.expenses)}</td><td>${cell(c.pl, c.pl.net, true)}</td><td>${money(c.cash.deposits)}</td></tr>`).join('')}
      </tbody></table></div></div>` : '';

    const exp = t.pl.expenseLines;
    const expenses = `<div class="card"><h3>Operating expenses by head</h3><div class="table-wrap" style="max-height:420px"><table class="pl">
      <thead><tr><th>Particulars</th><th>Amount</th><th>Share</th></tr></thead><tbody>
      ${exp.map((e) => `<tr><td>${esc(e.label)}</td><td>${money(e.amount)}</td><td>${t.pl.expenses ? ((e.amount / t.pl.expenses) * 100).toFixed(1) : 0}%</td></tr>`).join('') || '<tr><td colspan="3" class="muted">None</td></tr>'}
      </tbody></table></div></div>`;

    $('#reportOut').innerHTML = `<div class="card"><div class="muted small">${esc(r.from || '')} to ${esc(r.to || '')} · ${t.days} day(s), ${t.verified} verified</div><div class="totals">${tiles}</div></div>${pl}${companies}${summary}${expenses}`;
    if ($('#costEditor')) renderCostEditor(Number(form.company_id.value), r.from, r.to);
    $('#reportOut').querySelectorAll('[data-toggle]').forEach((b) => {
      b.onclick = () => {
        const open = b.getAttribute('aria-expanded') !== 'true';
        b.setAttribute('aria-expanded', String(open));
        b.textContent = open ? '－' : '＋';
        $('#reportOut').querySelectorAll(`tr[data-parent="${b.dataset.toggle}"]`).forEach((tr) => tr.classList.toggle('hidden', !open));
      };
    });
    $('#whyColl')?.addEventListener('click', () => $('#reportOut .memo-why').classList.toggle('hidden'));
    $('#reportOut').querySelectorAll('[data-pl]').forEach((cb) => {
      cb.onchange = async () => {
        const c = company();
        const coll = new Set(c.coll_excluded || []), others = new Set(c.others_excluded || []);
        const set = cb.dataset.pl === 'coll' ? coll : others;
        if (cb.checked) set.delete(cb.dataset.head); else set.add(cb.dataset.head);
        try {
          const res = await api(`/api/companies/${state.companyId}/pl-excluded`, { method: 'PUT', body: { coll: [...coll], others: [...others] } });
          c.coll_excluded = res.coll_excluded; c.others_excluded = res.others_excluded;
          toast(`${cb.dataset.head} ${cb.checked ? 'counted in' : 'left out of'} profit`);
          runReport();
        } catch (e) { toast(e.message); }
      };
    });
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

// ---------- deposits & expenses (always the company chosen in the sidebar) ----------
$('#cashForm').addEventListener('submit', (ev) => { ev.preventDefault(); runCash(); });
$('#cashForm').querySelectorAll('[data-range]').forEach((b) => { b.onclick = () => { setRange($('#cashForm'), b.dataset.range); runCash(); }; });

async function runCash() {
  const form = $('#cashForm');
  $('#cashCompany').textContent = company()?.name || '';
  const q = `company_id=${state.companyId}&${qs(form)}`;
  $('#cashXlsx').href = `/api/cashflow/export.xlsx?${q}`;
  $('#cashOut').innerHTML = '<div class="card muted">Loading…</div>';
  try {
    const r = await api(`/api/reports?${q}`);
    const t = r.total;
    if (!r.rows.length) { $('#cashOut').innerHTML = '<div class="card muted">No days entered in this range yet.</div>'; return; }
    const P = r.rows;
    const head = (name) => `<thead><tr><th>${name}</th>${P.map((p) => `<th>${esc(p.label)}</th>`).join('')}<th>Total</th></tr></thead>`;
    const line = (label, get, cls = '', attrs = '') => `<tr class="${cls}" ${attrs}><td>${label}</td>${P.map((p) => `<td>${fmt(get(p)) || '–'}</td>`).join('')}<td><b>${fmt(get(t)) || '–'}</b></td></tr>`;
    const table = (title, name, rows) => `<div class="card"><h3>${title}</h3><div class="table-wrap"><table class="pl">${head(name)}<tbody>${rows}</tbody></table></div></div>`;

    const tiles = [['Total deposits', t.cash.deposits], ['Bank', t.BANK], ['PTM (Paytm)', t.PTM], ['UPI', t.UPI],
      ['Party payments', t.cash.parties], ['Operating expenses', t.PEXP], ['Total paid out (T-Exp)', t.M], ['Days', t.days, 0]]
      .map(([k, v, d]) => `<div><span>${k}</span><b>${d === 0 ? v : money(v)}</b></div>`).join('');

    const deposits = table('Deposits', 'Deposit', [
      line('Bank', (x) => x.BANK), line('PTM (Paytm)', (x) => x.PTM), line('UPI', (x) => x.UPI), line('Total deposits', (x) => x.cash.deposits, 'sub'),
    ].join(''));
    const parties = table('Party payments', 'Party', [
      line('T-Sale', (x) => x.TSALE), line('Fleet', (x) => x.FLEET), line('R-Babu', (x) => x.RBABU), line('Ranjit', (x) => x.RANJIT),
      line('Others', (x) => x.OTHERS), line('Total party payments', (x) => x.cash.parties, 'sub'),
    ].join(''));
    const heads = t.pl.expenseLines.map((e) => e.label);
    const amt = (x, h) => x.pl.expenseLines.find((e) => e.label === h)?.amount;
    const expenses = table('Operating expenses by head <span class="muted small">(click a head to see every entry in the Ledger)</span>', 'Expense head', [
      ...heads.map((h) => line(esc(h), (x) => (x === t ? t.pl.expenseLines.find((e) => e.label === h).amount : amt(x, h)), 'clickable', `data-head="${esc(h)}"`)),
      line('Total operating expenses', (x) => x.PEXP, 'sub'),
    ].join(''));

    $('#cashOut').innerHTML = `<div class="card"><div class="muted small">${esc(r.from || '')} to ${esc(r.to || '')}</div><div class="totals">${tiles}</div></div>${deposits}${parties}${expenses}`;
    $('#cashOut').querySelectorAll('[data-head]').forEach((tr) => {
      tr.onclick = () => {
        const lf = $('#ledgerForm');
        lf.company_id.value = state.companyId; lf.from.value = form.from.value; lf.to.value = form.to.value;
        lf.side.value = 'out'; lf.col.value = 'PEXP'; lf.q.value = tr.dataset.head;
        state.ledgerLoaded = true; showTab('ledger'); runLedger();
      };
    });
  } catch (e) { $('#cashOut').innerHTML = `<div class="card err">${esc(e.message)}</div>`; }
}


// ---------- cash reconciliation (month-end summary, any date range) ----------
const RF = () => $('#reconForm');
function reconRange(kind) {
  const f = RF();
  markRange(f, kind);
  if (kind === 'prev') {
    const m = state.summary?.month;
    const base = m ? new Date(m.year, m.month - 2, 1) : new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1);
    f.from.value = d2(base);
    f.to.value = d2(new Date(base.getFullYear(), base.getMonth() + 1, 0));
  } else setRange(f, kind);
  f.month.value = f.from.value.slice(0, 8) === f.to.value.slice(0, 8) && f.from.value.endsWith('-01') ? f.from.value.slice(0, 7) : '';
}
RF().month.addEventListener('change', (ev) => {
  const v = ev.target.value;
  if (!v) return;
  const [y, m] = v.split('-').map(Number);
  markRange(RF(), null);
  RF().from.value = `${v}-01`;
  RF().to.value = d2(new Date(y, m, 0));
  runRecon();
});
for (const n of ['from', 'to']) RF()[n].addEventListener('change', () => { RF().month.value = ''; });
RF().querySelectorAll('[data-range]').forEach((b) => { b.onclick = () => { reconRange(b.dataset.range); runRecon(); }; });
RF().addEventListener('submit', (ev) => { ev.preventDefault(); runRecon(); });

const MONTH_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function reconTitle(from, to) {
  if (!from || !to) return 'All dates';
  const [y, m, d] = from.split('-').map(Number);
  if (d === 1 && to === d2(new Date(y, m, 0))) return `${MONTH_FULL[m - 1]}-${String(y).slice(2)}`;
  return `${from.split('-').reverse().join('-')} to ${to.split('-').reverse().join('-')}`;
}

async function reportTotal(from, to) {
  return (await api(`/api/reports?company_id=${state.companyId}&from=${from}&to=${to}&group=year`)).total;
}
const wholeMonth = (from, to) => {
  if (!from || !to || !from.endsWith('-01')) return null;
  const [y, m] = from.split('-').map(Number);
  return to === d2(new Date(y, m, 0)) ? { y, m } : null;
};
// Cash balance of the month before `from`, from its daily entries or its saved month-end figures.
async function previousClosing(from) {
  const [y, m] = from.split('-').map(Number);
  const p = new Date(y, m - 2, 1);
  const pf = d2(p), pt = d2(new Date(p.getFullYear(), p.getMonth() + 1, 0));
  let t = await reportTotal(pf, pt);
  if (!t.days) t = await api(`/api/companies/${state.companyId}/summaries/${p.getFullYear()}/${p.getMonth() + 1}/total`);
  if (!t) return null;
  return { label: reconTitle(pf, pt), balance: reconBalance(t).balance };
}
function reconBalance(t) {
  const fuelAmt = ['HSD', 'MS'].reduce((s, f) => s + ((t.fuelByRate?.[f]) || []).reduce((x, g) => x + g.amount, 0), 0);
  const inTotal = (Number(t.opening) || 0) + fuelAmt + (Number(t.COFFEE) || 0) + (Number(t.LUB) || 0) + (Number(t.COLL) || 0);
  const outTotal = ['BANK', 'PTM', 'UPI', 'TSALE', 'FLEET', 'RANJIT', 'RBABU', 'OTHERS', 'PEXP'].reduce((s, k) => s + (Number(t[k]) || 0), 0);
  return { inTotal, outTotal, balance: inTotal - outTotal };
}

async function runRecon() {
  const f = RF();
  $('#reconCompany').textContent = company()?.name || '';
  const q = `company_id=${state.companyId}&from=${f.from.value}&to=${f.to.value}`;
  $('#reconXlsx').href = `/api/recon/export.xlsx?${q}`;
  $('#reconOut').innerHTML = '<div class="card muted">Loading…</div>';
  try {
    let t = await reportTotal(f.from.value, f.to.value);
    const wm = wholeMonth(f.from.value, f.to.value);
    if (!t.days && wm) {
      const sm = await api(`/api/companies/${state.companyId}/summaries/${wm.y}/${wm.m}/total`);
      if (sm) t = sm;
    }
    if (!t.days && !t.fromSummary) {
      $('#reconOut').innerHTML = `<div class="card muted">No days entered in this range yet.${wm ? ` If this month was kept outside the system, you can <button class="small" id="enterSummary">enter its month-end figures</button>.` : ''}</div>`;
      $('#enterSummary')?.addEventListener('click', () => openSummaryForm(wm, null));
      return;
    }
    const dmy = (v) => v.split('-').reverse().join('-');
    const fuelRows = (fuel) => {
      const list = t.fuelByRate?.[fuel] || [];
      if (!list.length) return [[fuel, null, null, null]];
      return list.map((g) => [fuel, g.units, g.rate, g.amount, list.length > 1 ? `${dmy(g.from)} to ${dmy(g.to)}` : null]);
    };
    const prev = t.fromSummary || !f.from.value.endsWith('-01') ? null : await previousClosing(f.from.value);
    const obNote = prev ? `Previous month (${prev.label}) closed at ${fmt(prev.balance)}${Math.abs(prev.balance - t.opening) > 1 ? ` — difference ${fmt(t.opening - prev.balance)}` : ' ✓'}` : (t.firstDate && !t.fromSummary ? `Opening of ${dmy(t.firstDate)}` : null);
    const left = [
      ['Opening Cash', null, null, t.opening, obNote, prev && Math.abs(prev.balance - t.opening) > 1],
      ...fuelRows('HSD'), ...fuelRows('MS'),
      ['Coffee', null, null, t.COFFEE], ['Lubricant', null, null, t.LUB], ['Collection', null, null, t.COLL],
    ];
    const right = [['Bank', t.BANK], ['PTM', t.PTM], ['UPI', t.UPI], ['Tankar Sale', t.TSALE], ...(t.FLEET ? [['Fleet', t.FLEET]] : []),
      ['Ranjit Ji', t.RANJIT], ['Rajeshwar Babu', t.RBABU], ['Others', t.OTHERS], ['Pump Expenses', t.PEXP]];
    const { inTotal, outTotal, balance } = reconBalance(t);
    const n = Math.max(left.length, right.length);
    let rows = '';
    for (let i = 0; i < n; i++) {
      const l = left[i], r = right[i];
      rows += `<tr>
        <td>${l ? esc(l[0]) : ''}${l?.[4] ? `<div class="small ${l[5] ? 'neg' : 'muted'}">${esc(l[4])}</div>` : ''}</td><td>${l ? fmt(l[1]) : ''}</td><td>${l ? fmt(l[2]) : ''}</td><td>${l ? fmt(l[3]) : ''}</td>
        <td class="gap"></td><td>${r ? esc(r[0]) : ''}</td><td>${r ? fmt(r[1]) || '0.00' : ''}</td></tr>`;
    }
    const cash = t.lastCash ?? null;
    const diff = cash === null ? null : cash - balance;
    const cashNote = cash === null ? '' : `
      <tr><td colspan="5"></td><td>Closing balance on the report (${dmy(t.lastDate)})</td><td>${fmt(cash)}</td></tr>
      <tr class="${Math.abs(diff) > 1 ? 'recon-bad' : 'recon-ok'}"><td colspan="5"></td><td>Difference</td><td>${fmt(diff) || '0.00'}</td></tr>`;
    // Real differences (₹1 or more) listed by day; paise-level rounding lumped together, plus the
    // small effect of the sheet using units × rate for HSD/MS, so the table adds up to the difference.
    const big = (t.gaps || []).filter((g) => Math.abs(g.amount) >= 1);
    const small = (t.gaps || []).filter((g) => Math.abs(g.amount) < 1);
    const bigSum = big.reduce((s2, g) => s2 + g.amount, 0);
    const rounding = diff === null ? 0 : Math.round((diff - bigSum) * 100) / 100;
    const gapRows = big.map((g) => `<tr><td>${dmy(g.date)}</td><td>${g.kind === 'day'
      ? "This day's closing balance doesn't match its own rows (inflow − expenses)"
      : "Opening cash differs from the previous day's closing balance"}</td><td>${money(g.amount)}</td></tr>`).join('')
      + (Math.abs(rounding) >= 0.01 ? `<tr><td class="muted">${small.length} small</td><td class="muted">Paise rounding on the reports, and HSD/MS worked out as units × rate</td><td>${money(rounding)}</td></tr>` : '');
    const why = cash !== null && Math.abs(diff) > 1
      ? `<div class="fix-item warn" style="margin-top:12px">
         <div><b>Why the difference:</b> the Cash Balance is worked out from the day-by-day figures, while the closing balance is the cash the last day's report says was left at the pump. The difference is made up exactly of these days:</div>
         <table class="pl" style="margin:6px 0"><thead><tr><th>Date</th><th>What happened</th><th>Amount</th></tr></thead><tbody>${gapRows}</tbody>
           <tfoot><tr><td></td><td><b>Total (= difference)</b></td><td><b>${money(bigSum + rounding)}</b></td></tr></tfoot></table>
         <div><b>How to fix:</b> open those days (see the Errors menu). Red days: an amount was typed or printed wrong. Amber opening differences: correct the opening cash, or press “Accept difference” if cash really was added or taken out — accepted differences still show here, because they are real cash movements outside the sheet.</div></div>` : '';
    const source = t.fromSummary
      ? `<span class="muted small">Month-end figures entered by hand</span> <button class="small" id="editSummary">Edit figures</button>`
      : `<span class="muted small">${t.days} day(s), ${t.verified} verified</span>`;
    $('#reconOut').innerHTML = `<div class="card">
      <div class="row-between"><h3>Cash reconcillation-${esc(reconTitle(f.from.value, f.to.value))}</h3><span>${source}</span></div>
      <div class="table-wrap"><table class="recon">
        <thead><tr><th></th><th>Unit</th><th>Rate</th><th>Amount</th><th class="gap"></th><th>Particulars</th><th>Amount</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot>
          <tr class="tot"><td>Total</td><td></td><td></td><td>${fmt(inTotal)}</td><td class="gap"></td><td>Total</td><td>${fmt(outTotal)}</td></tr>
          <tr class="tot"><td colspan="5"></td><td>Cash Balance</td><td>${money(balance)}</td></tr>
          ${cashNote}
        </tfoot>
      </table></div>${why}</div>`;
    $('#editSummary')?.addEventListener('click', async () => openSummaryForm(wm, (await api(`/api/companies/${state.companyId}/summaries/${wm.y}/${wm.m}`))?.figures));
  } catch (e) { $('#reconOut').innerHTML = `<div class="card err">${esc(e.message)}</div>`; }
}

// Month-end figures for a month kept outside the daily sheet (typed from the old reconciliation).
function openSummaryForm(wm, fig) {
  const v = fig || {};
  const fuelRow = (fuel, g = {}) => `<div class="fields fuel-row" data-fuel="${fuel}"><label>${fuel} units <input name="units" type="text" inputmode="decimal" autocomplete="off" value="${g.units ?? ''}"></label><label>Rate <input name="rate" type="text" inputmode="decimal" autocomplete="off" value="${g.rate ?? ''}"></label></div>`;
  const inp = (k, label) => `<label>${label} <input name="${k}" type="text" inputmode="decimal" autocomplete="off" value="${v[k] ?? ''}"></label>`;
  $('#reconOut').innerHTML = `<div class="card"><h3>Month-end figures — ${esc(MONTH_FULL[wm.m - 1])} ${wm.y}</h3>
    <form id="summaryForm" class="form" style="padding:0">
      <div class="fields">${inp('opening', 'Opening cash')}</div>
      <div id="fuelRows">${(v.hsd?.length ? v.hsd : [{}]).map((g) => fuelRow('HSD', g)).join('')}${(v.ms?.length ? v.ms : [{}]).map((g) => fuelRow('MS', g)).join('')}</div>
      <div><button type="button" class="small" data-addfuel="HSD">+ HSD at another rate</button> <button type="button" class="small" data-addfuel="MS">+ MS at another rate</button></div>
      <div class="fields">${inp('coffee', 'Coffee')}${inp('lub', 'Lubricant')}${inp('coll', 'Collection')}</div>
      <div class="fields">${inp('bank', 'Bank')}${inp('ptm', 'PTM')}${inp('upi', 'UPI')}${inp('tsale', 'Tankar sale')}${inp('fleet', 'Fleet')}${inp('ranjit', 'Ranjit Ji')}${inp('rbabu', 'Rajeshwar Babu')}${inp('others', 'Others')}${inp('pexp', 'Pump expenses')}</div>
      <div class="review-actions"><button type="button" id="cancelSummary">Cancel</button><span class="spacer"></span><button class="primary">Save figures</button></div>
    </form></div>`;
  document.querySelectorAll('[data-addfuel]').forEach((b) => { b.onclick = () => $('#fuelRows').insertAdjacentHTML('beforeend', fuelRow(b.dataset.addfuel)); });
  $('#cancelSummary').onclick = () => runRecon();
  $('#summaryForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const form = ev.target;
    const body = Object.fromEntries(SUMMARY_FIELDS.map((k) => [k, form[k].value]));
    const fuel = (name) => [...form.querySelectorAll(`.fuel-row[data-fuel="${name}"]`)].map((r) => ({ units: r.querySelector('[name=units]').value, rate: r.querySelector('[name=rate]').value }));
    body.hsd = fuel('HSD'); body.ms = fuel('MS');
    try { await api(`/api/companies/${state.companyId}/summaries/${wm.y}/${wm.m}`, { method: 'PUT', body }); toast('Month-end figures saved'); runRecon(); } catch (e) { toast(e.message); }
  });
}
const SUMMARY_FIELDS = ['opening', 'coffee', 'lub', 'coll', 'bank', 'ptm', 'upi', 'tsale', 'fleet', 'ranjit', 'rbabu', 'others', 'pexp'];

// Purchase cost per litre, per month, entered from the P&L itself — as the cost, or as the dealer
// margin per litre (cost = selling rate − margin). New months copy it from the month before.
async function renderCostEditor(companyId, from, to) {
  const months = (await api(`/api/months?company_id=${companyId}`)).filter((m) => {
    const key = `${m.year}-${String(m.month).padStart(2, '0')}`;
    return (!from || key >= from.slice(0, 7)) && (!to || key <= to.slice(0, 7));
  }).sort((a, b) => a.year - b.year || a.month - b.month);
  const margin = (rate, cost) => (rate && cost ? (Number(rate) - Number(cost)).toFixed(2) : '');
  $('#costEditor').innerHTML = `<p class="small" style="margin:0 0 6px">The daily images only show the <b>selling</b> rate. Enter what the pump pays per litre — or the dealer margin per litre, and the cost is worked out.</p>
    <table class="pl" style="max-width:820px"><thead><tr><th>Month</th><th>HSD cost / ltr</th><th>or HSD margin</th><th>MS cost / ltr</th><th>or MS margin</th><th></th></tr></thead><tbody>
    ${months.map((m) => `<tr data-mid="${m.id}" data-hr="${m.hsd_rate ?? ''}" data-mr="${m.ms_rate ?? ''}"><td>${esc(m.title)}<div class="muted small">selling HSD ${fmt(m.hsd_rate) || '—'} · MS ${fmt(m.ms_rate) || '—'}</div></td>
      <td><input name="hsd_cost" type="text" inputmode="decimal" autocomplete="off" value="${m.hsd_cost ?? ''}"></td>
      <td><input name="hsd_margin" type="text" inputmode="decimal" autocomplete="off" value="${margin(m.hsd_rate, m.hsd_cost)}" placeholder="e.g. 3.20"></td>
      <td><input name="ms_cost" type="text" inputmode="decimal" autocomplete="off" value="${m.ms_cost ?? ''}"></td>
      <td><input name="ms_margin" type="text" inputmode="decimal" autocomplete="off" value="${margin(m.ms_rate, m.ms_cost)}" placeholder="e.g. 4.10"></td>
      <td><button class="small primary" data-savecost>Save</button></td></tr>`).join('')}</tbody></table>`;
  $('#costEditor').querySelectorAll('tr[data-mid]').forEach((tr) => {
    // Typing a margin fills the cost from the selling rate, and the other way round.
    for (const f of ['hsd', 'ms']) {
      const rate = Number(tr.dataset[f === 'hsd' ? 'hr' : 'mr']);
      const cost = tr.querySelector(`[name=${f}_cost]`), mar = tr.querySelector(`[name=${f}_margin]`);
      mar.addEventListener('input', () => { const m = parseAmount(mar.value); if (rate && m !== null && !Number.isNaN(m)) cost.value = (rate - m).toFixed(2); });
      cost.addEventListener('input', () => { const c = parseAmount(cost.value); mar.value = rate && c !== null && !Number.isNaN(c) ? (rate - c).toFixed(2) : ''; });
    }
  });
  $('#costEditor').querySelectorAll('[data-savecost]').forEach((b) => {
    b.onclick = async () => {
      const tr = b.closest('tr');
      try {
        await api(`/api/months/${tr.dataset.mid}`, { method: 'PATCH', body: { hsd_cost: tr.querySelector('[name=hsd_cost]').value, ms_cost: tr.querySelector('[name=ms_cost]').value } });
        toast('Purchase cost saved — next months will start with the same figures'); runReport();
      } catch (e) { toast(e.message); }
    };
  });
}

// ---------- errors: everything open, grouped, with why and how to fix ----------
const ERR_GROUPS = [
  { id: 'totals', title: 'Totals don’t add up', note: 'The rows typed for a day don’t match the totals printed on its image.', match: (c) => ['inflow', 'expense', 'cash'].includes(c.id) },
  { id: 'fuel', title: 'HSD / MS units × rate', note: 'A fuel row’s units × rate is not its amount.', match: (c) => c.id === 'HSD_amt' || c.id === 'MS_amt' },
  { id: 'opening', title: 'Opening cash differences', note: 'A day opens with different cash than the previous day ended with.', match: (c) => c.id === 'ob' },
  { id: 'dates', title: 'Dates', note: 'Missing days, days without a date, or two entries on one date.', match: (c) => c.id === 'date' },
];
$('#errForm').addEventListener('submit', (ev) => { ev.preventDefault(); runErrors(); });
$('#errForm').querySelectorAll('[data-range]').forEach((b) => { b.onclick = () => { setRange($('#errForm'), b.dataset.range); runErrors(); }; });

async function refreshErrCount() {
  if (!state.companyId) return;
  try {
    const r = await api(`/api/issues?company_id=${state.companyId}`);
    const n = r.checks.filter((x) => x.check.status === 'error').length + r.undated.length;
    $('#errCount').textContent = n;
    $('#errCount').classList.toggle('hidden', !n);
  } catch { /* the count is a convenience */ }
}

async function runErrors() {
  const f = $('#errForm');
  $('#errCompany').textContent = company()?.name || '';
  $('#errOut').innerHTML = '<div class="card muted">Checking…</div>';
  try {
    const r = await api(`/api/issues?company_id=${state.companyId}&from=${f.from.value}&to=${f.to.value}`);
    const dmy = (v) => v.split('-').reverse().join('-');
    const item = (x) => {
      const ex = explain(x.check, { lines: x.lines, computed: { checks: x.checks } }) || { why: x.check.detail || x.check.label, fix: '' };
      const accept = x.check.id === 'ob' && !x.locked ? `<button class="small" data-accept="${x.entryId}" data-diff="${x.check.diff}">Accept difference of ${fmt(-x.check.diff) || '0.00'}</button>` : '';
      return `<div class="fix-item ${x.check.status}">
        <div class="fix-title">${badge(x.check.status)} ${esc(dmy(x.date))} · ${esc(x.check.label)}</div>
        <div><b>Why:</b> ${esc(ex.why)}</div>
        <div><b>How to fix:</b> ${esc(ex.fix)}</div>
        ${ex.clues?.length ? `<ul>${ex.clues.map((k) => `<li>${esc(k)}</li>`).join('')}</ul>` : ''}
        <div class="err-actions"><button class="small primary" data-openid="${x.entryId}">Open this day</button>${accept}${x.locked ? '<span class="muted small">sent to Tally — locked</span>' : ''}</div>
      </div>`;
    };
    let html = '';
    let total = 0;
    for (const g of ERR_GROUPS) {
      const list = r.checks.filter((x) => g.match(x.check));
      let extra = '';
      if (g.id === 'dates') {
        extra += r.undated.map((u) => `<div class="fix-item error"><div class="fix-title">${badge('error')} Image without a date${u.image ? ` (${esc(u.image)})` : ''}</div>
          <div><b>Why:</b> the image was saved without a day, so it is not in any sheet or report.</div>
          <div><b>How to fix:</b> open it and set the Day printed on the image.</div>
          <div class="err-actions"><button class="small primary" data-openid="${u.entryId}">Open</button></div></div>`).join('');
        if (r.missing.length) {
          extra += `<div class="fix-item warn"><div class="fix-title">${badge('warn')} ${r.missing.length} day(s) with no entry</div>
            <div><b>Why:</b> nothing has been uploaded or typed for these dates, so the month is incomplete and totals are short.</div>
            <div><b>How to fix:</b> upload the day’s image, or click a date to type it in by hand.</div>
            <div class="err-actions">${r.missing.map((m) => `<button class="small" data-missing="${m.date}">${esc(dmy(m.date))}</button>`).join(' ')}</div></div>`;
        }
      }
      const count = list.length + (g.id === 'dates' ? r.undated.length + (r.missing.length ? 1 : 0) : 0);
      total += count;
      html += `<div class="card err-group"><div class="row-between"><h3>${esc(g.title)} ${count ? `<span class="badge b-${list.some((x) => x.check.status === 'error') || (g.id === 'dates' && r.undated.length) ? 'error' : 'warn'}">${count}</span>` : '<span class="badge b-ok">none</span>'}</h3>
        <span class="muted small">${esc(g.note)}</span></div>
        <div class="err-list">${list.map(item).join('')}${extra}${count ? '' : '<div class="muted">Nothing to fix here.</div>'}</div></div>`;
    }
    const unv = r.unverified;
    html += `<div class="card err-group"><div class="row-between"><h3>Waiting for review ${unv.length ? `<span class="badge b-review">${unv.length}</span>` : '<span class="badge b-ok">none</span>'}</h3>
      <span class="muted small">Days not yet marked verified. Only verified days go to Tally.</span></div>
      ${unv.length ? `<div class="fix-item warn"><div><b>Why:</b> these days have not been checked against their image.</div>
      <div><b>How to fix:</b> open each day, compare it with its image, fix anything red, then press “Save &amp; mark verified”.</div>
      <div class="err-actions">${unv.map((u) => `<button class="small" data-openid="${u.entryId}">${esc(dmy(u.date))}${u.errors ? ' ⚠' : ''}</button>`).join(' ')}</div></div>` : '<div class="muted">All days are verified.</div>'}</div>`;
    $('#errOut').innerHTML = (total ? '' : '<div class="card fix-list ok"><b>No errors in this range.</b></div>') + html;
    $('#errOut').querySelectorAll('[data-openid]').forEach((b) => { b.onclick = () => openReview(Number(b.dataset.openid)); });
    $('#errOut').querySelectorAll('[data-missing]').forEach((b) => { b.onclick = () => enterManually(b.dataset.missing); });
    $('#errOut').querySelectorAll('[data-accept]').forEach((b) => {
      b.onclick = async () => {
        try { await api(`/api/entries/${b.dataset.accept}/accept-ob`, { method: 'POST', body: { diff: Number(b.dataset.diff) } }); toast('Difference accepted'); if (state.monthId) await loadSummary(); runErrors(); } catch (e) { toast(e.message); }
      };
    });
  } catch (e) { $('#errOut').innerHTML = `<div class="card err">${esc(e.message)}</div>`; }
}
// The Errors list refreshes when the review form closes, so fixed items vanish at once.
$('#review').addEventListener('close', () => { if (state.tab === 'errors') runErrors(); refreshErrCount(); });

// ---------- Tally export ----------
const VOUCHER_TYPES = ['Sales', 'Receipt', 'Payment', 'Contra', 'Journal'];
async function openTally() {
  $('#tallyCompany').textContent = company()?.name || '';
  const f = $('#tallyForm');
  if (!f.from.value) setRange(f, 'month');
  try {
    state.tally = await api(`/api/tally/${state.companyId}/settings`);
    renderTallySettings();
    renderBatches();
    $('#tallyPreview').innerHTML = '';
  } catch (e) { toast(e.message); }
}

function renderTallySettings() {
  const t = state.tally;
  $('#tallyFormat').value = t.format || 'xml';
  $('#tallyCompanyName').value = t.tally_company || '';
  const isXml = (t.format || 'xml') === 'xml';
  $('#xmlHelp').classList.toggle('hidden', !isXml);
  $('#tplBlock').classList.toggle('hidden', isXml);
  $('#tplInfo').innerHTML = t.has_template
    ? `Using <b>${esc(t.template_name)}</b> (sheet “${esc(t.sheet)}”, headings on row ${t.header_row}). Match each column of your template to what should go in it:`
    : 'No template uploaded — the file will use a simple layout: Date, Voucher Type, Voucher No, Debit Ledger, Credit Ledger, Amount, Quantity, Rate, Narration. Upload your Tally import Excel to use its columns instead.';
  $('#tplRemove').classList.toggle('hidden', !t.has_template);
  const opts = (sel) => `<option value="">— leave empty —</option>` + Object.entries(t.fields).map(([k, v]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${esc(v)}</option>`).join('');
  $('#tplMap').innerHTML = t.has_template ? `<table class="pl" style="max-width:640px"><thead><tr><th>Template column</th><th>Heading</th><th>Fill with</th></tr></thead><tbody>
    ${t.headers.map((h) => `<tr><td>${esc(h.letter)}</td><td>${esc(h.text)}</td><td><select data-tplcol="${esc(h.letter)}">${opts(t.columns[h.letter])}</select></td></tr>`).join('')}</tbody></table>
    <p class="muted small">If your template has one “Ledger” column with “Dr/Cr”, each voucher is written as two rows (debit, then credit).</p>` : '';
  $('#cashLedger').value = t.cash_ledger || 'Cash';
  const cols = [...state.meta.inflowCols.filter((c) => c.key !== 'OB'), ...state.meta.expenseCols];
  $('#ledgerMap').innerHTML = `<table class="pl" style="max-width:900px"><thead><tr><th>Sheet column</th><th>Tally ledger</th><th>Voucher type</th><th>Tally group (for new ledgers)</th></tr></thead><tbody>
    ${cols.map((c) => { const l = t.ledgers[c.key] || {}; const g = t.groups[c.key]; return `<tr data-lcol="${c.key}"><td>${esc(c.label)}</td>
      <td><input name="ledger" value="${esc(l.ledger || '')}" placeholder="use the particulars as ledger"></td>
      <td><select name="voucher">${VOUCHER_TYPES.map((v) => `<option ${v === l.voucher ? 'selected' : ''}>${v}</option>`).join('')}</select></td>
      <td><select name="group">${t.tallyGroups.map((x) => `<option ${x === g ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></td></tr>`; }).join('')}</tbody></table>
    <p class="muted small">Ledger names must match Tally exactly (spelling and spaces). The group is only used when the ledger masters file creates a ledger that isn't in Tally yet.</p>`;
}

function collectTallySettings() {
  const columns = {};
  document.querySelectorAll('[data-tplcol]').forEach((s2) => { columns[s2.dataset.tplcol] = s2.value; });
  const ledgers = {};
  const groups = {};
  document.querySelectorAll('[data-lcol]').forEach((tr) => {
    ledgers[tr.dataset.lcol] = { ledger: tr.querySelector('[name=ledger]').value.trim(), voucher: tr.querySelector('[name=voucher]').value };
    groups[tr.dataset.lcol] = tr.querySelector('[name=group]').value;
  });
  const labels = { ...(state.tally.labels || {}) };
  document.querySelectorAll('[data-label]').forEach((i) => { const v = i.value.trim(); if (v) labels[i.dataset.label] = v; else delete labels[i.dataset.label]; });
  return { columns: state.tally.has_template ? columns : {}, ledgers, labels, groups, cash_ledger: $('#cashLedger').value.trim() || 'Cash',
    format: $('#tallyFormat').value, tally_company: $('#tallyCompanyName').value.trim() };
}
async function saveTally(quiet) {
  const t = state.tally;
  if (t.has_template && $('#tallyFormat').value === 'xlsx') {
    const used = Object.values(collectTallySettings().columns);
    const hasLedger = used.includes('ledger') || (used.includes('dr_ledger') && used.includes('cr_ledger'));
    const hasAmount = used.includes('amount') || used.includes('debit') || used.includes('credit');
    if (!used.includes('date') || !hasLedger || !hasAmount) { toast('The template needs at least a Date, the ledger(s), and an Amount (or Debit/Credit) column'); return false; }
  }
  state.tally = await api(`/api/tally/${state.companyId}/settings`, { method: 'PUT', body: collectTallySettings() });
  renderTallySettings();
  if (!quiet) toast('Tally settings saved');
  return true;
}
$('#tallySave').onclick = () => saveTally(false).catch((e) => toast(e.message));
$('#tallyFormat').onchange = () => { state.tally.format = $('#tallyFormat').value; saveTally(true).then(() => toast('Format saved')).catch((e) => toast(e.message)); };
$('#tplUpload').onclick = async () => {
  const file = $('#tplFile').files[0];
  if (!file) return toast('Choose your Tally template (.xlsx) first');
  const fd = new FormData(); fd.append('file', file);
  try { state.tally = await api(`/api/tally/${state.companyId}/template`, { method: 'POST', body: fd }); renderTallySettings(); toast('Template read — check the column matching, then save'); } catch (e) { toast(e.message); }
};
$('#tplRemove').onclick = async () => {
  if (!confirm('Remove the template and use the default layout?')) return;
  state.tally = await api(`/api/tally/${state.companyId}/template`, { method: 'DELETE' }); renderTallySettings();
};
$('#tallyForm').querySelectorAll('[data-range]').forEach((b) => { b.onclick = () => setRange($('#tallyForm'), b.dataset.range); });
$('#tallyForm').addEventListener('submit', (ev) => { ev.preventDefault(); tallyPreview(); });

async function tallyPreview() {
  const f = $('#tallyForm');
  if (!(await saveTally(true).catch((e) => { toast(e.message); return false; }))) return;
  const q = `from=${f.from.value}&to=${f.to.value}&include_errors=${f.include_errors.checked ? 1 : 0}`;
  $('#tallyPreview').innerHTML = '<p class="muted">Preparing…</p>';
  try {
    const p = await api(`/api/tally/${state.companyId}/preview?${q}`);
    const dmy = (v) => v.split('-').reverse().join('-');
    const dayBtns = (list, extra = () => '') => list.map((x) => `<button class="small" data-openid="${x.entryId}">${esc(dmy(x.date))}${extra(x)}</button>`).join(' ');
    // Particulars that fall to "use the particulars" — list them so a Tally ledger can be set for each.
    const labelSet = [...new Set(p.vouchers.filter((v) => !((state.tally.ledgers[colOf(v)] || {}).ledger)).map((v) => String(v.particulars || '').toUpperCase().replace(/\s+/g, ' ').trim()))].sort();
    $('#labelMap').innerHTML = labelSet.length ? `<table class="pl" style="max-width:640px"><thead><tr><th>Particulars on the image</th><th>Tally ledger (blank = same name)</th></tr></thead><tbody>
      ${labelSet.map((l) => `<tr><td>${esc(l)}</td><td><input data-label="${esc(l)}" value="${esc((state.tally.labels || {})[l] || '')}" placeholder="${esc(l)}"></td></tr>`).join('')}</tbody></table>` : 'No particulars need a ledger name.';
    const excluded = `
      ${p.unverified.length ? `<div class="fix-item warn"><b>${p.unverified.length} day(s) left out — not reviewed yet.</b> Open each, check it, and press “Save &amp; mark verified”:<div class="err-actions">${dayBtns(p.unverified, (x) => (x.errors ? ' ⚠' : ''))}</div></div>` : ''}
      ${p.withErrors.length ? `<div class="fix-item error"><b>${p.withErrors.length} verified day(s) left out — they still show red mismatches.</b> Fix them, or tick “Also include verified days that still show red mismatches”.<div class="err-actions">${dayBtns(p.withErrors)}</div></div>` : ''}
      ${p.exported.length ? `<div class="fix-item"><b>${p.exported.length} day(s) already sent to Tally</b> (not repeated): ${p.exported.map((x) => `${esc(dmy(x.date))} (batch #${x.batch})`).join(', ')}</div>` : ''}`;
    const vrows = p.vouchers.slice(0, 200).map((v) => `<tr><td>${esc(dmy(v.date))}</td><td>${esc(v.voucher_type)}</td><td>${esc(v.voucher_no)}</td><td>${esc(v.dr_ledger)}</td><td>${esc(v.cr_ledger)}</td><td>${fmt(v.amount)}</td><td>${esc(v.particulars)}</td></tr>`).join('');
    $('#tallyPreview').innerHTML = `<div class="err-list">${excluded}</div>
      <div class="totals"><div><span>Days going to Tally</span><b>${p.included.length}</b></div><div><span>Vouchers</span><b>${p.totals.vouchers}</b></div>
        <div><span>Total debit</span><b>${fmt(p.totals.debit) || '0.00'}</b></div><div><span>Total credit</span><b>${fmt(p.totals.credit) || '0.00'}</b></div>
        <div><span>Ledgers used</span><b>${Object.keys(p.ledgers).length}</b></div></div>
      ${p.vouchers.length ? `<div class="table-wrap" style="max-height:420px;margin-top:10px"><table class="sheet"><thead><tr><th>Date</th><th>Type</th><th>Voucher no</th><th>Debit ledger</th><th>Credit ledger</th><th>Amount</th><th>Particulars</th></tr></thead><tbody>${vrows}</tbody></table></div>
        ${p.vouchers.length > 200 ? `<p class="muted small">Showing 200 of ${p.vouchers.length}.</p>` : ''}
        <div class="review-actions" style="position:static"><span class="muted small">Check the ledger names above match Tally exactly. Creating the file locks these ${p.included.length} day(s).</span><span class="spacer"></span>
        ${$('#tallyFormat').value === 'xml' ? `<a class="btn" href="/api/tally/${state.companyId}/masters.xml?from=${f.from.value}&to=${f.to.value}" title="Import once in Tally: Import of Data → Masters">Ledger masters (XML)</a>` : ''}
        <button class="primary" id="tallyCreate">Create ${$('#tallyFormat').value === 'xml' ? 'Tally ERP 9 vouchers file (XML)' : 'Tally Excel file'}</button></div>` : '<p class="muted">Nothing to send for this range.</p>'}`;
    $('#tallyPreview').querySelectorAll('[data-openid]').forEach((b) => { b.onclick = () => openReview(Number(b.dataset.openid)); });
    $('#tallyCreate')?.addEventListener('click', async () => {
      if (!confirm(`Create the Tally file for ${p.included.length} verified day(s), ${p.totals.vouchers} vouchers?\n\nThese days will be locked so they can't be sent twice.`)) return;
      try {
        await saveTally(true);
        const r = await api(`/api/tally/${state.companyId}/export`, { method: 'POST', body: { from: f.from.value, to: f.to.value, include_errors: f.include_errors.checked } });
        toast(`Batch #${r.batchId}: ${r.days} day(s), ${r.vouchers} vouchers — downloading`);
        location.href = `/api/tally/batches/${r.batchId}/file`;
        renderBatches(); tallyPreview();
        if (state.monthId) loadSummary();
      } catch (e) { toast(e.message); }
    });
  } catch (e) { $('#tallyPreview').innerHTML = `<p class="err">${esc(e.message)}</p>`; }
}
const colOf = (v) => v.col;

async function renderBatches() {
  const list = await api(`/api/tally/${state.companyId}/batches`);
  const dmy = (v) => String(v).slice(0, 10).split('-').reverse().join('-');
  $('#tallyBatches').innerHTML = list.length ? `<table class="pl"><thead><tr><th>Batch</th><th>Dates</th><th>Days</th><th>Vouchers</th><th>Created</th><th>Status</th><th></th></tr></thead><tbody>
    ${list.map((b) => `<tr><td>#${b.id}</td><td>${dmy(b.date_from)} to ${dmy(b.date_to)}</td><td>${b.days}</td><td>${b.vouchers}</td><td>${new Date(b.created_at).toLocaleString('en-IN')}</td>
      <td>${b.voided_at ? '<span class="badge b-skip">unlocked</span>' : '<span class="badge b-ok">in Tally</span>'}</td>
      <td><a class="btn small" href="/api/tally/batches/${b.id}/file">Download again</a> ${b.voided_at ? '' : `<button class="small danger" data-unlock="${b.id}">Unlock days</button>`}</td></tr>`).join('')}</tbody></table>` : 'None yet.';
  $('#tallyBatches').querySelectorAll('[data-unlock]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm(`Unlock batch #${b.dataset.unlock}?\n\nIts days become editable and will be exported again next time.\nFirst DELETE this batch's vouchers in Tally, otherwise they will be entered twice.`)) return;
      try { await api(`/api/tally/batches/${b.dataset.unlock}/unlock`, { method: 'POST' }); toast('Batch unlocked'); renderBatches(); if (state.monthId) loadSummary(); } catch (e) { toast(e.message); }
    };
  });
}


// ---------- dashboard: sales, profit/loss, expenses, deposits over time ----------
// Categorical slots in fixed order (validated default palette); status green/red only for profit/loss.
const VIZ = {
  s1: '#2a78d6', s2: '#eb6834', s3: '#1baf7a', s4: '#eda100',
  good: '#0ca30c', critical: '#d03b3b',
  ink: '#0b0b0b', ink2: '#52514e', muted: '#898781', grid: '#e1e0d9', axis: '#c3c2b7', surface: '#fcfcfb',
};
const dashCharts = {};
$('#dashForm').addEventListener('change', () => runDash());
$('#dashForm').querySelectorAll('[data-range]').forEach((b) => { b.onclick = () => { setRange($('#dashForm'), b.dataset.range); runDash(); }; });
$('#dashToReports').onclick = (ev) => { ev.preventDefault(); showTab('reports'); };

const rupees = (v) => `₹${Number(v || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
const shortRupees = (v) => {
  const a = Math.abs(v);
  const s = a >= 1e7 ? `${(a / 1e7).toFixed(1)}Cr` : a >= 1e5 ? `${(a / 1e5).toFixed(1)}L` : a >= 1e3 ? `${(a / 1e3).toFixed(0)}k` : `${Math.round(a)}`;
  return `${v < 0 ? '−' : ''}₹${s}`;
};

function baseOptions({ stacked = false, horizontal = false } = {}) {
  const valueAxis = {
    stacked, beginAtZero: true, border: { display: false },
    grid: { color: VIZ.grid, drawTicks: false }, ticks: { color: VIZ.muted, padding: 6, callback: (v) => shortRupees(v), maxTicksLimit: 6 },
  };
  const catAxis = { stacked, grid: { display: false }, border: { color: VIZ.axis }, ticks: { color: VIZ.muted, maxRotation: 0, autoSkipPadding: 12 } };
  return {
    responsive: true, maintainAspectRatio: false, animation: { duration: 250 },
    indexAxis: horizontal ? 'y' : 'x',
    interaction: { mode: 'index', intersect: false, axis: horizontal ? 'y' : 'x' },
    plugins: {
      legend: { position: 'top', align: 'start', labels: { color: VIZ.ink2, boxWidth: 10, boxHeight: 10, useBorderRadius: true, borderRadius: 2, padding: 14 } },
      tooltip: {
        backgroundColor: '#ffffff', titleColor: VIZ.ink, bodyColor: VIZ.ink2, borderColor: 'rgba(11,11,11,0.10)', borderWidth: 1,
        padding: 10, boxPadding: 4, usePointStyle: true,
        filter: (item) => item.parsed[horizontal ? 'x' : 'y'] !== 0, // leave out series with nothing that period
        callbacks: { label: (c) => ` ${rupees(c.parsed[horizontal ? 'x' : 'y'])}  ${c.dataset.label}` },
      },
    },
    scales: horizontal ? { x: valueAxis, y: { ...catAxis, ticks: { color: VIZ.ink2 } } } : { x: catAxis, y: valueAxis },
  };
}
// Thin bars with rounded ends and a 2px surface gap between stacked segments.
const barSet = (label, data, color, extra = {}) => ({
  label, data, backgroundColor: color, hoverBackgroundColor: color, borderColor: VIZ.surface, borderWidth: { top: 2, bottom: 0, left: 0, right: 0 },
  borderRadius: 4, borderSkipped: 'start', maxBarThickness: 36, categoryPercentage: 0.7, barPercentage: 0.9, ...extra,
});
function drawChart(id, config) {
  if (dashCharts[id]) dashCharts[id].destroy();
  dashCharts[id] = new Chart(document.getElementById(id), config);
}

async function runDash() {
  if (typeof Chart === 'undefined') { toast('The chart library did not load — check the internet connection'); return; }
  const f = $('#dashForm');
  $('#dashCompany').textContent = company()?.name || '';
  const q = `company_id=${state.companyId}&from=${f.from.value}&to=${f.to.value}&group=${f.group.value}&fy=${f.fy.value}`;
  try {
    const r = await api(`/api/reports?${q}`);
    const t = r.total;
    const rows = r.rows;
    const labels = rows.map((x) => x.label);
    const est = t.pl.estimatedDays;
    $('#dashNote').textContent = `${t.days} day(s) · ${t.verified} verified${est ? ' · profit estimated (standard dealer commission)' : ''}`;
    $('#plSub').textContent = `Net profit (above zero) or loss (below), ₹${est ? ' — estimated' : ''}`;
    const deposits = t.cash.deposits;
    $('#dashTiles').innerHTML = [
      ['Total sales', rupees(t.pl.sales)],
      [`Net ${t.pl.net < 0 ? 'loss' : 'profit'}${est ? ' (est.)' : ''}`, `<span class="${t.pl.net < 0 ? 'loss' : 'profit'}">${t.pl.net < 0 ? '▼' : '▲'} ${rupees(Math.abs(t.pl.net))}</span>`],
      ['Pump expenses', rupees(t.PEXP)],
      ['Deposits', rupees(deposits)],
      ['HSD sold', `${Number(t.HSD).toLocaleString('en-IN', { maximumFractionDigits: 0 })} L`],
      ['MS sold', `${Number(t.MS).toLocaleString('en-IN', { maximumFractionDigits: 0 })} L`],
    ].map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('');
    if (!rows.length) {
      for (const id of Object.keys(dashCharts)) { dashCharts[id].destroy(); delete dashCharts[id]; }
      $('#dashNote').textContent = 'No days entered in this range yet.';
      return;
    }

    drawChart('chSales', { type: 'bar', options: baseOptions({ stacked: true }), data: { labels, datasets: [
      barSet('HSD', rows.map((x) => x.pl.hsdSales), VIZ.s1),
      barSet('MS', rows.map((x) => x.pl.msSales), VIZ.s2),
      barSet('Lube', rows.map((x) => x.pl.lube), VIZ.s3),
      barSet('Coffee', rows.map((x) => x.pl.coffee), VIZ.s4),
    ].filter((d) => d.data.some((v) => v)) } });

    // Profit green, loss red — the tooltip also says which, so colour is never the only cue.
    const net = rows.map((x) => x.pl.net);
    const plOpts = baseOptions();
    plOpts.plugins.legend.display = false;
    plOpts.plugins.tooltip.callbacks.label = (c) => ` ${c.parsed.y < 0 ? 'Loss' : 'Profit'} ${rupees(Math.abs(c.parsed.y))}${est ? ' (estimated)' : ''}`;
    plOpts.scales.y.grid.color = (ctx) => (ctx.tick.value === 0 ? VIZ.axis : VIZ.grid);
    drawChart('chPl', { type: 'bar', options: plOpts, data: { labels, datasets: [
      barSet('Net profit / loss', net, net.map((v) => (v < 0 ? VIZ.critical : VIZ.good)), { borderSkipped: false, borderWidth: 0 }),
    ] } });

    drawChart('chExp', { type: 'bar', options: baseOptions({ stacked: true }), data: { labels, datasets: [
      barSet('Pump expenses (P-Exp)', rows.map((x) => x.PEXP), VIZ.s1),
      barSet('Others payments', rows.map((x) => x.pl.otherPayments), VIZ.s2),
    ].filter((d) => d.data.some((v) => v)) } });

    drawChart('chDep', { type: 'bar', options: baseOptions({ stacked: true }), data: { labels, datasets: [
      barSet('Bank', rows.map((x) => x.BANK), VIZ.s1),
      barSet('PTM (Paytm)', rows.map((x) => x.PTM), VIZ.s2),
      barSet('UPI', rows.map((x) => x.UPI), VIZ.s3),
    ].filter((d) => d.data.some((v) => v)) } });

    // Top 12 heads; the rest fold into "Other heads" rather than getting new colours.
    const heads = t.pl.expenseLines;
    const top = heads.slice(0, 12);
    const rest = heads.slice(12).reduce((s, h) => s + h.amount, 0);
    if (rest) top.push({ label: `Other heads (${heads.length - 12})`, amount: rest });
    const hOpts = baseOptions({ horizontal: true });
    hOpts.plugins.legend.display = false;
    drawChart('chHeads', { type: 'bar', options: hOpts, data: { labels: top.map((h) => h.label), datasets: [
      barSet('Pump expenses', top.map((h) => h.amount), VIZ.s1, { borderWidth: 0, borderSkipped: 'start', maxBarThickness: 18 }),
    ] } });
  } catch (e) { toast(e.message); }
}

// Start last, after every handler above is defined.
boot();
