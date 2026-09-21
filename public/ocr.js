// Optional offline text reader. Runs Tesseract (open-source OCR) inside the browser:
// the image never leaves this computer and no AI service is called. Loaded only
// when the user presses "Try reading text", then its rows are turned into ledger lines.
const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';

function loadTesseract() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = TESSERACT_URL;
    s.onload = () => resolve(window.Tesseract);
    s.onerror = () => reject(new Error('could not load the text reader (check the internet connection)'));
    document.head.appendChild(s);
  });
}

const NUM = /^-?[\d.,]*\d[\d.,]*$/;
const cleanTok = (t) => t.replace(/[₹|'"‘’“”`\[\]{}]/g, '').replace(/^[(:.,]+|[):;,.]+$/g, '');
const isNum = (t) => NUM.test(t);
// "1,23,456.78", and "2.324.48" (a comma misread as a dot): only the last dot is decimal
const toNum = (t) => {
  let v = t.replace(/,/g, '');
  const parts = v.split('.');
  if (parts.length > 2) v = parts.slice(0, -1).join('') + '.' + parts[parts.length - 1];
  return Number(v);
};
const isWord = (t) => /[A-Za-z]/.test(t);
const SKIP = /DETAILS|PARTICULARS|\bUNIT\b|\bRATE\b|BAJRANG|PETROLEUM|LEDGER REPORT|STOCK|\bQTY\b|^\s*(AMOUNT|EXPENSES)\s*$/i;

// Enlarge and grey the image: Tesseract misses small table text at phone resolution.
async function prepare(imageUrl) {
  const img = await new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error('could not open the image'));
    i.src = imageUrl;
  });
  const scale = Math.min(3, Math.max(1, 2600 / img.naturalWidth));
  const c = document.createElement('canvas');
  c.width = Math.round(img.naturalWidth * scale);
  c.height = Math.round(img.naturalHeight * scale);
  const g = c.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(img, 0, 0, c.width, c.height);
  const px = g.getImageData(0, 0, c.width, c.height);
  const d = px.data;
  let lo = 255, hi = 0;
  for (let i = 0; i < d.length; i += 4) {
    const v = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    d[i] = v;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const span = Math.max(1, hi - lo);
  for (let i = 0; i < d.length; i += 4) { const v = ((d[i] - lo) / span) * 255; d[i] = d[i + 1] = d[i + 2] = v; }
  // Black-and-white, then erase the table's grid lines: long straight dark runs.
  // Tesseract skips whole rows when the text touches cell borders.
  const W = c.width, H = c.height;
  const dark = new Uint8Array(W * H);
  // Adaptive threshold (dark = darker than its neighbourhood) copes with coloured cells and photo glare.
  const integral = new Float64Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) {
    let rowSum = 0;
    for (let x = 0; x < W; x++) {
      rowSum += d[(y * W + x) * 4];
      integral[(y + 1) * (W + 1) + x + 1] = integral[y * (W + 1) + x + 1] + rowSum;
    }
  }
  const r = Math.max(8, Math.round(W / 60));
  for (let y = 0, p = 0; y < H; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(H, y + r + 1);
    for (let x = 0; x < W; x++, p++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(W, x + r + 1);
      const sum = integral[y1 * (W + 1) + x1] - integral[y0 * (W + 1) + x1] - integral[y1 * (W + 1) + x0] + integral[y0 * (W + 1) + x0];
      const mean = sum / ((x1 - x0) * (y1 - y0));
      dark[p] = d[p * 4] < mean - 18 ? 1 : 0;
    }
  }
  const kill = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    let run = 0;
    for (let x = 0; x <= W; x++) {
      if (x < W && dark[y * W + x]) run++;
      else { if (run > W * 0.08) for (let k = x - run; k < x; k++) kill[y * W + k] = 1; run = 0; }
    }
  }
  for (let x = 0; x < W; x++) {
    let run = 0;
    for (let y = 0; y <= H; y++) {
      if (y < H && dark[y * W + x]) run++;
      else { if (run > H * 0.04) for (let k = y - run; k < y; k++) kill[k * W + x] = 1; run = 0; }
    }
  }
  for (let p = 0, i = 0; p < W * H; p++, i += 4) { const v = kill[p] || !dark[p] ? 255 : 0; d[i] = d[i + 1] = d[i + 2] = v; }
  g.putImageData(px, 0, 0);
  return c;
}

// rates: { hsd, ms } of the month, used to name a fuel row whose label was not read
async function readLedgerText(imageUrl, progress = () => {}, rates = {}) {
  const Tesseract = await loadTesseract();
  progress('Loading reader…');
  const canvas = await prepare(imageUrl);
  const worker = await Tesseract.createWorker('eng', 1, {
    logger: (m) => { if (m.status === 'recognizing text') progress(`Reading… ${Math.round(m.progress * 100)}%`); },
  });
  let data;
  try {
    await worker.setParameters({ tessedit_pageseg_mode: '6' }); // one block of text rows: keeps table rows together
    ({ data } = await worker.recognize(canvas));
  } finally {
    await worker.terminate();
  }
  const near = (v, r) => r && v && Math.abs(v - r) <= 3;

  const out = { lines: [], printed: { total_inflow: null, total_expense: null, cash_in_hand: null }, date: null };
  const dm = /(\d{1,2})\s*[-./]\s*(\d{1,2})\s*[-./]\s*(\d{4})/.exec(data.text || '');
  if (dm) out.date = { d: Number(dm[1]), m: Number(dm[2]), y: Number(dm[3]), text: `${dm[1].padStart(2, '0')}-${dm[2].padStart(2, '0')}-${dm[3]}` };

  const words = (data.words || []).filter((w) => w.text.trim());
  if (!words.length) return out;
  const left = Math.min(...words.map((w) => w.bbox.x0));
  const right = Math.max(...words.map((w) => w.bbox.x1));
  const center = (left + right) / 2;
  const width = right - left || 1;

  // Rebuild table rows from word positions: Tesseract often breaks one row into pieces.
  const h = words.map((w) => w.bbox.y1 - w.bbox.y0).sort((x, y) => x - y)[Math.floor(words.length / 2)] || 10;
  const rows = [];
  for (const w of words.slice().sort((x, y) => (x.bbox.y0 + x.bbox.y1) - (y.bbox.y0 + y.bbox.y1))) {
    const cy = (w.bbox.y0 + w.bbox.y1) / 2;
    const row = rows.find((r) => Math.abs(r.cy - cy) < h * 0.6);
    if (row) { row.words.push(w); row.cy = (row.cy * (row.words.length - 1) + cy) / row.words.length; } else rows.push({ cy, words: [w] });
  }
  rows.sort((x, y) => x.cy - y.cy);
  let footer = false;
  const parsed = [];

  for (const r of rows) {
    const ws = r.words.sort((x, y) => x.bbox.x0 - y.bbox.x0);
    const raw = ws.map((w) => w.text).join(' ');
    let toks = ws
      .map((w) => ({ t: cleanTok(w.text.trim()), x: w.bbox.x0, x1: w.bbox.x1 }))
      .filter((w) => w.t && (isNum(w.t) || isWord(w.t)))
      .filter((w) => !/^(MS|HSD)-/i.test(w.t)); // stock figures like "MS-2860"
    // Excel row numbers down the left edge of screen photos
    if (toks.length > 1 && /^\d{3,5}$/.test(toks[0].t) && toks[0].x < left + width * 0.08) toks = toks.slice(1);
    if (!toks.length) continue;
    if (/STOCK/i.test(raw)) footer = true; // stock / cash / paytm box below the table
    if (/cash\s*in\s*hand/i.test(raw)) {
      const at = toks.findIndex((w) => /^hand$/i.test(w.t));
      const n = toks.slice(at + 1).find((w) => isNum(w.t)); // first figure after "Cash in Hand" (Paytm 12 may follow)
      if (n) out.printed.cash_in_hand = toNum(n.t);
      continue;
    }
    if (/total/i.test(raw)) {
      // "... (Total Inflow): 1,563,146.22   ... (Total Expenses): 1,482,754.60"
      const split = toks.findIndex((w) => /expens/i.test(w.t));
      const before = toks.slice(0, split < 0 ? toks.length : split).filter((w) => isNum(w.t) && toNum(w.t) >= 10);
      const after = split < 0 ? [] : toks.slice(split).filter((w) => isNum(w.t) && toNum(w.t) >= 10);
      if (/inflow/i.test(raw) && before.length) out.printed.total_inflow = toNum(before[before.length - 1].t);
      if (after.length) out.printed.total_expense = toNum(after[after.length - 1].t);
      continue;
    }
    // Screen photos: the unlabeled totals row sits just before "PAYTM12"
    const p12 = toks.findIndex((w) => /^PAYTM\s*12$|^PAYTM12$/i.test(w.t) || (/^PAYTM$/i.test(w.t) && toks[toks.indexOf(w) + 1]?.t === '12'));
    if (p12 >= 0) {
      const nums = toks.slice(0, p12).filter((w) => isNum(w.t)).map((w) => toNum(w.t));
      if (nums.length >= 3) [out.printed.total_inflow, out.printed.cash_in_hand, out.printed.total_expense] = nums.slice(-3);
      else if (nums.length === 2) [out.printed.cash_in_hand, out.printed.total_expense] = nums;
      continue;
    }
    if (footer || SKIP.test(raw)) continue;

    // Split at the first number → word change: left part is inflow, right part is an expense.
    let cut = -1;
    for (let i = 1; i < toks.length; i++) if (isWord(toks[i].t) && isNum(toks[i - 1].t)) { cut = i; break; }
    let segs = cut > 0 ? [toks.slice(0, cut), toks.slice(cut)] : [toks];
    // A lone integer before the label belongs to it: "2021 RANJEET JI FORTUNER 3075.6"
    if (segs.length === 2 && segs[0].length === 1 && /^\d+$/.test(segs[0][0].t)) segs = [toks];

    // Leading one-letter scraps ("L", "I") are border noise
    segs = segs.map((seg) => { let k = 0; while (k < seg.length - 1 && /^[A-Za-z]$/.test(seg[k].t)) k++; return seg.slice(k); });
    parsed.push(segs);
  }

  // Where the expenses column starts: between the inflow amounts and the expense labels of two-sided rows.
  const two = parsed.filter((sg) => sg.length === 2);
  const split = two.length
    ? (Math.max(...two.map((sg) => sg[0][sg[0].length - 1].x1)) + Math.min(...two.map((sg) => sg[1][0].x))) / 2
    : center;

  for (const segs of parsed) {
    segs.forEach((seg, i) => {
      const side = segs.length === 2 ? (i === 0 ? 'in' : 'out') : (seg[0].x < split ? 'in' : 'out');
      let end = seg.length;
      while (end > 0 && isNum(seg[end - 1].t)) end--;
      let label = seg.slice(0, end).map((w) => w.t).join(' ').trim();
      const nums = seg.slice(end).map((w) => toNum(w.t));
      // Fuel row whose "HSD"/"MS" label was lost: recognise it by its rate
      if (!label && side === 'in' && nums.length >= 3) label = near(nums[nums.length - 2], rates.hsd) ? 'HSD' : near(nums[nums.length - 2], rates.ms) ? 'MS' : '';
      // Drop noise (misread Hindi, borders): a real label has a word of 3+ letters, or is MS
      if (!label || !nums.length || !(/[A-Za-z]{3,}/.test(label) || /^MS$/i.test(label))) return;
      if (side === 'in') {
        const [unit, rate, amount] = nums.length >= 3 ? nums.slice(-3) : nums.length === 2 ? [nums[0], null, nums[1]] : [null, null, nums[0]];
        out.lines.push({ side, label: label.toUpperCase(), unit, rate, amount });
      } else {
        out.lines.push({ side, label: label.toUpperCase(), unit: null, rate: null, amount: nums[nums.length - 1] });
      }
    });
  }
  // Inflow rows first, as on the sheet
  out.lines.sort((a, b) => (a.side === b.side ? 0 : a.side === 'in' ? -1 : 1));
  return out;
}
