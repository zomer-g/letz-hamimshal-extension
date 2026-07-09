// MAIN-world hook for mavat.iplan.gov.il (Planning Administration).
//
// mavat is an Angular SPA. The plan page fetches all plan data — including the
// full document list grouped by category — via a single authenticated XHR:
//   GET /rest/api/SV4/1?mid={mid}&guid=0
// That request only succeeds from the SPA's own session at load time (replaying
// it returns 404), so — exactly like the nadlan /deal-data hook — we capture
// the page's OWN response instead of replaying it.
//
// Declared as a MAIN-world content_script at document_start so it patches
// fetch/XHR BEFORE the SPA boots and issues the call. The captured raw JSON is
// written to a shared DOM node (<script id="__gs_mavat_bridge">) that the
// ISOLATED-world scraper reads. The DOM is shared across worlds, so there is no
// postMessage timing race.

(function () {
  if (window.__GOVSCRAPER_MAVAT_HOOKED__) return;
  window.__GOVSCRAPER_MAVAT_HOOKED__ = true;

  const PLAN_RE = /\/rest\/api\/SV4\/1\?/i;   // the plan-data call
  const ZIP_RE = /\/rest\/api\/zipAttacments/i; // per-category document ZIP
  const BRIDGE_ID = '__gs_mavat_bridge';

  // --- capture mode (driven by the ISOLATED-world overlay) -----------------
  // When the overlay wants to bundle documents into ONE ZIP, it turns capture
  // mode on, then clicks mavat's own per-category download controls. We grab
  // each resulting zipAttacments blob (the page already fetched it with its own
  // reCAPTCHA token) and hand the bytes to the overlay, while SUPPRESSING the
  // page's own per-file save so the user doesn't get many loose downloads.
  let captureNonce = null; // truthy string while capturing
  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || typeof d !== 'object') return;
    if (d.__gsMavatCmd === 'capture-on') captureNonce = String(d.nonce || '1');
    else if (d.__gsMavatCmd === 'capture-off') captureNonce = null;
  });

  // Suppress FileSaver's anchor-based save while capturing (download anchors
  // only — never touches normal navigation links).
  const origClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (captureNonce && this.hasAttribute('download')) return;
    return origClick.apply(this, arguments);
  };
  const origDispatch = HTMLAnchorElement.prototype.dispatchEvent;
  HTMLAnchorElement.prototype.dispatchEvent = function (ev) {
    if (captureNonce && this.hasAttribute('download') && ev && ev.type === 'click') return false;
    return origDispatch.apply(this, arguments);
  };

  function cdFilename(cd) {
    if (!cd) return '';
    let m = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(cd);
    if (m) { try { return decodeURIComponent(m[1].trim().replace(/^"|"$/g, '')); } catch {} }
    m = /filename="?([^";]+)"?/i.exec(cd);
    return m ? m[1].trim() : '';
  }

  const store = {
    mid: currentMid(),
    raw: null,        // raw JSON string of the plan-data response
    topKeys: [],      // diagnostic: top-level keys
    hits: 0,
    updatedAt: 0,
  };

  function currentMid() {
    // URL shape: /SV4/1/{mid}/{tab}
    const m = (location.pathname || '').match(/\/SV4\/\d+\/(\d+)/i);
    return m ? m[1] : '';
  }

  function getBridge() {
    let n = document.getElementById(BRIDGE_ID);
    if (!n) {
      n = document.createElement('script');
      n.type = 'application/json';
      n.id = BRIDGE_ID;
      (document.documentElement || document).appendChild(n);
    }
    return n;
  }

  function flush() {
    store.updatedAt = Date.now();
    try { getBridge().textContent = JSON.stringify(store); } catch {}
    try {
      const de = document.documentElement;
      de.setAttribute('data-gs-mavat-hits', String(store.hits));
      de.setAttribute('data-gs-mavat-mid', store.mid || '');
    } catch {}
  }

  function resetIfMidChanged() {
    const now = currentMid();
    if (now !== store.mid) {
      store.mid = now;
      store.raw = null;
      store.topKeys = [];
      store.hits = 0;
    }
  }

  function capture(text) {
    if (!text) return;
    const t = text.trim();
    if (!(t.startsWith('{') || t.startsWith('['))) return;
    resetIfMidChanged();
    store.hits++;
    store.raw = text;
    try { store.topKeys = Object.keys(JSON.parse(text)); } catch { store.topKeys = []; }
    flush();
  }

  // --- fetch patch ---
  const origFetch = window.fetch;
  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const resp = await origFetch.apply(this, arguments);
    try {
      if (PLAN_RE.test(url)) resp.clone().text().then(capture).catch(() => {});
    } catch {}
    return resp;
  };

  // --- XHR patch ---
  const OrigXHR = window.XMLHttpRequest;
  function PatchedXHR() {
    const xhr = new OrigXHR();
    let url = '';
    const origOpen = xhr.open;
    xhr.open = function (m, u) { url = u; return origOpen.apply(xhr, arguments); };
    xhr.addEventListener('load', () => {
      try {
        if (!PLAN_RE.test(url)) return;
        // Angular HttpClient sets responseType='json', which makes
        // xhr.responseText THROW. Read xhr.response (works for every
        // responseType) and stringify objects.
        const rt = xhr.responseType;
        let text = '';
        if (rt === '' || rt === 'text') text = xhr.responseText;
        else if (xhr.response != null) {
          text = typeof xhr.response === 'string' ? xhr.response : JSON.stringify(xhr.response);
        }
        capture(text);
      } catch {}
    });
    // Capture per-category document ZIPs (blob) when the overlay is bundling.
    xhr.addEventListener('load', () => {
      try {
        if (!captureNonce || !ZIP_RE.test(url)) return;
        const blob = xhr.response;
        if (!(blob instanceof Blob)) return;
        const name = cdFilename(xhr.getResponseHeader && xhr.getResponseHeader('content-disposition'));
        window.postMessage({ __gsMavat: 'zip', nonce: captureNonce, name, blob }, location.origin);
      } catch {}
    });
    return xhr;
  }
  PatchedXHR.prototype = OrigXHR.prototype;
  window.XMLHttpRequest = PatchedXHR;

  flush();
})();
