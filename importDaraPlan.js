// Copies a newly downloaded DARA plan for the Kevin IRA into TipsLadderManager/data/ (gitignored)
// and refreshes the sample fixtures, so the app's sample DARA plan (data/SampleDaraPlan.csv) is the
// scaled version of the latest saved plan. Triggered by watch.js on dara-plan-kevin-rmd.csv.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const CSV_PATH  = path.join(os.homedir(), 'Downloads', 'dara-plan-kevin-rmd.csv');
const TIPS_ROOT = path.resolve(__dirname, '..', 'Treasuries', 'TipsLadderManager');

function main() {
  if (!fs.existsSync(CSV_PATH)) throw new Error(`CSV not found: ${CSV_PATH}`);
  const dataDir = path.join(TIPS_ROOT, 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  fs.copyFileSync(CSV_PATH, path.join(dataDir, 'DaraPlanKevinRmd.csv'));
  console.log('Copied to TipsLadderManager/data/DaraPlanKevinRmd.csv');
  execSync('node scripts/generate-test-fixtures.js', { cwd: TIPS_ROOT, stdio: 'inherit' });
  console.log('Done.');
}

try {
  main();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
