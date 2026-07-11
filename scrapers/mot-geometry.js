// Build GeoJSON (WGS84) + CSV rows (geometry_wkt in WGS84/EPSG:4326) from the
// raw features extracted by content/mot-inject.js.
//
// The inject returns each layer's features as { wkt, attrs }, where wkt is the
// geometry as served by the MOT GovMap tenant (ITM/EPSG:6991 — the same frame as
// the site's israelExtentPolygonGeo). We honour the GovScraper spatial contract
// (see skill govscraper-spatial): ALL published geometry is WGS84 lon/lat
// (EPSG:4326) per the 2026-07-08 decision — the CSV `geometry_wkt` column
// (un-prefixed, LAST) and the GeoJSON alike; ITM survives only as the
// `bbox_itm` metadata entry (both bboxes travel together). CRS is auto-detected
// per feature so the output stays correct even if the backend ever returns
// 3857 or WGS84 instead.

import { wktToGeoJson, __test__ } from './govmap.js';
import { geomToWkt } from '../lib/wkt.js';

const { detectCrs, itmToWgs84, wgs84ToItm, mercatorToWgs84, mercatorToItm } = __test__;

const id = (x, y) => [x, y];

function mapCoords(coords, fn) {
  if (!Array.isArray(coords)) return coords;
  if (typeof coords[0] === 'number') {
    const [x, y, ...rest] = coords;
    const [nx, ny] = fn(x, y);
    return rest.length ? [nx, ny, ...rest] : [nx, ny];
  }
  return coords.map((c) => mapCoords(c, fn));
}

function walkXY(coords, cb) {
  if (!Array.isArray(coords)) return;
  if (typeof coords[0] === 'number') { cb(coords[0], coords[1]); return; }
  for (const c of coords) walkXY(c, cb);
}

function toWgsFn(crs) { return crs === 'wgs84' ? id : crs === '3857' ? mercatorToWgs84 : itmToWgs84; }
function toItmFn(crs) { return crs === 'itm' ? id : crs === '3857' ? mercatorToItm : wgs84ToItm; }

// layer = { code, fields, mode, features:[{wkt,attrs}], capped, error }
export function buildLayerOutputs(layer) {
  const fields = Array.isArray(layer.fields) ? layer.fields.slice() : [];
  const feats = Array.isArray(layer.features) ? layer.features : [];

  const gj = [];
  const rows = [];
  const bw = [Infinity, Infinity, -Infinity, -Infinity]; // wgs84 bbox
  const bi = [Infinity, Infinity, -Infinity, -Infinity]; // itm bbox

  for (const f of feats) {
    const geom = wktToGeoJson(f.wkt);
    if (!geom || !geom.coordinates) continue;
    const crs = detectCrs(geom.coordinates);
    const wgsGeom = { type: geom.type, coordinates: mapCoords(geom.coordinates, toWgsFn(crs)) };
    // ITM is computed ONLY for the bbox_itm metadata — published geometry
    // (CSV geometry_wkt + GeoJSON) is WGS84, same as scrapers/govmap.js
    // (geomToWkt(wgs84) — mirrors govil-scraper ecc84ee, 2026-07-08).
    const itmGeom = crs === 'itm' ? geom : { type: geom.type, coordinates: mapCoords(geom.coordinates, toItmFn(crs)) };

    gj.push({ type: 'Feature', geometry: wgsGeom, properties: { ...f.attrs } });
    rows.push({ ...f.attrs, geometry_wkt: geomToWkt(wgsGeom) });
    walkXY(wgsGeom.coordinates, (x, y) => { if (x < bw[0]) bw[0] = x; if (y < bw[1]) bw[1] = y; if (x > bw[2]) bw[2] = x; if (y > bw[3]) bw[3] = y; });
    walkXY(itmGeom.coordinates, (x, y) => { if (x < bi[0]) bi[0] = x; if (y < bi[1]) bi[1] = y; if (x > bi[2]) bi[2] = x; if (y > bi[3]) bi[3] = y; });
  }

  const hasGeom = gj.length > 0;
  const geojson = {
    type: 'FeatureCollection',
    name: layer.code,
    crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:OGC:1.3:CRS84' } },
    metadata: hasGeom
      ? { layer: layer.code, feature_count: gj.length, capped: !!layer.capped, bbox_wgs84: bw, bbox_itm: bi, source: 'geo.mot.gov.il (GovMap intersect)' }
      : { layer: layer.code, feature_count: 0 },
    features: gj,
  };

  // Column order: requested fields first, then any extra attr keys, then
  // geometry_wkt LAST (un-prefixed — CKAN reserves leading underscores).
  const seen = new Set();
  const fieldOrder = [];
  for (const k of fields) { if (!seen.has(k)) { seen.add(k); fieldOrder.push(k); } }
  for (const r of rows) for (const k of Object.keys(r)) { if (k === 'geometry_wkt') continue; if (!seen.has(k)) { seen.add(k); fieldOrder.push(k); } }
  fieldOrder.push('geometry_wkt');

  return { code: layer.code, geojson, rows, fieldOrder, count: gj.length, capped: !!layer.capped };
}
