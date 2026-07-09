// MAIN-world hook injected into nadlan.gov.il to capture /deal-data responses.
//
// Why MAIN world: content scripts run in an isolated JS world; they can't
// override window.fetch as seen by the page's bundle. This file is declared as
// a MAIN-world content_script at document_start (manifest) so it patches
// fetch/XHR BEFORE the page bundle loads and obtains its JWT + reCAPTCHA token.
//
// Bridge design (v0.1.16): instead of postMessage (which races a not-yet-ready
// listener and loses the SPA's early auto-fetch), we ACCUMULATE every captured
// batch into a hidden <script type="application/json"> node in the DOM. The DOM
// is shared between the MAIN and ISOLATED worlds, so the content-script scraper
// can read the latest accumulated buffer at any time, with no timing race.

(function () {
  if (window.__GOVSCRAPER_INSTALLED__) return;
  window.__GOVSCRAPER_INSTALLED__ = true;

  const DEAL_DATA_RE = /api\.nadlan\.gov\.il\/deal-data/i;
  const DEAL_INFO_RE = /api\.nadlan\.gov\.il\/deal-info/i;
  const BRIDGE_ID = '__gs_nadlan_bridge';

  // Capture-only model: we passively read the /deal-data responses the page's
  // own SPA issues (page 1 + whatever the user loads by scrolling / "load more").
  // We do NOT forge paginated requests — the earlier JWT-replay path (which
  // re-signed /deal-data with a reverse-engineered secret to page past the first
  // batch) was removed; see git history if it ever needs to come back.

  // Accumulated capture across all batches for the CURRENT scope (gush/chelka,
  // neighborhood id, etc). When the SPA navigates to a different scope without
  // a full reload, we reset items so batches from different neighborhoods don't
  // pile up together.
  const store = {
    scopeKey: currentScopeKey(),
    total_rows: null,
    total_fetch: null,
    total_page: null,
    items: [],
    parcelMeta: null,
    hits: 0,          // how many deal-data responses we've intercepted
    decodeFails: 0,   // how many failed to decode
    lastRawLen: 0,
    updatedAt: 0,
  };

  function currentScopeKey() {
    try {
      const p = new URLSearchParams(location.search);
      return `${p.get('view') || ''}:${p.get('id') || ''}`;
    } catch {
      return '';
    }
  }

  function resetIfScopeChanged() {
    const now = currentScopeKey();
    if (now !== store.scopeKey) {
      store.scopeKey = now;
      store.total_rows = null;
      store.total_fetch = null;
      store.total_page = null;
      store.items = [];
      store.parcelMeta = null;
      store.hits = 0;
      store.decodeFails = 0;
    }
  }

  function getBridgeNode() {
    let node = document.getElementById(BRIDGE_ID);
    if (!node) {
      node = document.createElement('script');
      node.type = 'application/json';
      node.id = BRIDGE_ID;
      // documentElement is always present at document_start (head/body may not be)
      (document.documentElement || document).appendChild(node);
    }
    return node;
  }

  function flush() {
    store.updatedAt = Date.now();
    try {
      getBridgeNode().textContent = JSON.stringify(store);
    } catch (e) {
      // If items grew too large to stringify (shouldn't at ≤1000 deals), at
      // least keep the counters visible for diagnostics.
      try {
        getBridgeNode().textContent = JSON.stringify({ ...store, items: [], _truncated: true });
      } catch {}
    }
    // Lightweight diagnostics readable without parsing the whole buffer.
    try {
      const de = document.documentElement;
      de.setAttribute('data-gs-nadlan-hits', String(store.hits));
      de.setAttribute('data-gs-nadlan-items', String(store.items.length));
      de.setAttribute('data-gs-nadlan-decodefails', String(store.decodeFails));
    } catch {}
  }

  function mergeDealData(data) {
    resetIfScopeChanged();
    store.hits++;
    if (typeof data.total_rows === 'number') store.total_rows = data.total_rows;
    if (typeof data.total_fetch === 'number') store.total_fetch = data.total_fetch;
    if (typeof data.total_page === 'number') store.total_page = data.total_page;
    const items = Array.isArray(data.items) ? data.items : [];
    if (items.length) store.items.push(...items);
    flush();
  }

  async function decodeDealData(text) {
    // base64 → gzip → JSON
    try {
      const binStr = atob(text);
      const bytes = new Uint8Array(binStr.length);
      for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);
      if (typeof DecompressionStream !== 'undefined') {
        const stream = new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')));
        return JSON.parse(await stream.text());
      }
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch (e) {
      // Maybe it was plain JSON after all
      try { return JSON.parse(text); } catch {}
      return null;
    }
  }

  // Normalize whatever shape /deal-data returned into { total_rows, items, ... }.
  // Observed shapes:
  //   { statusCode, data: { total_rows, total_fetch, total_page, items: [...] } }
  //   { data: { ... } }   or the data object directly
  function extractDeal(parsed) {
    if (!parsed || typeof parsed !== 'object') return null;
    const d = parsed.data && typeof parsed.data === 'object' ? parsed.data : parsed;
    if (Array.isArray(d.items) || typeof d.total_rows === 'number') return d;
    return null;
  }

  async function handleDealText(text) {
    store.lastRawLen = (text || '').length;
    let parsed;
    // Body may be: a JSON string, a base64+gzip blob, or a JSON-quoted base64 string.
    try {
      parsed = JSON.parse(text);
      if (typeof parsed === 'string') parsed = await decodeDealData(parsed);
    } catch {
      parsed = await decodeDealData(text);
    }
    const deal = extractDeal(parsed);
    if (deal) {
      mergeDealData(deal);
    } else {
      store.decodeFails++;
      flush();
    }
  }

  function handleInfoText(text) {
    try {
      const json = JSON.parse(text);
      if (json) { store.parcelMeta = json; flush(); }
    } catch {}
  }

  // --- fetch patch ---------------------------------------------------------
  const origFetch = window.fetch;
  window.fetch = async function patchedFetch(input) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const resp = await origFetch.apply(this, arguments);
    try {
      if (DEAL_DATA_RE.test(url)) {
        resp.clone().text().then(handleDealText).catch(() => {});
      } else if (DEAL_INFO_RE.test(url)) {
        resp.clone().text().then(handleInfoText).catch(() => {});
      }
    } catch {}
    return resp;
  };

  // --- XHR patch -----------------------------------------------------------
  const OrigXHR = window.XMLHttpRequest;
  function PatchedXHR() {
    const xhr = new OrigXHR();
    let url = '';
    const origOpen = xhr.open;
    xhr.open = function (m, u) { url = u; return origOpen.apply(xhr, arguments); };
    xhr.addEventListener('load', () => {
      try {
        if (DEAL_DATA_RE.test(url)) handleDealText(xhr.responseText);
        else if (DEAL_INFO_RE.test(url)) handleInfoText(xhr.responseText);
      } catch {}
    });
    return xhr;
  }
  PatchedXHR.prototype = OrigXHR.prototype;
  window.XMLHttpRequest = PatchedXHR;

  // Initialize the bridge node immediately so the scraper can detect "hook is
  // present, 0 hits so far" vs "hook never ran".
  flush();
})();
