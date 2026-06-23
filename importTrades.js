const fs = require('fs');
const path = require('path');
const os = require('os');
const { google } = require('googleapis');
const { authenticate } = require('@google-cloud/local-auth');
const { parse } = require('csv-parse/sync');

// ── Config ────────────────────────────────────────────────────────────────────
const SPREADSHEET_ID = '1epVEbtnjE18fx9PBLrLFCrKw_D0pScIk31LV8qnv4J8';

const SHEET_MAP = {
  'tradespod.csv':     { sheetId: 1540387774, name: 'TradesPOD' },
  'tradesroth.csv':    { sheetId: 889893703,  name: 'TradesRoth' },
  'tradesira.csv':     { sheetId: 2124339902, name: 'TradesIRA' },
  'tradesamyira.csv':  { sheetId: 1839917397, name: 'TradesAmyIRA' },
  'tradesamypod.csv':  { sheetId: 1218857201, name: 'TradesAmyPOD' },
  'tradesdana.csv':    { sheetId: 74383282,   name: 'TradesDana' },
  'tradesinherited.csv': { sheetId: 392046034, name: 'TradesInheritedIRA' },
};
// ─────────────────────────────────────────────────────────────────────────────

const CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');
const TOKEN_PATH        = path.join(__dirname, 'token.json');
const SCOPES            = ['https://www.googleapis.com/auth/spreadsheets'];

function safeConvert(val) {
  const cleaned = String(val).replace(/[$,%]/g, '').trim();
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
    skip_empty_lines: true,
  });
  return rows.map(row => row.map(safeConvert));
}

async function getColCount(sheets, sheetName, rowNum) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!${rowNum}:${rowNum}`,
  });
  return (res.data.values?.[0] || []).length;
}

async function getLastRow(sheets, sheetName) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!A:A`,
  });
  return (res.data.values || []).length;
}

async function importToSheet(sheets, csvData, sheetConfig) {
  const { sheetId, name } = sheetConfig;

  // csvData[0] is the header — skip it
  const dataRows = csvData.slice(1);
  const numDataRows = dataRows.length;
  if (numDataRows === 0) throw new Error('CSV has no data rows.');

  const lastRowBefore = await getLastRow(sheets, name);   // 1-indexed last existing row
  const lastColBefore = await getColCount(sheets, name, lastRowBefore); // col count of last existing row

  const insertAt0    = lastRowBefore;          // 0-indexed insert position
  const firstRow1    = lastRowBefore + 1;      // 1-indexed first new data row

  // ── 1. Add empty rows at end of sheet ────────────────────────────────────
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      requests: [{
        appendDimension: {
          sheetId,
          dimension: 'ROWS',
          length: numDataRows,
        },
      }],
    },
  });

  // ── 2. Write data ─────────────────────────────────────────────────────────
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${name}!A${firstRow1}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: dataRows },
  });

  // ── 3. Copy formulas from last existing row into new rows (cols I+) ───────
  if (lastColBefore > 8) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: {
        requests: [{
          copyPaste: {
            source: {
              sheetId,
              startRowIndex: lastRowBefore - 1, // 0-indexed last existing row
              endRowIndex:   lastRowBefore,
              startColumnIndex: 8,              // col I
              endColumnIndex:   lastColBefore,
            },
            destination: {
              sheetId,
              startRowIndex: insertAt0,
              endRowIndex:   insertAt0 + numDataRows,
              startColumnIndex: 8,
              endColumnIndex:   lastColBefore,
            },
            pasteType: 'PASTE_FORMULA',
          },
        }],
      },
    });
  }

  // ── 4. Read back inserted rows for post-processing ────────────────────────
  const readRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${name}!A${firstRow1}:H${firstRow1 + numDataRows - 1}`,
  });
  const rows = readRes.data.values || [];

  // Tag each row with its original sheet position (0-indexed) so we can
  // batch-delete safely after in-memory processing
  const ops = rows.map((data, i) => ({
    data,
    sheetRow0: insertAt0 + i,   // 0-indexed
    sheetRow1: firstRow1 + i,   // 1-indexed
    deleted: false,
    valueUpdates: [],
  }));

  // ── 5. Merge adjacent Full Redemption pairs (bottom-up) ───────────────────
  const active = [...ops];
  for (let i = active.length - 1; i > 0; i--) {
    const curr = active[i];
    const prev = active[i - 1];
    if (String(curr.data[1] || '').includes('Full Redemption') &&
        String(prev.data[1] || '').includes('Full Redemption')) {
      prev.valueUpdates.push({ col: 5, value: curr.data[4] }); // copy col E
      curr.deleted = true;
      active.splice(i, 1);
    }
  }

  // ── 6. Delete SWVXX / SNSXX rows ─────────────────────────────────────────
  for (const op of active) {
    const sym = String(op.data[2] || '');
    if (sym === 'SWVXX' || sym === 'SNSXX') op.deleted = true;
  }

  // ── 7. Apply value updates (Full Redemption col E copies) ────────────────
  const allUpdates = ops.flatMap(op =>
    op.valueUpdates.map(u => ({
      range: `${name}!${colToLetter(u.col)}${op.sheetRow1}`,
      values: [[u.value]],
    }))
  );
  if (allUpdates.length) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { valueInputOption: 'USER_ENTERED', data: allUpdates },
    });
  }

  // ── 8. Delete rows bottom-up ──────────────────────────────────────────────
  const toDelete = ops
    .filter(op => op.deleted)
    .map(op => op.sheetRow0)
    .sort((a, b) => b - a);

  if (toDelete.length) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: {
        requests: toDelete.map(row0 => ({
          deleteDimension: {
            range: { sheetId, dimension: 'ROWS', startIndex: row0, endIndex: row0 + 1 },
          },
        })),
      },
    });
  }

  // ── 9. Format columns + sort ──────────────────────────────────────────────
  const newDataRowCount = numDataRows - toDelete.length;
  const totalLastCol = Math.max(lastColBefore, 8);

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      requests: [
        // Column formats (entire columns, matching GAS behavior)
        { repeatCell: { range: { sheetId, startColumnIndex: 0, endColumnIndex: 1 },
            cell: { userEnteredFormat: { numberFormat: { type: 'DATE',   pattern: 'MM/dd/yy'   } } },
            fields: 'userEnteredFormat.numberFormat' } },
        { repeatCell: { range: { sheetId, startColumnIndex: 4, endColumnIndex: 5 },
            cell: { userEnteredFormat: { numberFormat: { type: 'NUMBER', pattern: '#,##0'       } } },
            fields: 'userEnteredFormat.numberFormat' } },
        { repeatCell: { range: { sheetId, startColumnIndex: 5, endColumnIndex: 6 },
            cell: { userEnteredFormat: { numberFormat: { type: 'NUMBER', pattern: '#,##0.0000'  } } },
            fields: 'userEnteredFormat.numberFormat' } },
        { repeatCell: { range: { sheetId, startColumnIndex: 7, endColumnIndex: 8 },
            cell: { userEnteredFormat: { numberFormat: { type: 'NUMBER', pattern: '#,##0.00'    } } },
            fields: 'userEnteredFormat.numberFormat' } },
        // Sort: date asc, then action desc (Sell before Buy)
        {
          sortRange: {
            range: {
              sheetId,
              startRowIndex:    insertAt0,
              endRowIndex:      insertAt0 + newDataRowCount,
              startColumnIndex: 0,
              endColumnIndex:   totalLastCol,
            },
            sortSpecs: [
              { dimensionIndex: 0, sortOrder: 'ASCENDING'  }, // col A: date
              { dimensionIndex: 1, sortOrder: 'DESCENDING' }, // col B: Sell before Buy
            ],
          },
        },
      ],
    },
  });
}

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
  const filename = process.argv[2];
  if (!filename) {
    console.error('Usage: node importTrades.js <filename.csv>');
    process.exit(1);
  }

  const sheetConfig = SHEET_MAP[filename.toLowerCase()];
  if (!sheetConfig) {
    console.error(`Unknown file: ${filename}`);
    console.error(`Known files: ${Object.keys(SHEET_MAP).join(', ')}`);
    process.exit(1);
  }

  const csvPath = path.join(os.homedir(), 'Downloads', filename);
  console.log(`Reading: ${csvPath}`);
  const csvData = parseCsv(csvPath);
  console.log(`Parsed ${csvData.length - 1} data rows → sheet "${sheetConfig.name}"`);

  const auth = await authorize();
  const sheets = google.sheets({ version: 'v4', auth });

  console.log('Writing to sheet…');
  await importToSheet(sheets, csvData, sheetConfig);
  console.log('Done.');
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
