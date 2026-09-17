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
  buildDynamicSchemaResult, formatIsraelDate, fileEntryUrl,
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

// --- DynamicCollector with bare FileName + field schema ---------------------
// Shape captured live from verdict_the_rabbinical_courts (2026-09): files are
// { FileName:"<bare name>", Extension, DisplayName } under Data.file, served at
// /BlobFolder/dynamiccollectorresultitem/<UrlName>/he/<FileName>.

const RABBINICAL_ITEM = {
  Data: {
    list: ['32'], list2: ['5'], list_3: ['8'],
    dayan: 'הרב שניאור פרדס',
    date: '2026-08-24T21:00:00Z',
    number: '00000001',
    file: [{ FileName: 'הגדרת מזונות.docx', FileMime: 'x', FileSize: '97593', Extension: 'docx', DisplayName: 'מאמר הרב פרדס' }],
    namepsak: 'מאמר: חיוב מזונות',
    des: { DescriptionHtmlString: '<p>תקציר</p>', DescriptionBlankTextString: 'תקציר' },
    avocat: 'לא רלוונטי',
  },
  Description: null,
  UrlName: 'pasad019',
};
const RABBINICAL_FIELDS = [
  { Type: 0, Name: 'list', Label: 'נושא', ResultsOrder: 3, MultiChoiseValues: { Values: [{ Key: '32', Value: 'מאמרים' }] } },
  { Type: 0, Name: 'list2', Label: 'בית דין', ResultsOrder: 2, MultiChoiseValues: { Values: [{ Key: '5', Value: 'ירושלים' }] } },
  { Type: 1, Name: 'dayan', Label: 'שם דיין', ResultsOrder: 5, MultiChoiseValues: null },
  { Type: 2, Name: 'date', Label: 'מועד מתן פסק הדין', ResultsOrder: 6, MultiChoiseValues: null },
  { Type: 1, Name: 'number', Label: 'מספר תיק', ResultsOrder: 7, MultiChoiseValues: null },
  { Type: 3, Name: 'file', Label: 'קובץ פסק הדין', ResultsOrder: 8, MultiChoiseValues: null },
  { Type: 5, Name: 'namepsak', Label: 'שם פסק דין', ResultsOrder: 1, MultiChoiseValues: null },
  { Type: 4, Name: 'des', Label: 'תקציר', ResultsOrder: 9, MultiChoiseValues: null },
  { Type: 1, Name: 'avocat', Label: 'שמות הפרקליטים והמייצגים', ResultsOrder: 10, MultiChoiseValues: null },
  { Type: 6, Name: 'list_3', Label: 'תת נושא', ResultsOrder: 4, MultiChoiseValues: { Values: [{ Key: '8', Value: 'מזונות', ParentKey: '13' }] } },
];
const RABBINICAL_URL = 'https://www.gov.il/BlobFolder/dynamiccollectorresultitem/pasad019/he/'
  + encodeURIComponent('הגדרת מזונות.docx');

test('attachments: bare FileName → BlobFolder url from UrlName', () => {
  const out = extractAttachmentsLite([RABBINICAL_ITEM], { kind: 'dynamic_collector' });
  assertEqual(out.length, 1);
  assertEqual(out[0].url, RABBINICAL_URL);
  assertEqual(out[0].filename, 'pasad019 - הגדרת מזונות.docx');
});

test('attachments: bare FileName without extension gets a sane Extension appended', () => {
  const item = { UrlName: 'x1', Data: { file: [{ FileName: 'psak', Extension: 'PDF' }] } };
  assertEqual(extractAttachmentsLite([item], {})[0].filename, 'x1 - psak.pdf');
});

test('attachments: bare FileName without UrlName → skipped', () => {
  assertEqual(extractAttachmentsLite([{ Data: { file: [{ FileName: 'a.docx' }] } }], {}).length, 0);
});

test('flattenItem: Data file array → link column (not dropped)', () => {
  const out = flattenItem(RABBINICAL_ITEM);
  assertEqual(out.file, RABBINICAL_URL);
});

test('fileEntryUrl: full URL passes through', () => {
  assertEqual(fileEntryUrl({ FileName: 'https://x.gov.il/a' }, 'u'), 'https://x.gov.il/a');
});

test('formatIsraelDate: UTC evening → next Israel calendar day', () => {
  assertEqual(formatIsraelDate('2026-08-24T21:00:00Z'), '2026-08-25');
  assertEqual(formatIsraelDate('2026-01-10T08:30:00Z'), '2026-01-10 10:30');
  assertEqual(formatIsraelDate('לא תאריך'), 'לא תאריך');
});

test('buildDynamicSchemaResult: labels, order, code→value, file names+links', () => {
  const res = buildDynamicSchemaResult([RABBINICAL_ITEM], 1, { originalUrl: 'u', collectorName: 'c', kind: 'dynamic_collector' }, null, RABBINICAL_FIELDS);
  assertEqual(res.fields.slice(0, 4), ['שם פסק דין', 'בית דין', 'נושא', 'תת נושא']);
  assert(res.fields.indexOf('קובץ פסק הדין - קישור') === res.fields.indexOf('קובץ פסק הדין') + 1, 'link column follows file column');
  const row = res.rows[0];
  assertEqual(row['נושא'], 'מאמרים');
  assertEqual(row['בית דין'], 'ירושלים');
  assertEqual(row['תת נושא'], 'מזונות');
  assertEqual(row['מועד מתן פסק הדין'], '2026-08-25');
  assertEqual(row['תקציר'], 'תקציר');
  assertEqual(row['קובץ פסק הדין'], 'מאמר הרב פרדס');
  assertEqual(row['קובץ פסק הדין - קישור'], RABBINICAL_URL);
  assertEqual(row.UrlName, 'pasad019');
  assertEqual(res.attachments.length, 1);
});

test('buildDynamicSchemaResult: legacy text values pass through, placeholders dropped', () => {
  const item = { UrlName: 'old1', Data: { list: [' גירושין ואכיפתם'], list2: ['_none'], list_3: ['- ללא -', '8'] } };
  const row = buildDynamicSchemaResult([item], 1, {}, null, RABBINICAL_FIELDS).rows[0];
  assertEqual(row['נושא'], 'גירושין ואכיפתם');
  assertEqual(row['בית דין'], '');
  assertEqual(row['תת נושא'], 'מזונות');
  assertEqual(row['קובץ פסק הדין'], '');
});

test('extractDynamicConfig: field schema array parsed from ng-init', () => {
  const init = `dynamicCtrl.Events.initCtrl({"listMultiChoiseValues":{"Values":[]}}, 0, '11111111-2222-3333-4444-555555555555','',10,'',[{"Type":0,"Name":"list","Label":"נושא [x]","MultiChoiseValues":{"Values":[{"Key":"1","Value":"א"}]}},{"Type":3,"Name":"file","Label":"קובץ"}],'MultiAutoComplete','99999999-2222-3333-4444-555555555555')`;
  const html = `<div ng-init="${init.replace(/"/g, '&quot;').replace(/'/g, '&#39;')}"></div>`;
  const cfg = extractDynamicConfig(html);
  assertEqual(cfg.templateId, '11111111-2222-3333-4444-555555555555');
  assertEqual(cfg.itemsPerPage, 10);
  assertEqual(cfg.fields.map(f => f.Name), ['list', 'file']);
  assertEqual(cfg.fields[0].Label, 'נושא [x]');
});

// --- orderFields ------------------------------------------------------------

test('orderFields: priority fields first, then rest in first-seen order', () => {
  const rows = [{ zzz: 1, title: 'a', url: 'u', extra: 2 }];
  assertEqual(orderFields(rows), ['title', 'url', 'zzz', 'extra']);
});

run('govil-transform');
