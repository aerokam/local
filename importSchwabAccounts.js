const fs = require('fs');
const path = require('path');
const os = require('os');
const { google } = require('googleapis');
const { authenticate } = require('@google-cloud/local-auth');
const { parse } = require('csv-parse/sync');

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

const CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');
const TOKEN_PATH        = path.join(__dirname, 'token.json');
const SCOPES            = ['https://www.googleapis.com/auth/spreadsheets'];

async function loadSavedCredentials() {
  try {
    const content = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
    return google.auth.fromJSON(content);
  } catch {
    return null;
  }
}

async function saveCredentials(client) {
  const keys = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
  const key = keys.installed || keys.web;
  fs.writeFileSync(TOKEN_PATH, JSON.stringify({
    type: 'authorized_user',
    client_id: key.client_id,
    client_secret: key.client_secret,
    refresh_token: client.credentials.refresh_token,
  }));
}

async function authorize() {
  let client = await loadSavedCredentials();
  if (client) return client;
  client = await authenticate({ keyfilePath: CREDENTIALS_PATH, scopes: SCOPES });
  await saveCredentials(client);
  return client;
}

async function main() {
  if (SPREADSHEET_ID === 'YOUR_SPREADSHEET_ID_HERE') {
    console.error('Error: set SPREADSHEET_ID in import.js before running.');
    process.exit(1);
  }

  console.log(`Reading: ${CSV_PATH}`);
  const allData = parseCsv(CSV_PATH);
  console.log(`Parsed ${allData.length} rows across all accounts.`);

  let auth = await authorize();

  try {
    console.log('Writing to sheet…');
    await writeToSheet(auth, allData);
    console.log('Done.');
  } catch (err) {
    if (err.message && err.message.includes('invalid_grant')) {
      console.log('Token expired. Re-authenticating...');
      fs.unlinkSync(TOKEN_PATH);
      auth = await authorize();
      console.log('Writing to sheet…');
      await writeToSheet(auth, allData);
      console.log('Done.');
    } else {
      throw err;
    }
  }
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
