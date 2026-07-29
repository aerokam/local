const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const DOWNLOADS = path.join(os.homedir(), 'Downloads');

// Static filename → command (keys lowercase for case-insensitive matching)
const STATIC_TARGETS = {
  'schwaballaccounts.csv': 'node importSchwabAccounts.js',
  'fidelityallaccounts.csv': 'node importFidelityAccounts.js',
};

// Trades files matched case-insensitively; actual filename passed to script
// so importTrades.js can build the correct CSV path
const TRADES_KEYS = new Set([
  'tradespod.csv',
  'tradesroth.csv',
  'tradesira.csv',
  'tradesamyira.csv',
  'tradesamypod.csv',
  'tradesdana.csv',
  'tradesinherited.csv',
]);

const debounces = {};

function runImport(filename, command) {
  console.log(`[${new Date().toLocaleTimeString()}] Detected: ${filename} — running ${command}…`);
  try {
    execSync(command, { cwd: __dirname, stdio: 'inherit' });
  } catch {
    // error output already printed via stdio: inherit
  }
}

fs.watch(DOWNLOADS, (event, filename) => {
  if (!filename) return;
  const fullPath = path.join(DOWNLOADS, filename);
  if (!fs.existsSync(fullPath)) return; // ignore deletions

  // Windows ReadDirectoryChangesW can misattribute an event elsewhere in
  // Downloads to this filename (e.g. AV touching it right after another
  // file lands). Require the file to have actually been written recently.
  const { mtimeMs } = fs.statSync(fullPath);
  if (Date.now() - mtimeMs > 10000) return;

  const key = filename.toLowerCase();
  let command;

  if (key in STATIC_TARGETS) {
    command = STATIC_TARGETS[key];
  } else if (TRADES_KEYS.has(key)) {
    command = `node importTrades.js "${filename}"`;
  } else {
    return;
  }

  clearTimeout(debounces[key]);
  // wait 2 s so the browser finishes writing before we read the file
  debounces[key] = setTimeout(() => runImport(filename, command), 2000);
});

const allWatched = [
  ...Object.keys(STATIC_TARGETS),
  ...[...TRADES_KEYS],
].join(', ');
console.log(`Watching Downloads for: ${allWatched}`);
console.log('(Ctrl+C to stop)');
