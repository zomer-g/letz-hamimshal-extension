// GovMap geometry/projection tests — ITM(EPSG:6991)→WGS84 inverse, Web-Mercator
// inverse, CRS auto-detection, centroid, bbox parse. Spatial correctness is
// critical (see govscraper-spatial); a regression here silently corrupts every
// lon/lat in the output CSV/GeoJSON.
//
// Run: node tests/govmap-proj.test.mjs

import { __test__ } from '../scrapers/govmap.js';
import { test, run, assert, assertEqual, assertClose } from './_assert.mjs';

const {
  itmToWgs84, wgs84ToItm, mercatorToWgs84, wgs84ToMercator, mercatorToItm,
  detectCrs, computeCentroid, parseBbox, slugify, wktToGeoJson,
} = __test__;

// Golden values from pyproj (EPSG:6991 ↔ EPSG:4326), the Main scraper's
// authority. EPSG:6991 carries a 7-param datum shift, so the false origin does
// NOT invert to the nominal (lon0,lat0) — it lands ~78 m away. These goldens
// pin the datum-aware chain to pyproj.
test('ITM→WGS84 matches pyproj golden (Tel Aviv)', () => {
  const [lon, lat] = itmToWgs84(185120.2296, 665099.3368);
  assertClose(lon, 34.840764266, 1e-7, 'lon');
  assertClose(lat, 32.078664953, 1e-7, 'lat');
});

test('WGS84→ITM matches pyproj golden (Tel Aviv)', () => {
  const [x, y] = wgs84ToItm(34.84076426604166, 32.078664952832284);
  assertClose(x, 185120.2296, 1e-2, 'easting');
  assertClose(y, 665099.3368, 1e-2, 'northing');
});

test('ITM↔WGS84 round-trips to sub-mm', () => {
  const [lon, lat] = itmToWgs84(195000, 700000);
  const [x, y] = wgs84ToItm(lon, lat);
  assertClose(x, 195000, 1e-3, 'easting');
  assertClose(y, 700000, 1e-3, 'northing');
});

test('mercatorToItm (3857→6991) matches pyproj golden', () => {
  // Live entitiesByPoint geom: POINT(3878456.136944239 3773641.059844983)
  const [x, y] = mercatorToItm(3878456.136944239, 3773641.059844983);
  assertClose(x, 185120.2296, 1e-2, 'easting');
  assertClose(y, 665099.3368, 1e-2, 'northing');
});

test('ITM typical point lands inside Israel bbox', () => {
  const [lon, lat] = itmToWgs84(180000, 663000);
  assert(lon > 34 && lon < 36, `lon out of range: ${lon}`);
  assert(lat > 31 && lat < 33, `lat out of range: ${lat}`);
});

test('ITM is monotonic: +easting → +longitude', () => {
  const [lonA] = itmToWgs84(180000, 663000);
  const [lonB] = itmToWgs84(200000, 663000);
  assert(lonB > lonA, 'easting increase should increase longitude');
});

test('Web-Mercator round-trips WGS84', () => {
  const [x, y] = wgs84ToMercator(34.84, 32.07);
  const [lon, lat] = mercatorToWgs84(x, y);
  assertClose(lon, 34.84, 1e-9, 'lon');
  assertClose(lat, 32.07, 1e-7, 'lat');
});

// --- WKT (EPSG:3857) → GeoJSON ----------------------------------------------

test('wktToGeoJson: POINT', () => {
  assertEqual(wktToGeoJson('POINT(3878456.13 3773641.05)'),
    { type: 'Point', coordinates: [3878456.13, 3773641.05] });
});

test('wktToGeoJson: POLYGON with one ring', () => {
  const g = wktToGeoJson('POLYGON((0 0, 2 0, 2 2, 0 0))');
  assertEqual(g, { type: 'Polygon', coordinates: [[[0, 0], [2, 0], [2, 2], [0, 0]]] });
});

test('wktToGeoJson: empty/garbage → null', () => {
  assertEqual(wktToGeoJson(''), null);
});

test('Web-Mercator origin → (0,0)', () => {
  const [lon, lat] = mercatorToWgs84(0, 0);
  assertClose(lon, 0, 1e-9, 'lon');
  assertClose(lat, 0, 1e-9, 'lat');
});

// --- CRS auto-detection -----------------------------------------------------

test('detectCrs: WGS84 lon/lat', () => {
  assertEqual(detectCrs([34.78, 32.07]), 'wgs84');
});

test('detectCrs: ITM metres', () => {
  assertEqual(detectCrs([180000, 663000]), 'itm');
});

test('detectCrs: Web-Mercator metres', () => {
  assertEqual(detectCrs([3870000, 3760000]), '3857');
});

test('detectCrs: handles nested coordinate arrays (polygon ring)', () => {
  assertEqual(detectCrs([[[180000, 663000], [181000, 663000]]]), 'itm');
});

// --- centroid ---------------------------------------------------------------

test('computeCentroid: averages vertices of a square ring', () => {
  const c = computeCentroid({ type: 'Polygon', coordinates: [[[0, 0], [2, 0], [2, 2], [0, 2]]] });
  assertEqual(c, [1, 1]);
});

test('computeCentroid: single point', () => {
  assertEqual(computeCentroid({ type: 'Point', coordinates: [5, 7] }), [5, 7]);
});

test('computeCentroid: null geometry → null', () => {
  assertEqual(computeCentroid(null), null);
});

// --- parseBbox / slugify ----------------------------------------------------

test('parseBbox: 4 comma-separated numbers', () => {
  assertEqual(parseBbox('180000,660000,182000,662000'), [180000, 660000, 182000, 662000]);
});

test('parseBbox: wrong arity → null', () => {
  assertEqual(parseBbox('1,2,3'), null);
});

test('parseBbox: non-numeric → null', () => {
  assertEqual(parseBbox('a,b,c,d'), null);
});

test('parseBbox: empty → null', () => {
  assertEqual(parseBbox(''), null);
});

test('slugify: spaces and path chars → underscore', () => {
  assertEqual(slugify('שכבת בנייני ציבור/2024'), 'שכבת_בנייני_ציבור_2024');
});

run('govmap-proj');
