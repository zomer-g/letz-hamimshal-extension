// עיריית ירושלים — מערכת המידע הציבורית לרישוי בנייה
// (ykpubdata.jerusalem.muni.il). The user searches by address/file number and
// gets one or more building-licensing files (תיק רישוי בנייה), each with many
// archived documents.
//
// DIRECT-FETCH path (verified live 2026-07-07 — see memory jerusalem-ykpubdata-api):
//   Data API — anonymous, stateless, ACAO:*, no reCAPTCHA/cookies:
//     POST https://jerbasicserviceapi.jerusalem.muni.il/api/Db/ExecuteGetJSON
//     body { ProcName:<int>, Cnn:"cnnGisYk", Parameters:{...} } → JSON array.
//   Documents of a file: getArchivContentData(SystemCode, TikNum) =
//     ProcName 242700452 (or 242700571 when SystemCode==="26400056"),
//     Parameters { sysId:<SystemCode>, tikNum:<"1992/0699.03"> } → rows:
//       { documentDescr (שם המסמך), urlDoc (file URL), dateIn, docExtension (often "") }.
//   File bytes: GET urlDoc — host jerarchivews.jerusalem.muni.il. IMPORTANT: the
//     archive 404s without a Referer and 403s WITH an Origin header, so the SW
//     proxy needs a DNR rule (rules.json id 3) to set Referer + strip Origin.
//     The real extension isn't in the URL (/api/items/<GUID>) → derive it from
//     the response Content-Type at download time.
//
// Hash routes (SPA): #/  #/TableData?TikNum=0&SystemCode=<c>  (address file-list)
//                    #/Details?TikNum=<file>&SystemCode=<c>&Page=<...>  (one file's docs)

import { smartFetchBytesMeta } from '../lib/fetch-proxy.js';

const HOST = 'ykpubdata.jerusalem.muni.il';
const API = 'https://jerbasicserviceapi.jerusalem.muni.il/api/Db/ExecuteGetJSON';
const CNN = 'cnnGisYk';

// getArchivContentData stored proc, keyed by SystemCode (mirrors the app).
function docProc(systemCode) {
  return systemCode === '26400056' ? 242700571 : 242700452;
}

const SYSTEM_LABELS = { '26400046': 'תיק רישוי בנייה', '26400056': 'תיק פיקוח' };
// SystemCodes that share the getArchivContentData documents contract.
const DOC_SYSTEMS = new Set(['26400046', '26400056']);

export const jlmScraper = {
  id: 'jlm',
  label: 'עיריית ירושלים — רישוי בנייה',

  parseUrl(href) {
    let u;
    try { u = new URL(href); } catch { return null; }
    if ((u.hostname || '').toLowerCase() !== HOST) return null;

    const { route, params } = parseHash(u.hash);
    const systemCode = params.get('SystemCode') || '';
    const tikNum = (params.get('TikNum') || '').trim();
    const r = route.toLowerCase();

    // A specific file's page (Details) with a real file number → download it.
    if (/details/.test(r) && tikNum && tikNum !== '0' && DOC_SYSTEMS.has(systemCode)) {
      const sysLabel = SYSTEM_LABELS[systemCode] || 'תיק';
      return {
        scraperId: 'jlm', kind: 'jlm_tik', tikNum, systemCode, originalUrl: href,
        label: `${sysLabel} ${tikNum}`,
        collectorName: `jlm_${systemCode}_${safeTik(tikNum)}`,
      };
    }

    // The address file-list (TableData): several files, each downloadable. The
    // file numbers are read from the page DOM by the overlay.
    if (/tabledata/.test(r) && DOC_SYSTEMS.has(systemCode)) {
      return {
        scraperId: 'jlm', kind: 'jlm_list', systemCode, originalUrl: href,
        label: 'רשימת תיקים — עיריית ירושלים', collectorName: 'jlm_list',
      };
    }

    // Anything else on the domain (search landing / home) → favorites-only overlay.
    return {
      scraperId: 'jlm', kind: 'jlm_home', systemCode, originalUrl: href,
      label: 'עיריית ירושלים — רישוי בנייה', collectorName: 'jlm',
    };
  },

  async fetch(parsed, { onProgress } = {}) {
    if (parsed.kind !== 'jlm_tik') {
      return { rows: [], fields: DOC_FIELDS, sourceUrl: parsed.originalUrl, collectorName: parsed.collectorName, kind: parsed.kind, total: 0, attachments: [] };
    }
    const res = await fetchTikDocuments(parsed.systemCode, parsed.tikNum, { onProgress });
    return {
      ...res,
      sourceUrl: parsed.originalUrl,
      collectorName: parsed.collectorName,
      kind: parsed.kind,
    };
  },
};

const DOC_FIELDS = ['documentDescr', 'dateIn', 'docExtension', 'urlDoc'];

// Core, reused by the details-page download AND by each file on the list page.
// Returns { rows, fields, attachments, total, warning, systemCode, tikNum }.
export async function fetchTikDocuments(systemCode, tikNum, { onProgress } = {}) {
  onProgress?.({ phase: 'scrape', current: 0, total: 0, message: `טוען מסמכים לתיק ${tikNum}…` });
  const docs = await callProc(docProc(systemCode), { sysId: systemCode, tikNum });
  const list = Array.isArray(docs) ? docs : [];

  const rows = list.map((d) => ({
    documentDescr: str(d.documentDescr),
    dateIn: str(d.dateIn || d.documentDate),
    docExtension: str(d.docExtension) || extFromUrl(d.urlDoc),
    urlDoc: str(d.urlDoc),
  }));

  const attachments = [];
  for (let i = 0; i < list.length; i++) {
    const url = str(list[i].urlDoc);
    if (!url) continue;
    attachments.push({
      url,
      descr: str(list[i].documentDescr).trim() || `מסמך_${i + 1}`,
      docExtension: str(list[i].docExtension) || extFromUrl(url), // usually "" → sniffed at download
    });
  }

  onProgress?.({ phase: 'scrape', current: list.length, total: list.length, message: `נמצאו ${list.length} מסמכים` });
  return {
    rows, fields: DOC_FIELDS, attachments, total: rows.length,
    systemCode, tikNum,
    warning: list.length ? null : 'לא נמצאו מסמכים לתיק זה.',
  };
}

// Download a document's bytes (+ its Content-Type, for extension detection).
export function fetchDocFile(url) {
  return smartFetchBytesMeta(url);
}

// POST a stored-proc call to the DB gateway (ACAO:* → direct cross-origin fetch).
async function callProc(procName, parameters) {
  const body = JSON.stringify({ ProcName: procName, Cnn: CNN, Parameters: parameters });
  const resp = await fetch(API, { method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json' }, body });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

// --- the full תיק model: document categories + per-tab data tables ----------
// The building-licensing (26400046) file's canonical tab hierarchy. Each entry
// is one proc (Parameters casing matters — verified live). Two return documents
// (urlDoc); the rest are data tables → one CSV each.

// Document categories (files with urlDoc).
const DOC_SOURCES = [
  { key: 'archiv', label: 'מסמכי ארכיון', proc: (s) => (s === '26400056' ? 242700571 : 242700452), params: (s, t) => ({ sysId: s, tikNum: t }) },
  { key: 'heiter', label: 'מסמכי היתר', proc: () => 242700628, params: (s, t) => ({ sysId: s, tikNum: t }) },
];

// Per-tab data tables (building-licensing only — other systems use other procs).
const BUILDING_TABLES = [
  { key: 'teur', label: 'תיאור הבקשה', proc: () => 242700447, params: (s, t) => ({ tikNum: t, systemCode: s }) },
  { key: 'processes', label: 'תהליכים', proc: () => 242700451, params: (s, t) => ({ SystemID: s, TikNum: t }) },
  { key: 'hahlatot', label: 'החלטות', proc: () => 242700453, params: (s, t) => ({ systemID: s, tikNum: t }) },
  { key: 'tnaim', label: 'תנאים', proc: () => 242700450, params: (s, t) => ({ TikNum: t }) },
  { key: 'ktovet', label: 'כתובת', proc: () => 242700455, params: (s, t) => ({ systemId: s, tikNum: t }) },
  { key: 'gushim', label: 'גושים וחלקות', proc: () => 242700456, params: (s, t) => ({ SystemId: s, TikNum: t }) },
  { key: 'sqr', label: 'סקר', proc: () => 242700454, params: (s, t) => ({ SystemId: s, TikNum: t }) },
];

// Fetch the whole file: every document category + every data table, in parallel.
// Returns { systemCode, tikNum, documentCategories:[{key,label,docs:[{descr,url,docExtension,dateIn}],count}],
//           dataTables:[{key,label,rows,fields,count}] }. Empty categories are kept
// (count 0) so the UI can show the full canonical hierarchy.
export async function fetchTikFull(systemCode, tikNum, { onProgress } = {}) {
  const tables = systemCode === '26400046' ? BUILDING_TABLES : [];
  const jobs = [
    ...DOC_SOURCES.map((d) => ({ type: 'docs', def: d })),
    ...tables.map((t) => ({ type: 'table', def: t })),
  ];
  let done = 0;
  onProgress?.({ current: 0, total: jobs.length, message: 'טוען את נתוני התיק…' });
  const results = await Promise.all(jobs.map(async (job) => {
    let rows = [];
    try { rows = await callProc(job.def.proc(systemCode), job.def.params(systemCode, tikNum)); }
    catch { rows = []; }
    if (!Array.isArray(rows)) rows = rows ? [rows] : [];
    done++;
    onProgress?.({ current: done, total: jobs.length, message: 'טוען את נתוני התיק…' });
    return { job, rows };
  }));

  const documentCategories = [];
  const dataTables = [];
  for (const { job, rows } of results) {
    if (job.type === 'docs') {
      const docs = rows.filter((r) => r && r.urlDoc).map((r, i) => ({
        descr: str(r.documentDescr).trim() || `מסמך_${i + 1}`,
        url: str(r.urlDoc),
        docExtension: str(r.docExtension) || extFromUrl(r.urlDoc),
        dateIn: str(r.dateIn || r.documentDate),
      }));
      documentCategories.push({ key: job.def.key, label: job.def.label, docs, count: docs.length });
    } else {
      const cleaned = rows.map(cleanRow);
      const fields = cleaned.length ? Object.keys(cleaned[0]) : [];
      dataTables.push({ key: job.def.key, label: job.def.label, rows: cleaned, fields, count: cleaned.length });
    }
  }
  return { systemCode, tikNum, documentCategories, dataTables };
}

// Flatten a data-table row for CSV: strip HTML from cell values (some fields,
// e.g. decisions' hamhahTochen, embed whole HTML documents).
function cleanRow(row) {
  const out = {};
  for (const k of Object.keys(row || {})) {
    const v = row[k];
    out[k] = (typeof v === 'string' && v.indexOf('<') >= 0) ? stripHtml(v) : v;
  }
  return out;
}
function stripHtml(s) {
  return String(s)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ').trim();
}

// --- helpers ---------------------------------------------------------------

function parseHash(hash) {
  let h = String(hash || '');
  if (h.startsWith('#')) h = h.slice(1);
  const qi = h.indexOf('?');
  const route = qi >= 0 ? h.slice(0, qi) : h;
  const query = qi >= 0 ? h.slice(qi + 1) : '';
  let params;
  try { params = new URLSearchParams(query); } catch { params = new URLSearchParams(''); }
  return { route: route || '/', params };
}

function str(v) { return v == null ? '' : String(v); }
function safeTik(t) { return str(t).replace(/[\\/:*?"<>|]+/g, '-'); }
function extFromUrl(url) {
  const s = str(url).split(/[?#]/)[0];
  const m = /\.([a-z0-9]{1,5})$/i.exec(s);
  return m ? m[1].toLowerCase() : '';
}

export { SYSTEM_LABELS, DOC_SYSTEMS };
