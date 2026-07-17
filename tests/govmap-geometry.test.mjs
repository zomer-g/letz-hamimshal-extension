// Geometry backfill + WGS84 output for the govmap scraper.
//
// GovMap's entitiesByPoint stopped inlining each entity's WKT `geom`
// (observed 2026-07-08, a global API change) — without the per-feature
// entities-geometry backfill every scrape silently publishes empty geometry.
// Mirrors the Main scraper's tests (govil-scraper
// tests/scrapers/test_govmap_geometry_fallback.py). Also pins the 2026-07-08
// user decision: the CSV `geometry_wkt` column is WGS84 lon/lat (EPSG:4326),
// not ITM.
//
// Run: node tests/govmap-geometry.test.mjs
import { test, assertEqual, assert, run } from './_assert.mjs';
import { __test__ } from '../scrapers/govmap.js';

const { fetchGeometry, ensureGeometry, entityToParts } = __test__;

// ---- fetch mocking ----------------------------------------------------------

const calls = [];
let responder = null;

globalThis.fetch = async (url, init) => {
  const body = init && init.body ? JSON.parse(init.body) : null;
  calls.push({ url: String(url), body });
  return responder(String(url), body);
};

function jsonResponse(obj, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => obj,
  };
}

// A small square around GovMap's 3857 neighborhood, as the endpoint returns it.
const SQUARE_3857 = {
  type: 'Polygon',
  coordinates: [[
    [3900000, 3700000], [3900100, 3700000],
    [3900100, 3700100], [3900000, 3700100], [3900000, 3700000],
  ]],
};

// ---- ensureGeometry ---------------------------------------------------------

test('geom already present → zero requests (fast path)', async () => {
  calls.length = 0;
  responder = () => { throw new Error('must not be called'); };
  const e = { objectId: 1, geom: 'POINT(3900000 3700000)' };
  await ensureGeometry('429', e);
  assertEqual(calls.length, 0);
  assertEqual(e.geom, 'POINT(3900000 3700000)');
});

test('missing geom → entities-geometry fetch with a SINGLE objectId', async () => {
  calls.length = 0;
  responder = () => jsonResponse(SQUARE_3857);
  const e = { objectId: 19, centroid: [3900050, 3700050] };
  await ensureGeometry('429', e);
  assertEqual(calls.length, 1);
  assert(calls[0].url.endsWith('/user-layers/entities-geometry'), calls[0].url);
  // The server DISSOLVES multi-id requests into ONE merged geometry — the
  // request must always carry exactly one id.
  assertEqual(calls[0].body.objectIds.length, 1);
  assertEqual(calls[0].body.objectIds[0], '19');
  assertEqual(calls[0].body.layerId, '429');
  assert(e.geom.startsWith('POLYGON('), e.geom);
});

test('endpoint fails → centroid Point fallback', async () => {
  calls.length = 0;
  responder = () => jsonResponse({}, 500);
  const e = { objectId: 7, centroid: [3901234.5, 3705678.9] };
  await ensureGeometry('429', e);
  assertEqual(e.geom, 'POINT(3901234.5 3705678.9)');
});

test('endpoint fails + no centroid → geom stays unset', async () => {
  responder = () => jsonResponse({}, 500);
  const e = { objectId: 8 };
  await ensureGeometry('429', e);
  assert(!e.geom);
});

test('no objectId → no request, no geom', async () => {
  calls.length = 0;
  responder = () => { throw new Error('must not be called'); };
  const e = { centroid: [3900000, 3700000] };
  await ensureGeometry('429', e);
  assertEqual(calls.length, 0);
  assert(!e.geom);
});

// ---- fetchGeometry retry ----------------------------------------------------

test('fetchGeometry retries transient failures then succeeds', async () => {
  calls.length = 0;
  let n = 0;
  responder = () => (++n < 2 ? jsonResponse({}, 502) : jsonResponse(SQUARE_3857));
  const geom = await fetchGeometry('429', 5);
  assertEqual(calls.length, 2);
  assertEqual(geom.type, 'Polygon');
});

// ---- circuit breaker (2026-07-17: entities-geometry serves the SPA shell) ----

test('HTML shell response trips the breaker: centroid fallback, no further calls', async () => {
  __test__._setGeomEndpointDead(false);
  calls.length = 0;
  responder = () => ({
    ok: true, status: 200,
    headers: { get: (h) => (h === 'content-type' ? 'text/html; charset=utf-8' : null) },
    json: async () => { throw new Error('not json'); },
  });
  const e1 = { objectId: 31, centroid: [3900000, 3700000] };
  await ensureGeometry('21', e1);
  assertEqual(e1.geom, 'POINT(3900000 3700000)');
  assertEqual(e1.gsCentroidOnly, true);
  assertEqual(calls.length, 1); // no retries on the SPA shell — breaker trips at once
  const e2 = { objectId: 32, centroid: [3900001, 3700001] };
  await ensureGeometry('21', e2);
  assertEqual(calls.length, 1); // breaker: second entity makes NO geometry request
  assertEqual(e2.geom, 'POINT(3900001 3700001)');
  __test__._setGeomEndpointDead(false);
});

// ---- WGS84 output (2026-07-08 decision) --------------------------------------

test('entityToParts: geometry is WGS84 lon/lat, not ITM', () => {
  const parts = entityToParts({
    objectId: 3,
    geom: 'POINT(3900000 3700000)',
    fields: [{ fieldName: 'שם', fieldValue: 'בדיקה' }],
  });
  const [lon, lat] = parts.wgs84.coordinates;
  assert(lon > 33 && lon < 36.5, `lon out of Israel range: ${lon}`);
  assert(lat > 29 && lat < 34, `lat out of Israel range: ${lat}`);
  assertEqual(parts.props['שם'], 'בדיקה');
  // No ITM part anymore — the CSV column derives from wgs84.
  assertEqual(parts.itm, undefined);
});

await run('govmap-geometry');
