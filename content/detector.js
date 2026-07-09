// Content script entrypoint. Runs at document_idle on every host listed in
// manifest.content_scripts.matches. Responsibilities:
//   1. Dispatch the URL through the registry to decide if this page offers a
//      scrapeable dataset; if so, hand off to overlay.js.
//   2. For nadlan.gov.il, install the MAIN-world hook (inject.js) so the
//      page's own fetch/XHR for /deal-data can be captured.
//   3. Watch for URL changes (SPA navigation, layer toggling on govmap) and
//      re-dispatch — the overlay's parsed state must always reflect the
//      current location.href, otherwise toggling layers on govmap would still
//      download the originally-loaded layer.
//
// Why everything runs in the content script: same-origin fetch() carries the
// user's Cloudflare cookies for gov.il, which is what lets us bypass the
// server-side cloudscraper requirement.

(async () => {
  if (window.__GOVSCRAPER_DETECTOR_RAN__) return;
  window.__GOVSCRAPER_DETECTOR_RAN__ = true;

  const host = location.hostname.toLowerCase();

  // nadlan capture is now handled entirely by content/inject.js — declared as a
  // MAIN-world content_script at document_start in the manifest, writing into a
  // shared DOM bridge node. No postMessage listener or chrome.scripting
  // injection is needed here anymore (both raced the SPA's early auto-fetch).

  let registry;
  try {
    registry = await import(chrome.runtime.getURL('scrapers/registry.js'));
  } catch (e) {
    console.warn('[GovScraper] failed to load registry:', e);
    return;
  }

  let currentKey = '';
  let lastHref = '';
  let lastMatch = null;

  // Per-site opt-out: scraper ids the user disabled (e.g. run only on GovMap).
  // Cached synchronously so the popup message handlers can read it; loaded once
  // before the first dispatch (below) so a disabled site never flashes, and kept
  // live via storage.onChanged.
  let disabledSites = new Set();

  async function checkAndUpdate(force = false) {
    // force (settings change / SPA nav) bypasses the dedup so we always re-evaluate.
    if (force) currentKey = '';
    if (!force && location.href === lastHref) return;
    lastHref = location.href;

    const match = registry.dispatchByUrl(location.href);
    lastMatch = match;
    const key = matchKey(match);
    if (key === currentKey) return;
    currentKey = key;

    if (!match) {
      window.GovScraperOverlay?.remove();
      return;
    }

    // Per-site opt-out: user turned the extension off for this site.
    if (disabledSites.has(match.scraper.id)) {
      window.GovScraperOverlay?.remove();
      return;
    }

    // The floating window is shown automatically only when enabled (default on)
    // and not snoozed for today. When gated, remove any existing overlay — the
    // user can still download from the popup ("download without the window").
    const { 'overlay.enabled': enabled, 'overlay.hideUntil': hideUntil } =
      await chrome.storage.local.get(['overlay.enabled', 'overlay.hideUntil']);
    if (enabled === false || (hideUntil && Date.now() < hideUntil)) {
      window.GovScraperOverlay?.remove();
      return;
    }

    window.GovScraperOverlay?.show({ match, registry });
  }

  // React live to settings toggled in the popup (show/hide, snooze, per-site).
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== 'local') return;
    if (ch['sites.disabled']) disabledSites = new Set(Array.isArray(ch['sites.disabled'].newValue) ? ch['sites.disabled'].newValue : []);
    if (ch['overlay.enabled'] || ch['overlay.hideUntil'] || ch['sites.disabled']) checkAndUpdate(true);
  });

  // Commands from the popup: report what's on this page, and run a download
  // on demand (so a user who disabled/hid the floating window can still grab
  // the dataset straight from the toolbar popup).
  const ONE_CLICK = new Set(['dynamic_collector', 'traditional_collector', 'idf_section', 'wfs_layer']);
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'gs-popup-detect') {
      const m = registry.dispatchByUrl(location.href);
      if (!m) { sendResponse({ detected: false }); return; }
      sendResponse({
        detected: true,
        label: m.parsed.label || m.parsed.collectorName || 'מאגר',
        source: m.scraper.label || '',
        kind: m.parsed.kind,
        scraperId: m.scraper.id,
        disabled: disabledSites.has(m.scraper.id),
        oneClick: ONE_CLICK.has(m.parsed.kind),
      });
      return;
    }
    if (msg.type === 'gs-popup-download') {
      const m = registry.dispatchByUrl(location.href);
      if (!m) { sendResponse({ ok: false, error: 'no-dataset' }); return; }
      try { window.GovScraperOverlay?.show({ match: m, registry, autoRun: true }); sendResponse({ ok: true, oneClick: ONE_CLICK.has(m.parsed.kind) }); }
      catch (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); }
      return;
    }
  });

  function matchKey(m) {
    if (!m) return '';
    const p = m.parsed;
    // Identify a match by the fields that distinguish one dataset from another.
    // For govmap that's the layerIds; for traditional/dynamic collectors it's
    // the collector name + officeId + extra query params; for parcel it's
    // gush+chelka. Stringifying queryParams handles arbitrary filter changes.
    return [
      m.scraper.id,
      p.kind,
      p.layerId || '',
      Array.isArray(p.layerIds) ? p.layerIds.join(',') : '',
      p.collectorName || '',
      p.officeId || '',
      p.gush || '',
      p.chelka || '',
      JSON.stringify(p.queryParams || {}),
    ].join('|');
  }

  // Load the per-site opt-out list before the first dispatch so a disabled
  // site is gated from the start (no flash of the overlay).
  try {
    const v = await chrome.storage.local.get('sites.disabled');
    if (Array.isArray(v['sites.disabled'])) disabledSites = new Set(v['sites.disabled']);
  } catch {}

  // Initial dispatch.
  await checkAndUpdate(true);

  // SPA-friendly URL watcher. We can't reliably patch history.pushState from
  // the isolated world (the page's history calls won't see our patch — they
  // use the MAIN world's reference), so we poll every 500 ms. Cheap and works
  // for every SPA we care about (govmap, gov.il React, nadlan, idf). popstate
  // and hashchange are bonus immediate triggers for browser back/forward and
  // hash-only routing.
  setInterval(() => { checkAndUpdate(); }, 500);
  window.addEventListener('popstate', () => checkAndUpdate(true));
  window.addEventListener('hashchange', () => checkAndUpdate(true));
})();
