import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const result = spawnSync(resolve('.venv/bin/python'), ['-B', 'tests/provider-usage-browser.py', ...process.argv.slice(2)], {
  cwd: process.cwd(), env: process.env, stdio: 'inherit',
});
if (result.error) {
  console.error('Provider usage browser harness could not start');
  process.exit(1);
}
process.exit(result.status ?? 1);
