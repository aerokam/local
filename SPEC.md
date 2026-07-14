# Brokerage CSV → Google Sheets Importer

Watches `~/Downloads` for brokerage export files and automatically pushes them into Google Sheets. Supports Schwab, Fidelity, and per-account trades. Triggered on file download; no manual step required.

---

## Files

| File | Purpose |
|------|---------|
| `watch.js` | Monitors Downloads for target CSVs, triggers the appropriate importer |
| `importSchwabAccounts.js` | Parses Schwab multi-account CSV → Google Sheets |
| `importFidelityAccounts.js` | Parses Fidelity CSV → Google Sheets |
| `importTrades.js` | Appends trades CSV → correct account sheet based on filename |
| `auth.js` | Shared service-account auth — all importers call `authorize()` from here |
| `sheetsimporter.json` | Google service account key (from Google Cloud Console) |

---

## Importers

### Schwab — `importSchwabAccounts.js`

- **Source file:** `~/Downloads/SchwabAllAccounts.csv`
- **Spreadsheet:** `1epVEbtnjE18fx9PBLrLFCrKw_D0pScIk31LV8qnv4J8`
- **Sheet tab:** `Import`
- **Anchor:** row 2, col B (one left of col C, matching original GAS behavior)
- **Columns written:** Account name + 7 selected fields:
  - Symbol, Description, Qty, Price, Mkt Val, Gain $, Gain %
- **Parsing:** Multi-account CSV — detects account headers, groups rows by account, inserts blank separator rows between accounts. Strips `$`, `%`, `,` and converts numeric strings to numbers.

### Fidelity — `importFidelityAccounts.js`

- **Source file:** `~/Downloads/FidelityAllAccounts.csv`
- **Spreadsheet:** `1pDPmDW3S3heYks7eZ-2Ipu7v_CSDsEKpneMZQL4m_No`
- **Sheet tab:** `Download`
- **Anchor:** `B1` (row 1, col B)
- **Columns written:** First 16 columns of the CSV (B:Q)
- **Parsing:** Straight dump — no account grouping. All rows written as-is after numeric conversion. Column B is formatted as plain text after write (matches GAS `setNumberFormat("@")`).

### Trades — `importTrades.js`

- **Source files:** `~/Downloads/Trades<Account>.csv` (case-insensitive)
- **Spreadsheet:** `1epVEbtnjE18fx9PBLrLFCrKw_D0pScIk31LV8qnv4J8`
- **Filename → sheet mapping:**

  | Filename (any case) | Sheet tab | Sheet GID |
  |---------------------|-----------|-----------|
  | `TradesPOD.csv` | `TradesPOD` | 1540387774 |
  | `TradesRoth.csv` | `TradesRoth` | 889893703 |
  | `TradesIRA.csv` | `TradesIRA` | 2124339902 |
  | `TradesAmyIRA.csv` | `TradesAmyIRA` | 1839917397 |
  | `TradesAmyPOD.csv` | `TradesAmyPOD` | 1218857201 |
  | `TradesDana.csv` | `TradesDana` | 74383282 |
  | `TradesInherited.csv` | `TradesInheritedIRA` | 392046034 |

- **Behavior:** Appends to the sheet (does not overwrite). Post-processing after append:
  1. Copies formulas from the row above the inserted block (cols I+) into all new rows
  2. Merges adjacent Full Redemption row pairs (copies lower row's qty to upper, deletes lower)
  3. Deletes SWVXX and SNSXX rows (money market)
  4. Formats: col A = `MM/dd/yy`, col E = `#,##0`, col F = `#,##0.0000`, col H = `#,##0.00`
  5. Sorts by date ascending, then action descending (Sell before Buy)

---

## Watcher — `watch.js`

Watches the Downloads folder using Node's `fs.watch`. When a target file appears or is modified:
1. Waits 2 seconds (debounce so the browser finishes writing)
2. Runs the corresponding importer

All filenames matched case-insensitively. Debounce timers are per-file and independent.

**Watched files:**
```
SchwabAllAccounts.csv      →  importSchwabAccounts.js
FidelityAllAccounts.csv    →  importFidelityAccounts.js
Trades<Account>.csv        →  importTrades.js "<filename>"
```

---

## Running

```bash
# Start the watcher (normally handled by Task Scheduler on login)
npm run watch

# Run importers manually
npm run schwab
npm run fidelity
node importTrades.js TradesIRA.csv
```

---

## Automation

A Windows Task Scheduler task (`SchwabFidelityWatcher`) runs `watch.js` automatically at logon using:
```
C:\Program Files\nodejs\node.exe  C:\Users\aerok\projects\Local\watch.js
```

No manual start needed after login.

---

## Auth Setup

Uses a Google service account (no interactive consent, no expiring refresh token — required since the watcher runs unattended via Task Scheduler). The key lives in `sheetsimporter.json`; `auth.js` loads it and every importer calls `authorize()` from there.

Setup (Google Cloud Console, project `sheetsimporter-495018`):
1. IAM & Admin → Service Accounts → create one, download its JSON key as `sheetsimporter.json` in this folder.
2. Share each target spreadsheet with the service account's email as Editor.
3. Confirm the Google Sheets API is enabled for the project.

Required scope: `https://www.googleapis.com/auth/spreadsheets`

---

## Adding a New Broker

1. Create `importXxxAccounts.js` following the pattern of the existing importers (config block at top, `parseCsv`, `writeToSheet`, `authorize`, `main`)
2. Add the lowercase filename → command to `STATIC_TARGETS` in `watch.js`
3. Add an npm script to `package.json`

## Adding a New Trades Account

1. Add the lowercase filename → `{ sheetId, name }` to `SHEET_MAP` in `importTrades.js`
2. Add the lowercase filename to `TRADES_KEYS` in `watch.js`
