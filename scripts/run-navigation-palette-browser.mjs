import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// The harness needs a Python with `websockets` and `psutil`. Prefer the repo's
// own venv, then the parent Mission Control venv used by the worktree layout.
const candidates = ['.venv/bin/python', '../.venv/bin/python', '../../.venv/bin/python'];
const interpreter = candidates.map((path) => resolve(path)).find((path) => existsSync(path));
if (!interpreter) {
  console.error(`Navigation palette browser harness needs a Python venv (websockets, psutil). Tried: ${candidates.join(', ')}`);
  process.exit(1);
}

const result = spawnSync(interpreter, ['-B', 'tests/navigation-palette-browser.py', ...process.argv.slice(2)], {
  cwd: process.cwd(), env: process.env, stdio: 'inherit',
});
if (result.error) {
  console.error('Navigation palette browser harness could not start');
  process.exit(1);
}
process.exit(result.status ?? 1);
