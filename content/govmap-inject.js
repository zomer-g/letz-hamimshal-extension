// MAIN-world hook for govmap.gov.il.
//
// The scraper sweeps a layer's full catalog extent via the entitiesByPoint API.
// As a fallback (when neither a URL bbox nor a catalog extent is available) it
// scopes the sweep to the current map view instead. govmap is an OpenLayers app
// that exposes its map as `window.__olMap`, but that lives in the MAIN world —
// the ISOLATED-world scraper can't read it. So here (MAIN world) we publish the
// current view extent to a DOM attribute the scraper reads.
//
// The extent is in the map's projection (EPSG:3857). We publish it verbatim
// plus its CRS; the scraper uses it directly as the 3857 sweep extent.

(function () {
  if (window.__GOVSCRAPER_GOVMAP_HOOKED__) return;
  window.__GOVSCRAPER_GOVMAP_HOOKED__ = true;

  function publish() {
    try {
      const m = window.__olMap;
      if (!m || typeof m.getView !== 'function' || typeof m.getSize !== 'function') return;
      const view = m.getView();
      const ext = view.calculateExtent(m.getSize());
      if (!Array.isArray(ext) || ext.length !== 4 || !ext.every(Number.isFinite)) return;
      const proj = (view.getProjection && view.getProjection() && view.getProjection().getCode && view.getProjection().getCode()) || 'EPSG:3857';
      const de = document.documentElement;
      de.setAttribute('data-gs-govmap-ext', ext.join(','));
      de.setAttribute('data-gs-govmap-proj', proj);
    } catch {}
  }

  // __olMap is created after the app boots, so poll. Binding to 'moveend' keeps
  // the extent fresh as the user pans/zooms; the poll also covers map recreation.
  let bound = false;
  setInterval(() => {
    publish();
    const m = window.__olMap;
    if (m && typeof m.on === 'function' && !bound) {
      bound = true;
      try { m.on('moveend', publish); } catch {}
    }
  }, 1000);
})();
