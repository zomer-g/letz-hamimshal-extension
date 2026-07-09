// gov.il data-transform tests — the listing→row flattening, item/total
// extraction, attachment discovery, and ng-init config parsing. These mirror
// the API contracts in MEMORY.md and are the most regression-prone logic in the
// extension.
//
// Run: node tests/govil-transform.test.mjs

import { __test__ } from '../scrapers/govil.js';
import { test, run, assert, assertEqual } from './_assert.mjs';

const {
  extractItems, extractTotal, flattenItem, simplifyValue, htmlToPlainText,
  extractAttachmentsLite, decodeEntities, extractDynamicConfig, extractPageTitle, orderFields,
} = __test__;

// --- extractItems / extractTotal --------------------------------------------

test('extractItems: Results (DynamicCollector)', () => {
  assertEqual(extractItems({ Results: [{ a: 1 }], TotalResults: 1 }), [{ a: 1 }]);
});

test('extractItems: results (lowercase, traditional)', () => {
  assertEqual(extractItems({ results: [1, 2] }), [1, 2]);
});

test('extractItems: nested result object', () => {
  assertEqual(extractItems({ result: { items: [9] } }), [9]);
});

test('extractItems: bare array', () => {
  assertEqual(extractItems([1, 2, 3]), [1, 2, 3]);
});

test('extractItems: nothing → []', () => {
  assertEqual(extractItems({ foo: 'bar' }), []);
});

test('extractTotal: TotalResults', () => {
  assertEqual(extractTotal({ TotalResults: 1234 }), 1234);
});

test('extractTotal: lowercase total as string', () => {
  assertEqual(extractTotal({ total: '57' }), 57);
});

test('extractTotal: missing → null', () => {
  assertEqual(extractTotal({ items: [] }), null);
});

// --- flattenItem ------------------------------------------------------------

test('flattenItem: tags.metaData array of {title} → joined column', () => {
  const out = flattenItem({ tags: { metaData: { ministry: [{ title: 'בריאות' }, { title: 'אוצר' }] } } });
  assertEqual(out.ministry, 'בריאות, אוצר');
});

test('flattenItem: tags single {title} object → string', () => {
  const out = flattenItem({ tags: { metaData: { status: { title: 'פעיל' } } } });
  assertEqual(out.status, 'פעיל');
});

test('flattenItem: Data wrapper lifted to top level', () => {
  const out = flattenItem({ Data: { name: 'X', year: 2024 } });
  assertEqual(out.name, 'X');
  assertEqual(out.year, 2024);
});

test('flattenItem: SKIP_KEYS dropped (file/attachments)', () => {
  const out = flattenItem({ title: 'T', file: 'a.pdf', attachments: [1] });
  assertEqual(out.title, 'T');
  assert(!('file' in out), 'file should be skipped');
  assert(!('attachments' in out), 'attachments should be skipped');
});

test('flattenItem: relative url absolutized', () => {
  const out = flattenItem({ url: '/he/pages/foo' });
  assertEqual(out.url, 'https://www.gov.il/he/pages/foo');
});

// --- simplifyValue ----------------------------------------------------------

test('simplifyValue: null → empty string', () => {
  assertEqual(simplifyValue(null), '');
});

test('simplifyValue: primitive array joined with "; "', () => {
  assertEqual(simplifyValue(['a', 'b', 'c']), 'a; b; c');
});

test('simplifyValue: array of {title} joined with ", "', () => {
  assertEqual(simplifyValue([{ title: 'x' }, { title: 'y' }]), 'x, y');
});

test('simplifyValue: object with title → title', () => {
  assertEqual(simplifyValue({ title: 'hello', other: 1 }), 'hello');
});

test('simplifyValue: scalar passthrough', () => {
  assertEqual(simplifyValue(42), 42);
});

test('htmlToPlainText strips tags and decodes entities', () => {
  // Both </p> and <br> insert a newline; only runs of 3+ newlines collapse.
  assertEqual(htmlToPlainText('<p>a&amp;b</p><br>c'), 'a&b\n\nc');
});

test('htmlToPlainText collapses 3+ newlines to 2', () => {
  assertEqual(htmlToPlainText('a<br><br><br><br>b'), 'a\n\nb');
});

// --- extractAttachmentsLite -------------------------------------------------

test('attachments: bare BlobFolder PDF url', () => {
  const out = extractAttachmentsLite([{ someUrl: 'https://www.gov.il/BlobFolder/x/he/doc.pdf' }], {});
  assertEqual(out.length, 1);
  assertEqual(out[0].url, 'https://www.gov.il/BlobFolder/x/he/doc.pdf');
  assertEqual(out[0].filename, 'doc.pdf');
});

test('attachments: structured descriptor (FileName=url + Extension)', () => {
  const items = [{ Data: { Document: [{ FileName: 'https://www.gov.il/BlobFolder/a/b/file123', Extension: 'pdf', DisplayName: 'חוות דעת' }] } }];
  const out = extractAttachmentsLite(items, {});
  assertEqual(out.length, 1);
  assertEqual(out[0].url, 'https://www.gov.il/BlobFolder/a/b/file123');
  assertEqual(out[0].filename, 'חוות דעת.pdf');
});

test('attachments: dedup by absolute url', () => {
  const items = [
    { u: 'https://www.gov.il/BlobFolder/x/he/doc.pdf' },
    { v: 'https://www.gov.il/BlobFolder/x/he/doc.pdf' },
  ];
  assertEqual(extractAttachmentsLite(items, {}).length, 1);
});

test('attachments: non-doc url ignored', () => {
  assertEqual(extractAttachmentsLite([{ url: 'https://www.gov.il/he/pages/foo' }], {}).length, 0);
});

// --- decodeEntities / extractPageTitle / extractDynamicConfig ---------------

test('decodeEntities: HTML entities → chars', () => {
  assertEqual(decodeEntities('a&#39;b&quot;c&amp;d'), `a'b"c&d`);
});

test('extractPageTitle: h1 wins', () => {
  assertEqual(extractPageTitle('<h1>כותרת ראשית</h1><title>זנב | gov.il</title>'), 'כותרת ראשית');
});

test('extractPageTitle: title fallback strips gov.il suffix', () => {
  assertEqual(extractPageTitle('<title>שם המאגר | gov.il</title>'), 'שם המאגר');
});

test('extractDynamicConfig: templateId + itemsPerPage from ng-init', () => {
  const html = `<div ng-init="dynamicCtrl.Events.initCtrl(&#39;11111111-2222-3333-4444-555555555555&#39;,20,&#39;he&#39;)"></div>`;
  const cfg = extractDynamicConfig(html);
  assertEqual(cfg.templateId, '11111111-2222-3333-4444-555555555555');
  assertEqual(cfg.itemsPerPage, 20);
  assertEqual(cfg.resultsApiUrl, '');
});

test('extractDynamicConfig: custom results API + x-client-id (2nd GUID)', () => {
  const html = `<div ng-init="dynamicCtrl.Events.initCtrl(&#39;aaaaaaaa-1111-1111-1111-111111111111&#39;,20,&#39;https://pub-justice.openapi.gov.il/api/foo&#39;,&#39;bbbbbbbb-2222-2222-2222-222222222222&#39;)"></div>`;
  const cfg = extractDynamicConfig(html);
  assertEqual(cfg.templateId, 'aaaaaaaa-1111-1111-1111-111111111111');
  assertEqual(cfg.resultsApiUrl, 'https://pub-justice.openapi.gov.il/api/foo');
  assertEqual(cfg.xClientId, 'bbbbbbbb-2222-2222-2222-222222222222');
});

// --- orderFields ------------------------------------------------------------

test('orderFields: priority fields first, then rest in first-seen order', () => {
  const rows = [{ zzz: 1, title: 'a', url: 'u', extra: 2 }];
  assertEqual(orderFields(rows), ['title', 'url', 'zzz', 'extra']);
});

run('govil-transform');
