const fs = require('fs');
const path = require('path');
const os = require('os');
const { google } = require('googleapis');
const { authenticate } = require('@google-cloud/local-auth');
const { parse } = require('csv-parse/sync');

// ── Config ────────────────────────────────────────────────────────────────────
const SPREADSHEET_ID = '1pDPmDW3S3heYks7eZ-2Ipu7v_CSDsEKpneMZQL4m_No';
const SHEET_NAME     = 'Download';
const ANCHOR_ROW     = 1;
const ANCHOR_COL     = 2; // B
const MAX_COLS       = 16; // B:Q

const CSV_PATH = path.join(os.homedir(), 'Downloads', 'FidelityAllAccounts.csv');
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
  if (!fs.existsSync(csvPath)) throw new Error(`CSV not found: ${csvPath}`);

  const rows = parse(fs.readFileSync(csvPath, 'utf8'), {
    relax_quotes: true,
    relax_column_count: true,
    skip_empty_lines: false,
  });

  return rows.map(row => row.slice(0, MAX_COLS).map(cell => safeConvert(cell)));
}

async function writeToSheet(auth, allData) {
  const sheets = google.sheets({ version: 'v4', auth });

  const startLetter = colToLetter(ANCHOR_COL);
  const endLetter   = colToLetter(ANCHOR_COL + MAX_COLS - 1);
  const clearRange  = `${SHEET_NAME}!${startLetter}${ANCHOR_ROW}:${endLetter}${ANCHOR_ROW + allData.length}`;

  await sheets.spreadsheets.values.clear({ spreadsheetId: SPREADSHEET_ID, range: clearRange });

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!${startLetter}${ANCHOR_ROW}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: allData },
  });

  // Match GAS: setNumberFormat("@") on column B → plain text
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const sheet = meta.data.sheets.find(s => s.properties.title === SHEET_NAME);
  if (sheet) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: {
        requests: [{
          repeatCell: {
            range: {
              sheetId: sheet.properties.sheetId,
              startColumnIndex: ANCHOR_COL - 1,
              endColumnIndex: ANCHOR_COL,
            },
            cell: { userEnteredFormat: { numberFormat: { type: 'TEXT' } } },
            fields: 'userEnteredFormat.numberFormat',
          },
        }],
      },
    });
  }
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

const TIPS_ROOT = path.resolve(__dirname, '..', 'Treasuries', 'TipsLadderManager');

async function main() {
  console.log(`Reading: ${CSV_PATH}`);
  const allData = parseCsv(CSV_PATH);
  console.log(`Parsed ${allData.length} rows.`);

  // Copy raw CSV to TipsLadderManager/data/ (gitignored) and refresh sanitized test fixtures.
  try {
    const dataDir = path.join(TIPS_ROOT, 'data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    fs.copyFileSync(CSV_PATH, path.join(dataDir, 'FidelityAllAccounts.csv'));
    console.log('Copied to TipsLadderManager/data/FidelityAllAccounts.csv');
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
