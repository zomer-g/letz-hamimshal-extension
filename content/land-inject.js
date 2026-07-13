// MAIN-world hook for apps.land.gov.il/TabaSearch (רמ"י — איתור תוכניות).
//
// Why MAIN world: the search state (city code, block/parcel, plan types, dates)
// lives only inside the Angular component and never appears in the hash-route
// URL. The page's own bundle POSTs it to  …/SerachPlans/GetPlans  via XHR
// (Angular HttpClient). This isolated content script can't see that request from
// the ISOLATED world, so we patch fetch + XHR here (document_start, MAIN world)
// and record the LAST request body — the exact, stateless criteria the ISOLATED
// scraper then replays same-origin (and subdivides) to pull every plan.
//
// Bridge: a hidden <script type="application/json" id="__gs_land_bridge"> that
// both worlds share via the DOM. We store only the latest search { criteria,
// totalRecords, at } — no accumulation, no race.

(function () {
  if (window.__GS_LAND_INSTALLED__) return;
  window.__GS_LAND_INSTALLED__ = true;

  const GETPLANS_RE = /SerachPlans\/GetPlans/i;
  const BRIDGE_ID = '__gs_land_bridge';

  function bridgeNode() {
    let node = document.getElementById(BRIDGE_ID);
    if (!node) {
      node = document.createElement('script');
      node.type = 'application/json';
      node.id = BRIDGE_ID;
      (document.documentElement || document).appendChild(node);
    }
    return node;
  }

  function writeBridge(state) {
    try { bridgeNode().textContent = JSON.stringify(state); } catch {}
    try { document.documentElement.setAttribute('data-gs-land', '1'); } catch {}
  }

  // Initialize immediately so the scraper can tell "hook present, no search yet".
  writeBridge({ criteria: null, totalRecords: null, at: 0 });

  function record(reqBody, respText) {
    let criteria = null;
    try { criteria = typeof reqBody === 'string' ? JSON.parse(reqBody) : (reqBody && typeof reqBody === 'object' ? reqBody : null); }
    catch { criteria = null; }
    if (!criteria || typeof criteria !== 'object') return; // ignore requests we can't read

    let totalRecords = null;
    try {
      const j = typeof respText === 'string' ? JSON.parse(respText) : respText;
      if (j && typeof j.totalRecords === 'number') totalRecords = j.totalRecords;
    } catch {}

    writeBridge({ criteria, totalRecords, at: Date.now() });
  }

  // --- fetch patch (in case the app ever uses fetch) -------------------------
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const body = init && init.body;
      const p = origFetch.apply(this, arguments);
      try {
        if (GETPLANS_RE.test(url)) {
          p.then((r) => r.clone().text().then((t) => record(body, t)).catch(() => record(body, null))).catch(() => {});
        }
      } catch {}
      return p;
    };
  }

  // --- XHR patch (Angular HttpClient uses XHR) -------------------------------
  const OrigXHR = window.XMLHttpRequest;
  const origOpen = OrigXHR.prototype.open;
  const origSend = OrigXHR.prototype.send;
  OrigXHR.prototype.open = function (method, url) {
    this.__gsLandUrl = url;
    return origOpen.apply(this, arguments);
  };
  OrigXHR.prototype.send = function (body) {
    const xhr = this;
    try {
      if (xhr.__gsLandUrl && GETPLANS_RE.test(xhr.__gsLandUrl)) {
        xhr.addEventListener('load', function () {
          let respText = '';
          // Angular sets responseType='json', which makes responseText throw —
          // read `response` and stringify if it's an object.
          try { respText = typeof xhr.response === 'object' ? JSON.stringify(xhr.response) : (xhr.responseText || String(xhr.response || '')); }
          catch { try { respText = JSON.stringify(xhr.response); } catch {} }
          record(typeof body === 'string' ? body : null, respText);
        });
      }
    } catch {}
    return origSend.apply(this, arguments);
  };
})();
