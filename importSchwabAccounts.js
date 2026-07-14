const fs = require('fs');
const path = require('path');
const os = require('os');
const { google } = require('googleapis');
const { parse } = require('csv-parse/sync');
const { authorize } = require('./auth');

// ── Config ────────────────────────────────────────────────────────────────────
const SPREADSHEET_ID = '1epVEbtnjE18fx9PBLrLFCrKw_D0pScIk31LV8qnv4J8'; // from the sheet URL
const SHEET_NAME     = 'Import';
const ANCHOR_ROW     = 2;
const ANCHOR_COL     = 3; // C

const CSV_PATH = path.join(os.homedir(), 'Downloads', 'SchwabAllAccounts.csv');

const INCLUDE_FIELDS = [
  'Symbol',
  'Description',
  'Qty (Quantity)',
  'Price',
  'Mkt Val (Market Value)',
  'Gain $ (Gain/Loss $)',
  'Gain % (Gain/Loss %)',
];
// ─────────────────────────────────────────────────────────────────────────────

function safeConvert(val) {
  const cleaned = val.replace(/[$,%]/g, '').trim();
  const num = Number(cleaned);
  return isNaN(num) || cleaned === '' ? val.trim() : num;
}

function colToLetter(col) {
  let letter = '';
  while (col > 0) {
    const rem = (col - 1) % 26;
    letter = String.fromCharCode(65 + rem) + letter;
    col = Math.floor((col - 1) / 26);
  }
  return letter;
}

function parseCsv(csvPath) {
  if (!fs.existsSync(csvPath)) {
    throw new Error(`CSV not found: ${csvPath}`);
  }

  const lines = parse(fs.readFileSync(csvPath, 'utf8'), {
    relax_quotes: true,
    relax_column_count: true,
    skip_empty_lines: false,
  });

  const accountPattern = /^[A-Za-z0-9_]+.*\.\.\.\d+$/;
  let currentAccount = '';
  const allData = [];

  for (let i = 0; i < lines.length; i++) {
    const row = lines[i];
    if (!row || row.every(c => c.trim() === '')) continue;

    if (row.includes('Symbol')) {
      let j = i - 1;
      while (j >= 0 && (!lines[j] || lines[j].every(c => c.trim() === ''))) j--;
      currentAccount = lines[j] ? lines[j].join(' ').trim() : 'Unknown Account';

      const fieldIndexes = INCLUDE_FIELDS.map(f => row.indexOf(f));

      let k = i + 1;
      while (k < lines.length) {
        const r = lines[k];
        if (!r || r.every(c => c.trim() === '')) { k++; continue; }
        if (r.includes('Symbol') || accountPattern.test(r.join(' ').trim())) break;

        const rowData = fieldIndexes.map(idx => idx === -1 ? '' : safeConvert(r[idx] || ''));
        if (rowData.some(v => v !== '')) allData.push([currentAccount, ...rowData]);
        k++;
      }

      allData.push(new Array(INCLUDE_FIELDS.length + 1).fill(''));
      i = k - 1;
    }
  }

  while (allData.length && allData[allData.length - 1].every(v => v === '')) allData.pop();
  return allData;
}

async function writeToSheet(auth, allData) {
  const sheets = google.sheets({ version: 'v4', auth });

  const startCol   = ANCHOR_COL - 1; // one left of anchor, matching GAS behavior
  const startLetter = colToLetter(startCol);
  const endLetter   = colToLetter(startCol + INCLUDE_FIELDS.length); // account col + fields
  const clearRange  = `${SHEET_NAME}!${startLetter}${ANCHOR_ROW}:${endLetter}1000`;

  await sheets.spreadsheets.values.clear({
    spreadsheetId: SPREADSHEET_ID,
    range: clearRange,
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!${startLetter}${ANCHOR_ROW}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: allData },
  });
}

const TIPS_ROOT = path.resolve(__dirname, '..', 'Treasuries', 'TipsLadderManager');

async function main() {
  if (SPREADSHEET_ID === 'YOUR_SPREADSHEET_ID_HERE') {
    console.error('Error: set SPREADSHEET_ID in import.js before running.');
    process.exit(1);
  }

  console.log(`Reading: ${CSV_PATH}`);
  const allData = parseCsv(CSV_PATH);
  console.log(`Parsed ${allData.length} rows across all accounts.`);

  // Copy raw CSV to TipsLadderManager/data/ (gitignored) and refresh sanitized test fixtures.
  try {
    const dataDir = path.join(TIPS_ROOT, 'data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    fs.copyFileSync(CSV_PATH, path.join(dataDir, 'SchwabAllAccounts.csv'));
    console.log('Copied to TipsLadderManager/data/SchwabAllAccounts.csv');
    const { execSync } = require('child_process');
    execSync('node scripts/generate-test-fixtures.js', { cwd: TIPS_ROOT, stdio: 'inherit' });
  } catch (e) {
    console.warn('generate-test-fixtures skipped:', e.message);
  }

  const auth = await authorize();

  console.log('Writing to sheet…');
  await writeToSheet(auth, allData);
  console.log('Done.');
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
