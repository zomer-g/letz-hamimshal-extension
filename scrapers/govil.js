// gov.il scraper — DynamicCollector + Traditional Collector + Content Page.
//
// Hybrid origin model:
//   - Same-origin fetches (www.gov.il page HTML, /he/api/DynamicCollector,
//     the /client-config.js shims) run directly in the content script so the
//     user's Cloudflare cookies + page session are reused.
//   - Cross-origin fetches to openapi-gc.digital.gov.il (the post-2026 home of
//     Traditional collector + Content Page APIs) go through the service worker
//     via smartFetch — content scripts inherit page CORS even with
//     host_permissions, but the SW is CORS-exempt for hosts it owns.
//
// Wire format mirrors govscraper/scrapers/govil/_fields.py exactly.

import { smartFetch } from '../lib/fetch-proxy.js';

const BASE_URL = 'https://www.gov.il';
const DYNAMIC_API_URL = `${BASE_URL}/he/api/DynamicCollector`;

const RE_DYNAMIC = /\/he\/departments?\/dynamiccollectors?\/([^/?#]+)/i;
const RE_TRADITIONAL = /\/he\/collectors?\/([^/?#]+)/i;
const RE_CONTENT_PAGE = /\/he\/pages\/([^/?#]+)/i;
const RE_GUID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
const RE_GUID_ALL = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;

const RESERVED_PARAMS = new Set(['skip', 'limit', 'from', 'officeid', 'culture', 'collectortype']);

export const govilScraper = {
  id: 'govil',
  label: 'gov.il',

  parseUrl(href) {
    let u;
    try { u = new URL(href); } catch { return null; }
    const host = (u.hostname || '').toLowerCase();
    if (!host.endsWith('gov.il')) return null;
    if (host.endsWith('nadlan.gov.il') || host.endsWith('govmap.gov.il')) return null;
    if (host.endsWith('iplan.gov.il') || host.endsWith('idf.il')) return null;
    if (host.endsWith('land.gov.il')) return null; // apps.land.gov.il → landScraper
    if (host.endsWith('mot.gov.il')) return null;
    if (host === 'data.gov.il') return null;

    const path = u.pathname.replace(/\/+$/, '');
    const params = Object.fromEntries(u.searchParams.entries());
    const officeId = params.officeId || params.OfficeId || null;

    let m = path.match(RE_DYNAMIC);
    if (m) {
      return {
        scraperId: 'govil',
        kind: 'dynamic_collector',
        collectorName: m[1],
        officeId,
        originalUrl: href,
        queryParams: params,
        label: `מאגר DynamicCollector: ${decodeURIComponent(m[1])}`,
      };
    }
    m = path.match(RE_TRADITIONAL);
    if (m) {
      return {
        scraperId: 'govil',
        kind: 'traditional_collector',
        collectorName: m[1],
        officeId,
        originalUrl: href,
        queryParams: params,
        label: `אוסף Collector: ${decodeURIComponent(m[1])}`,
      };
    }
    m = path.match(RE_CONTENT_PAGE);
    if (m) {
      return {
        scraperId: 'govil',
        kind: 'content_page',
        collectorName: m[1],
        officeId: null,
        originalUrl: href,
        queryParams: params,
        label: `דף תוכן: ${decodeURIComponent(m[1])}`,
      };
    }
    return null;
  },

  async fetch(parsed, { onProgress, pageSize = 20, isCancelled } = {}) {
    if (parsed.kind === 'dynamic_collector') {
      return scrapeDynamic(parsed, { onProgress, pageSize, isCancelled });
    }
    if (parsed.kind === 'traditional_collector') {
      return scrapeTraditional(parsed, { onProgress, pageSize, isCancelled });
    }
    if (parsed.kind === 'content_page') {
      return scrapeContentPage(parsed, { onProgress });
    }
    throw new Error(`Unknown govil kind: ${parsed.kind}`);
  },
};

// ---------------------------------------------------------------------------
// DynamicCollector
// ---------------------------------------------------------------------------

function extractDynamicConfig(pageHtml) {
  // Look for ng-init="dynamicCtrl.Events.initCtrl(..." (entity-encoded quotes).
  const ngInitMatch = pageHtml.match(/ng-init="(dynamicCtrl\.Events\.initCtrl\([^"]*)"/);
  let initText = '';
  if (ngInitMatch) {
    initText = decodeEntities(ngInitMatch[1]);
  } else {
    // Fallback: search a window around `initCtrl`
    const idx = pageHtml.indexOf('initCtrl');
    if (idx >= 0) {
      initText = decodeEntities(pageHtml.slice(idx, idx + 2000));
    }
  }
  const config = { templateId: '', resultsApiUrl: '', xClientId: '', itemsPerPage: 20, pageTitle: extractPageTitle(pageHtml), fields: [] };
  if (!initText) return config;
  config.fields = extractDynamicFields(initText);

  const guids = [...initText.matchAll(RE_GUID_ALL)].map(m => m[1]);
  const urlMatch = initText.match(/'(https?:\/\/[^']+)'/);
  if (urlMatch) config.resultsApiUrl = urlMatch[1];
  if (guids.length) {
    config.templateId = guids[0];
    if (config.resultsApiUrl && guids.length >= 2) config.xClientId = guids[1];
  }
  const ippMatch = initText.match(/',\s*(\d+)\s*,/);
  if (ippMatch) config.itemsPerPage = parseInt(ippMatch[1], 10);
  return config;
}

// The ng-init call also carries the template's field schema — a JSON array of
// { Type, Name, Label, MultiChoiseValues:{Values:[{Key,Value}]}, ResultsOrder }.
// It turns list codes ("32") into their labels and names the CSV columns the
// way the site shows them. Best-effort: [] when absent or unparsable.
function extractDynamicFields(initText) {
  const start = initText.search(/\[\s*\{\s*"Type"\s*:/);
  if (start < 0) return [];
  const end = matchingBracket(initText, start);
  if (end < 0) return [];
  try {
    const arr = JSON.parse(initText.slice(start, end + 1));
    return Array.isArray(arr) ? arr.filter(f => f && typeof f.Name === 'string' && f.Name) : [];
  } catch {
    return [];
  }
}

function matchingBracket(s, openIdx) {
  let depth = 0, inStr = false, esc = false;
  for (let i = openIdx; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') { if (--depth === 0) return i; }
  }
  return -1;
}

function decodeEntities(s) {
  return s
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function extractPageTitle(html) {
  let m = html.match(/<h1[^>]*>\s*([\s\S]+?)\s*<\/h1>/);
  if (m) {
    const text = m[1].replace(/<[^>]+>/g, '').trim();
    if (text) return text;
  }
  m = html.match(/<title[^>]*>\s*([\s\S]+?)\s*<\/title>/i);
  if (m) {
    let text = m[1].replace(/<[^>]+>/g, '').trim();
    text = text.replace(/\s*[|\-–—]\s*gov\.il.*$/i, '').trim();
    text = text.replace(/\s*[|\-–—]\s*אתר ממשלתי.*$/, '').trim();
    if (text) return text;
  }
  return '';
}

async function fetchPageHtml(url) {
  const resp = await smartFetch(url);
  if (!resp.ok) throw new Error(`Failed to fetch page HTML (${resp.status}): ${url}`);
  return resp.text();
}

async function scrapeDynamic(parsed, { onProgress, pageSize, isCancelled }) {
  // Prefer the current page's HTML (already in DOM) when running as content
  // script — saves a network round-trip and matches the user-visible page.
  let html = '';
  if (typeof document !== 'undefined' && document?.documentElement) {
    html = document.documentElement.outerHTML;
  } else {
    html = await fetchPageHtml(parsed.originalUrl);
  }
  const config = extractDynamicConfig(html);
  if (!config.templateId) {
    throw new Error('לא ניתן לחלץ DynamicTemplateID מדף ה-HTML');
  }
  if (config.pageTitle) parsed.collectorName = config.pageTitle;

  const useCustomApi = !!config.resultsApiUrl;
  const apiUrl = config.resultsApiUrl || DYNAMIC_API_URL;
  const effectivePageSize = config.itemsPerPage || pageSize || 20;

  const supportsLimit = useCustomApi && apiUrl.toLowerCase().includes('/api/police/');
  const batchLimit = supportsLimit ? 5000 : null;

  const extraFilters = {};
  for (const [k, v] of Object.entries(parsed.queryParams || {})) {
    if (RESERVED_PARAMS.has(k.toLowerCase())) continue;
    if (v === null || v === '') continue;
    extraFilters[k] = v;
  }

  const allItems = [];
  let total = 0;
  let skip = 0;
  let warning = null;

  while (true) {
    if (isCancelled?.()) { warning = 'בוטל על-ידי המשתמש'; break; }
    let body;
    let headers = { 'content-type': 'application/json' };
    if (useCustomApi) {
      body = { skip };
      if (batchLimit) body.limit = batchLimit;
      for (const [k, v] of Object.entries(extraFilters)) if (!(k in body)) body[k] = v;
      if (config.xClientId) headers['x-client-id'] = config.xClientId;
    } else {
      const queryFilters = { skip: { Query: skip } };
      for (const [k, v] of Object.entries(extraFilters)) {
        const num = Number(v);
        queryFilters[k] = { Query: Number.isFinite(num) && String(num) === String(v) ? num : v };
      }
      body = { DynamicTemplateID: config.templateId, QueryFilters: queryFilters, From: skip };
    }

    // Retry each page a few times before giving up — a single throttled/transient
    // failure should not abort a 1000+ page listing. Only break (losing the rest)
    // once retries are exhausted, since we can't safely skip a page (it would
    // desync the `skip` offset).
    let data, pageErr = null;
    for (let attemptN = 0; attemptN < 4; attemptN++) {
      if (isCancelled?.()) { pageErr = new Error('בוטל על-ידי המשתמש'); break; }
      try {
        const resp = await smartFetch(apiUrl, { method: 'POST', headers, body: JSON.stringify(body) });
        data = await safeJson(resp, `DynamicCollector skip=${skip}`);
        pageErr = null;
        break;
      } catch (e) {
        pageErr = e;
        await sleep(900 * (attemptN + 1) + Math.floor(Math.random() * 400));
      }
    }
    if (pageErr) {
      warning = `חלק מהנתונים עלולים להיות חסרים (שגיאה בעמוד ${skip}): ${pageErr.message}`;
      break;
    }

    const items = extractItems(data);
    if (skip === 0) total = extractTotal(data) ?? items.length;
    allItems.push(...items);
    onProgress?.({ phase: 'scrape', current: allItems.length, total, message: `נאספו ${allItems.length} מתוך ${total} רשומות` });

    if (!items.length || allItems.length >= total) break;
    skip += items.length;
    await sleep(total > 500 ? 500 : 200);
  }

  if (config.fields.length) return buildDynamicSchemaResult(allItems, total, parsed, warning, config.fields);
  return buildTabularResult(allItems, total, parsed, warning);
}

// ---------------------------------------------------------------------------
// Traditional Collector
// ---------------------------------------------------------------------------

async function scrapeTraditional(parsed, { onProgress, pageSize }) {
  const runtime = await loadRuntimeConfig();
  const endpoint = `${runtime.collectorApiBase}/api/DataCollector/GetResults`;
  const layoutEndpoint = `${runtime.collectorApiBase}/api/DataCollector/GetLayoutCollectorModel`;
  console.info('[GovScraper] traditional endpoint:', endpoint);

  const collectorTypes = await discoverCollectorTypes(layoutEndpoint, parsed.collectorName, runtime);
  console.info('[GovScraper] traditional collector types:', collectorTypes);
  let displayName = parsed.collectorName;
  try {
    const html = (typeof document !== 'undefined') ? document.documentElement.outerHTML : await fetchPageHtml(parsed.originalUrl);
    const title = extractPageTitle(html);
    if (title) { parsed.collectorName = title; displayName = title; }
    else { displayName = parsed.collectorName.replace(/[-_]/g, ' '); }
  } catch { /* best-effort title */ }

  const extraFilters = {};
  for (const [k, v] of Object.entries(parsed.queryParams || {})) {
    if (RESERVED_PARAMS.has(k.toLowerCase())) continue;
    if (v === null || v === '') continue;
    extraFilters[k] = v;
  }

  const limit = pageSize || 20;
  const allItems = [];
  let total = 0;
  let skip = 0;
  let warning = null;

  while (true) {
    const parts = collectorTypes.map(ct => `CollectorType=${encodeURIComponent(ct)}`);
    parts.push('culture=he');
    parts.push(`skip=${skip}`);
    parts.push(`limit=${limit}`);
    if (parsed.officeId) parts.push(`officeId=${encodeURIComponent(parsed.officeId)}`);
    for (const [k, v] of Object.entries(extraFilters)) parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
    const url = `${endpoint}?${parts.join('&')}`;

    let data;
    try {
      const headers = {};
      if (runtime.clientId) headers['x-client-id'] = runtime.clientId;
      const resp = await smartFetch(url, { headers });
      data = await safeJson(resp, `Traditional collector skip=${skip}`);
    } catch (e) {
      warning = `חלק מהנתונים עלולים להיות חסרים (שגיאה בעמוד ${skip}): ${e.message}`;
      console.error('[GovScraper] traditional GetResults failed:', e, 'url:', url);
      break;
    }
    const items = extractItems(data);
    if (skip === 0) {
      total = extractTotal(data) ?? items.length;
      console.info(`[GovScraper] first page: total=${total}, items=${items.length}, sample keys=`, items[0] ? Object.keys(items[0]) : '(empty)');
    }
    allItems.push(...items);
    onProgress?.({ phase: 'scrape', current: allItems.length, total, message: `נאספו ${allItems.length} מתוך ${total} רשומות` });
    if (!items.length || allItems.length >= total) break;
    skip += limit;
    await sleep(total > 500 ? 500 : 200);
  }

  parsed.collectorName = displayName;
  return buildTabularResult(allItems, total, parsed, warning);
}

async function discoverCollectorTypes(layoutEndpoint, collectorName, runtime) {
  try {
    const url = `${layoutEndpoint}?collectorId=${encodeURIComponent(collectorName)}&culture=he`;
    const headers = {};
    if (runtime.clientId) headers['x-client-id'] = runtime.clientId;
    const resp = await smartFetch(url, { headers });
    if (!resp.ok) {
      console.warn(`[GovScraper] GetLayoutCollectorModel HTTP ${resp.status} for collectorId=${collectorName}`);
      return [collectorName];
    }
    const text = await resp.text();
    // The layout model embeds CollectorType values in two places:
    //   1. Filter URLs as ?collectionTypes=X (matches the Python regex)
    //   2. As explicit "collectionTypes":["X","Y"] JSON arrays on category nodes
    // We look in both — the URL form alone occasionally returns empty for
    // ministries whose layout uses only category arrays.
    const urlForm = [...text.matchAll(/collectionTypes?=([^&"]+)/g)].map(m => m[1]);
    const jsonForm = [];
    const arrRe = /"collectionTypes?"\s*:\s*\[([^\]]+)\]/g;
    let am;
    while ((am = arrRe.exec(text))) {
      const inner = am[1];
      for (const sm of inner.matchAll(/"([^"]+)"/g)) jsonForm.push(sm[1]);
    }
    const all = [...urlForm, ...jsonForm];
    if (all.length) {
      const seen = new Set();
      const out = [];
      for (const t of all) if (!seen.has(t)) { seen.add(t); out.push(t); }
      console.info(`[GovScraper] discovered ${out.length} types for ${collectorName}:`, out);
      return out;
    }
    console.warn(`[GovScraper] no collectionTypes found in layout for ${collectorName} — falling back to ['${collectorName}']`);
  } catch (e) {
    console.warn('[GovScraper] discoverCollectorTypes failed:', e);
  }
  return [collectorName];
}

// ---------------------------------------------------------------------------
// Runtime config — discover collector_api_base + x-client-id from gov.il shims
// ---------------------------------------------------------------------------

let _runtimeConfigCache = null;
export async function loadRuntimeConfig() {
  if (_runtimeConfigCache) return _runtimeConfigCache;
  const cfg = {
    collectorApiBase: `${BASE_URL}/CollectorsWebApi`,
    contentPageApiBase: `${BASE_URL}/ContentPageWebApi`,
    clientId: '',
  };
  // The shim format is window['govilRunConfig'] = { ... };  — the { ... } may
  // be JSON or a JS object literal (unquoted keys, single quotes). JSON.parse
  // works on the former; for the latter we fall back to extracting individual
  // fields by regex. We never eval — CWS forbids it and MV3 blocks it anyway.
  const OBJ_RE = /window\[\s*['"]govilRunConfig['"]\s*\]\s*=\s*(\{[\s\S]+?\})\s*;/;
  for (const [path, baseKey, kind] of [
    ['/CollectorsWebApi/client-config.js', 'dataCollectorWebApi', 'collector'],
    ['/ContentpageWebApi/client-config.js', 'contentPageWebApi', 'contentpage'],
  ]) {
    try {
      const resp = await smartFetch(`${BASE_URL}${path}`);
      const text = await resp.text();
      const m = text.match(OBJ_RE);
      if (!m) {
        console.warn(`[GovScraper] runtime config (${kind}): govilRunConfig not found in ${path}`);
        continue;
      }
      const raw = m[1];
      let data = null;
      try {
        data = JSON.parse(raw);
      } catch {
        // Permissive fallback: pull each known field via regex from the raw text.
        data = looseExtract(raw, ['clientId', baseKey]);
      }
      if (data?.clientId && !cfg.clientId) cfg.clientId = String(data.clientId).trim();
      const base = String(data?.[baseKey] || '').replace(/\/$/, '');
      if (base) {
        if (kind === 'collector') cfg.collectorApiBase = base;
        else cfg.contentPageApiBase = base;
      }
      console.info(`[GovScraper] runtime config (${kind}): base=${base || '(default)'}, clientId=${cfg.clientId ? cfg.clientId.slice(0, 8) + '…' : '(none)'}`);
    } catch (e) {
      console.warn(`[GovScraper] runtime config (${kind}) failed:`, e);
    }
  }
  _runtimeConfigCache = cfg;
  return cfg;
}

function looseExtract(text, keys) {
  const out = {};
  for (const key of keys) {
    const re = new RegExp(`['"]?${key}['"]?\\s*:\\s*['"]([^'"]+)['"]`);
    const m = text.match(re);
    if (m) out[key] = m[1];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Content Page (React SPA /he/pages/{name})
// ---------------------------------------------------------------------------

async function scrapeContentPage(parsed, { onProgress }) {
  const runtime = await loadRuntimeConfig();
  const apiBase = `${runtime.contentPageApiBase}/api/content-pages`;
  const name = parsed.collectorName;
  const firstUrl = `${apiBase}/${encodeURIComponent(name)}?culture=he`;
  const headers = {};
  if (runtime.clientId) headers['x-client-id'] = runtime.clientId;

  onProgress?.({ phase: 'scrape', current: 0, total: 0, message: 'טוען דף תוכן…' });

  let first;
  try {
    const resp = await smartFetch(firstUrl, { headers });
    first = await safeJson(resp, `ContentPage ${firstUrl}`);
  } catch (e) {
    throw new Error(`טעינת דף התוכן נכשלה: ${e.message}`);
  }

  // Walk tabs
  const tabs = first?.contentMain?.sideNav?.tagItems || [];
  const rows = [];
  const seenLinks = new Set();

  const addLinksFromContent = (json, chapterLabel) => {
    const blobs = json?.contentMain?.htmlContents || [];
    for (const blob of blobs) {
      const html = blob?.sectionData || '';
      const anchorRe = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
      let m;
      while ((m = anchorRe.exec(html))) {
        let href = m[1];
        const text = m[2].replace(/<[^>]+>/g, '').trim();
        if (!href) continue;
        if (href.startsWith('/')) href = `${BASE_URL}${href}`;
        const key = `${chapterLabel}|${href}`;
        if (seenLinks.has(key)) continue;
        seenLinks.add(key);
        rows.push({ chapter: chapterLabel, title: text || href, url: href });
      }
    }
  };

  addLinksFromContent(first, 'ראשי');
  for (let i = 0; i < tabs.length; i++) {
    const tab = tabs[i];
    let chapterIdx = null;
    if (tab?.url) {
      try { chapterIdx = new URL(tab.url, BASE_URL).searchParams.get('chapterIndex'); } catch {}
    }
    if (chapterIdx == null) continue;
    const url = `${apiBase}/${encodeURIComponent(name)}?culture=he&chapterIndex=${encodeURIComponent(chapterIdx)}`;
    try {
      const resp = await smartFetch(url, { headers });
      const data = await safeJson(resp, `ContentPage tab ${chapterIdx}`);
      addLinksFromContent(data, tab.title || `פרק ${chapterIdx}`);
      onProgress?.({ phase: 'scrape', current: i + 1, total: tabs.length, message: `סורק פרקים: ${i + 1}/${tabs.length}` });
    } catch (e) {
      console.warn('[GovScraper] content tab fetch failed:', e);
    }
  }

  return {
    rows,
    fields: ['chapter', 'title', 'url'],
    sourceUrl: parsed.originalUrl,
    collectorName: extractPageTitle(typeof document !== 'undefined' ? document.documentElement.outerHTML : '') || parsed.collectorName,
    kind: parsed.kind,
    total: rows.length,
    attachments: [],
  };
}

// ---------------------------------------------------------------------------
// Helpers shared with all gov.il flavors
// ---------------------------------------------------------------------------

function extractItems(data) {
  for (const k of ['Results', 'results', 'Items', 'items', 'data', 'Data']) {
    if (Array.isArray(data?.[k])) return data[k];
  }
  if (Array.isArray(data?.result)) return data.result;
  if (data?.result && typeof data.result === 'object') return extractItems(data.result);
  if (data?.Result && typeof data.Result === 'object') return extractItems(data.Result);
  if (Array.isArray(data)) return data;
  return [];
}

function extractTotal(data) {
  for (const k of ['TotalResults', 'totalResults', 'total', 'Total', 'count']) {
    if (k in (data || {})) {
      const n = parseInt(data[k], 10);
      if (Number.isFinite(n)) return n;
    }
  }
  if (data?.result && typeof data.result === 'object') return extractTotal(data.result);
  if (data?.Result && typeof data.Result === 'object') return extractTotal(data.Result);
  return null;
}

async function safeJson(resp, what) {
  const text = await resp.text();
  const contentType = (resp.headers.get('content-type') || '').toLowerCase();
  if (!text.trim()) {
    throw new Error(`${what} returned empty body (status=${resp.status})`);
  }
  if (contentType.includes('text/html') || /^\s*<!doctype html|^\s*<html/i.test(text)) {
    if (looksLikeCfBlock(text)) {
      throw new Error(`${what} blocked by Cloudflare (status=${resp.status})`);
    }
    throw new Error(`${what} returned HTML instead of JSON (status=${resp.status})`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${what} returned non-JSON body (status=${resp.status}): ${e.message}`);
  }
}

function looksLikeCfBlock(html) {
  const lower = html.toLowerCase();
  return (
    (lower.includes('attention required') && lower.includes('cloudflare') && lower.includes('you have been blocked'))
    || lower.includes('cf-error-details')
  );
}

function buildTabularResult(items, total, parsed, warning) {
  // Flatten nested objects to readable cells. Specialized for gov.il
  // Traditional/Dynamic collector shapes — extracts `.title` from
  // `tags.metaData.X = [{title, url, ...}]` patterns into plain strings.
  const flat = items.map(it => flattenItem(it));
  const fields = orderFields(flat);
  return {
    rows: flat,
    fields,
    sourceUrl: parsed.originalUrl,
    collectorName: parsed.collectorName,
    kind: parsed.kind,
    total,
    warning,
    attachments: extractAttachmentsLite(items, parsed),
  };
}

// DynamicCollector with a parsed field schema: columns are the site's own
// labels in its display order, list codes resolve to their text, dates are
// Israel-local, rich text is plain, and every file field gets a names column
// plus a download-link column (so the CSV alone is a complete index).
function buildDynamicSchemaResult(items, total, parsed, warning, fields) {
  const ordered = fields.slice().sort((a, b) => (a.ResultsOrder ?? 999) - (b.ResultsOrder ?? 999));
  const usedLabels = new Set();
  const cols = ordered.map(f => {
    let label = String(f.Label || '').trim() || f.Name;
    if (usedLabels.has(label)) label = `${label} (${f.Name})`;
    usedLabels.add(label);
    const values = new Map();
    for (const v of f.MultiChoiseValues?.Values || []) {
      if (v && v.Key != null) values.set(String(v.Key), String(v.Value ?? ''));
    }
    return { field: f, label, values };
  });
  const known = new Set(ordered.map(f => f.Name));
  const fileLinkLabel = (label) => `${label} - קישור`;

  const rows = items.map(item => {
    const data = (item && item.Data && typeof item.Data === 'object') ? item.Data : {};
    const urlName = item?.UrlName || '';
    const row = {};
    for (const { field, label, values } of cols) {
      const v = data[field.Name];
      if (field.Type === 3 || isFileLikeArray(v)) {
        const files = Array.isArray(v) ? v.filter(e => e && typeof e === 'object') : [];
        row[label] = files.map(e => String(e.DisplayName || e.FileName || '').trim()).filter(Boolean).join(' | ');
        row[fileLinkLabel(label)] = files.map(e => fileEntryUrl(e, urlName)).filter(Boolean).join(' | ');
      } else if (values.size) {
        // Older items store the text itself (sometimes padded) or a "none"
        // placeholder instead of a code — pass text through, drop placeholders.
        const codes = Array.isArray(v) ? v : (v == null || v === '' ? [] : [v]);
        row[label] = codes
          .map(c => String(c ?? '').trim())
          .filter(c => c && !NONE_PLACEHOLDERS.has(c))
          .map(c => values.get(c) ?? c)
          .join('; ');
      } else if (field.Type === 2 && typeof v === 'string') {
        row[label] = formatIsraelDate(v);
      } else if (v && typeof v === 'object' && !Array.isArray(v) && ('DescriptionBlankTextString' in v || 'DescriptionHtmlString' in v)) {
        row[label] = String(v.DescriptionBlankTextString || htmlToPlainText(String(v.DescriptionHtmlString || ''))).trim();
      } else {
        row[label] = simplifyValue(v);
      }
    }
    // Data keys the schema doesn't describe — keep them rather than lose data.
    for (const [k, v] of Object.entries(data)) {
      if (known.has(k) || SKIP_KEYS.has(k.toLowerCase())) continue;
      row[k] = isFileLikeArray(v)
        ? v.map(e => fileEntryUrl(e, urlName)).filter(Boolean).join(' | ')
        : simplifyValue(v);
    }
    if (item?.Description) row.Description = simplifyValue(item.Description);
    row.UrlName = urlName;
    return row;
  });

  const fieldsOut = [];
  for (const { field, label } of cols) {
    fieldsOut.push(label);
    if (field.Type === 3) fieldsOut.push(fileLinkLabel(label));
  }
  const seen = new Set(fieldsOut);
  for (const r of rows) for (const k of Object.keys(r)) if (!seen.has(k)) { seen.add(k); fieldsOut.push(k); }

  return {
    rows,
    fields: fieldsOut,
    sourceUrl: parsed.originalUrl,
    collectorName: parsed.collectorName,
    kind: parsed.kind,
    total,
    warning,
    attachments: extractAttachmentsLite(items, parsed),
  };
}

const NONE_PLACEHOLDERS = new Set(['_none', '- ללא -', 'ללא']);

// "2026-08-24T21:00:00Z" → "2026-08-25" (the Israel calendar date the site
// shows); keeps the time when it isn't local midnight. Unparsable → as-is.
function formatIsraelDate(s) {
  const d = new Date(s);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(s) || Number.isNaN(d.getTime())) return s;
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(d).map(p => [p.type, p.value]));
    const date = `${parts.year}-${parts.month}-${parts.day}`;
    return parts.hour === '00' && parts.minute === '00' ? date : `${date} ${parts.hour}:${parts.minute}`;
  } catch {
    return s;
  }
}

// A DynamicCollector file entry { FileName, Extension, DisplayName } → its
// download URL. FileName is usually a bare name served from the item's blob
// folder (/BlobFolder/dynamiccollectorresultitem/<UrlName>/he/<FileName>);
// some APIs put a full URL there instead.
function fileEntryUrl(entry, urlName) {
  const fn = String(entry?.FileName || entry?.fileName || '').trim();
  if (!fn) return '';
  if (/^https?:\/\//i.test(fn)) return fn;
  if (/^\/?BlobFolder\//i.test(fn)) return `${BASE_URL}/${fn.replace(/^\//, '')}`;
  if (!urlName) return '';
  return `${BASE_URL}/BlobFolder/dynamiccollectorresultitem/${encodeURIComponent(urlName)}/he/${encodeURIComponent(fn)}`;
}

const SKIP_KEYS = new Set(['$$hashkey', 'file', 'files', 'attachments', 'fileattachments', 'filedata', 'document']);

function flattenItem(item) {
  const out = {};
  for (const [key, value] of Object.entries(item || {})) {
    if (SKIP_KEYS.has(key.toLowerCase())) continue;

    // tags.{metaData,promotedMetaData}.<field> = [{title, url, ...}]
    // → emit a single column "<field>" with comma-joined titles.
    if (key === 'tags' && value && typeof value === 'object' && !Array.isArray(value)) {
      for (const sectionVal of Object.values(value)) {
        if (!sectionVal || typeof sectionVal !== 'object') continue;
        for (const [fieldName, fieldVals] of Object.entries(sectionVal)) {
          if (Array.isArray(fieldVals)) {
            const titles = fieldVals
              .filter(v => v && typeof v === 'object' && 'title' in v)
              .map(v => String(v.title || '').trim())
              .filter(Boolean);
            if (titles.length) out[fieldName] = titles.join(', ');
          } else if (fieldVals && typeof fieldVals === 'object' && 'title' in fieldVals) {
            out[fieldName] = String(fieldVals.title || '').trim();
          }
        }
      }
      continue;
    }

    // DynamicCollector items wrap useful data under `Data`. Lift it to top level.
    if (key === 'Data' && value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [k2, v2] of Object.entries(value)) {
        if (isFileLikeArray(v2)) {
          // Files are downloaded separately; the CSV keeps their links.
          const urls = v2.map(e => fileEntryUrl(e, item.UrlName)).filter(Boolean);
          if (urls.length) out[k2] = urls.join(' | ');
          continue;
        }
        if (SKIP_KEYS.has(k2.toLowerCase())) continue;
        out[k2] = simplifyValue(v2);
      }
      continue;
    }

    out[key] = simplifyValue(value);
  }

  // Absolute URLs for any /he/... or /BlobFolder/... slug in url-shaped columns
  for (const k of ['url', 'UrlName', 'Url']) {
    if (typeof out[k] === 'string' && out[k].startsWith('/')) {
      out[k] = `${BASE_URL}${out[k]}`;
    }
  }
  return out;
}

function isFileLikeArray(v) {
  if (!Array.isArray(v) || !v.length) return false;
  return v.some(entry => entry && typeof entry === 'object' && (entry.FileName || entry.fileName));
}

function simplifyValue(v) {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) {
    if (!v.length) return '';
    // Primitive list → join
    if (v.every(x => x === null || typeof x !== 'object')) {
      return v.filter(x => x !== null && x !== undefined).join('; ');
    }
    // Array of {title} objects → extract titles
    const titles = v
      .filter(x => x && typeof x === 'object' && 'title' in x)
      .map(x => String(x.title || '').trim())
      .filter(Boolean);
    if (titles.length === v.length) return titles.join(', ');
    // Otherwise count
    return `[${v.length} פריטים]`;
  }
  if (typeof v === 'object') {
    if ('title' in v && typeof v.title === 'string') return v.title;
    return JSON.stringify(v);
  }
  if (typeof v === 'string' && /<[a-zA-Z!\/]/.test(v) && /<(p|div|li|br|table)/i.test(v)) {
    // Light HTML → plain text
    return htmlToPlainText(v);
  }
  return v;
}

function htmlToPlainText(html) {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Preferred column ordering: title/description/url first, then metadata fields, then leftovers.
const PRIORITY_FIELDS = ['title', 'Description', 'description', 'url', 'UrlName'];

function orderFields(rows) {
  const seen = new Set();
  const all = [];
  for (const row of rows) for (const k of Object.keys(row)) if (!seen.has(k)) { seen.add(k); all.push(k); }
  const priority = PRIORITY_FIELDS.filter(f => seen.has(f));
  const rest = all.filter(f => !PRIORITY_FIELDS.includes(f));
  return [...priority, ...rest];
}

// Doc extensions we package in a deep scrape.
const DOC_EXT_RE = /\.(pdf|docx?|xlsx?|pptx?|zip|csv)(\?|#|$)/i;
const DOC_EXT_BARE_RE = /^(pdf|docx?|xlsx?|pptx?|zip|csv)$/i;
// Keys whose string value is a file URL / path, a display name, or an extension.
const FILE_URL_KEY_RE = /^(file_?name|file_?url|download_?url|url|link|href|file_?path|path)$/i;
const FILE_NAME_KEY_RE = /^(display_?name|doc_?name|file_?title|title|name|caption)$/i;
const FILE_EXT_KEY_RE = /^(extension|ext|file_?type)$/i;

function extractAttachmentsLite(items, parsed) {
  // Best-effort: find downloadable files in items so the deep scrape can fetch
  // them. Handles two shapes:
  //   (1) Structured descriptors — an object with a *FileName/url field holding
  //       a URL plus an Extension/DisplayName (e.g. the justice appraiser API's
  //       Data.Document[] = [{ FileName:<url>, DisplayName, Extension:"pdf" }],
  //       where the URL itself has NO extension).
  //   (2) A bare string that is itself a doc URL (the classic BlobFolder/*.pdf).
  const out = [];
  const seen = new Set();
  const push = (rawUrl, filename, idx) => {
    const abs = /^https?:/i.test(rawUrl) ? rawUrl : `${BASE_URL}${rawUrl.startsWith('/') ? '' : '/'}${rawUrl}`;
    if (seen.has(abs)) return;
    seen.add(abs);
    out.push({
      url: abs,
      filename: filename || decodeURIComponent(abs.split('/').pop().split('?')[0] || `file_${idx}`),
      itemIndex: idx,
    });
  };

  const visit = (node, idx) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const v of node) visit(v, idx); return; }

    const entries = Object.entries(node);
    // (1) structured descriptor
    let descUrl = '', ext = '', display = '';
    for (const [k, v] of entries) {
      if (typeof v !== 'string' || !v) continue;
      if (!descUrl && FILE_URL_KEY_RE.test(k) && (/^https?:\/\//i.test(v) || /^\/?BlobFolder\//i.test(v))) descUrl = v;
      else if (!ext && FILE_EXT_KEY_RE.test(k)) ext = v.replace(/^\./, '').toLowerCase();
      else if (!display && FILE_NAME_KEY_RE.test(k) && v.trim()) display = v.trim();
    }
    if (descUrl && (DOC_EXT_RE.test(descUrl) || DOC_EXT_BARE_RE.test(ext))) {
      let fn = display || decodeURIComponent(descUrl.split('/').pop().split('?')[0] || '');
      if (ext && !/\.[a-z0-9]{1,5}$/i.test(fn)) fn += `.${ext}`;
      push(descUrl, fn, idx);
    }
    // (2) bare doc-URL strings (any key)
    for (const [, v] of entries) {
      if (typeof v === 'string' && (/^\/?BlobFolder\//i.test(v) || /^https?:\/\//i.test(v)) && DOC_EXT_RE.test(v)) {
        push(v, '', idx);
      }
    }
    // recurse into nested objects/arrays
    for (const v of Object.values(node)) if (v && typeof v === 'object') visit(v, idx);
  };

  // (3) DynamicCollector file fields holding a bare FileName — the URL is
  //     derived from the item's UrlName. Named "<UrlName> - <file>" so each
  //     file maps back to its CSV row.
  const pushBareFiles = (item, idx) => {
    const urlName = item?.UrlName;
    const data = item?.Data;
    if (!urlName || !data || typeof data !== 'object') return;
    for (const v of Object.values(data)) {
      if (!isFileLikeArray(v)) continue;
      for (const e of v) {
        const fn = String(e?.FileName || e?.fileName || '').trim();
        if (!fn || /^https?:\/\//i.test(fn) || /^\/?BlobFolder\//i.test(fn)) continue; // handled by (1)/(2)
        const url = fileEntryUrl(e, urlName);
        if (!url) continue;
        let name = fn;
        const ext = String(e.Extension || '').replace(/^\./, '');
        if (!/\.[a-z0-9]{1,5}$/i.test(name) && /^[a-z0-9]{1,5}$/i.test(ext)) name += `.${ext.toLowerCase()}`;
        push(url, `${urlName} - ${name}`, idx);
      }
    }
  };

  for (let idx = 0; idx < items.length; idx++) {
    pushBareFiles(items[idx], idx);
    visit(items[idx], idx);
  }
  return out;
}

function walk(obj, fn, path = '') {
  if (obj === null || obj === undefined) return;
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => walk(v, fn, `${path}[${i}]`));
    return;
  }
  if (typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      walk(v, fn, path ? `${path}.${k}` : k);
    }
    return;
  }
  fn(path, obj);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// --- test-only exports ------------------------------------------------------
// Pure helpers exposed for unit tests (tests/govil-transform.test.mjs). These
// are not used by the extension at runtime — exporting them has no behavioural
// effect; it only widens the module's surface for the test harness.
export const __test__ = {
  extractItems,
  extractTotal,
  flattenItem,
  simplifyValue,
  htmlToPlainText,
  extractAttachmentsLite,
  decodeEntities,
  extractDynamicConfig,
  extractPageTitle,
  orderFields,
  buildDynamicSchemaResult,
  formatIsraelDate,
  fileEntryUrl,
};
