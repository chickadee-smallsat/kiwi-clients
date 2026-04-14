const fs = require('node:fs');
const path = require('node:path');

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const APP_DIR = path.resolve(__dirname, '..');

const BIN_NAME = process.platform === 'win32' ? 'plotly-client.exe' : 'plotly-client';
const source = path.join(ROOT_DIR, 'target', 'release', BIN_NAME);
const targetDir = path.join(APP_DIR, 'resources', 'bin');
const target = path.join(targetDir, BIN_NAME);

if (!fs.existsSync(source)) {
  throw new Error(`Missing Rust binary at ${source}. Run cargo build --release -p plotly-client first.`);
}

fs.mkdirSync(targetDir, { recursive: true });
fs.copyFileSync(source, target);

if (process.platform !== 'win32') {
  fs.chmodSync(target, 0o755);
}

console.log(`Copied ${source} -> ${target}`);
