// URL → scraper dispatch tests. Covers registry.dispatchByUrl() and every
// scraper's parseUrl(): positive matches, negative (must-not-match) cases, and
// registry ordering (govmap/nadlan/idf/mavat must win over the generic govil
// matcher on shared *.gov.il hosts).
//
// Run: node tests/dispatch.test.mjs

import { dispatchByUrl } from '../scrapers/registry.js';
import { test, run, assert, assertEqual } from './_assert.mjs';

function kindOf(href) {
  const m = dispatchByUrl(href);
  return m ? `${m.scraper.id}:${m.parsed.kind}` : null;
}
function parse(href) {
  const m = dispatchByUrl(href);
  return m ? m.parsed : null;
}

// --- gov.il (govil) ---------------------------------------------------------

test('govil dynamic collector', () => {
  const p = parse('https://www.gov.il/he/departments/dynamiccollectors/some_collector');
  assertEqual(p.scraperId, 'govil');
  assertEqual(p.kind, 'dynamic_collector');
  assertEqual(p.collectorName, 'some_collector');
});

test('govil dynamic collector (capitalized path)', () => {
  assertEqual(kindOf('https://www.gov.il/he/Departments/DynamicCollectors/X'), 'govil:dynamic_collector');
});

test('govil traditional collector + officeId', () => {
  const p = parse('https://www.gov.il/he/collectors/foo?officeId=42');
  assertEqual(p.kind, 'traditional_collector');
  assertEqual(p.collectorName, 'foo');
  assertEqual(p.officeId, '42');
});

test('govil content page', () => {
  const p = parse('https://www.gov.il/he/pages/some_page');
  assertEqual(p.kind, 'content_page');
  assertEqual(p.collectorName, 'some_page');
});

test('govil extra query params kept (minus reserved)', () => {
  const p = parse('https://www.gov.il/he/collectors/foo?officeId=42&year=2024&skip=20');
  assertEqual(p.queryParams.year, '2024');
});

test('govil rejects bare gov.il homepage', () => {
  assertEqual(kindOf('https://www.gov.il/he/'), null);
});

test('govil rejects data.gov.il', () => {
  assertEqual(kindOf('https://data.gov.il/dataset/foo'), null);
});

// --- nadlan -----------------------------------------------------------------

test('nadlan parcel (kparcel_all)', () => {
  const p = parse('https://www.nadlan.gov.il/?view=kparcel_all&id=30649-58');
  assertEqual(p.scraperId, 'nadlan');
  assertEqual(p.kind, 'parcel');
  assertEqual(p.gush, '30649');
  assertEqual(p.chelka, '58');
});

test('nadlan parcel rejects id without dash', () => {
  assertEqual(kindOf('https://www.nadlan.gov.il/?view=kparcel_all&id=30649'), null);
});

test('nadlan neighborhood requires page=deals', () => {
  assertEqual(kindOf('https://www.nadlan.gov.il/?view=neighborhood&id=65210'), null);
  assertEqual(kindOf('https://www.nadlan.gov.il/?view=neighborhood&id=65210&page=deals'), 'nadlan:neighborhood_deals');
});

test('nadlan settlement + street deals', () => {
  assertEqual(kindOf('https://www.nadlan.gov.il/?view=settlement&id=5000&page=deals'), 'nadlan:settlement_deals');
  assertEqual(kindOf('https://www.nadlan.gov.il/?view=street&id=900&page=deals'), 'nadlan:street_deals');
});

test('nadlan rejects unknown view', () => {
  assertEqual(kindOf('https://www.nadlan.gov.il/?view=bogus&id=1&page=deals'), null);
});

test('nadlan rejects missing id', () => {
  assertEqual(kindOf('https://www.nadlan.gov.il/?view=street&page=deals'), null);
});

// --- govmap -----------------------------------------------------------------

test('govmap single layer', () => {
  const p = parse('https://www.govmap.gov.il/?lay=512');
  assertEqual(p.scraperId, 'govmap');
  assertEqual(p.kind, 'wfs_layer');
  assertEqual(p.layerId, '512');
  assertEqual(p.layerIds, ['512']);
});

test('govmap multi-layer (comma list)', () => {
  const p = parse('https://www.govmap.gov.il/?lay=512,513,514');
  assertEqual(p.layerIds, ['512', '513', '514']);
  assertEqual(p.layerId, '512');
});

test('govmap bbox parsed to 4 numbers', () => {
  const p = parse('https://www.govmap.gov.il/?lay=512&bbox=180000,660000,182000,662000');
  assertEqual(p.bboxItm, [180000, 660000, 182000, 662000]);
});

test('govmap rejects no layer param', () => {
  assertEqual(kindOf('https://www.govmap.gov.il/'), null);
});

// --- idf --------------------------------------------------------------------

test('idf allowed section (military prosecution)', () => {
  const p = parse('https://www.idf.il/%D7%90%D7%AA%D7%A8%D7%99-%D7%99%D7%97%D7%99%D7%93%D7%95%D7%AA/%D7%94%D7%A4%D7%A8%D7%A7%D7%9C%D7%99%D7%98%D7%95%D7%AA-%D7%94%D7%A6%D7%91%D7%90%D7%99%D7%AA/foo/');
  assert(p !== null, 'expected match');
  assertEqual(p.kind, 'idf_section');
  assertEqual(p.section, 'הפרקליטות-הצבאית');
});

test('idf rejects non-allowlisted section', () => {
  assertEqual(kindOf('https://www.idf.il/%D7%90%D7%AA%D7%A8%D7%99-%D7%99%D7%97%D7%99%D7%93%D7%95%D7%AA/some-other-unit/'), null);
});

test('idf rejects unrelated idf path', () => {
  assertEqual(kindOf('https://www.idf.il/news/'), null);
});

// --- mavat ------------------------------------------------------------------

test('mavat plan page', () => {
  const p = parse('https://mavat.iplan.gov.il/SV4/1/1010230000/110');
  assertEqual(p.scraperId, 'mavat');
  assertEqual(p.kind, 'mavat_plan');
  assertEqual(p.mid, '1010230000');
});

test('mavat rejects non-plan path', () => {
  assertEqual(kindOf('https://mavat.iplan.gov.il/'), null);
});

// --- jlm (Jerusalem building-licensing) -------------------------------------

test('jlm details page (real file number) → jlm_tik', () => {
  const p = parse('https://ykpubdata.jerusalem.muni.il/#/Details?TikNum=1992%2F0699.03&SystemCode=26400046&Page=BakashalInfo');
  assertEqual(p.scraperId, 'jlm');
  assertEqual(p.kind, 'jlm_tik');
  assertEqual(p.tikNum, '1992/0699.03'); // URL-decoded from %2F
  assertEqual(p.systemCode, '26400046');
});

test('jlm supervision system (26400056) also matches jlm_tik', () => {
  assertEqual(kindOf('https://ykpubdata.jerusalem.muni.il/#/Details?TikNum=10%2F20&SystemCode=26400056'), 'jlm:jlm_tik');
});

test('jlm address list (TableData) → jlm_list', () => {
  const p = parse('https://ykpubdata.jerusalem.muni.il/#/TableData?TikNum=0&SystemCode=26400046');
  assertEqual(p.kind, 'jlm_list');
  assertEqual(p.systemCode, '26400046');
});

test('jlm Details with TikNum=0 is not a file → home', () => {
  assertEqual(kindOf('https://ykpubdata.jerusalem.muni.il/#/Details?TikNum=0&SystemCode=26400046'), 'jlm:jlm_home');
});

test('jlm search/home landing → jlm_home', () => {
  assertEqual(kindOf('https://ykpubdata.jerusalem.muni.il/#/?SystemCode=26400046'), 'jlm:jlm_home');
  assertEqual(kindOf('https://ykpubdata.jerusalem.muni.il/'), 'jlm:jlm_home');
});

test('jlm details without TikNum falls back to home', () => {
  assertEqual(kindOf('https://ykpubdata.jerusalem.muni.il/#/Details?SystemCode=26400046'), 'jlm:jlm_home');
});

test('jlm rejects other jerusalem.muni.il hosts', () => {
  assertEqual(kindOf('https://www.jerusalem.muni.il/'), null);
});

// --- registry ordering: specific hosts must NOT be captured by govil ---------

test('ordering: nadlan host not captured by govil', () => {
  const m = dispatchByUrl('https://www.nadlan.gov.il/?view=street&id=9&page=deals');
  assertEqual(m.scraper.id, 'nadlan');
});

test('ordering: govmap host not captured by govil', () => {
  const m = dispatchByUrl('https://www.govmap.gov.il/?lay=1');
  assertEqual(m.scraper.id, 'govmap');
});

test('ordering: mavat host not captured by govil', () => {
  const m = dispatchByUrl('https://mavat.iplan.gov.il/SV4/1/123/1');
  assertEqual(m.scraper.id, 'mavat');
});

test('non-gov url → no match', () => {
  assertEqual(kindOf('https://example.com/he/collectors/foo'), null);
});

test('garbage url → no match (no throw)', () => {
  assertEqual(kindOf('not a url'), null);
});

run('dispatch');
