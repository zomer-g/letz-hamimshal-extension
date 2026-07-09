// MAIN-world bridge for geo.mot.gov.il (Ministry of Transport GIS, "חצב").
//
// WHY a MAIN-world inject: the layers displayed on חצב's map (e.g.
// "רכבת כבדה - מסילות") are vector features served by the MOT's own GovMap
// tenant. The page draws them through the GovMap JS API loaded at the top of
// the page (`window.govmap`), which talks to its backend over a cross-origin
// MessageChannel — so the geometry is NOT fetchable by a plain HTTP request and
// is NOT in any public catalog. The ONLY way to obtain the exact displayed
// layer's geometry is to call the page's OWN api, with the exact layer CODE.
//
// This script (declared world:"MAIN", document_idle) runs in the page context
// where `window.govmap` lives. On request from the ISOLATED-world overlay
// (window.postMessage `__gsMotCmd:'extract'`) it sweeps each requested layer and
// posts the features back. No name-guessing, no redirect to govmap.gov.il —
// exactly the layers the user checked, returned as WKT (ITM/EPSG:6991).

(function () {
  if (window.__GOVSCRAPER_MOT_HOOKED__) return;
  window.__GOVSCRAPER_MOT_HOOKED__ = true;

  // Israel national extent in ITM (EPSG:6991), from the site's own
  // israelExtentPolygonGeo. The sweep tiles this bbox.
  const ISRAEL_ITM = { minx: 129897.85, miny: 376689.53, maxx: 287854.42, maxy: 818015.41 };
  const CAP = 500;          // server caps intersectFeatures at 500 rows/tile (verified live
                            // 2026-06-26: dense layers all return exactly 500) — a tile that
                            // reaches it is capped and must be subdivided.
  const MAX_DEPTH = 14;     // recursion guard (point-dense tiles)
  const MAX_TILES = 6000;   // per-layer safety
  const MAX_FEATURES = 250000;
  const TILE_TIMEOUT = 60000;
  const READY_TIMEOUT = 25000;

  function post(msg) { try { window.postMessage(Object.assign({ __gsMot: 1 }, msg), location.origin); } catch {} }

  function bboxWkt(b) {
    // closed ring, ITM coords
    return `POLYGON((${b.minx} ${b.maxy}, ${b.maxx} ${b.maxy}, ${b.maxx} ${b.miny}, ${b.minx} ${b.miny}, ${b.minx} ${b.maxy}))`;
  }

  function hasIntersectByGeom() { return !!(window.govmap && typeof window.govmap.intersectFeatures === 'function'); }
  function hasIntersectByWhere() { return !!(window.govmap && typeof window.govmap.intersectFeaturesByWhereClause === 'function'); }
  function ready() { return hasIntersectByGeom() || hasIntersectByWhere(); }

  async function waitReady(ms) {
    const t0 = Date.now();
    while (!ready()) { if (Date.now() - t0 > ms) return false; await sleep(300); }
    return true;
  }
  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  // Per-layer field list, from the page's own identifyFields table. This MUST
  // match the order of the row's Values array exactly (the API returns
  // [field0, field1, …, shapeLength, shapeArea, geometryWKT]), so we do NOT add
  // OBJECTID here — OBJECTID is a sibling of Values (row.ObjectId), captured
  // separately. Layers absent from identifyFields fall back to geometry-only.
  function fieldsFor(code) {
    try {
      const f = window.identifyFields && (window.identifyFields[code] || window.identifyFields[String(code).toUpperCase()]);
      if (Array.isArray(f) && f.length) return f.slice();
    } catch {}
    return [];
  }

  function rowObjectId(row) {
    if (!row || typeof row !== 'object') return null;
    for (const k of Object.keys(row)) if (/^objectid$/i.test(k)) return row[k];
    return null;
  }

  // Resolve a GovMap API promise/callback into {data} or {error}, with a timeout.
  function callApi(method, arg) {
    return new Promise((resolve) => {
      let done = false;
      const to = setTimeout(() => { if (!done) { done = true; resolve({ error: 'timeout' }); } }, TILE_TIMEOUT);
      const finish = (v) => { if (!done) { done = true; clearTimeout(to); resolve(v); } };
      try {
        const p = window.govmap[method](arg);
        Promise.resolve(p)
          .then((res) => finish({ data: (res && res.data) || [] }))
          .catch((e) => finish({ error: String((e && e.message) || e || 'error') }));
      } catch (e) { finish({ error: String((e && e.message) || e || 'throw') }); }
    });
  }

  // data[] → [{ wkt, attrs, oid }]. Each row is { ObjectId, Values }; Values is
  // [field0…fieldN, shapeLength, shapeArea, geometryWKT] when getShapes:true, so
  // geometry is the LAST entry and the requested fields map to the FIRST N. The
  // trailing shape metrics between fields and geometry are ignored.
  function featuresFrom(data, fields) {
    const out = [];
    for (const row of (data || [])) {
      const vals = (row && row.Values) || [];
      if (!vals.length) continue;
      const wkt = vals[vals.length - 1];
      if (typeof wkt !== 'string' || wkt.indexOf('(') < 0) continue; // not a geometry row
      const attrs = {};
      const oid = rowObjectId(row);
      if (oid != null) attrs.OBJECTID = oid;
      for (let i = 0; i < fields.length && i < vals.length - 1; i++) attrs[fields[i]] = vals[i];
      out.push({ wkt, attrs, oid });
    }
    return out;
  }

  function dedupKey(f) {
    return f.oid != null ? 'oid:' + String(f.oid) : 'wkt:' + f.wkt;
  }

  // Spatial sweep of one layer using intersectFeatures (geometry filter) →
  // cap-safe quad-tree. Falls back to a single intersectFeaturesByWhereClause
  // call if the geometry method is unavailable.
  async function sweepLayer(code, onProg) {
    const fields = fieldsFor(code);
    const seen = new Map();
    let tiles = 0, capped = false, firstErr = null, mode = '';

    if (hasIntersectByGeom()) {
      mode = 'intersectFeatures';
      const stack = [{ b: ISRAEL_ITM, d: 0 }];
      while (stack.length) {
        if (tiles >= MAX_TILES || seen.size >= MAX_FEATURES) { capped = true; break; }
        const { b, d } = stack.pop();
        tiles++;
        const r = await callApi('intersectFeatures', { geometry: bboxWkt(b), layerName: code, fields, getShapes: true });
        if (r.error) { if (!firstErr) firstErr = r.error; continue; }
        const feats = featuresFrom(r.data, fields);
        if (feats.length >= CAP && d < MAX_DEPTH) {
          const mx = (b.minx + b.maxx) / 2, my = (b.miny + b.maxy) / 2;
          stack.push(
            { b: { minx: b.minx, miny: b.miny, maxx: mx, maxy: my }, d: d + 1 },
            { b: { minx: mx, miny: b.miny, maxx: b.maxx, maxy: my }, d: d + 1 },
            { b: { minx: b.minx, miny: my, maxx: mx, maxy: b.maxy }, d: d + 1 },
            { b: { minx: mx, miny: my, maxx: b.maxx, maxy: b.maxy }, d: d + 1 },
          );
          continue;
        }
        if (feats.length >= CAP) capped = true; // hit cap at max depth
        for (const f of feats) { const k = dedupKey(f); if (!seen.has(k)) seen.set(k, f); }
        if (tiles % 4 === 0 && onProg) onProg(seen.size, tiles);
      }
    } else if (hasIntersectByWhere()) {
      mode = 'intersectFeaturesByWhereClause';
      const r = await callApi('intersectFeaturesByWhereClause', { layerName: code, fields, getShapes: true, whereClause: '1=1' });
      if (r.error) firstErr = r.error;
      else {
        const feats = featuresFrom(r.data, fields);
        for (const f of feats) { const k = dedupKey(f); if (!seen.has(k)) seen.set(k, f); }
        if (feats.length >= 1000) capped = true; // single-call path can't beat a server cap
      }
    } else {
      firstErr = 'GovMap API not available on the page';
    }

    return {
      code,
      fields,
      mode,
      features: [...seen.values()],
      capped,
      error: seen.size ? null : firstErr,
    };
  }

  async function extract(nonce, codes) {
    if (!await waitReady(READY_TIMEOUT)) {
      post({ type: 'error', nonce, error: 'מפת חצב עדיין נטענת (GovMap API לא מוכן). המתן שהמפה תיטען במלואה ונסה שוב.' });
      return;
    }
    const layers = [];
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i];
      post({ type: 'progress', nonce, message: `שולף גיאומטריה: ${code} (${i + 1}/${codes.length})`, count: 0 });
      try {
        const L = await sweepLayer(code, (cnt, t) => post({ type: 'progress', nonce, message: `${code}: ${cnt} עצמים (${t} אריחים)`, count: cnt }));
        layers.push(L);
        post({ type: 'progress', nonce, message: `${code}: ${L.features.length} עצמים${L.error ? ' — ' + L.error : ''}`, count: L.features.length });
      } catch (e) {
        layers.push({ code, fields: [], mode: '', features: [], capped: false, error: String((e && e.message) || e) });
      }
    }
    post({ type: 'result', nonce, layers });
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.__gsMotCmd !== 'extract') return;
    extract(String(d.nonce || '1'), Array.isArray(d.codes) ? d.codes.map(String) : []);
  });

  // Signal presence to the ISOLATED-world overlay.
  try { document.documentElement.setAttribute('data-gs-mot-inject', '1'); } catch {}
})();
