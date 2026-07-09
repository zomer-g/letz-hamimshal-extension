// Zero-dependency test micro-harness shared by all *.test.mjs files.
//
// Mirrors the style of wkt-parity.test.mjs: plain Node, no framework. Each test
// file imports { test, run } and calls run() at the end, which exits non-zero if
// any assertion failed (CI-friendly). Output is one line per case (ok/FAIL).

let _failed = 0;
let _passed = 0;
const _cases = [];

export function test(name, fn) {
  _cases.push({ name, fn });
}

function eq(a, b) {
  if (a === b) return true;
  // deep-equal for plain objects/arrays
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}

export function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

export function assertEqual(got, want, msg) {
  if (!eq(got, want)) {
    throw new Error(
      `${msg ? msg + ': ' : ''}expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`
    );
  }
}

export function assertDeepEqual(got, want, msg) {
  return assertEqual(got, want, msg);
}

export function assertClose(got, want, eps, msg) {
  if (!(Math.abs(got - want) <= eps)) {
    throw new Error(`${msg ? msg + ': ' : ''}expected ${want} ± ${eps}, got ${got}`);
  }
}

export function assertThrows(fn, msg) {
  let threw = false;
  try { fn(); } catch { threw = true; }
  if (!threw) throw new Error(msg || 'expected function to throw');
}

export async function run(suiteName) {
  console.log(`\n=== ${suiteName} ===`);
  for (const c of _cases) {
    try {
      await c.fn();
      _passed++;
      console.log(`ok   ${c.name}`);
    } catch (e) {
      _failed++;
      console.error(`FAIL ${c.name}`);
      console.error(`     ${e.message}`);
    }
  }
  console.log(`--- ${suiteName}: ${_passed} passed, ${_failed} failed ---`);
  if (_failed) process.exit(1);
}
