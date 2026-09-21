const Anthropic = require('@anthropic-ai/sdk');
const sharp = require('sharp');
const { z } = require('zod');

const client = new Anthropic();
const MODEL = 'claude-opus-5';

const num = { type: ['number', 'null'] };
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['report_date', 'inflows', 'expenses', 'total_inflow', 'total_expense', 'cash_in_hand', 'stock_atg', 'stock_manual', 'paytm12', 'unreadable'],
  properties: {
    report_date: { type: ['string', 'null'], description: 'DD-MM-YYYY' },
    inflows: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['label', 'unit', 'rate', 'amount'],
        properties: { label: { type: 'string' }, unit: num, rate: num, amount: num },
      },
    },
    expenses: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['label', 'amount'],
        properties: { label: { type: 'string' }, amount: num },
      },
    },
    total_inflow: num,
    total_expense: num,
    cash_in_hand: num,
    stock_atg: { type: ['string', 'null'] },
    stock_manual: { type: ['string', 'null'] },
    paytm12: num,
    unreadable: { type: 'array', items: { type: 'string' } },
  },
};

const Result = z.object({
  report_date: z.string().nullable(),
  inflows: z.array(z.object({ label: z.string(), unit: z.number().nullable(), rate: z.number().nullable(), amount: z.number().nullable() })),
  expenses: z.array(z.object({ label: z.string(), amount: z.number().nullable() })),
  total_inflow: z.number().nullable(),
  total_expense: z.number().nullable(),
  cash_in_hand: z.number().nullable(),
  stock_atg: z.string().nullable(),
  stock_manual: z.string().nullable(),
  paytm12: z.number().nullable(),
  unreadable: z.array(z.string()),
});

const PROMPT = `This image is one day's cash ledger ("Daily Ledger Report") from a fuel station (petrol pump). It is either a printed report or a phone photo of an Excel screen. Transcribe it exactly.

Layout:
- Left side "DETAILS (Inflow)": rows with DETAILS, UNIT, RATE, AMOUNT. Always includes OPENING/OPNING CASH, HSD and MS; may include LUBE, COFFEE, TANK SELL, CSP, CYBER, NITESH or other names.
- Right side "EXPENSES": particulars and AMOUNT (PAYTM, BANK JAMA, UPI SBI, vehicle numbers with names, KHORAKI, etc.).
- Totals: "Total Inflow"/"कुल" on the left and "Total Expenses" on the right. On Excel-screen photos the totals row sits at the bottom: the cell under "AMOUNT" on the left is total inflow, the rightmost number under the expenses AMOUNT column is total expenses, and the orange/red cell in the middle is cash in hand.
- Footer: STOCK-ATG, STOCK-MANUAL, Cash in Hand, and a "PAYTM 12"/"paytm12" figure. PAYTM 12 is a note, not an expense line.

Rules:
- One entry per filled row, in the order shown. Skip rows that are blank or only "-".
- Numbers are Indian-formatted (1,23,456.78 or 123456.78). Return plain numbers. A "-" or empty cell is null.
- Keep labels as written (uppercase is fine). Do not merge, total or reclassify rows.
- Opening cash goes in inflows with its amount.
- report_date as DD-MM-YYYY from "दिनांक"/"DATE".
- If a digit is genuinely unreadable, give your best reading and name the row in "unreadable".`;

async function prepareImage(buffer) {
  // Keep within the API's image limits and normalise to JPEG.
  const out = await sharp(buffer).rotate().resize({ width: 2000, height: 2000, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 88 }).toBuffer();
  return out.toString('base64');
}

async function extractLedger(buffer) {
  const data = await prepareImage(buffer);
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } },
        { type: 'text', text: PROMPT },
      ],
    }],
  });

  if (response.stop_reason === 'refusal') throw new Error('The model declined to read this image');
  if (response.stop_reason === 'max_tokens') throw new Error('Image reading was cut off; try again');
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return Result.parse(JSON.parse(text));
}

// Convert the model's transcription into ledger lines + printed totals.
function toEntry(result) {
  let id = 0;
  const lines = [
    ...result.inflows.map((r) => ({ id: ++id, side: 'in', label: r.label, unit: r.unit, rate: r.rate, amount: r.amount })),
    ...result.expenses.map((r) => ({ id: ++id, side: 'out', label: r.label, unit: null, rate: null, amount: r.amount })),
  ];
  let day = null;
  const m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/.exec((result.report_date || '').trim());
  if (m) day = { d: Number(m[1]), m: Number(m[2]), y: Number(m[3].length === 2 ? `20${m[3]}` : m[3]) };
  return {
    lines,
    date: day,
    report_date: result.report_date,
    printed: { total_inflow: result.total_inflow, total_expense: result.total_expense, cash_in_hand: result.cash_in_hand },
    notes: { stock_atg: result.stock_atg, stock_manual: result.stock_manual, paytm12: result.paytm12, unreadable: result.unreadable },
  };
}

module.exports = { extractLedger, toEntry };
