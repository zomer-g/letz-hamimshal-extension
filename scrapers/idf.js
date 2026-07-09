// idf.il scraper — extracts document links (PDF/DOC/XLS) from allowlisted
// section pages of the Israeli Defense Force unit sites.
//
// Strategy: runs as a content script INSIDE idf.il. The user's browser has
// already cleared Incapsula's JS challenge, so same-origin fetches and DOM
// reads work without the Playwright workarounds the server-side worker uses.
//
// Allowlisted sections (mirrors govscraper/scrapers/idf/_engine.py:_IDF_ALLOWED_SECTIONS):
//   /אתרי-יחידות/הפרקליטות-הצבאית/...   Military Prosecution
//   /אתרי-יחידות/אתר-הפקודות/...         Orders portal

import { smartFetch } from '../lib/fetch-proxy.js';

const IDF_HOSTS = new Set(['idf.il', 'www.idf.il']);
const UNIT_SITES = 'אתרי-יחידות';
const ALLOWED_SECTIONS = ['הפרקליטות-הצבאית', 'אתר-הפקודות'];
const ALLOWED_PATH_PREFIXES = ALLOWED_SECTIONS.map(s => `/${UNIT_SITES}/${s}/`);
const DOC_EXT_RE = /\.(pdf|docx?|xlsx?|pptx?|rtf|odt|ods|odp)(\?|#|$)/i;

export const idfScraper = {
  id: 'idf',
  label: 'idf.il',

  parseUrl(href) {
    let u;
    try { u = new URL(href); } catch { return null; }
    const host = (u.hostname || '').toLowerCase();
    if (!IDF_HOSTS.has(host)) return null;
    const path = safeDecodeURI(u.pathname || '/');
    const matchedPrefix = ALLOWED_PATH_PREFIXES.find(p => path === p.slice(0, -1) || path.startsWith(p));
    if (!matchedPrefix) return null;
    const section = matchedPrefix.split('/')[2];
    const sectionLabel = section === 'הפרקליטות-הצבאית' ? 'פרקליטות צבאית' :
                          section === 'אתר-הפקודות' ? 'אתר הפקודות' : section;
    return {
      scraperId: 'idf',
      kind: 'idf_section',
      section,
      sectionLabel,
      originalUrl: href,
      path,
      label: `מסמכים — ${sectionLabel}`,
      collectorName: `idf_${section}`,
    };
  },

  async fetch(parsed, { onProgress } = {}) {
    onProgress?.({ phase: 'scrape', current: 0, total: 0, message: 'אוסף קישורים מעמוד IDF…' });
    const seen = new Map();
    extractDocsFromDocument(document, parsed.originalUrl, parsed.path, seen);
    onProgress?.({ phase: 'scrape', current: seen.size, total: seen.size, message: `נמצאו ${seen.size} מסמכים בעמוד הנוכחי` });

    // Best-effort: also scan child pages linked from this page that are in
    // the same section. Conservative — one level deep, hard cap on count.
    const childLinks = collectChildLinks(document, parsed.originalUrl, parsed.path);
    const MAX_CHILDREN = 25;
    const queue = childLinks.slice(0, MAX_CHILDREN);
    let scanned = 0;
    for (const childUrl of queue) {
      try {
        const resp = await smartFetch(childUrl);
        if (!resp.ok) continue;
        const html = await resp.text();
        const doc = new DOMParser().parseFromString(html, 'text/html');
        extractDocsFromDocument(doc, childUrl, parsed.path, seen);
      } catch {}
      scanned++;
      onProgress?.({
        phase: 'scrape',
        current: scanned,
        total: queue.length,
        message: `סורק עמודי משנה: ${scanned}/${queue.length} • ${seen.size} מסמכים`,
      });
    }

    const rows = [...seen.values()].map(d => ({
      title: d.title,
      url: d.url,
      extension: d.ext,
      sourcePage: d.sourcePage,
    }));

    return {
      rows,
      fields: ['title', 'extension', 'url', 'sourcePage'],
      sourceUrl: parsed.originalUrl,
      collectorName: parsed.collectorName,
      kind: parsed.kind,
      total: rows.length,
      attachments: rows.map(r => ({ url: r.url, filename: chooseFilename(r), ext: r.extension })),
      warning: null,
    };
  },
};

function safeDecodeURI(s) {
  try { return decodeURI(s); } catch { return s; }
}

function extractDocsFromDocument(doc, sourcePage, sectionPath, seen) {
  const anchors = doc.querySelectorAll('a[href]');
  for (const a of anchors) {
    const href = a.getAttribute('href');
    if (!href) continue;
    let abs;
    try {
      abs = new URL(href, sourcePage).toString();
    } catch { continue; }
    if (!isInScope(abs)) continue;
    if (!DOC_EXT_RE.test(abs.split('?')[0])) continue;
    if (seen.has(abs)) continue;
    const m = abs.split('?')[0].match(DOC_EXT_RE);
    const ext = m ? m[1].toLowerCase() : '';
    const title = (a.textContent || '').trim() ||
                  decodeURIComponent(abs.split('/').filter(Boolean).pop() || '');
    seen.set(abs, { url: abs, title, ext, sourcePage });
  }
}

function collectChildLinks(doc, currentUrl, sectionPath) {
  const out = new Set();
  for (const a of doc.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href');
    if (!href) continue;
    let abs;
    try { abs = new URL(href, currentUrl).toString(); } catch { continue; }
    if (!isInScope(abs)) continue;
    if (DOC_EXT_RE.test(abs.split('?')[0])) continue; // skip files
    // Same-section descendants only
    const p = safeDecodeURI(new URL(abs).pathname);
    if (!p.startsWith(`/${UNIT_SITES}/`)) continue;
    if (abs === currentUrl) continue;
    out.add(abs.split('#')[0]);
  }
  return [...out];
}

function isInScope(url) {
  try {
    const u = new URL(url);
    if (!IDF_HOSTS.has(u.hostname.toLowerCase())) {
      // External files like BlobFolder-on-different-host? Allow PDF/DOC anywhere
      // if linked from an idf.il page (some orders link to s3/etc).
      return DOC_EXT_RE.test(u.pathname.split('?')[0]);
    }
    const path = safeDecodeURI(u.pathname);
    return ALLOWED_PATH_PREFIXES.some(p => path.startsWith(p));
  } catch {
    return false;
  }
}

function chooseFilename(row) {
  const url = row.url;
  try {
    const last = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || '');
    if (last) return sanitize(last);
  } catch {}
  return sanitize(`${row.title || 'document'}.${row.extension || 'pdf'}`);
}

function sanitize(name) {
  return String(name).replace(/[\\\/:*?"<>|\r\n\t]+/g, '_').slice(0, 180) || 'document';
}
