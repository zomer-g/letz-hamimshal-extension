// Fun (opt-in) flourish: perch the "לץ הממשל" jester hat on the host site's
// own logo. OFF by default — enabled from the popup settings
// (storage `overlay.jesterHat`). Purely decorative, pointer-events:none, and
// fully non-breaking: if no logo is found it simply does nothing.

(function () {
  if (window.__GS_LOGO_HAT__) return;
  window.__GS_LOGO_HAT__ = true;

  const SVGNS = 'http://www.w3.org/2000/svg';

  // Best-effort per-host logo selectors, tried before the generic heuristics.
  const HOST_SELECTORS = {
    'www.gov.il': ['a.logo img', 'header a[href*="/he"] img', '.top-header img'],
    'www.nadlan.gov.il': ['a[href="/"] img', 'header img'],
    'www.govmap.gov.il': ['a[href="/"] img', 'header img', '[class*="logo" i] img'],
    'mavat.iplan.gov.il': ['a[href*="home"] img', 'header img', '[class*="logo" i] img'],
    'idf.il': ['a[href="/"] img', 'header img', '[class*="logo" i] img'],
    'www.idf.il': ['a[href="/"] img', 'header img', '[class*="logo" i] img'],
    'geo.mot.gov.il': ['#header img', 'img[src*="logo" i]', 'header img'],
  };
  const GENERIC = [
    'header a img', '[role="banner"] a img',
    'a[href="/"] img', 'a[href="/he"] img', 'a[href$="/he/"] img',
    '[class*="logo" i] img', '[id*="logo" i] img',
    'img[alt*="logo" i]', 'img[src*="logo" i]', 'img[alt*="לוגו"]',
    'header img', '.header img', 'nav img',
    'header a svg', '[class*="logo" i] svg',
  ];

  function isLogoish(el) {
    if (!el || el.offsetParent === null) return false;
    const r = el.getBoundingClientRect();
    return r.width >= 24 && r.width <= 460 && r.height >= 14 && r.height <= 200 && r.top < 220 && r.bottom > 0;
  }

  function findLogo() {
    const host = location.hostname.toLowerCase();
    const sels = (HOST_SELECTORS[host] || []).concat(GENERIC);
    for (const sel of sels) {
      let els;
      try { els = document.querySelectorAll(sel); } catch { continue; }
      for (const el of els) if (isLogoish(el)) return el;
    }
    return null;
  }

  // Build the jester hat (variant-B palette) as real SVG DOM — no innerHTML, so
  // no CSP / Trusted-Types issues on strict gov pages.
  function svgEl(tag, attrs) {
    const e = document.createElementNS(SVGNS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }
  function buildHat() {
    const svg = svgEl('svg', { viewBox: '0 0 100 112', width: '36', height: '40' });
    const g = svgEl('g', {});
    const cols = ['#0E8FA6', '#F2B705', '#F5F0E6', '#0B5566'];
    const xs = [14, 23, 32, 41, 50, 59, 68, 77, 86];
    for (let i = 0; i < 8; i++) g.appendChild(svgEl('polygon', { points: `50,16 ${xs[i]},100 ${xs[i + 1]},100`, fill: cols[i % 4] }));
    for (const x of xs) g.appendChild(svgEl('circle', { cx: x, cy: 102, r: 5, fill: '#F2B705', stroke: '#cf9d00', 'stroke-width': 0.6 }));
    g.appendChild(svgEl('circle', { cx: 50, cy: 16, r: 11.5, fill: '#F2B705' }));
    g.appendChild(svgEl('circle', { cx: 46.5, cy: 12.5, r: 3, fill: '#fff4cc', opacity: 0.85 }));
    svg.appendChild(g);
    return svg;
  }

  let enabled = false;
  let hatEl = null;
  let logoEl = null;
  let iv = null;

  function makeHat() {
    if (hatEl) return;
    hatEl = document.createElement('div');
    hatEl.setAttribute('aria-hidden', 'true');
    Object.assign(hatEl.style, {
      position: 'fixed', zIndex: '2147483646', pointerEvents: 'none',
      width: '36px', height: '40px', transform: 'rotate(-18deg)',
      transformOrigin: 'bottom center', filter: 'drop-shadow(0 1px 1px rgba(0,0,0,.25))',
      transition: 'none', display: 'none',
    });
    hatEl.appendChild(buildHat());
    document.body.appendChild(hatEl);
  }

  function reposition() {
    if (!enabled || !hatEl) return;
    if (!logoEl || logoEl.offsetParent === null || !document.contains(logoEl)) {
      logoEl = findLogo();
    }
    if (!logoEl) { hatEl.style.display = 'none'; return; }
    const r = logoEl.getBoundingClientRect();
    if (r.width < 5 || r.bottom < 0 || r.top > innerHeight) { hatEl.style.display = 'none'; return; }
    hatEl.style.display = '';
    // sit on the top-left corner of the logo, overlapping its top edge a touch
    hatEl.style.left = Math.round(r.left - 8) + 'px';
    hatEl.style.top = Math.round(r.top - 28) + 'px';
  }

  function start() {
    makeHat();
    logoEl = findLogo();
    reposition();
    addEventListener('scroll', reposition, { passive: true });
    addEventListener('resize', reposition, { passive: true });
    if (!iv) iv = setInterval(() => { if (!enabled) { clearInterval(iv); iv = null; return; } reposition(); }, 1200);
  }
  function stop() {
    enabled = false;
    if (iv) { clearInterval(iv); iv = null; }
    if (hatEl) { hatEl.remove(); hatEl = null; }
    logoEl = null;
  }

  try {
    chrome.storage.local.get('overlay.jesterHat').then((v) => {
      enabled = v['overlay.jesterHat'] === true;
      if (enabled) start();
    });
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== 'local' || !ch['overlay.jesterHat']) return;
      const on = ch['overlay.jesterHat'].newValue === true;
      if (on && !enabled) { enabled = true; start(); }
      else if (!on && enabled) { stop(); }
    });
  } catch {}
})();
