const { spawnSync } = require('node:child_process');
const path = require('node:path');

const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3', [
  path.join(__dirname, 'build-bank-shortcut.py'), '--check',
], { stdio: 'inherit' });
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
