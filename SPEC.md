# Brokerage CSV → Google Sheets Importer

Watches `~/Downloads` for brokerage export files and automatically pushes them into Google Sheets. Supports Schwab, Fidelity, and per-account trades, plus the Kevin IRA DARA plan (to TipsLadderManager, not a sheet). Triggered on file download; no manual step required.

---

## Files

| File | Purpose |
|------|---------|
| `watch.js` | Monitors Downloads for target CSVs, triggers the appropriate importer |
| `importSchwabAccounts.js` | Parses Schwab multi-account CSV → Google Sheets |
| `importFidelityAccounts.js` | Parses Fidelity CSV → Google Sheets |
| `importTrades.js` | Appends trades CSV → correct account sheet based on filename |
| `importDaraPlan.js` | Copies the Kevin IRA DARA plan to TipsLadderManager and refreshes its sample DARA plan |
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
- **After the sheet write:** copies the CSV to `Treasuries/TipsLadderManager/data/SchwabAllAccounts.csv` (gitignored) and runs `Treasuries/TipsLadderManager/scripts/generate-test-fixtures.js`. That script rebuilds TipsLadderManager's sample holdings and its sanitized Schwab test file, commits them, and pushes that commit alone; other unpushed commits in the Treasuries checkout are not pushed with it (Treasuries `knowledge/Testing.md` §4.0). A failure in this step is logged and does not affect the sheet write, which has already completed.

### Fidelity — `importFidelityAccounts.js`

- **Source file:** `~/Downloads/FidelityAllAccounts.csv`
- **Spreadsheet:** `1pDPmDW3S3heYks7eZ-2Ipu7v_CSDsEKpneMZQL4m_No`
- **Sheet tab:** `Download`
- **Anchor:** `B1` (row 1, col B)
- **Columns written:** First 16 columns of the CSV (B:Q)
- **Parsing:** Straight dump — no account grouping. All rows written as-is after numeric conversion. Column B is formatted as plain text after write (matches GAS `setNumberFormat("@")`).
- **After the sheet write:** nothing. No test reads Fidelity holdings, so this importer does not touch the Treasuries repository.

### DARA plan — `importDaraPlan.js`

- **Source file:** `~/Downloads/dara-plan-kevin-rmd.csv` (the Kevin IRA's DARA plan, exported from TipsLadderManager)
- **Writes:** no sheet. Copies the file to `Treasuries/TipsLadderManager/data/DaraPlanKevinRmd.csv` (gitignored) and runs `Treasuries/TipsLadderManager/scripts/generate-test-fixtures.js`, which rewrites `data/SampleDaraPlan.csv` (and `data/SampleHoldings.csv` from the last Schwab download) at a scale factor of 0.5, commits them, and pushes that commit alone (Treasuries `knowledge/Testing.md` §4.0).

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

- **Concurrency:** Acquires a per-sheet lockfile (`.import-<sheetId>.lock`) before writing, so two overlapping imports into the same account sheet (e.g. if `watch.js` is ever running in two places at once) queue instead of racing on the append/write steps. A lock older than 5 minutes is treated as abandoned and reclaimed; waits up to 60s before giving up. This does not deduplicate — two imports of the same CSV still produce duplicate rows, just no longer corrupted ones.
- **Behavior:** Appends to the sheet (does not overwrite). Post-processing after append:
  1. Copies formulas (cols I+) into all new rows, sourced from the nearest preceding row that actually has formula content — scans backward up to 50 rows so a prior row left without formulas (e.g. from an earlier failed import) doesn't get used as the template
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
dara-plan-kevin-rmd.csv    →  importDaraPlan.js
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

A Windows Task Scheduler task (`DownloadsWatcher`) runs `watch.js` automatically at logon:
```
C:\Program Files\nodejs\node.exe  C:\Users\aerok\projects\Local\watch.js
```
Configured with Interactive logon and Limited run level (not "run whether user is logged on or not," not elevated), so it starts in the user's desktop session and opens a normal visible console window — the same as running it manually, except automatic.

Only one instance of `watch.js` should run at a time. Two instances watching the same Downloads folder both react to the same file write and both call `importTrades.js`, which corrupts or duplicates data in the target sheet (see `importTrades.js`'s per-sheet lock below — it prevents the two instances from *racing*, but does not prevent them from *duplicating* an import, since neither instance knows about the other). Do not also start `watch.js` manually in a terminal if the scheduled task is enabled.

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
