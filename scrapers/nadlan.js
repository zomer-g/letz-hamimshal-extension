// nadlan.gov.il scraper — real-estate deals for any scope the SPA exposes.
//
// Supported views (all use the same /deal-data endpoint internally):
//   ?view=kparcel_all&id=<gush>-<chelka>       — single parcel deals
//   ?view=neighborhood&id=<n>&page=deals       — neighborhood deals
//   ?view=settlement&id=<n>&page=deals         — settlement (יישוב) deals
//   ?view=street&id=<n>&page=deals             — street deals
//
// The /deal-data POST requires HS256 JWT signing + reCAPTCHA Enterprise scoring
// (see govscraper/scrapers/nadlan/legacy_api.py) which we can't replicate from
// plain fetch(). Strategy: a MAIN-world script (content/inject.js) intercepts
// the page's own /deal-data fetches and forwards the decoded payload to us via
// chrome.storage.session. We poll that storage key once the user clicks
// "Download".
//
// Multi-batch pagination: the SPA loads up to 500 deals per /deal-data call and
// exposes a "load more" button for larger scopes. Our hook captures every batch
// the page issues, so the user only needs to scroll/click to load everything
// they want — then click Download.

const VIEW_KINDS = {
  kparcel_all: { kind: 'parcel', label: 'פרצל נדל"ן', requireDealsPage: false },
  neighborhood: { kind: 'neighborhood_deals', label: 'עסקאות בשכונה', requireDealsPage: true },
  settlement: { kind: 'settlement_deals', label: 'עסקאות ביישוב', requireDealsPage: true },
  street: { kind: 'street_deals', label: 'עסקאות ברחוב', requireDealsPage: true },
};

export const nadlanScraper = {
  id: 'nadlan',
  label: 'nadlan.gov.il',

  parseUrl(href) {
    let u;
    try { u = new URL(href); } catch { return null; }
    const host = (u.hostname || '').toLowerCase();
    if (!host.endsWith('nadlan.gov.il')) return null;
    const params = Object.fromEntries(u.searchParams.entries());
    const view = (params.view || '').toLowerCase();
    const viewMeta = VIEW_KINDS[view];
    if (!viewMeta) return null;
    const page = (params.page || '').toLowerCase();
    if (viewMeta.requireDealsPage && page !== 'deals') return null;

    const id = params.id || '';
    if (!id) return null;

    if (view === 'kparcel_all') {
      if (!id.includes('-')) return null;
      const [gush, chelka] = id.split('-');
      if (!gush || !chelka) return null;
      return {
        scraperId: 'nadlan',
        kind: 'parcel',
        view,
        gush,
        chelka,
        scopeId: id,
        collectorName: `nadlan_parcel_${gush}_${chelka}`,
        originalUrl: href,
        queryParams: params,
        label: `${viewMeta.label} — גוש ${gush} חלקה ${chelka}`,
      };
    }

    return {
      scraperId: 'nadlan',
      kind: viewMeta.kind,
      view,
      scopeId: id,
      collectorName: `nadlan_${view}_${id}`,
      originalUrl: href,
      queryParams: params,
      label: `${viewMeta.label} — מזהה ${id}`,
    };
  },

  async fetch(parsed, { onProgress } = {}) {
    const scopeLabel = parsed.kind === 'parcel'
      ? `גוש ${parsed.gush} חלקה ${parsed.chelka}`
      : `${VIEW_KINDS[parsed.view]?.label || parsed.view} (${parsed.scopeId})`;

    onProgress?.({
      phase: 'wait',
      current: 0,
      total: 0,
      message: `מאתר עסקאות עבור ${scopeLabel}…`,
      sub: 'אם הטבלה לא נטענה — גלול בדף עד שתופיע, הלכידה תתחיל אוטומטית',
    });

    // Phase 1 — get the first batch. The MAIN-world hook may have already
    // captured it (if the user scrolled before clicking); otherwise we drive
    // the SPA (scroll + load-more) and wait. We never fail until WAIT_MS.
    const WAIT_MS = 180000; // 3 minutes
    advancePagination(onProgress).catch(() => {});
    let captured = await waitForCapture(WAIT_MS, (elapsed, diag) => {
      const left = Math.max(0, Math.round((WAIT_MS - elapsed) / 1000));
      const d = diag || {};
      const sub = d.hits
        ? `נקלטו ${d.hits} קריאות /deal-data • ${d.items} עסקאות${d.decodeFails ? ` • ${d.decodeFails} כשלי פענוח` : ''}`
        : 'גלול בעמוד למטה עד שתופיע טבלת העסקאות — אאתר אוטומטית';
      onProgress?.({
        phase: 'wait',
        current: Math.round(elapsed / 1000),
        total: WAIT_MS / 1000,
        message: `ממתין שטבלת העסקאות תיטען (${left}‎ שניות נותרו)`,
        sub,
      });
    });

    if (!captured || !captured.items?.length) {
      const diag = readDiagnostics();
      if (diag.hits > 0 && diag.decodeFails > 0) {
        throw new Error(
          `קלטתי ${diag.hits} קריאות /deal-data אבל פענוח הנתונים נכשל (${diag.decodeFails}). ייתכן שמבנה התגובה של נדל"ן השתנה — דווח לי ואתקן.`
        );
      }
      if (!diag.hookPresent) {
        throw new Error(
          'הוק הלכידה לא הותקן בדף. רענן (F5) ונסה שוב; אם זה חוזר — ייתכן שצריך להסיר ולטעון מחדש את התוסף.'
        );
      }
      throw new Error(
        'לא נטענה טבלת עסקאות בדף תוך 3 דקות (0 קריאות /deal-data). סביר שה-SPA של נדל"ן לא טען את הטבלה. נסה: ' +
        '(א) לגלול ידנית עד שטבלת העסקאות מופיעה, (ב) לרענן (F5), (ג) ללחוץ "עסקאות מכירה" בסרגל העליון — ואז "הורד עסקאות" שוב.'
      );
    }

    // Capture-only: use whatever the page's own SPA has loaded so far — page 1
    // plus anything the user pulled in by scrolling / clicking "load more"
    // (every batch the SPA issues is intercepted by content/inject.js). We do a
    // final re-read in case more batches landed while we were waiting.
    captured = (await readCapture()) || captured;

    const items = captured.items || [];
    const totalRows = captured.total_rows || items.length;

    // Inject scope context onto every row + dedup composite key (assetId|dealDate)
    const seen = new Set();
    const rows = [];
    for (const it of items) {
      const row = { ...it };
      if (parsed.kind === 'parcel') {
        row.gush = parsed.gush;
        row.chelka = parsed.chelka;
      } else {
        row.scope_view = parsed.view;
        row.scope_id = parsed.scopeId;
      }
      const key = `${row.assetId || ''}|${row.dealDate || ''}|${row.dealAmount || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(row);
    }

    onProgress?.({
      phase: 'scrape',
      current: rows.length,
      total: totalRows,
      message: `נאספו ${rows.length} עסקאות`,
    });

    // Explain the gap, if any. We paged via signed-JWT replay until the count
    // stopped growing — usually because nadlan's per-IP rate limit started
    // returning 403 on further pages.
    let warning = null;
    if (parsed.kind !== 'parcel' && totalRows > rows.length) {
      warning = `בהיקף הזה רשומות ${totalRows} עסקאות; אספתי ${rows.length} (מה שהדף טען עד כה). כדי לאסוף יותר — גלול בטבלת העסקאות ולחץ "טען עוד" עד שכל העסקאות ייטענו, ואז הורד שוב. לכיסוי מלא של אזור גדול מומלץ למקד לרחוב בודד (view=street) או לפרצל (view=kparcel_all&id=גוש-חלקה).`;
    }

    return {
      rows: rows.map(r => flatten(r)),
      fields: orderColumns(rows, parsed.kind),
      sourceUrl: parsed.originalUrl,
      collectorName: parsed.collectorName,
      kind: parsed.kind,
      total: rows.length,
      warning,
      attachments: [],
      meta: captured.parcelMeta || null,
    };
  },
};

const PRIMARY_FIELDS_PARCEL = [
  'gush', 'chelka',
  'dealDate', 'dealAmount', 'priceSM',
  'roomNum', 'floor', 'assetArea', 'yearBuilt', 'buildingFloors',
  'dealNature', 'hokHamecher',
  'address', 'parcelNum',
  'neighborhoodName', 'settlementName',
  'assetId', 'addressId', 'polygonId',
  'streetCode', 'settlmentID', 'neighborhoodId',
];
const PRIMARY_FIELDS_SCOPE = [
  'scope_view', 'scope_id',
  'dealDate', 'dealAmount', 'priceSM',
  'address', 'neighborhoodName', 'settlementName',
  'roomNum', 'floor', 'assetArea', 'yearBuilt', 'buildingFloors',
  'dealNature', 'hokHamecher',
  'gush', 'chelka', 'parcelNum',
  'assetId', 'addressId', 'polygonId',
  'streetCode', 'settlmentID', 'neighborhoodId',
];

function orderColumns(rows, kind) {
  const primary = kind === 'parcel' ? PRIMARY_FIELDS_PARCEL : PRIMARY_FIELDS_SCOPE;
  const seen = new Set();
  const out = [];
  for (const f of primary) {
    if (rows.some(r => r && r[f] !== undefined)) { out.push(f); seen.add(f); }
  }
  for (const r of rows) {
    for (const k of Object.keys(r || {})) {
      if (!seen.has(k)) { seen.add(k); out.push(k); }
    }
  }
  return out;
}

function flatten(obj, prefix = '', out = {}) {
  if (obj === null || obj === undefined) return out;
  if (typeof obj !== 'object') { out[prefix || 'value'] = obj; return out; }
  if (Array.isArray(obj)) {
    out[prefix || 'value'] = obj.every(v => typeof v !== 'object' || v === null)
      ? obj.filter(v => v !== null && v !== undefined).join('; ')
      : JSON.stringify(obj);
    return out;
  }
  for (const [k, v] of Object.entries(obj)) {
    flatten(v, prefix ? `${prefix}.${k}` : k, out);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Drive the SPA so its lazy loader fires. The deals table on nadlan.gov.il is
// only mounted once the user scrolls into view, and pagination requires
// clicking a "טען עוד" button. We do both automatically.
// ---------------------------------------------------------------------------

// One round of "advance the deals list". Called repeatedly by the fetch()
// accumulation loop. Combines every mechanism nadlan's SPA might use to load
// the next page of deals:
//   1. Window scroll to bottom (window-scroll lazy loaders)
//   2. Scroll every inner overflow container to its bottom + fire scroll events
//      (the deals table commonly lives in its own scrollable div)
//   3. Click a "טען עוד" / pagination button if one is visible
async function advancePagination(onProgress) {
  scrollWindowToBottom();
  await sleep(250);
  scrollAllContainersToBottom();
  await sleep(250);
  // Fire a window scroll event too — some React listeners need the event,
  // not just the scrollTop mutation.
  try { window.dispatchEvent(new Event('scroll')); } catch {}

  const btn = findLoadMoreButton();
  if (btn) {
    try { btn.scrollIntoView({ block: 'center' }); } catch {}
    await sleep(150);
    try { btn.click(); } catch {}
  }
}

function scrollWindowToBottom() {
  const target = Math.max(
    document.body.scrollHeight,
    document.documentElement.scrollHeight,
  );
  try { window.scrollTo(0, target); } catch {}
  try { document.documentElement.scrollTop = target; } catch {}
  try { document.body.scrollTop = target; } catch {}
}

function scrollAllContainersToBottom() {
  const all = document.querySelectorAll('*');
  for (const el of all) {
    let style;
    try { style = getComputedStyle(el); } catch { continue; }
    const oy = style.overflowY;
    if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight - el.clientHeight > 40) {
      try {
        el.scrollTop = el.scrollHeight;
        el.dispatchEvent(new Event('scroll', { bubbles: true }));
      } catch {}
    }
  }
}

function findLoadMoreButton() {
  // Match on visible button text. nadlan uses Hebrew labels — "טען עוד",
  // "הצג עוד", "עוד עסקאות", or English fallbacks for some versions.
  const TEXTS = ['טען עוד', 'הצג עוד', 'עוד עסקאות', 'הצגת עסקאות נוספות', 'load more', 'show more'];
  const candidates = document.querySelectorAll('button, a, [role="button"], [class*="button"], [class*="btn"]');
  for (const el of candidates) {
    if (el.disabled) continue;
    const txt = ((el.textContent || el.getAttribute('aria-label') || '') + '').trim().toLowerCase();
    if (!txt) continue;
    for (const t of TEXTS) {
      if (txt.includes(t.toLowerCase())) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue; // skip hidden
        return el;
      }
    }
  }
  return null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---------------------------------------------------------------------------
// Capture bridge — see content/inject.js. The MAIN-world hook accumulates all
// /deal-data payloads into chrome.storage.session under 'nadlan.lastCapture';
// we poll until either at least one batch arrives or we time out.
// ---------------------------------------------------------------------------

async function waitForCapture(timeoutMs, onTick) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const captured = await readCapture();
    if (captured && captured.items && captured.items.length) return captured;
    await new Promise(r => setTimeout(r, 500));
    onTick?.(timeoutMs - (deadline - Date.now()), readDiagnostics());
  }
  return readCapture();
}

const BRIDGE_ID = '__gs_nadlan_bridge';

// Primary capture path: read the DOM bridge node that content/inject.js (MAIN
// world) keeps up to date. The DOM is shared between worlds, so there's no
// postMessage timing race — whatever the hook has accumulated is available
// here synchronously. Storage is kept only as a legacy fallback.
async function readCapture() {
  const node = document.getElementById(BRIDGE_ID);
  if (node && node.textContent) {
    try {
      const parsed = JSON.parse(node.textContent);
      if (parsed && Array.isArray(parsed.items)) return parsed;
    } catch {}
  }
  if (typeof chrome !== 'undefined' && chrome.storage?.session) {
    try {
      const { 'nadlan.lastCapture': cap } = await chrome.storage.session.get('nadlan.lastCapture');
      return cap || null;
    } catch {}
  }
  return null;
}

// Lightweight, non-parsing diagnostics for live UI feedback.
function readDiagnostics() {
  const de = document.documentElement;
  return {
    hookPresent: de.hasAttribute('data-gs-nadlan-hits'),
    hits: parseInt(de.getAttribute('data-gs-nadlan-hits') || '0', 10),
    items: parseInt(de.getAttribute('data-gs-nadlan-items') || '0', 10),
    decodeFails: parseInt(de.getAttribute('data-gs-nadlan-decodefails') || '0', 10),
  };
}

export async function clearCapture() {
  const node = document.getElementById(BRIDGE_ID);
  if (node) node.remove();
  document.documentElement.removeAttribute('data-gs-nadlan-hits');
  document.documentElement.removeAttribute('data-gs-nadlan-items');
  document.documentElement.removeAttribute('data-gs-nadlan-decodefails');
  if (typeof chrome !== 'undefined' && chrome.storage?.session) {
    try { await chrome.storage.session.remove('nadlan.lastCapture'); } catch {}
  }
}
