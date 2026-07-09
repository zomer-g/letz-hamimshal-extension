// Runs every *.test.mjs in this directory as a separate Node process and
// aggregates the results. Exits non-zero if any suite fails (CI-friendly).
//
// Run: node tests/run-all.mjs   (or: npm test)

import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(here)
  .filter(f => f.endsWith('.test.mjs'))
  .sort();

let failed = 0;
const results = [];
for (const f of files) {
  const r = spawnSync(process.execPath, [join(here, f)], { stdio: 'inherit' });
  const ok = r.status === 0;
  if (!ok) failed++;
  results.push({ f, ok });
}

console.log('\n==================== SUMMARY ====================');
for (const { f, ok } of results) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${f}`);
}
console.log(`================================================`);
console.log(`${results.length - failed}/${results.length} suites passed`);
if (failed) process.exit(1);
