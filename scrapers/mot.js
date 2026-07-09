// geo.mot.gov.il — Ministry of Transport GIS viewer ("חצב").
//
// Ported from the OVER worker's scrapers/hatzav/_engine.py. The site is a
// static GovMap-based map viewer with NO data API of its own: its entire layer
// catalog ships as one static JS file, https://geo.mot.gov.il/DataNew.js
// (~400 KB, plain HTTP, no WAF/cookies/reCAPTCHA). We GET it (same-origin from
// the content script), regex-parse the layer dicts, and return one row per
// layer. Each layer's actual feature files live on data.gov.il (the Download
// URLs) — surfaced as attachments for the deep "+ קבצים" download.
//
// DataNew.js layout (one single-line assignment per entry):
//   layerInfo['KEY']    = [maintaining_body, update_quarter, description]
//   Download['KEY']     = [shp.zip, kml/kmz.zip, csv, metadata.xlsx/pdf, …]
//   downloadLayer['KEY']= true | false
//   layerByGroup['name']= ['group', …]
//   layerHebEng['name'] = 'KEY'          (Hebrew display name → code)

const SITE = 'https://geo.mot.gov.il';
const CATALOG_URL = `${SITE}/DataNew.js`;

const WANTED = new Set(['layerInfo', 'Download', 'downloadLayer', 'layerByGroup', 'layerHebEng']);
const ASSIGN_STR = /^\s*(\w+)\s*\[\s*'((?:[^'\\]|\\.)*)'\s*\]\s*=\s*'((?:[^'\\]|\\.)*)'\s*;?\s*$/;
const ASSIGN_ARR = /^\s*(\w+)\s*\[\s*'((?:[^'\\]|\\.)*)'\s*\]\s*=\s*(\[.*\])\s*;?\s*$/;
const ASSIGN_BOOL = /^\s*(\w+)\s*\[\s*'((?:[^'\\]|\\.)*)'\s*\]\s*=\s*(true|false)\b/;
const STR_LITERAL = /'((?:[^'\\]|\\.)*)'/g;
const DATASET_RE = /\/dataset\/([^/]+)\/resource\//i;
const FILE_KINDS = new Set(['shp', 'kml', 'csv', 'metadata']);

const COLUMN_ORDER = [
  'layer_key', 'layer_name', 'groups', 'maintaining_body', 'update_period',
  'description', 'downloadable', 'data_gov_il_dataset', 'download_shp_url',
  'download_kml_url', 'download_csv_url', 'download_metadata_url',
  'reference_url', 'num_files',
];

export const motScraper = {
  id: 'mot',
  label: 'משרד התחבורה — חצב (geo.mot.gov.il)',

  parseUrl(href) {
    let u;
    try { u = new URL(href); } catch { return null; }
    if ((u.hostname || '').toLowerCase() !== 'geo.mot.gov.il') return null;
    // The whole catalog is one dataset → only the portal root is trackable.
    if (!/^\/?(?:index\.html?|default\.aspx?)?\/?$/i.test(u.pathname || '')) return null;
    return {
      scraperId: 'mot',
      kind: 'mot_catalog',
      originalUrl: href,
      collectorName: 'mot_hatzav_layers',
      label: 'שכבות מוצגות — משרד התחבורה (חצב)',
    };
  },

  async fetch(parsed, { onProgress } = {}) {
    onProgress?.({ phase: 'scrape', current: 0, total: 1, message: 'אוסף את השכבות המוצגות…' });
    const catalog = await getCatalog();

    // Download ONLY the layers the user has turned on in the map — NOT the whole
    // catalog. Displayed = checked checkboxes in the layer tree (code from the
    // label's id `lbl{CODE}`).
    const activeCodes = readDisplayedCodes();
    if (!activeCodes.size) {
      throw new Error('לא נבחרו שכבות להצגה. סמן שכבות בעץ השכבות (☑) ואז נסה שוב — התוסף מוריד רק את השכבות המוצגות במפה.');
    }

    const { rows, specs } = buildLayerRows(catalog, activeCodes);
    if (!rows.length) throw new Error('השכבות המסומנות לא נמצאו בקטלוג (ייתכן שמבנה DataNew.js השתנה).');

    // Column order: stable leading columns, then any first-seen extras.
    const fields = COLUMN_ORDER.slice();
    const seen = new Set(fields);
    for (const r of rows) for (const k of Object.keys(r)) if (!seen.has(k)) { seen.add(k); fields.push(k); }

    // Attachments = the actual layer files (shp/kml/csv/metadata) on data.gov.il.
    const seenUrls = new Set();
    const attachments = [];
    for (const { url, filename, kind, layer } of specs) {
      if (seenUrls.has(url)) continue;
      seenUrls.add(url);
      attachments.push({ url, filename, kind, layer });
    }

    onProgress?.({ phase: 'scrape', current: rows.length, total: rows.length, message: `זוהו ${rows.length} שכבות (${attachments.length} קבצים)` });

    return {
      rows,
      fields,
      sourceUrl: parsed.originalUrl,
      collectorName: parsed.collectorName,
      kind: parsed.kind,
      attachments,
    };
  },
};

// ---------------------------------------------------------------------------

function unescapeJs(s) {
  return String(s).replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

function parseCatalogJs(jsText) {
  const out = {};
  for (const v of WANTED) out[v] = {};
  for (const line of jsText.split('\n')) {
    if (!line.includes("['")) continue; // cheap pre-filter
    let m = ASSIGN_STR.exec(line);
    if (m && WANTED.has(m[1])) { out[m[1]][unescapeJs(m[2])] = unescapeJs(m[3]); continue; }
    m = ASSIGN_ARR.exec(line);
    if (m && WANTED.has(m[1])) {
      const vals = [];
      let lm;
      STR_LITERAL.lastIndex = 0;
      while ((lm = STR_LITERAL.exec(m[3]))) vals.push(unescapeJs(lm[1]));
      out[m[1]][unescapeJs(m[2])] = vals;
      continue;
    }
    m = ASSIGN_BOOL.exec(line);
    if (m && WANTED.has(m[1])) { out[m[1]][unescapeJs(m[2])] = (m[3] === 'true'); continue; }
  }
  return out;
}

function classifyDownload(url) {
  const u = url.toLowerCase().split('?', 1)[0];
  if (u.includes('kml') || u.includes('kmz')) return 'kml'; // *_kml.zip before generic .zip
  if (u.endsWith('.csv')) return 'csv';
  if (u.endsWith('.zip')) return 'shp';
  if (/\.(xlsx|xls|pdf|docx?)$/.test(u)) return 'metadata';
  return 'link'; // a reference URL (data.gov.il resource page / mavat), not a file
}

function filenameOf(url) {
  try {
    const path = new URL(url).pathname || '';
    const name = path.split('/').pop() || '';
    return name ? decodeURIComponent(name) : '';
  } catch { return ''; }
}

// Catalog (DataNew.js) fetched + parsed once per page session.
let _catalogCache = null;
async function getCatalog() {
  if (_catalogCache) return _catalogCache;
  const resp = await fetch(CATALOG_URL, { credentials: 'omit' }); // same-origin static file
  if (!resp.ok) throw new Error(`קטלוג השכבות לא נטען (HTTP ${resp.status}). ייתכן שהאתר זמנית לא זמין.`);
  _catalogCache = parseCatalogJs(await resp.text());
  return _catalogCache;
}

// Which layers are CURRENTLY DISPLAYED = the checked checkboxes in the layer
// tree. Each `label.checkboxlabel` has id `lbl{CODE}` — the robust code source
// (no fragile name→layerHebEng mapping). The tree lives in the geo.mot top
// frame (the GovMap map is a separate iframe), so the scraper reads it directly.
function readDisplayedCodes() {
  const codes = new Set();
  if (typeof document === 'undefined') return codes;
  for (const lab of document.querySelectorAll('label.checkboxlabel')) {
    const m = (lab.id || '').match(/^lbl(.+)$/);
    if (!m) continue;
    const cb = resolveCheckbox(lab);
    if (cb && cb.checked) codes.add(m[1]);
  }
  return codes;
}

// What's available to download among the CURRENTLY displayed layers — drives the
// overlay picker so it offers ONLY formats/layers that actually exist.
export async function previewDisplayed() {
  const catalog = await getCatalog();
  const can = catalog.downloadLayer || {};
  const dl = catalog.Download || {};
  const codeToName = {};
  for (const [name, code] of Object.entries(catalog.layerHebEng || {})) if (code && !(code in codeToName)) codeToName[code] = name;

  const counts = { csv: 0, kml: 0, shp: 0, metadata: 0 };
  const layers = [];
  for (const code of readDisplayedCodes()) {
    const formats = new Set();
    for (const u of (dl[code] || [])) { const k = classifyDownload(u); if (FILE_KINDS.has(k)) formats.add(k); }
    const downloadable = !!can[code] && formats.size > 0;
    if (downloadable) for (const k of formats) counts[k] += 1;
    layers.push({ code, name: codeToName[code] || code, downloadable, formats: [...formats] });
  }
  layers.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  return { layers, counts, displayedCount: layers.length, downloadableCount: layers.filter(l => l.downloadable).length };
}

function resolveCheckbox(lab) {
  if (lab.htmlFor) { const x = document.getElementById(lab.htmlFor); if (x && x.type === 'checkbox') return x; }
  const inside = lab.querySelector('input[type=checkbox]');
  if (inside) return inside;
  let p = lab.previousElementSibling;
  for (let i = 0; i < 3 && p; i++) {
    if (p.matches && p.matches('input[type=checkbox]')) return p;
    const q = p.querySelector && p.querySelector('input[type=checkbox]');
    if (q) return q;
    p = p.previousElementSibling;
  }
  const par = lab.parentElement;
  if (par) { const q = par.querySelector('input[type=checkbox]'); if (q) return q; }
  return null;
}

function buildLayerRows(catalog, onlyCodes) {
  const layerInfo = catalog.layerInfo || {};
  const downloads = catalog.Download || {};
  const downloadable = catalog.downloadLayer || {};
  const byGroup = catalog.layerByGroup || {};
  const hebEng = catalog.layerHebEng || {};

  // Invert layerHebEng (Hebrew name → CODE) to CODE → first Hebrew name.
  const codeToName = {};
  for (const [name, code] of Object.entries(hebEng)) {
    if (code && !(code in codeToName)) codeToName[code] = name;
  }

  let codes = [...new Set([...Object.keys(layerInfo), ...Object.keys(downloads), ...Object.keys(downloadable)])];
  if (onlyCodes && onlyCodes.size) codes = codes.filter(c => onlyCodes.has(c));
  codes.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

  const rows = [];
  const specs = [];
  codes.forEach((code, idx) => {
    const name = codeToName[code] || '';
    const groups = name ? (byGroup[name] || []) : [];
    const info = layerInfo[code] || [];
    const urls = downloads[code] || [];

    const byKind = {};
    let datasetId = '';
    let nFiles = 0;
    for (const url of urls) {
      const kind = classifyDownload(url);
      if (!(kind in byKind)) byKind[kind] = url;
      if (FILE_KINDS.has(kind)) {
        nFiles++;
        specs.push({ idx, url, kind, layer: name || code, filename: filenameOf(url) || `layer_${idx}` });
      }
      if (!datasetId) { const mm = DATASET_RE.exec(url); if (mm) datasetId = mm[1]; }
    }

    rows.push({
      layer_key: code,
      layer_name: name,
      groups: Array.isArray(groups) ? groups.join('; ') : '',
      maintaining_body: info[0] || '',
      update_period: info[1] || '',
      description: info[2] || '',
      downloadable: downloadable[code] ? 'true' : 'false',
      data_gov_il_dataset: datasetId,
      download_shp_url: byKind.shp || '',
      download_kml_url: byKind.kml || '',
      download_csv_url: byKind.csv || '',
      download_metadata_url: byKind.metadata || '',
      reference_url: byKind.link || '',
      num_files: String(nFiles),
    });
  });

  return { rows, specs };
}
