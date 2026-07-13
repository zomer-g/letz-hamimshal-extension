// רשות מקרקעי ישראל — איתור תוכניות (תב"ע)  ·  apps.land.gov.il/TabaSearch
//
// The page is an Angular SPA whose search state (city code, block/parcel, plan
// types, statuses, dates) lives ONLY in the component — the hash-route URL
// (#/Plans) carries nothing. So we can't derive the search from the URL.
//
// DIRECT-FETCH + one small MAIN-world hook (verified live 2026-07-13):
//   • content/land-inject.js captures the LAST search request body the page's
//     own bundle POSTs to  …/TabaSearch/api//SerachPlans/GetPlans  and writes it
//     to a DOM bridge (#__gs_land_bridge). That request is stateless — no token,
//     no reCAPTCHA — so the content script REPLAYS it same-origin to get results.
//   • Response: { totalRecords, plansSmall:[ { planNumber, planId, cityText,
//     mahut, status, statusDate, documentsSet:{ takanon, tasritim[], nispachim[],
//     mmg, map, … } } ] }. Each document carries { path, info, codeMismach };
//     `path` uses Windows backslashes and resolves to a same-origin static file
//     under https://apps.land.gov.il/IturTabotData/…  (a plain GET, 200).
//   • `map` is NOT a file — it is an external old.govmap.gov.il viewer link, so
//     it rides along in the index CSV and is never downloaded.
//
// THE 150 CAP: GetPlans hard-caps at 150 rows with NO pagination (page/skip
// params are ignored), even when totalRecords is far higher (ערד → 379). To get
// EVERY plan we subdivide the query — split the 36-item planTypes list (with
// planTypesUsed:true), and where a single type still returns 150, bisect the
// statusDate range — merging by planId. `totalRecords` is unreliable once any
// filter is applied (returns 0 for filtered subsets), so the ONLY safe "this
// bucket is complete" signal is `returned < 150`.

const API_URL = 'https://apps.land.gov.il/TabaSearch/api//SerachPlans/GetPlans';
const FILE_ORIGIN = 'https://apps.land.gov.il';
const BRIDGE_ID = '__gs_land_bridge';
const PAGE_CAP = 150; // server's hard result cap per query

// The full סיווג-תוכנית code list the site sends when no type filter is set.
// Used as the subdivision axis, and as a fallback if the captured criteria have
// no planTypes for some reason.
const DEFAULT_PLAN_TYPES = [72, 21, 1, 8, 9, 10, 12, 20, 62, 31, 41, 25, 22, 2, 11, 13, 61, 32, 74, 78, 77, 73, 76, 75, 80, 79, 40, 60, 71, 70, 67, 68, 69, 30, 50, 3];

// Downloadable document types on a plan's documentsSet. `map` is intentionally
// excluded (external govmap link, not a file). `single:true` = one {path,info}
// object; otherwise an array of them.
export const DOC_TYPES = [
  { key: 'takanon', label: 'הוראות', single: true },
  { key: 'tasritim', label: 'תשריטים', single: false },
  { key: 'nispachim', label: 'נספחים', single: false },
  { key: 'mmg', label: 'ממ"ג', single: true },
];

export const landScraper = {
  id: 'land',
  label: 'רשות מקרקעי ישראל — איתור תוכניות',

  parseUrl(href) {
    let u;
    try { u = new URL(href); } catch { return null; }
    if ((u.hostname || '').toLowerCase() !== 'apps.land.gov.il') return null;
    // The app is served at /TabaSearch (hash-routed). Match the app, not a search.
    const path = `${u.pathname}${u.hash || ''}`;
    if (!/\/TabaSearch/i.test(path)) return null;
    return {
      scraperId: 'land',
      kind: 'land_plans',
      originalUrl: href,
      label: 'איתור תוכניות (רמ"י)',
      collectorName: 'land_plans',
    };
  },

  // Standard contract: collect ALL plans for the current search and expose both
  // the index rows and the full attachment list. The overlay's custom UI
  // (initLand) drives the two output modes; this exists so the scraper is
  // self-consistent and usable generically.
  async fetch(parsed, { onProgress, isCancelled } = {}) {
    const criteria = readSearchCriteria();
    if (!criteria) {
      return {
        rows: [], fields: indexFields(), attachments: [],
        sourceUrl: parsed.originalUrl, collectorName: parsed.collectorName, kind: parsed.kind,
        warning: 'בצע/י חיפוש בעמוד (למשל יישוב: ערד) ואז נסה/י שוב — התוסף מוריד את תוצאות החיפוש.',
      };
    }
    const plans = await collectAllPlans(criteria, { onProgress, isCancelled });
    const attachments = plansToAttachments(plans, DOC_TYPES.map(t => t.key));
    return {
      rows: plansToRows(plans),
      fields: indexFields(),
      attachments,
      plans,
      criteria,
      sourceUrl: parsed.originalUrl,
      collectorName: parsed.collectorName,
      kind: parsed.kind,
      total: plans.length,
      warning: plans.length ? null : 'לא נמצאו תוכניות עבור החיפוש הנוכחי.',
    };
  },
};

// --- search-criteria bridge -------------------------------------------------

// Read the last search request body captured by content/land-inject.js.
// Returns the criteria object (the GetPlans request body) or null if the user
// hasn't searched yet / the hook isn't present.
export function readSearchCriteria() {
  try {
    const node = document.getElementById(BRIDGE_ID);
    if (!node || !node.textContent) return null;
    const data = JSON.parse(node.textContent);
    const c = data && data.criteria;
    if (!c || typeof c !== 'object') return null;
    return c;
  } catch { return null; }
}

// The totalRecords the page last saw (for a quick "~N plans" hint before the
// full collection runs). May be null.
export function readReportedTotal() {
  try {
    const node = document.getElementById(BRIDGE_ID);
    if (!node || !node.textContent) return null;
    const data = JSON.parse(node.textContent);
    return typeof data.totalRecords === 'number' ? data.totalRecords : null;
  } catch { return null; }
}

// Is the MAIN-world hook installed at all? (diagnostic — the bridge node exists
// as soon as the hook runs, even before the first search.)
export function hookPresent() {
  return !!document.getElementById(BRIDGE_ID);
}

// --- querying ---------------------------------------------------------------

function baseBody(criteria) {
  return {
    planNumber: criteria.planNumber || '',
    city: criteria.city ?? '',
    gush: criteria.gush || '',
    chelka: criteria.chelka || '',
    statuses: Array.isArray(criteria.statuses) ? criteria.statuses : [],
    planTypes: [],
    planTypesUsed: false,
    fromStatusDate: '',
    toStatusDate: '',
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function postPlans(body, isCancelled) {
  if (isCancelled && isCancelled()) throw new Error('cancelled');
  const ctrl = new AbortController();
  // Abort with an explicit reason (a bare abort() surfaces as the confusing
  // "signal is aborted without reason"). Poll for user-cancel so Cancel is
  // responsive mid-request instead of waiting out the whole timeout.
  const to = setTimeout(() => { try { ctrl.abort(new DOMException('timeout', 'TimeoutError')); } catch { ctrl.abort(); } }, 60000);
  const poll = setInterval(() => { if (isCancelled && isCancelled()) { try { ctrl.abort(new DOMException('cancelled', 'AbortError')); } catch { ctrl.abort(); } } }, 400);
  try {
    const resp = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const j = await resp.json();
    return Array.isArray(j.plansSmall) ? j.plansSmall : [];
  } finally {
    clearTimeout(to);
    clearInterval(poll);
  }
}

// Run ONE base (unfiltered-by-type) query for the current criteria — used for a
// fast preview: returns { totalRecords, plans } (plans capped at 150).
export async function previewSearch(criteria, { isCancelled } = {}) {
  if (isCancelled && isCancelled()) throw new Error('cancelled');
  const ctrl = new AbortController();
  const to = setTimeout(() => { try { ctrl.abort(new DOMException('timeout', 'TimeoutError')); } catch { ctrl.abort(); } }, 60000);
  try {
    const resp = await fetch(API_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(baseBody(criteria)), signal: ctrl.signal,
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const j = await resp.json();
    return { totalRecords: typeof j.totalRecords === 'number' ? j.totalRecords : null, plans: Array.isArray(j.plansSmall) ? j.plansSmall : [] };
  } finally { clearTimeout(to); }
}

function fmtDate(d) {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${d.getFullYear()}`;
}

// Collect EVERY plan for the given criteria, defeating the 150 cap by
// subdividing on planTypes (then statusDate) and merging by planId.
export async function collectAllPlans(criteria, { onProgress, isCancelled } = {}) {
  const out = new Map();
  let queries = 0;
  let failedBuckets = 0; // buckets abandoned after all retries → results may be partial
  const MAX_QUERIES = 500; // safety backstop against a pathological split
  const MIN_SPAN_MS = 40 * 86400000; // ~40 days — stop bisecting below this

  const report = () => onProgress?.({
    phase: 'scrape', current: out.size, total: 0,
    message: `אוסף תוכניות… ${out.size}`,
    sub: `${queries} שאילתות${failedBuckets ? ` • ${failedBuckets} נסיונות חוזרים` : ''}`,
  });
  const addAll = (plans) => { for (const p of plans) if (p && p.planId != null) out.set(p.planId, p); report(); };

  // One query, retried with jittered backoff and self-paced so a burst of
  // subdivision requests doesn't trip the server's rate limit (which otherwise
  // hangs a request until our timeout aborts it). Returns the plan array, or
  // null if the bucket ultimately failed (counted, not fatal). User-cancel is
  // never retried — it rethrows immediately.
  async function run(planTypes, fromD, toD) {
    if (queries >= MAX_QUERIES) return null;
    queries++;
    const body = { ...baseBody(criteria), planTypes: planTypes || [], planTypesUsed: !!planTypes, fromStatusDate: fromD || '', toStatusDate: toD || '' };
    let lastErr;
    for (let n = 0; n < 4; n++) {
      if (isCancelled && isCancelled()) throw new Error('cancelled');
      if (n > 0) await sleep(800 * (2 ** (n - 1)) + Math.floor(Math.random() * 500)); // 0.8s, 1.6s, 3.2s backoff
      try {
        const plans = await postPlans(body, isCancelled);
        await sleep(120); // gentle pacing between successful queries
        return plans;
      } catch (e) {
        if (isCancelled && isCancelled()) throw new Error('cancelled');
        lastErr = e;
      }
    }
    failedBuckets++;
    report();
    console.warn('[GovScraper] land: bucket failed after retries', { planTypes, fromD, toD, err: String(lastErr) });
    return null; // give up on this bucket; keep the rest
  }

  async function dateBisect(planTypes, from, to) {
    if (isCancelled && isCancelled()) throw new Error('cancelled');
    if (queries >= MAX_QUERIES) return;
    const plans = await run(planTypes, fmtDate(from), fmtDate(to));
    if (plans == null) return; // failed bucket — skip
    if (plans.length < PAGE_CAP || (to - from) <= MIN_SPAN_MS) { addAll(plans); return; }
    const mid = new Date((+from + +to) / 2);
    await dateBisect(planTypes, from, mid);
    await dateBisect(planTypes, new Date(+mid + 86400000), to);
  }

  async function collect(planTypes) {
    if (isCancelled && isCancelled()) throw new Error('cancelled');
    if (queries >= MAX_QUERIES) return;
    const plans = await run(planTypes, '', '');
    if (plans == null) return; // failed bucket — skip
    if (plans.length < PAGE_CAP) { addAll(plans); return; }
    if (planTypes && planTypes.length > 1) {
      const m = Math.ceil(planTypes.length / 2);
      await collect(planTypes.slice(0, m));
      await collect(planTypes.slice(m));
    } else {
      // A single plan type still hit the cap → bisect by status date.
      await dateBisect(planTypes, new Date(1948, 0, 1), new Date(new Date().getFullYear() + 1, 0, 1));
    }
  }

  const startTypes = Array.isArray(criteria.planTypes) && criteria.planTypes.length ? criteria.planTypes.slice() : DEFAULT_PLAN_TYPES.slice();
  await collect(startTypes);
  const arr = [...out.values()];
  arr.incompleteQueries = failedBuckets; // surfaced by the overlay as a warning
  return arr;
}

// --- documents / files ------------------------------------------------------

// Turn an API `path` ("/IturTabotData\\tabot\\darom\\6006426\\גליון 1.pdf") into
// an absolute, properly-encoded same-origin URL.
export function fileUrl(path) {
  const norm = String(path || '').replace(/\\/g, '/');
  if (/^https?:\/\//i.test(norm)) return norm; // already absolute (e.g. map link)
  const enc = norm.split('/').map((seg, i) => (i === 0 ? seg : encodeURIComponent(seg))).join('/');
  return FILE_ORIGIN + (enc.startsWith('/') ? enc : '/' + enc);
}

function extOf(path) {
  const s = String(path || '').replace(/\\/g, '/').split(/[?#]/)[0];
  const m = /\.([a-z0-9]{1,6})$/i.exec(s);
  return m ? m[1].toLowerCase() : '';
}

// A file is downloadable only if it resolves to a public apps.land.gov.il file.
// A small minority of docs point at an internal host (e.g. http://rmiapplic/
// IturTabot2/…) that doesn't resolve for the public — those are listed in the
// index CSV but skipped in the ZIP (they'd only ever fail).
export function isDownloadableUrl(url) {
  return /^https?:\/\/apps\.land\.gov\.il\//i.test(String(url || ''));
}

// Flatten a plan's downloadable documents (of the requested types) into a list
// of { type, typeLabel, info, path, url, ext, codeMismach }.
export function planFiles(plan, typeKeys) {
  const ds = (plan && plan.documentsSet) || {};
  const want = new Set(typeKeys && typeKeys.length ? typeKeys : DOC_TYPES.map(t => t.key));
  const out = [];
  for (const t of DOC_TYPES) {
    if (!want.has(t.key)) continue;
    const v = ds[t.key];
    const items = t.single ? (v && v.path ? [v] : []) : (Array.isArray(v) ? v : []);
    for (const it of items) {
      if (!it || !it.path) continue;
      out.push({
        type: t.key, typeLabel: t.label,
        info: String(it.info || '').trim(),
        path: it.path, url: fileUrl(it.path), ext: extOf(it.path),
        codeMismach: it.codeMismach,
      });
    }
  }
  return out;
}

// External govmap viewer link for a plan (map "file"), if present — recorded in
// the index CSV, never downloaded.
export function planMapLink(plan) {
  const m = plan && plan.documentsSet && plan.documentsSet.map;
  return m && m.path ? fileUrl(m.path) : '';
}

function sanitizeSeg(s) {
  return String(s || '').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim();
}

// Folder name for a plan inside the ZIP — plan number, with planId appended so
// two plans that share a number never collide into one folder.
export function planFolder(plan) {
  const num = sanitizeSeg(plan.planNumber) || 'תוכנית';
  return `${num} (${plan.planId})`;
}

// Build the attachment list for a ZIP download: { url, filename } where filename
// is  "<plan folder>/<type>/<info>.<ext>".
export function plansToAttachments(plans, typeKeys) {
  const atts = [];
  for (const plan of plans) {
    const folder = planFolder(plan);
    const takenPerDir = {};
    for (const f of planFiles(plan, typeKeys)) {
      if (!isDownloadableUrl(f.url)) continue; // internal-host / external link — CSV only
      const dir = `${folder}/${sanitizeSeg(f.typeLabel)}`;
      takenPerDir[dir] = takenPerDir[dir] || [];
      const base = sanitizeSeg(f.info) || f.typeLabel || 'קובץ';
      let name = `${base}${f.ext ? '.' + f.ext : ''}`;
      // de-dup within the type folder
      if (takenPerDir[dir].includes(name)) {
        const dot = name.lastIndexOf('.');
        const b = dot > 0 ? name.slice(0, dot) : name;
        const e = dot > 0 ? name.slice(dot) : '';
        let i = 2; while (takenPerDir[dir].includes(`${b}_${i}${e}`)) i++;
        name = `${b}_${i}${e}`;
      }
      takenPerDir[dir].push(name);
      atts.push({ url: f.url, filename: `${dir}/${name}`, planId: plan.planId });
    }
  }
  return atts;
}

// --- index CSV --------------------------------------------------------------

export function indexFields() {
  return ['planNumber', 'planId', 'cityText', 'mahut', 'status', 'statusDate', 'horaot', 'tasritim', 'nispachim', 'mmg', 'mapLink'];
}

// One row per plan (summary + per-type file counts + govmap link).
export function plansToRows(plans) {
  return plans.map((p) => {
    const ds = p.documentsSet || {};
    const cnt = (v, single) => single ? (v && v.path ? 1 : 0) : (Array.isArray(v) ? v.length : 0);
    return {
      planNumber: p.planNumber || '',
      planId: p.planId,
      cityText: p.cityText || '',
      mahut: p.mahut || '',
      status: p.status || '',
      statusDate: String(p.statusDate || '').trim(),
      horaot: cnt(ds.takanon, true),
      tasritim: cnt(ds.tasritim, false),
      nispachim: cnt(ds.nispachim, false),
      mmg: cnt(ds.mmg, true),
      mapLink: planMapLink(p),
    };
  });
}

// One row per file — for the "index only" CSV that lists every downloadable file
// with a direct URL (so the user can grab any single file without the big ZIP).
export function fileIndexFields() {
  return ['planNumber', 'planId', 'cityText', 'docType', 'fileName', 'ext', 'downloadable', 'url'];
}
export function plansToFileRows(plans, typeKeys) {
  const rows = [];
  for (const p of plans) {
    for (const f of planFiles(p, typeKeys)) {
      rows.push({
        planNumber: p.planNumber || '', planId: p.planId, cityText: p.cityText || '',
        docType: f.typeLabel, fileName: f.info, ext: f.ext,
        downloadable: isDownloadableUrl(f.url) ? 1 : 0, url: f.url,
      });
    }
  }
  return rows;
}

// Same-origin file fetch → bytes (Uint8Array). Files live on apps.land.gov.il,
// so the content script fetches them directly (cookies carried, no SW proxy).
export async function fetchFileBytes(url, { isCancelled } = {}) {
  if (isCancelled && isCancelled()) throw new Error('cancelled');
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 120000);
  try {
    const resp = await fetch(url, { signal: ctrl.signal, credentials: 'include' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const buf = await resp.arrayBuffer();
    return new Uint8Array(buf);
  } finally { clearTimeout(to); }
}
