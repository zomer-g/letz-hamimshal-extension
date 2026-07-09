// geo.mot geometry-builder tests.
//
// content/mot-inject.js extracts each displayed layer's features as
// { wkt, attrs } in ITM (EPSG:6991, the MOT GovMap tenant's native frame).
// scrapers/mot-geometry.js turns that into the GovScraper spatial-contract
// output: GeoJSON in WGS84 (CRS84) + CSV rows whose geometry_wkt stays ITM and
// sits LAST/un-prefixed. These tests pin that contract.
//
// Run: node tests/mot-geometry.test.mjs

import { buildLayerOutputs } from '../scrapers/mot-geometry.js';
import { test, run, assert, assertEqual, assertClose } from './_assert.mjs';

const LAYER = {
  code: 'RAIL_LINE',
  fields: ['OBJECTID', 'RAIL_TYPE'],
  features: [
    { wkt: 'LINESTRING(180000 660000, 181000 661000)', attrs: { OBJECTID: 5, RAIL_TYPE: 'כבדה' } },
    { wkt: 'POINT(184000 668000)', attrs: { OBJECTID: 6, RAIL_TYPE: 'תחנה' } },
  ],
  capped: false,
  error: null,
};

test('geometry_wkt is preserved as ITM and ordered LAST, un-prefixed', () => {
  const o = buildLayerOutputs(LAYER);
  assertEqual(o.fieldOrder[o.fieldOrder.length - 1], 'geometry_wkt');
  assert(!o.fieldOrder.some((f) => f.startsWith('_')), 'no leading-underscore columns');
  assertEqual(o.rows[0].geometry_wkt, 'LINESTRING(180000 660000, 181000 661000)');
  assertEqual(o.rows[0].OBJECTID, 5);
  assertEqual(o.rows[0].RAIL_TYPE, 'כבדה');
});

test('GeoJSON is a WGS84 (CRS84) FeatureCollection over central Israel', () => {
  const o = buildLayerOutputs(LAYER);
  assertEqual(o.geojson.type, 'FeatureCollection');
  assertEqual(o.geojson.crs.properties.name, 'urn:ogc:def:crs:OGC:1.3:CRS84');
  assertEqual(o.count, 2);
  const [lon, lat] = o.geojson.features[0].geometry.coordinates[0];
  // ITM (180000,660000) ≈ Tel Aviv area → lon ~34.79, lat ~32.03.
  assertClose(lon, 34.7867, 1e-3, 'lon');
  assertClose(lat, 32.0325, 1e-3, 'lat');
});

test('both bboxes travel together (bbox_wgs84 + bbox_itm)', () => {
  const o = buildLayerOutputs(LAYER);
  const m = o.geojson.metadata;
  assert(Array.isArray(m.bbox_wgs84) && m.bbox_wgs84.length === 4, 'bbox_wgs84');
  assert(Array.isArray(m.bbox_itm) && m.bbox_itm.length === 4, 'bbox_itm');
  // ITM bbox spans the input easting/northing range.
  assertEqual(m.bbox_itm, [180000, 660000, 184000, 668000]);
});

test('a layer with no geometry yields count 0 and an empty FeatureCollection', () => {
  const o = buildLayerOutputs({ code: 'EMPTY', fields: ['OBJECTID'], features: [], capped: false, error: 'no data' });
  assertEqual(o.count, 0);
  assertEqual(o.geojson.features.length, 0);
  assertEqual(o.fieldOrder[o.fieldOrder.length - 1], 'geometry_wkt');
});

test('a 3857 WKT is reprojected: geometry_wkt becomes ITM, GeoJSON WGS84', () => {
  // Same Tel Aviv point in Web-Mercator (EPSG:3857).
  const o = buildLayerOutputs({
    code: 'WM', fields: ['OBJECTID'],
    features: [{ wkt: 'POINT(3875000 3760000)', attrs: { OBJECTID: 1 } }],
    capped: false, error: null,
  });
  assertEqual(o.count, 1);
  const [lon, lat] = o.geojson.features[0].geometry.coordinates;
  assert(lon > 34 && lon < 36, `lon in Israel range, got ${lon}`);
  assert(lat > 31 && lat < 33, `lat in Israel range, got ${lat}`);
  // geometry_wkt must be ITM now (easting ~1.2e5–3e5), NOT the 3857 input.
  const wkt = o.rows[0].geometry_wkt;
  const x = parseFloat(wkt.match(/-?\d+(?:\.\d+)?/)[0]);
  assert(x > 100000 && x < 350000, `geometry_wkt easting is ITM, got ${x}`);
});

run('mot-geometry');
