// buildLawModel() tests — the consolidated-law page (/laws/<id>).
// Verifies: amendment files become downloadable docs, files are deduped by URL
// (one publication can cover several correction numbers), backslash URLs are
// normalized, and the file-less collections ride along as catalog CSVs.
//
// Run: node tests/knesset-law.test.mjs

import { buildLawModel } from '../scrapers/knesset.js';
import { test, run, assert, assertEqual } from './_assert.mjs';

// Minimal shape mirroring GetLegislationLawItem (backslash paths, shared file).
const FIXTURE = {
  general: {
    itemId: '2000613', hebSubject: 'חוק התכנון והבנייה, התשכ"ה-1965', lawValidity: 'תקף',
    publicationDate: '1965-08-12T00:00:00', latestPublicationDate: '2026-04-05T00:00:00',
    knsName: 'כנסת 5', lawSubjectsName: ' תכנון ובנייה', ministriesName: ' הפנים',
    committeeNames: ' פנים והגנת הסביבה', openBookUrl: 'https://he.wikisource.org/x', kolZchutUrl: '',
  },
  corrections: {
    listCorrections: [
      { correctionNumber: '167', name: 'חוק א', correctionType: 'עקיף', publicationDate: '2026-04-05T15:11:00', filePath: 'https://fs.knesset.gov.il/25\\law\\25_lsr_1.pdf', fileType: 'pdf', summaryLaw: '<p>סיכום</p>' },
      { correctionNumber: '166', name: 'חוק ב', correctionType: 'עקיף', publicationDate: '2026-03-31T14:19:00', filePath: 'https://fs.knesset.gov.il/25\\law\\25_lsr_2.pdf', fileType: 'pdf' },
      { correctionNumber: '165', name: 'חוק ב', correctionType: 'עקיף', publicationDate: '2026-03-31T14:19:00', filePath: 'https://fs.knesset.gov.il/25\\law\\25_lsr_2.pdf', fileType: 'pdf' }, // same file as 166
      { correctionNumber: '164', name: 'חוק ללא קובץ', correctionType: 'ישיר', publicationDate: '2025-01-01T00:00:00', filePath: '', fileType: null }, // no file
    ],
    listLegislationBills: [{ itemId: '1042100', name: 'הצעת חוק', description: ' (מ/1898) ', subTypeName: 'ממשלתית', currentStep: 'הכנה', committeeName: 'ועדה', latestSessionDate: '2026-07-12T16:30:00' }],
    listRelatedsReplaceAnother: [{ itemId: '2000836', name: 'פקודה', displayPublicationDate: '1936-05-04T00:00:00', ValidityFinishDate: '1981-07-01T00:00:00' }],
    listRelatedsReplacedBy: [],
  },
  secondaryLawInstalled: [{ itemId: '2192223', name: 'תקנות', statusDesc: '', knessetId: '24', sessionDate: '2022-06-20T12:00:00', PublicationDate: '2022-07-17T00:00:00', committeeName: 'ועדה', informers: ' משרד הפנים', clouse: ' טרם' }],
  secondaryLawInProcess: [{ itemId: '2218633', name: 'צו', statusDesc: 'לאשר', knessetId: '25', sessionDate: '2024-07-03T10:00:00', PublicationDate: 'None', committeeName: 'ועדה', informers: ' משפטים', clouse: ' 69' }],
};

test('law model: amendment PDFs become docs, deduped by URL', () => {
  const m = buildLawModel(FIXTURE);
  assertEqual(m.categories.length, 1);
  const cat = m.categories[0];
  assertEqual(cat.key, 'corrections');
  // 4 corrections → 167 + (166/165 share a file) + 164 has no file = 2 unique docs
  assertEqual(cat.count, 2);
  assertEqual(cat.docs.length, 2);
});

test('law model: backslash paths normalized to forward slashes', () => {
  const m = buildLawModel(FIXTURE);
  for (const d of m.categories[0].docs) {
    assert(!d.url.includes('\\'), `url still has backslash: ${d.url}`);
    assert(d.url.startsWith('https://fs.knesset.gov.il/'), d.url);
    assertEqual(d.ext, 'pdf');
  }
});

test('law model: doc descr carries correction number + name + date', () => {
  const m = buildLawModel(FIXTURE);
  const first = m.categories[0].docs[0];
  assert(first.descr.includes('תיקון 167'), first.descr);
  assert(first.descr.includes('חוק א'), first.descr);
  assert(first.descr.includes('2026-04-05'), first.descr);
});

test('law model: info CSV row summarizes the law', () => {
  const m = buildLawModel(FIXTURE);
  assertEqual(m.billInfoRows.length, 1);
  assertEqual(m.billInfoRows[0].ItemId, '2000613');
  assertEqual(m.billInfoRows[0].PublicationDate, '1965-08-12');
  assertEqual(m.bill.name, 'חוק התכנון והבנייה, התשכ"ה-1965');
  assertEqual(m.bill.status, 'תקף');
});

test('law model: catalog CSVs for file-less collections', () => {
  const m = buildLawModel(FIXTURE);
  const keys = m.dataCsvs.map(c => c.key);
  assertEqual(keys.join(','), 'corrections,secondary,bills,related');
  const corr = m.dataCsvs.find(c => c.key === 'corrections');
  assertEqual(corr.rows.length, 4); // ALL corrections, incl. the file-less one
  assertEqual(corr.rows[0].summary, 'סיכום'); // html stripped
  const sec = m.dataCsvs.find(c => c.key === 'secondary');
  assertEqual(sec.rows.length, 2); // installed + in-process merged
  assertEqual(sec.rows[0].state, 'מותקנת');
  assertEqual(sec.rows[1].state, 'בהליך');
});

test('law model: empty/garbage input degrades gracefully', () => {
  const m = buildLawModel({});
  assertEqual(m.categories.length, 0);
  assertEqual(m.dataCsvs.length, 0);
  assertEqual(m.billInfoRows.length, 1);
});

run();
