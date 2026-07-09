// Cross-origin fetch proxy.
//
// Content scripts in MV3 inherit the host page's CORS context for cross-origin
// fetches, even when the extension has host_permissions for the target. The
// service worker, however, runs in the extension's own origin and IS exempt
// from CORS for hosts in its host_permissions. So: any fetch that crosses
// origin boundaries goes through the SW.
//
// Same-origin fetches stay in the content script — they need the page's CF
// cookies (which are page-context, not extension-context) for gov.il APIs
// that share an origin with the page.

const PAGE_ORIGIN = (typeof window !== 'undefined' && window.location) ? window.location.origin : '';

export async function smartFetch(url, options = {}) {
  let target;
  try {
    target = new URL(url, PAGE_ORIGIN);
  } catch {
    target = null;
  }
  const targetOrigin = target ? target.origin : '';
  const sameOrigin = targetOrigin && targetOrigin === PAGE_ORIGIN;

  if (sameOrigin || typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
    return fetch(url, { credentials: 'include', ...options });
  }

  // Route through SW. SW fetches go through the declarativeNetRequest rule that
  // rewrites Origin → https://www.gov.il, so openapi-gc's Apigee gateway accepts
  // the request (otherwise it returns 500 RF-OriginError).
  const payload = {
    url,
    method: options.method || 'GET',
    headers: options.headers || {},
    body: options.body || null,
    credentials: options.credentials || 'omit',
  };
  const resp = await chrome.runtime.sendMessage({ type: 'proxy-fetch', payload });
  if (!resp || !resp.ok) {
    throw new Error(`proxy-fetch failed: ${resp?.error || 'unknown'}`);
  }
  return new ProxyResponse(resp.body, resp.status, resp.headers);
}

// Also expose a binary variant for downloading attached files (PDFs, DOCs).
// Returns the raw bytes as Uint8Array. Routes through the SW for cross-origin
// targets so we inherit the same DNR Origin rewrite + host_permissions exemption.
export async function smartFetchBytes(url) {
  let target;
  try { target = new URL(url, PAGE_ORIGIN); } catch { target = null; }
  const sameOrigin = target && target.origin === PAGE_ORIGIN;

  if (sameOrigin || typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
    const resp = await fetch(url, { credentials: 'include' });
    if (!resp.ok) throw new Error(`fetch ${url}: HTTP ${resp.status}`);
    return new Uint8Array(await resp.arrayBuffer());
  }
  const r = await chrome.runtime.sendMessage({
    type: 'proxy-fetch-bytes',
    payload: { url, credentials: 'omit' },
  });
  if (!r || !r.ok) throw new Error(`proxy-fetch-bytes failed: ${r?.error || 'unknown'}`);
  // SW transfers as base64; decode here.
  const bin = atob(r.bodyBase64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// Like smartFetchBytes, but also returns the response's Content-Type and
// Content-Disposition — needed when a file's real extension isn't in its URL
// (e.g. Jerusalem archive items are /api/items/<GUID> served as application/pdf).
export async function smartFetchBytesMeta(url) {
  let target;
  try { target = new URL(url, PAGE_ORIGIN); } catch { target = null; }
  const sameOrigin = target && target.origin === PAGE_ORIGIN;

  if (sameOrigin || typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
    const resp = await fetch(url, { credentials: 'include' });
    if (!resp.ok) throw new Error(`fetch ${url}: HTTP ${resp.status}`);
    const bytes = new Uint8Array(await resp.arrayBuffer());
    return { bytes, contentType: resp.headers.get('content-type') || '', disposition: resp.headers.get('content-disposition') || '' };
  }
  const r = await chrome.runtime.sendMessage({ type: 'proxy-fetch-bytes', payload: { url, credentials: 'omit' } });
  if (!r || !r.ok) throw new Error(`proxy-fetch-bytes failed: ${r?.error || 'unknown'}`);
  const bin = atob(r.bodyBase64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { bytes, contentType: r.contentType || '', disposition: r.disposition || '' };
}

class ProxyResponse {
  constructor(bodyText, status, headers) {
    this._text = bodyText || '';
    this.status = status;
    this.ok = status >= 200 && status < 300;
    this._headers = headers || {};
  }
  async text() { return this._text; }
  async json() { return JSON.parse(this._text); }
  get headers() {
    const h = this._headers;
    return { get: (k) => h[String(k).toLowerCase()] || h[k] || null };
  }
}
