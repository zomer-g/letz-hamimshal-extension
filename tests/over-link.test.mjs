// OVER deep-link builder tests. The /direct/ route resolves a dataset BY its
// source address, so the exact concatenation shape matters: the target URL is
// appended verbatim, never percent-encoded.
//
// Run: node tests/over-link.test.mjs

import { overDirectUrl, overSearchUrl, OVER_HOME } from '../lib/over-link.js';
import { test, run, assertEqual } from './_assert.mjs';

test('appends the target URL verbatim (the shape OVER documents)', () => {
  // The reference example from over.org.il.
  assertEqual(
    overDirectUrl('https://www.govmap.gov.il/?c=219143.61,618345.06&lay=11'),
    'https://over.org.il/direct/https://www.govmap.gov.il/?c=219143.61,618345.06&lay=11'
  );
});

test('does NOT percent-encode the target', () => {
  const out = overDirectUrl('https://www.gov.il/he/pages/a?b=1&c=2');
  assertEqual(out.includes('%3A'), false);
  assertEqual(out.includes('%2F'), false);
  assertEqual(out.endsWith('https://www.gov.il/he/pages/a?b=1&c=2'), true);
});

test('http is accepted as well as https', () => {
  assertEqual(overDirectUrl('http://example.gov.il/x'), 'https://over.org.il/direct/http://example.gov.il/x');
});

test('falls back to the OVER home page for non-web addresses', () => {
  // The popup has no "tabs" permission, so a page with no content script yields
  // no URL at all — the CTA must still be a live link, never "/direct/undefined".
  for (const bad of [undefined, null, '', '   ', 'chrome://extensions', 'about:blank', 'javascript:alert(1)']) {
    assertEqual(overDirectUrl(bad), OVER_HOME);
  }
});

test('trims surrounding whitespace', () => {
  assertEqual(overDirectUrl('  https://www.govmap.gov.il/?lay=11 '), 'https://over.org.il/direct/https://www.govmap.gov.il/?lay=11');
});

test('search links percent-encode the query (Hebrew layer captions)', () => {
  assertEqual(overSearchUrl('גושים וחלקות'), OVER_HOME + '?q=' + encodeURIComponent('גושים וחלקות'));
  assertEqual(overSearchUrl(''), OVER_HOME);
  assertEqual(overSearchUrl(null), OVER_HOME);
});

run('over-link');
