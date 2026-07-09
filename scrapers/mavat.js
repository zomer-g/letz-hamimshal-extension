// mavat.iplan.gov.il — Planning Administration (מנהל התכנון) plan documents.
//
// A plan page is an Angular SPA that loads everything via one XHR
// (GET /rest/api/SV4/1?mid={mid}&guid=0). content/mavat-inject.js (MAIN world,
// document_start) captures that response into a DOM bridge; here we read it to
// extract the plan metadata + the categorized document inventory.
//
// DOWNLOADS — important: mavat gates every data/file API behind reCAPTCHA v3.
// An HTTP interceptor calls reCaptchaService.getRecaptchaToken() and injects a
// fresh token into the body of every request to /rest/api/SV4/1 and
// /rest/api/{zip}Attacments. So the bytes CANNOT be fetched by building a URL —
// without a token the server returns 404. The ONLY legitimate way to download
// is to click mavat's OWN per-category "הורדת קבצים ב ZIP" control: the site
// then generates the token itself and serves the ZIP natively. The overlay runs
// in the ISOLATED world but shares the page DOM, so it can click that control
// (clickNativeSection below); the click fires the page's own MAIN-world handler
// → POST /rest/api/zipAttacments (with the site's token) → native browser
// download of "{planNumber}_{category}.zip". We never mint or forge a token.

const BRIDGE_ID = '__gs_mavat_bridge';

// Normalized categories. Order matters: categoryForLabel returns the first
// matching slug, so list more-specific buckets before broader ones.
export const MAVAT_CATEGORIES = [
  { slug: 'regulations', label: 'הוראות / תקנון', re: /תקנון|הוראות/ },
  { slug: 'blueprint', label: 'תשריט', re: /תשריט/ },
  { slug: 'appendices', label: 'נספחים', re: /נספח/ },
  { slug: 'digital', label: 'קבצים דיגיטליים', re: /דיגיטל|kml|gis|shp|dwg/i },
  { slug: 'admin', label: 'מידע מנהלי', re: /מנהלי|פרוטוקול|החלט|דיון|בקשה|תצהיר|חוו"?ד|חוות.?דעת/ },
  { slug: 'publication', label: 'נוסחי פרסום', re: /פרסום|נוסח|עיתון|רשומות|ילקוט/ },
  { slug: 'other', label: 'מסמכים נוספים', re: null }, // fallback
];

function categoryForLabel(text) {
  const t = String(text || '');
  for (const c of MAVAT_CATEGORIES) if (c.re && c.re.test(t)) return c.slug;
  return 'other';
}

// Categorize a rsPlanDocsGen item. The authoritative signal is CAT_C_TITLE
// (the granular bucket — "הוראות"/"תשריט"/"נספחים"/"קבצים דיגיטלים" — which is
// exactly what the page's accordion sections are named), then CAT_A/B/D; only
// fall back to DOC_NAME last (it can be misleading, e.g. an appendix named
// "נספח/ הוראות בינוי" must NOT be classed as regulations).
function categorizeGenDoc(d) {
  for (const field of [d.CAT_C_TITLE, d.CAT_A_TITLE, d.CAT_B_TITLE, d.CAT_D_TITLE]) {
    const slug = categoryForLabel(field);
    if (slug !== 'other') return slug;
  }
  return categoryForLabel(d.DOC_NAME);
}
function categoryMeta(slug) {
  return MAVAT_CATEGORIES.find(c => c.slug === slug) || MAVAT_CATEGORIES[MAVAT_CATEGORIES.length - 1];
}
export function categorySlugLabel(slug) {
  return categoryMeta(slug).label;
}

export const mavatScraper = {
  id: 'mavat',
  label: 'מנהל התכנון (mavat)',

  parseUrl(href) {
    let u;
    try { u = new URL(href); } catch { return null; }
    if ((u.hostname || '').toLowerCase() !== 'mavat.iplan.gov.il') return null;
    const m = u.pathname.match(/\/SV4\/\d+\/(\d+)/i); // /SV4/{ver}/{mid}/{tab}
    if (!m) return null;
    return {
      scraperId: 'mavat',
      kind: 'mavat_plan',
      mid: m[1],
      originalUrl: href,
      collectorName: `mavat_${m[1]}`,
      label: `תוכנית (mavat) — ${m[1]}`,
    };
  },

  async fetch(parsed, { onProgress } = {}) {
    onProgress?.({ phase: 'wait', current: 0, total: 0, message: 'טוען את נתוני התוכנית…' });

    const json = await waitForBridge(parsed.mid, 30000, (elapsed) => {
      onProgress?.({ phase: 'wait', current: Math.round(elapsed / 1000), total: 30, message: 'ממתין שדף התוכנית יטען את הנתונים…' });
    });

    if (!json) {
      const diag = readDiagnostics();
      throw new Error(diag.hookPresent
        ? 'לא נתפסו נתוני תוכנית. רענן את הדף (F5) ונסה שוב.'
        : 'הוק הלכידה לא הותקן בדף. רענן (F5) ונסה שוב.');
    }

    // --- plan metadata (real planDetails schema) ---
    const pd = json.planDetails || {};
    const planNumber = String(pd.NUMB || parsed.mid).trim();
    const planTitle = String(pd.E_NAME || '').trim();
    const planName = planNumber + (planTitle ? ` — ${planTitle}` : '');
    const planMeta = {
      number: planNumber,
      title: planTitle,
      type: String(pd.ENTITY_SUBTYPE || pd.DESCRIPTOR || '').trim(),
      status: String(json.shortStatus || json.mainStatus || '').trim(),
      statusDate: String(json.statusDate || pd.LAST_UPDATE_DATE || '').trim(),
      permissions: String(pd.PERMISSIONS || '').trim(),
      goals: stripHtml(pd.GOALS),
      instructions: stripHtml(pd.INSTRACTIONS),
      edition: String(pd.EDITION || '').trim(),
    };

    // --- document inventory (rsPlanDocsGen is the richest source) ---
    const gen = Array.isArray(json.rsPlanDocsGen) ? json.rsPlanDocsGen : [];
    const documents = gen.map((d) => ({
      id: d.ID,
      name: String(d.DOC_NAME || '').replace(/\s+/g, ' ').trim(),
      fileType: String(d.FILE_TYPE || '').trim().toLowerCase(),
      catA: String(d.CAT_A_TITLE || '').trim(),
      catC: String(d.CAT_C_TITLE || '').trim(),
      // full accordion path — lets the download map each captured ZIP entry back
      // to its document (mavat's ZIP entry filenames are non-informative).
      chain: [d.CAT_A_TITLE, d.CAT_B_TITLE, d.CAT_C_TITLE, d.CAT_D_TITLE].map((x) => String(x || '').trim()).filter(Boolean),
      order: Number(d.CAT_D_ORDER ?? d.CAT_C_ORDER ?? 0) || 0,
      category: categorizeGenDoc(d),
    }));

    // --- downloadable categories come from mavat's OWN per-section ZIP buttons,
    //     organized by the site's accordion hierarchy (top heading → section).
    //     Those buttons are what we can legitimately click. ---
    const sections = await findNativeSections();
    const categories = buildCategories(sections, json, documents.length);

    onProgress?.({ phase: 'scrape', current: documents.length, total: documents.length,
      message: `זוהו ${documents.length} מסמכים ב-${sections.length} קטגוריות להורדה` });

    return {
      rows: inventoryRows(documents, planMeta),
      fields: INVENTORY_FIELDS,
      sourceUrl: parsed.originalUrl,
      collectorName: sanitizePlan(planNumber),
      kind: parsed.kind,
      planName,
      planNumber,
      planMeta,
      documents,
      categories,
      attachments: [],
      _diag: documents.length ? null : { topKeys: Object.keys(json) },
    };
  },
};

// ---------------------------------------------------------------------------
// Native download driving — click mavat's own per-category ZIP control.
// The real click handler is on the INNER span.uk-text-float-link (not the
// outer div.sv4-doc-download-zip). Returns true if a control was clicked.
// ---------------------------------------------------------------------------

// Section key separator (a control char that won't appear in titles).
export const KEY_SEP = '␟';
// Top-level document headings whose accordions we open so lazy controls render.
const DOC_HEADINGS = ['מסמכי התכנית', 'מסמכי מידע מנהלי', 'נוסחי פרסום', 'התנגדויות'];

function accTitle(el) {
  return (el.textContent || '').replace(/הורדת\s*קבצים[\s\S]*$/, '').replace(/\s+/g, ' ').trim();
}

// Open (never toggle-closed) the top document accordions so their — and any
// lazily-rendered — download controls exist in the DOM.
async function expandDocSections() {
  for (const want of DOC_HEADINGS) {
    const t = [...document.querySelectorAll('.uk-accordion-title')].find(x => accTitle(x).startsWith(want));
    const li = t && (t.closest('li') || t.parentElement);
    if (t && li && !li.classList.contains('uk-open')) { t.click(); await sleep(450); }
  }
  await sleep(300);
}

// Ancestor accordion titles for a node, leaf-first.
function chainFor(el) {
  const c = [];
  let p = el;
  for (let up = 0; up < 16 && p; up++) {
    p = p.parentElement;
    if (!p) break;
    const h = p.querySelector(':scope > .uk-accordion-title, :scope > a.uk-accordion-title, :scope > .title-c');
    if (h) { const x = accTitle(h); if (x && !c.includes(x)) c.push(x); }
  }
  return c;
}

// Every per-section "הורדת קבצים ב ZIP" control. The container class varies, but
// they all hold an inner span.uk-text-float-link — that's the reliable handle.
function downloadSpans() {
  return [...document.querySelectorAll('span.uk-text-float-link')].filter(s => /הורדת\s*קבצים/.test(s.textContent || ''));
}

// Resolve a download span to its FULL place in the accordion hierarchy as a
// top-first chain (e.g. ["מסמכי התכנית","מסמכים מאושרים (מתן תוקף)","נספחים"]).
// Plans nest 1–4 levels deep; the chain captures whatever depth this button
// lives at, so the picker can mirror the real tree.
function sectionOf(span) {
  const chain = chainFor(span).reverse(); // chainFor is leaf-first
  return { chain, key: chain.join(KEY_SEP) };
}

export async function findNativeSections() {
  await expandDocSections();
  const out = [];
  const seen = new Set();
  for (const span of downloadSpans()) {
    const s = sectionOf(span);
    if (!s.chain.length || seen.has(s.key)) continue;
    seen.add(s.key);
    out.push(s);
  }
  return out;
}

// Click the download control for the section identified by `key`, expanding
// any collapsed ancestor accordions first so the control is live.
export async function clickNativeSection(key) {
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const span of downloadSpans()) {
      if (sectionOf(span).key !== key) continue;
      if (span.offsetParent == null) {
        let p = span;
        for (let up = 0; up < 16 && p; up++) {
          p = p.parentElement;
          if (!p) break;
          const h = p.querySelector(':scope > .uk-accordion-title, :scope > a.uk-accordion-title, :scope > .title-c');
          const li = h && (h.closest('li') || h.parentElement);
          if (h && li && !li.classList.contains('uk-open')) h.click();
        }
        await sleep(400);
      }
      fireClick(span);
      return true;
    }
    await expandDocSections(); // not rendered yet — expand and retry once
  }
  return false;
}

// Each doc's category path (CAT_A › B › C › D, empty levels dropped).
function genCatPaths(json) {
  return (Array.isArray(json.rsPlanDocsGen) ? json.rsPlanDocsGen : []).map((d) =>
    [d.CAT_A_TITLE, d.CAT_B_TITLE, d.CAT_C_TITLE, d.CAT_D_TITLE].map((x) => (x || '').trim()).filter(Boolean));
}
// Docs whose category path STARTS WITH this accordion chain — i.e. exactly what
// the native ZIP at that chain delivers (a CAT_C button bundles all its CAT_D).
function countForChain(paths, chain) {
  let n = 0;
  for (const p of paths) if (chain.every((c, i) => p[i] === c)) n++;
  return n;
}

// Build the picker model: one entry per downloadable section, each carrying its
// FULL hierarchy chain so the overlay can render the real (1–4 level) tree.
function buildCategories(sections, json, docCount) {
  const paths = genCatPaths(json);
  const leaf = (ch) => ch[ch.length - 1];
  const cats = sections.map((s) => ({
    key: s.key,
    chain: s.chain,
    slug: categoryForLabel(leaf(s.chain)),
    label: leaf(s.chain),
    count: countForChain(paths, s.chain),
    native: true,
  }));
  cats.push({ key: '__csv__', chain: ['מידע נוסף', 'קטלוג + מידע התוכנית (CSV)'], slug: 'summary', label: 'קטלוג + מידע התוכנית (CSV)', count: docCount, native: false });
  return cats;
}

// Documents delivered by the native ZIP at a given accordion chain — the docs
// whose category path STARTS WITH that chain (a CAT_C button bundles its CAT_D).
// Used by the download to give each captured file its real DOC_NAME.
export function docsForChain(documents, chain) {
  const ch = (chain || []).filter(Boolean);
  if (!ch.length) return [];
  return (documents || [])
    .filter((d) => Array.isArray(d.chain) && ch.every((c, i) => d.chain[i] === c))
    .sort((a, b) => (a.order || 0) - (b.order || 0));
}

function fireClick(node) {
  for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) {
    node.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
  }
}

// ---------------------------------------------------------------------------
// Inventory CSV
// ---------------------------------------------------------------------------

const INVENTORY_FIELDS = ['קטגוריה', 'שם מסמך', 'סוג קובץ', 'מספר תוכנית', 'שם תוכנית', 'סטטוס', 'מטרת התכנית', 'עיקרי הוראותיה'];

function inventoryRows(documents, meta) {
  if (!documents.length) {
    return [{ 'קטגוריה': '', 'שם מסמך': '(אין מסמכים)', 'סוג קובץ': '', 'מספר תוכנית': meta.number,
      'שם תוכנית': meta.title, 'סטטוס': meta.status, 'מטרת התכנית': meta.goals, 'עיקרי הוראותיה': meta.instructions }];
  }
  return documents.map((d, i) => ({
    'קטגוריה': categorySlugLabel(d.category),
    'שם מסמך': d.name,
    'סוג קובץ': d.fileType,
    // plan-level fields only on the first row to keep the CSV readable
    'מספר תוכנית': i === 0 ? meta.number : '',
    'שם תוכנית': i === 0 ? meta.title : '',
    'סטטוס': i === 0 ? meta.status : '',
    'מטרת התכנית': i === 0 ? meta.goals : '',
    'עיקרי הוראותיה': i === 0 ? meta.instructions : '',
  }));
}

// ---------------------------------------------------------------------------
// Bridge read
// ---------------------------------------------------------------------------

async function waitForBridge(mid, timeoutMs, onTick) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const j = readBridge(mid);
    if (j) return j;
    await sleep(400);
    onTick?.(timeoutMs - (deadline - Date.now()));
  }
  return readBridge(mid);
}

function readBridge(mid) {
  const node = document.getElementById(BRIDGE_ID);
  if (!node || !node.textContent) return null;
  let store;
  try { store = JSON.parse(node.textContent); } catch { return null; }
  if (!store || !store.raw) return null;
  if (mid && store.mid && String(store.mid) !== String(mid)) return null; // stale scope
  try { return JSON.parse(store.raw); } catch { return null; }
}

function readDiagnostics() {
  const de = document.documentElement;
  return { hookPresent: de.hasAttribute('data-gs-mavat-hits'), hits: parseInt(de.getAttribute('data-gs-mavat-hits') || '0', 10) };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripHtml(s) {
  return String(s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

export function sanitizePlan(s) {
  return String(s || 'plan').replace(/[\\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 60) || 'plan';
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
