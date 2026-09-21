# Pump Ledger — daily images → monthly reconciliation Excel

Create a company (petrol pump), then upload its daily ledger report images (printed report or phone photo of the Excel
screen). Claude reads each image, every line is mapped to a column of the monthly
sheet, you validate each image against its own totals and the month as a whole, then
download the month as an Excel file with the same layout and formulas as the
original sheet.

## How lines map to the sheet

| Image line | Sheet column |
|---|---|
| Opening cash | B `OB` (day 1 only — later days carry forward `=Y(prev)`) |
| HSD / MS | C / F units, D / G rate (units = amount ÷ rate when the unit cell is blank) |
| Lube, Mobil | I `Lub` |
| Coffee | J `Cofee` |
| Any other inflow (Tank sell, CSP, Cyber, Nitesh …) | K `Collection` |
| Sum of all expense lines | M `T-Exp` |
| Bank jama | N `Bank` |
| Paytm | O `PTM` |
| UPI / SBI | P `UPI` |
| HSDPC tank sell | Q `T-Sale` |
| Fleet | R `Fleet` |
| Rajeshwar / Poclain | S `R-Babu` |
| Vehicle numbers, Ranjit/Ranjeet, Sanjiv/Sanju, Fortuner | T `Ranjit` |
| CSP, Dr Sahab, Nitesh, Cyber (return) | U `Others` |
| Everything else (khoraki, food, salary, DG …) | W `P-Exp` (= T-Exp − mapped columns) |

Rules are editable in the app (**Mapping rules**). When you change a line's column by
hand you can tick **remember** to add a rule for that label.

## Checks

Per image: date found and unique; inflow lines add up to the printed total inflow;
expense lines add up to the printed total expenses; HSD/MS units × rate = amount;
printed cash in hand = inflow − expenses; opening cash = previous day's closing.

Per month: every day uploaded, no undated or duplicate days, every image passes,
every image marked verified, totals-row closing = last day's closing.

## Run locally

```bash
cp .env.example .env   # fill in DATABASE_URL and ANTHROPIC_API_KEY
npm install
npm run dev            # http://localhost:3000 (or PORT)
```

Migrations in `db/migrations` run on every start.

## Deploy (Render + Neon)

Web service: build `npm ci`, start `npm start`. Environment variables:

- `DATABASE_URL` — Neon pooled connection string
- `ANTHROPIC_API_KEY` — used to read the images
- `APP_PASSWORD` — password to open the app
- `SESSION_SECRET` — any long random string
- `NODE_ENV=production`
