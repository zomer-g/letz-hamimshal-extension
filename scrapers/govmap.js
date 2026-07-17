// govmap.gov.il scraper — entitiesByPoint API (GovMap's 2026 rebuild).
//
// GovMap removed the public OGC WFS in its 2026 rebuild: GetFeature /
// GetCapabilities now return the SPA HTML shell, gated behind their new
// x-govmap-token. Feature data instead comes from
// `POST /api/layers-catalog/entitiesByPoint` — a point+tolerance "identify"
// query that returns up to 100 entities, each with WKT geometry (EPSG:3857)
// and its attribute fields. The only "auth" is three random header IDs
// (x-fingerprint-id = x-user-id = any 32-hex, x-trace-id = any) — fully
// anonymous, same-origin from the govmap page.
//
// To extract a whole layer despite the 100-row cap we quad-tree sweep the
// layer's catalog extent: query a cell; if it returns the cap, split into four
// and recurse; dedup the union by objectId. This mirrors the Main scraper's
// govscraper/scrapers/govmap/entities_client.py exactly (same endpoint, same
// subdivide-on-cap strategy, same 3857→4326 reprojection, same per-feature
// entities-geometry backfill for the 2026-07-08 geom-omission regression).
//
// Layer id: the numeric `?lay=<id>` value is what entitiesByPoint wants
// directly (e.g. "18"); the catalog's serviceLayerId is kept only for display.

import { geomToWkt } from '../lib/wkt.js';

const BASE = 'https://www.govmap.gov.il/api';
const ENTITIES_URL = BASE + '/layers-catalog/entitiesByPoint';
const CATALOG_URL = BASE + '/layers-catalog/catalog?lang=he';
// entitiesByPoint used to inline each entity's WKT under `geom`. Observed
// 2026-07-08: it now omits `geom` entirely for MANY layers (a global GovMap
// API change — confirmed on previously-`geom`-bearing layers) and returns only
// a `centroid` point. GovMap's OWN frontend falls back to this per-feature
// endpoint in exactly that case (decompiled from its live JS bundle). Mirrors
// the Main scraper's entities_client.py fix (govil-scraper commit a9503f9).
//
// 2026-07-17 UPDATE: this endpoint is now ALSO dead to anonymous clients —
// verified same-origin from a govmap page: HTTP 200 + text/html (the SPA
// shell), never JSON. Net effect: every non-point feature degrades to its
// centroid Point, so polygons/lines currently come out as points. The Main
// scraper migrated to the spatial-analysis API (layer-data +
// object-geojson-data — see govil-scraper spatial_client.py); porting that
// here is the real fix. Until then geomEndpointDead (below) trips on the
// first HTML response so heavy layers don't burn 3 requests + ~3s of retry
// sleeps per feature, and the result carries a centroid-only count so the
// overlay can tell the user and point them at over.org.il.
const ENTITY_GEOMETRY_URL = BASE + '/user-layers/entities-geometry';
// Circuit breaker for ENTITY_GEOMETRY_URL: once it serves the SPA HTML shell
// instead of JSON it will keep doing so — skip it for the rest of the run.
// Mirrors entities_client.py's _geom_endpoint_dead. Reset per fetch() run.
let geomEndpointDead = false;
const PAGE_CAP = 100;          // entitiesByPoint returns at most this many per call
const MAX_DEPTH = 14;          // quad-tree recursion guard
const MAX_FEATURES = 100000;   // safety cap per layer
// National EPSG:3857 fallback extent (≈ Israel + margin) — only used when the
// catalog entry has no extent and the URL/viewport give none.
const NATIONAL_3857 = [3760000, 3400000, 4030000, 3970000];

export const govmapScraper = {
  id: 'govmap',
  label: 'govmap.gov.il',

  parseUrl(href) {
    let u;
    try { u = new URL(href); } catch { return null; }
    const host = (u.hostname || '').toLowerCase();
    if (!host.endsWith('govmap.gov.il')) return null;
    const params = Object.fromEntries(u.searchParams.entries());
    const lay = params.lay || params.layers || params.layer;
    if (!lay) return null;
    const layerIds = String(lay).split(',').map(s => s.trim()).filter(Boolean);
    if (!layerIds.length) return null;
    const bboxItm = parseBbox(params.bbox || params.extent);
    const layerId = layerIds[0]; // primary, kept for backwards compat
    return {
      scraperId: 'govmap',
      kind: 'wfs_layer',
      layerId,
      layerIds,
      bboxItm,
      collectorName: layerIds.length > 1
        ? `govmap_layers_${layerIds.join('_')}`
        : `govmap_layer_${layerId}`,
      originalUrl: href,
      queryParams: params,
      label: layerIds.length > 1
        ? `שכבות GovMap (${layerIds.length}): ${layerIds.join(', ')}`
        : `שכבת GovMap: ${layerId}`,
    };
  },

  async fetch(parsed, { onProgress, extentMode, isCancelled } = {}) {
    geomEndpointDead = false; // fresh run — re-probe the geometry endpoint once
    const cancelled = () => { try { return !!(isCancelled && isCancelled()); } catch { return false; } };
    const layerIds = Array.isArray(parsed.layerIds) && parsed.layerIds.length
      ? parsed.layerIds
      : [parsed.layerId];

    const perLayer = [];
    let globalCaption = '';

    // Sweep extent (EPSG:3857). Two modes:
    //   'view'  → only what's on screen now (the live OpenLayers viewport).
    //   default → an explicit URL bbox wins; else the layer's full catalog
    //             extent; else the viewport; else the national fallback.
    const wantView = extentMode === 'view';
    const urlExtent3857 = parsed.bboxItm ? itmBboxTo3857(parsed.bboxItm) : null;
    const viewExtent3857 = getViewportExtent3857();
    if (wantView && !viewExtent3857) {
      throw new Error('לא ניתן לקרוא את תחום התצוגה הנוכחי של המפה. המתן שהמפה תסיים להיטען, הזז/הגדל מעט את המפה, ונסה שוב.');
    }

    for (let li = 0; li < layerIds.length; li++) {
      if (cancelled()) break;
      const layerId = layerIds[li];
      onProgress?.({
        phase: 'lookup',
        current: li,
        total: layerIds.length,
        message: `שכבה ${li + 1}/${layerIds.length}: מאתר בקטלוג…`,
      });
      const entry = await resolveLayerFromCatalog(layerId);
      const typeName = entry?.serviceLayerId || `govmap:layer_${layerId}`;
      const caption = entry?.caption || '';
      if (li === 0 && caption) globalCaption = caption;

      const extent = wantView
        ? viewExtent3857
        : (urlExtent3857
          || (Array.isArray(entry?.extent) && entry.extent.length === 4 ? entry.extent : null)
          || viewExtent3857
          || NATIONAL_3857);

      onProgress?.({
        phase: 'scrape',
        current: li,
        total: layerIds.length,
        message: `שכבה ${li + 1}/${layerIds.length} (${caption || layerId}): סורק features…`,
      });

      let entities;
      try {
        entities = await sweepEntities(String(layerId), extent, (p) => {
          onProgress?.({
            ...p,
            message: `שכבה ${li + 1}/${layerIds.length} (${caption || layerId}): ${p.message}`,
            sub: layerIds.length > 1 ? `שכבות הושלמו: ${li}/${layerIds.length}` : '',
          });
        }, cancelled);
      } catch (e) {
        // Don't kill the whole multi-layer run because one layer fails.
        perLayer.push({ layerId, caption, typeName, entities: [], error: e.message });
        continue;
      }
      perLayer.push({
        layerId, caption, typeName, entities,
        needCredentials: !!entry?.needCredentials,
      });
    }

    // Update parsed for caption-based naming if the catalog gave us a name.
    if (layerIds.length === 1 && globalCaption) {
      parsed.collectorName = `govmap_${slugify(globalCaption)}_${layerIds[0]}`;
      parsed.label = `שכבת GovMap: ${globalCaption} (lay=${layerIds[0]})`;
    } else if (layerIds.length > 1) {
      const captions = perLayer.map(l => l.caption || l.layerId).filter(Boolean);
      parsed.label = `שכבות GovMap: ${captions.join(' + ')}`;
    }

    // Build rows + GeoJSON. Each entity's geom is WKT in EPSG:3857; we reproject
    // to WGS84 (EPSG:4326) for BOTH the geometry_wkt CSV column and the GeoJSON
    // sidecar + _lon/_lat centroid — matching the Main scraper, which switched
    // all published geometry to 4326 (govil-scraper ecc84ee, 2026-07-08).
    const allRows = [];
    const allFeatures = [];
    for (const { layerId, caption, entities } of perLayer) {
      for (const ent of (entities || [])) {
        const parts = entityToParts(ent);
        const props = { ...parts.props };
        const [lon, lat] = computeCentroid(parts.wgs84) || [null, null];
        props._lon = lon;
        props._lat = lat;
        props._geometry_type = parts.wgs84?.type || '';
        // Un-prefixed `geometry_wkt` matches the Main scraper's CSV column
        // (govscraper/scrapers/govmap/legacy_engine.py: _derive_columns).
        // WGS84 lon/lat, not ITM — see the block comment above.
        props.geometry_wkt = parts.wgs84 ? geomToWkt(parts.wgs84) : '';
        if (layerIds.length > 1) {
          props._layer_id = layerId;
          props._layer_caption = caption || '';
        }
        allRows.push(props);
        allFeatures.push({ type: 'Feature', geometry: parts.wgs84 || null, properties: props });
      }
    }

    const failures = perLayer.filter(l => l.error).map(l => `${l.caption || l.layerId}: ${l.error}`);
    const gated = perLayer.filter(l => l.needCredentials).map(l => l.caption || l.layerId);
    const centroidOnly = perLayer.reduce(
      (n, l) => n + (l.entities || []).filter(e => e.gsCentroidOnly).length, 0);
    const notes = [];
    if (failures.length) notes.push(`שכבות שנכשלו: ${failures.join(' | ')}`);
    if (gated.length) notes.push(`שכבות שעשויות לדרוש הרשאה: ${gated.join(', ')}`);
    if (centroidOnly > 0) {
      notes.push(`⚠ עבור ${centroidOnly} מתוך ${allRows.length} רשומות GovMap לא סיפק גאומטריה מלאה (פוליגון/קו) — נשמרה נקודת מרכז בלבד. ייתכן שהשכבה זמינה במלואה באתר OVER: https://www.over.org.il`);
    }
    notes.push(wantView
      ? 'ההורדה כוללת רק את תחום התצוגה הנוכחי (extent) — לא את כל השכבה.'
      : 'ההורדה סורקת את כל השכבה דרך ה-API החדש של GovMap (entitiesByPoint) — שכבות גדולות עשויות לקחת זמן.');

    return {
      rows: allRows,
      fields: collectFields(allRows),
      sourceUrl: parsed.originalUrl,
      collectorName: parsed.collectorName,
      kind: parsed.kind,
      total: allFeatures.length,
      attachments: [],
      geojson: { type: 'FeatureCollection', features: allFeatures },
      layerTypeName: perLayer.map(l => l.typeName).join(', '),
      perLayer: perLayer.map(({ layerId, caption, typeName, error }) => ({
        layerId, caption, typeName, error,
      })),
      centroidOnly,
      warning: notes.length ? notes.join(' • ') : null,
    };
  },
};

// ---------------------------------------------------------------------------
// entitiesByPoint client (same-origin POST from the govmap page).
// ---------------------------------------------------------------------------

function entitiesHeaders() {
  const rid = randomHex32();
  return {
    'content-type': 'application/json',
    'x-fingerprint-id': rid,
    'x-user-id': rid,
    'x-trace-id': randomHex32(),
  };
}

// fetch with a hard timeout. A stalled request (no response) would otherwise
// hang the sweep forever, leaving the overlay's scrapeInProgress flag stuck true
// so the download button silently ignores every later click. AbortController
// turns a stall into a normal error that the per-cell try/catch skips over.
async function fetchWithTimeout(url, init, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function queryEntities(layerId, cx, cy, tol) {
  const body = { point: [cx, cy], layers: [{ layerId: String(layerId) }], tolerance: tol };
  const resp = await fetchWithTimeout(ENTITIES_URL, {
    method: 'POST',
    headers: entitiesHeaders(),
    body: JSON.stringify(body),
    credentials: 'omit',
  }, 30000);
  if (!resp.ok) throw new Error(`entitiesByPoint HTTP ${resp.status}`);
  const json = await resp.json();
  const data = json?.data || [];
  return data.length ? (data[0].entities || []) : [];
}

// One feature's true geometry (GeoJSON dict, EPSG:3857) via GovMap's
// per-feature fallback endpoint — the only path for a layer whose
// entitiesByPoint response omits `geom` (see ENTITY_GEOMETRY_URL).
// IMPORTANT: passing multiple objectIds does NOT return one geometry per id —
// the server DISSOLVES them into a single merged geometry (verified live), so
// this must be called once per feature. Returns null on failure.
async function fetchGeometry(layerId, objectId, retries = 2) {
  if (geomEndpointDead) return null;
  const body = { layerId: String(layerId), objectIds: [String(objectId)] };
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const resp = await fetchWithTimeout(ENTITY_GEOMETRY_URL, {
        method: 'POST',
        headers: entitiesHeaders(),
        body: JSON.stringify(body),
        credentials: 'omit',
      }, 30000);
      if (!resp.ok) throw new Error(`entities-geometry HTTP ${resp.status}`);
      const ctype = (resp.headers && typeof resp.headers.get === 'function' && resp.headers.get('content-type')) || '';
      if (ctype && !ctype.includes('json')) {
        // SPA HTML shell — the endpoint no longer serves geometry (observed
        // 2026-07-17, same fate as the WFS). Trip the breaker so the rest of
        // the sweep skips it instead of burning retries per feature.
        geomEndpointDead = true;
        console.warn(`[GovScraper] entities-geometry returned ${ctype} — falling back to centroids for the rest of this run.`);
        return null;
      }
      const json = await resp.json();
      return (json && typeof json === 'object' && json.type) ? json : null;
    } catch (e) {
      if (attempt >= retries) {
        console.warn(`[GovScraper] entities-geometry failed for ${layerId}#${objectId}:`, e);
        return null;
      }
      await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  return null;
}

// Backfill `entity.geom` (WKT, EPSG:3857) IN PLACE when entitiesByPoint didn't
// inline it. True geometry first (fetchGeometry); falls back to a Point at the
// entity's `centroid` (approximate but still mappable — much better than the
// silently-empty geometry the missing `geom` produces downstream); leaves
// `geom` unset only if neither source is available. No-op (zero extra
// requests) when `geom` is already present — the common/fast case.
// Mirrors entities_client.py:ensure_geometry.
async function ensureGeometry(layerId, entity) {
  if (entity.geom) return;
  const oid = entity.objectId;
  if (oid == null) return;
  const geom = await fetchGeometry(layerId, oid);
  if (geom) {
    entity.geom = geomToWkt(geom);
    return;
  }
  const c = entity.centroid;
  if (Array.isArray(c) && c.length >= 2 && isFinite(c[0]) && isFinite(c[1])) {
    entity.geom = geomToWkt({ type: 'Point', coordinates: [Number(c[0]), Number(c[1])] });
    // Only the centroid was available — surfaced to the user in the result
    // notes (entityToParts copies just objectId+fields, so this never leaks
    // into the CSV columns).
    entity.gsCentroidOnly = true;
  }
}

// Quad-tree sweep the extent → Map(objectId → entity). Subdivides any cell that
// hits the 100-row cap. Mirrors entities_client.py:GovMapEntitiesClient.sweep.
async function sweepEntities(layerId, extent3857, onProgress, isCancelled) {
  const [minx, miny, maxx, maxy] = extent3857;
  const seen = new Map();
  const stack = [[minx, miny, maxx, maxy, 0]];
  let calls = 0;
  while (stack.length) {
    // Honour Cancel promptly: a huge layer (e.g. RMI plots, 1M+ features) would
    // otherwise keep sweeping long after the user cancelled, leaving the overlay
    // busy so the download button stays unresponsive.
    if (isCancelled && isCancelled()) break;
    const [x0, y0, x1, y1, depth] = stack.pop();
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const tol = Math.hypot(x1 - x0, y1 - y0) / 2; // half-diagonal covers the cell
    let ents = [];
    try {
      ents = await queryEntities(layerId, cx, cy, tol);
    } catch (e) {
      console.warn('[GovScraper] entitiesByPoint cell failed (d=' + depth + '):', e);
    }
    calls++;
    if (ents.length >= PAGE_CAP && depth < MAX_DEPTH) {
      stack.push(
        [x0, y0, cx, cy, depth + 1],
        [cx, y0, x1, cy, depth + 1],
        [x0, cy, cx, y1, depth + 1],
        [cx, cy, x1, y1, depth + 1],
      );
    } else {
      for (const e of ents) {
        const oid = e.objectId;
        if (oid != null && !seen.has(oid)) {
          seen.set(oid, e);
          // Only for entities we actually keep (post-dedup, post-subdivision)
          // — never wasted on a cell that gets subdivided. See ensureGeometry
          // for why entitiesByPoint's `geom` can't be trusted anymore.
          await ensureGeometry(layerId, e);
        }
      }
    }
    if (calls % 5 === 0) {
      onProgress?.({
        phase: 'scrape',
        current: seen.size,
        total: 0,
        message: `${seen.size} feature-ים (${calls} שאילתות)`,
      });
    }
    if (seen.size >= MAX_FEATURES) {
      console.info('[GovScraper] govmap sweep hit MAX_FEATURES=' + MAX_FEATURES);
      break;
    }
  }
  onProgress?.({
    phase: 'scrape',
    current: seen.size,
    total: seen.size,
    message: `${seen.size} feature-ים (${calls} שאילתות)`,
  });
  return [...seen.values()];
}

// One entity → { wgs84 geometry, properties }.
// 2026-07-08 (user decision, mirrors govil-scraper ecc84ee): ALL published
// geometry is WGS84/4326 — the ITM reprojection for the CSV column is gone
// (it also burned a full Helmert chain per vertex on million-feature layers).
function entityToParts(entity) {
  const geom3857 = wktToGeoJson(entity.geom || '');
  const wgs84 = geom3857 ? reprojectGeom(geom3857, mercatorToWgs84) : null;
  const props = { objectId: entity.objectId };
  for (const f of (entity.fields || [])) {
    if (f && f.fieldName) props[f.fieldName] = f.fieldValue;
  }
  return { wgs84, props };
}

function reprojectGeom(geom, fn) {
  if (!geom || !geom.coordinates) return geom;
  return { type: geom.type, coordinates: mapCoords(geom.coordinates, fn) };
}

// ---------------------------------------------------------------------------
// WKT (EPSG:3857) → GeoJSON geometry. Mirrors entities_client.py:wkt_to_geojson.
// Coordinates stay in the source CRS (3857); the caller reprojects.
// ---------------------------------------------------------------------------

const NUM_RE = /[-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/g;

function parseCoordRun(s) {
  const pts = [];
  for (const pair of s.split(',')) {
    const nums = pair.match(NUM_RE);
    if (nums && nums.length >= 2) pts.push([parseFloat(nums[0]), parseFloat(nums[1])]);
  }
  return pts;
}

function parseRings(s) {
  const rings = [];
  const re = /\(([^()]*)\)/g;
  let m;
  while ((m = re.exec(s)) !== null) rings.push(parseCoordRun(m[1]));
  return rings;
}

export function wktToGeoJson(wkt) {
  if (!wkt) return null;
  const m = /^\s*([A-Za-z]+)\s*([\s\S]*)$/.exec(wkt);
  if (!m) return null;
  const typ = m[1].toUpperCase();
  let body = m[2].trim();
  const inner = (body.startsWith('(') && body.endsWith(')')) ? body.slice(1, -1).trim() : body;
  try {
    switch (typ) {
      case 'POINT': {
        const c = parseCoordRun(inner);
        return c.length ? { type: 'Point', coordinates: c[0] } : null;
      }
      case 'LINESTRING':
        return { type: 'LineString', coordinates: parseCoordRun(inner) };
      case 'POLYGON':
        return { type: 'Polygon', coordinates: parseRings(inner) };
      case 'MULTIPOINT':
        return { type: 'MultiPoint', coordinates: parseCoordRun(inner.replace(/[()]/g, '')) };
      case 'MULTILINESTRING':
        return { type: 'MultiLineString', coordinates: parseRings(inner) };
      case 'MULTIPOLYGON': {
        const polys = [];
        const re = /\(((?:[^()]|\([^()]*\))*)\)/g;
        let mm;
        while ((mm = re.exec(inner)) !== null) polys.push(parseRings(mm[1]));
        return { type: 'MultiPolygon', coordinates: polys };
      }
      default:
        return null;
    }
  } catch (e) {
    console.debug('[GovScraper] WKT parse failed:', e, wkt.slice(0, 60));
    return null;
  }
}

// ---------------------------------------------------------------------------
// Catalog fetch + cache. Session-scoped via chrome.storage.session — the
// catalog is ~660 KB and rarely changes within a browsing session.
// ---------------------------------------------------------------------------

let _catalogCache = null;
async function loadCatalog() {
  if (_catalogCache) return _catalogCache;
  try {
    const stored = await chrome.storage.session.get('govmap.catalog');
    if (stored['govmap.catalog']) {
      _catalogCache = stored['govmap.catalog'];
      return _catalogCache;
    }
  } catch {}

  const headers = {
    Accept: 'application/json, text/plain, */*',
    'x-user-id': randomHex32(),
    'x-trace-id': randomHex32(),
  };
  const resp = await fetchWithTimeout(CATALOG_URL, { headers, credentials: 'omit' }, 30000);
  if (!resp.ok) throw new Error(`קטלוג GovMap נכשל: HTTP ${resp.status}`);
  const payload = await resp.json();

  // Walk for layer entries: any dict with both `id` and `serviceLayerId`.
  const byId = {};
  (function walk(obj) {
    if (Array.isArray(obj)) { for (const v of obj) walk(v); return; }
    if (obj && typeof obj === 'object') {
      if ('id' in obj && 'serviceLayerId' in obj) {
        byId[String(obj.id)] = {
          id: String(obj.id),
          serviceLayerId: obj.serviceLayerId,
          caption: obj.caption || '',
          name: obj.name || '',
          extent: Array.isArray(obj.extent) ? obj.extent : null,
          needCredentials: !!obj.needCredentials,
          dim: obj.dim,
        };
      }
      for (const v of Object.values(obj)) walk(v);
    }
  })(payload);

  _catalogCache = byId;
  try { await chrome.storage.session.set({ 'govmap.catalog': byId }); } catch {}
  return byId;
}

// The layer's human-readable catalog caption (or '' when unresolvable).
// Used by the overlay to deep-link the OVER limitations note to a search for
// this specific layer (https://www.over.org.il/?q=<caption>).
export async function resolveLayerCaption(layerId) {
  const entry = await resolveLayerFromCatalog(String(layerId));
  return entry?.caption || '';
}

async function resolveLayerFromCatalog(layerId) {
  // Explicit WFS type name — bypass catalog
  if (/^govmap:layer_/i.test(layerId)) {
    return { id: layerId, serviceLayerId: layerId, caption: '', name: '' };
  }
  try {
    const catalog = await loadCatalog();
    return catalog[String(layerId)] || null;
  } catch (e) {
    console.warn('[GovScraper] govmap catalog lookup failed:', e);
    return null;
  }
}

function randomHex32() {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return [...a].map(b => b.toString(16).padStart(2, '0')).join('');
}

function slugify(s) {
  return String(s).replace(/[\\\/:*?"<>|\s]+/g, '_').replace(/_+/g, '_').slice(0, 60);
}

// Live OpenLayers view extent (EPSG:3857) published by content/govmap-inject.js,
// used only as a fallback when neither a URL bbox nor a catalog extent exists.
function getViewportExtent3857() {
  try {
    if (typeof document === 'undefined') return null;
    const raw = document.documentElement.getAttribute('data-gs-govmap-ext');
    const proj = document.documentElement.getAttribute('data-gs-govmap-proj') || 'EPSG:3857';
    if (!raw) return null;
    const box = raw.split(',').map(Number);
    if (box.length !== 4 || !box.every(Number.isFinite)) return null;
    if (/6991|2039/.test(proj)) return itmBboxTo3857(box);
    if (/4326/.test(proj)) {
      const [minx, miny] = wgs84ToMercator(box[0], box[1]);
      const [maxx, maxy] = wgs84ToMercator(box[2], box[3]);
      return [minx, miny, maxx, maxy];
    }
    return box; // EPSG:3857 (govmap's OpenLayers default) — use verbatim
  } catch { return null; }
}

function parseBbox(raw) {
  if (!raw) return null;
  const parts = String(raw).split(/[,;]/).map(s => parseFloat(s.trim()));
  if (parts.length !== 4 || parts.some(n => !Number.isFinite(n))) return null;
  return parts;
}

function itmBboxTo3857(bboxItm) {
  const [xmin, ymin, xmax, ymax] = bboxItm;
  const a = wgs84ToMercator(...itmToWgs84(xmin, ymin));
  const b = wgs84ToMercator(...itmToWgs84(xmax, ymax));
  return [a[0], a[1], b[0], b[1]];
}

// ---------------------------------------------------------------------------
// Coordinate projection (hand-rolled, no proj4js bundle). EPSG:3857 features
// from entitiesByPoint are reprojected to WGS84 (GeoJSON) and to ITM EPSG:6991
// (geometry_wkt CSV column).
//
// CRITICAL: EPSG:6991 (IG05/12) is NOT a bare Israeli-TM projection of WGS84 —
// it carries a 7-parameter datum shift (towgs84). Omitting it puts every point
// ~78 m off true 6991. So WGS84↔6991 here replicates pyproj's exact pipeline
// (the Main scraper's authority):
//   WGS84 geodetic → geocentric (WGS84) → Helmert (coordinate_frame) →
//   geodetic (GRS80) → Israeli TM (Snyder).
// Verified against pyproj to sub-mm (forward ~2.5 µm, inverse ~0.4 mm), so the
// extension's geometry_wkt now matches the Main engine's EPSG:6991 exactly.
// Helmert params from PROJ's EPSG:6991 def (t in m, r in arcsec, s in ppm).
// ---------------------------------------------------------------------------

const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const ELL_WGS = { a: 6378137.0, f: 1 / 298.257223563 };
const ELL_GRS = { a: 6378137.0, f: 1 / 298.257222101 };
// IG05/12 ↔ WGS84, coordinate_frame convention (WGS84 → 6991-datum sign).
const HELMERT_W2I = { tx: -23.772, ty: -17.49, tz: -17.859, rx: -0.3132, ry: -1.85274, rz: 1.67299, s: 5.4262 };
const _ITM = {
  k0: 1.0000067,
  fe: 219529.584,
  fn: 626907.39,
  lon0: 35.2045169444444 * D2R,
  lat0: 31.7343936111111 * D2R,
};

function detectCrs(coords) {
  const sample = firstPoint(coords);
  if (!sample) return 'wgs84';
  const [x, y] = sample;
  if (Math.abs(x) <= 180 && Math.abs(y) <= 90) return 'wgs84';
  if (Math.abs(x) > 1e6 || Math.abs(y) > 1e6) return '3857';
  if (x > 100000 && x < 350000 && y > 300000 && y < 900000) return 'itm';
  return '3857';
}

function firstPoint(coords) {
  if (!Array.isArray(coords) || coords.length === 0) return null;
  if (typeof coords[0] === 'number') return coords;
  return firstPoint(coords[0]);
}

function mapCoords(coords, fn) {
  if (!Array.isArray(coords)) return coords;
  if (typeof coords[0] === 'number') {
    const [x, y, ...rest] = coords;
    const [nx, ny] = fn(x, y);
    return rest.length ? [nx, ny, ...rest] : [nx, ny];
  }
  return coords.map(c => mapCoords(c, fn));
}

function mercatorToWgs84(x, y) {
  const lon = (x / 20037508.34) * 180;
  let lat = (y / 20037508.34) * 180;
  lat = (180 / Math.PI) * (2 * Math.atan(Math.exp((lat * Math.PI) / 180)) - Math.PI / 2);
  return [lon, lat];
}

function wgs84ToMercator(lon, lat) {
  const x = (lon * 20037508.34) / 180;
  let y = Math.log(Math.tan(((90 + lat) * Math.PI) / 360)) / (Math.PI / 180);
  y = (y * 20037508.34) / 180;
  return [x, y];
}

function mercatorToItm(x, y) {
  const [lon, lat] = mercatorToWgs84(x, y);
  return wgs84ToItm(lon, lat);
}

function meridionalArc(lat, a, e2) {
  return a * (
    (1 - e2 / 4 - (3 * e2 * e2) / 64 - (5 * e2 * e2 * e2) / 256) * lat
    - ((3 * e2) / 8 + (3 * e2 * e2) / 32 + (45 * e2 * e2 * e2) / 1024) * Math.sin(2 * lat)
    + ((15 * e2 * e2) / 256 + (45 * e2 * e2 * e2) / 1024) * Math.sin(4 * lat)
    - ((35 * e2 * e2 * e2) / 3072) * Math.sin(6 * lat)
  );
}

// --- datum chain (geodetic ↔ geocentric ↔ Helmert) -------------------------

function geodToCart(lonRad, latRad, ell) {
  const e2 = ell.f * (2 - ell.f);
  const s = Math.sin(latRad), c = Math.cos(latRad);
  const N = ell.a / Math.sqrt(1 - e2 * s * s);
  return [N * c * Math.cos(lonRad), N * c * Math.sin(lonRad), N * (1 - e2) * s];
}

function cartToGeod(X, Y, Z, ell) {
  const e2 = ell.f * (2 - ell.f);
  const lon = Math.atan2(Y, X);
  const p = Math.hypot(X, Y);
  let lat = Math.atan2(Z, p * (1 - e2));
  for (let i = 0; i < 8; i++) {
    const s = Math.sin(lat);
    const N = ell.a / Math.sqrt(1 - e2 * s * s);
    lat = Math.atan2(Z + e2 * N * s, p);
  }
  return [lon, lat];
}

// Helmert, coordinate_frame convention. t in m, r in arcsec, s in ppm.
// `inv` negates all params (1st-order inverse — accurate to <1 mm for these
// tiny values, matching PROJ's `+inv` to sub-mm).
function helmert(X, Y, Z, h, inv) {
  const a2r = D2R / 3600;
  const sgn = inv ? -1 : 1;
  const tx = sgn * h.tx, ty = sgn * h.ty, tz = sgn * h.tz;
  const rx = sgn * h.rx * a2r, ry = sgn * h.ry * a2r, rz = sgn * h.rz * a2r;
  const m = 1 + (sgn * h.s) * 1e-6;
  return [
    tx + m * (X + rz * Y - ry * Z),
    ty + m * (-rz * X + Y + rx * Z),
    tz + m * (ry * X - rx * Y + Z),
  ];
}

// ITM (EPSG:6991) → WGS84: TM inverse (GRS80) → datum shift → WGS84 geodetic.
function itmToWgs84(x, y) {
  const { k0, fe, fn, lon0, lat0 } = _ITM;
  const a = ELL_GRS.a, e2 = ELL_GRS.f * (2 - ELL_GRS.f);
  const xn = x - fe, yn = y - fn;

  const M0 = meridionalArc(lat0, a, e2);
  const M = M0 + yn / k0;
  const mu = M / (a * (1 - e2 / 4 - (3 * e2 * e2) / 64 - (5 * e2 * e2 * e2) / 256));
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const phi1 = mu
    + ((3 * e1) / 2 - (27 * e1 * e1 * e1) / 32) * Math.sin(2 * mu)
    + ((21 * e1 * e1) / 16 - (55 * e1 * e1 * e1 * e1) / 32) * Math.sin(4 * mu)
    + ((151 * e1 * e1 * e1) / 96) * Math.sin(6 * mu);

  const sinPhi1 = Math.sin(phi1);
  const cosPhi1 = Math.cos(phi1);
  const tanPhi1 = Math.tan(phi1);
  const eps2 = e2 / (1 - e2);
  const C1 = eps2 * cosPhi1 * cosPhi1;
  const T1 = tanPhi1 * tanPhi1;
  const N1 = a / Math.sqrt(1 - e2 * sinPhi1 * sinPhi1);
  const R1 = (a * (1 - e2)) / Math.pow(1 - e2 * sinPhi1 * sinPhi1, 1.5);
  const D = xn / (N1 * k0);

  const phi = phi1
    - ((N1 * tanPhi1) / R1)
      * ((D * D) / 2
        - ((5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * eps2) * Math.pow(D, 4)) / 24
        + ((61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * eps2 - 3 * C1 * C1) * Math.pow(D, 6)) / 720);
  const lam = lon0
    + (D
      - ((1 + 2 * T1 + C1) * Math.pow(D, 3)) / 6
      + ((5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * eps2 + 24 * T1 * T1) * Math.pow(D, 5)) / 120)
      / cosPhi1;

  // GRS80 geodetic → datum shift (6991→WGS84 = inverse Helmert) → WGS84 geodetic.
  const [X, Y, Z] = geodToCart(lam, phi, ELL_GRS);
  const [X2, Y2, Z2] = helmert(X, Y, Z, HELMERT_W2I, true);
  const [lon2, lat2] = cartToGeod(X2, Y2, Z2, ELL_WGS);
  return [lon2 * R2D, lat2 * R2D];
}

// WGS84 → ITM (EPSG:6991): WGS84 geodetic → datum shift → TM forward (GRS80).
// Composed with mercatorToWgs84 it gives the 3857→6991 hop the CSV needs.
function wgs84ToItm(lon, lat) {
  const { k0, fe, fn, lon0, lat0 } = _ITM;
  const [X, Y, Z] = geodToCart(lon * D2R, lat * D2R, ELL_WGS);
  const [X2, Y2, Z2] = helmert(X, Y, Z, HELMERT_W2I, false);
  const [lam, phi] = cartToGeod(X2, Y2, Z2, ELL_GRS);

  const a = ELL_GRS.a, e2 = ELL_GRS.f * (2 - ELL_GRS.f), eps2 = e2 / (1 - e2);
  const sinPhi = Math.sin(phi);
  const cosPhi = Math.cos(phi);
  const tanPhi = Math.tan(phi);
  const N = a / Math.sqrt(1 - e2 * sinPhi * sinPhi);
  const T = tanPhi * tanPhi;
  const C = eps2 * cosPhi * cosPhi;
  const A = (lam - lon0) * cosPhi;
  const M = meridionalArc(phi, a, e2);
  const M0 = meridionalArc(lat0, a, e2);

  const x = fe + k0 * N * (
    A
    + ((1 - T + C) * Math.pow(A, 3)) / 6
    + ((5 - 18 * T + T * T + 72 * C - 58 * eps2) * Math.pow(A, 5)) / 120
  );
  const y = fn + k0 * (
    (M - M0)
    + N * tanPhi * (
      (A * A) / 2
      + ((5 - T + 9 * C + 4 * C * C) * Math.pow(A, 4)) / 24
      + ((61 - 58 * T + T * T + 600 * C - 330 * eps2) * Math.pow(A, 6)) / 720
    )
  );
  return [x, y];
}

function computeCentroid(geometry) {
  if (!geometry) return null;
  const points = [];
  walkPoints(geometry.coordinates, points);
  if (!points.length) return null;
  let sx = 0, sy = 0;
  for (const [x, y] of points) { sx += x; sy += y; }
  return [sx / points.length, sy / points.length];
}

function walkPoints(coords, out) {
  if (!Array.isArray(coords)) return;
  if (typeof coords[0] === 'number') { out.push([coords[0], coords[1]]); return; }
  for (const c of coords) walkPoints(c, out);
}

function collectFields(rows) {
  const seen = new Set();
  const fields = [];
  for (const r of rows) for (const k of Object.keys(r)) if (!seen.has(k)) { seen.add(k); fields.push(k); }
  return fields;
}

// --- test-only exports ------------------------------------------------------
// Pure geometry/projection helpers exposed for unit tests
// (tests/govmap-proj.test.mjs). No runtime effect.
export const __test__ = {
  itmToWgs84,
  wgs84ToItm,
  mercatorToWgs84,
  wgs84ToMercator,
  mercatorToItm,
  detectCrs,
  computeCentroid,
  parseBbox,
  slugify,
  wktToGeoJson,
  fetchGeometry,
  ensureGeometry,
  entityToParts,
  _setGeomEndpointDead: (v) => { geomEndpointDead = !!v; },
};
