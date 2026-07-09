// Cross-engine WKT parity (extension side). Zero-dependency Node test.
//
// Pins lib/wkt.js geomToWkt() to the shared golden fixture so the JS serialiser
// produces byte-identical WKT to the Main scraper's Python coords.geom_to_wkt().
// The Main repo's tests/test_wkt_parity.py pins the Python side to a
// byte-identical copy of the same fixture and guards that the copies don't drift.
//
// Run:  node tests/wkt-parity.test.mjs
// Exits non-zero if any case fails (CI-friendly).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { geomToWkt } from '../lib/wkt.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(here, 'wkt_golden.json'), 'utf-8'));

let failed = 0;
for (const c of fixture.cases) {
  const got = geomToWkt(c.geom);
  if (got !== c.wkt) {
    failed++;
    console.error(`FAIL ${c.name}`);
    console.error(`  expected ${JSON.stringify(c.wkt)}`);
    console.error(`  got      ${JSON.stringify(got)}`);
  } else {
    console.log(`ok   ${c.name}`);
  }
}

if (failed) {
  console.error(`\n${failed} WKT-parity case(s) failed`);
  process.exit(1);
}
console.log(`\nAll ${fixture.cases.length} WKT-parity cases passed`);
