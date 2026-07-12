// MV3 service worker — message router + downloads.
//
// The actual scraping runs inside the content script (same-origin fetch
// reuses the user's Cloudflare cookies). This worker handles:
//   - proxy cross-origin fetches for the allowlisted gov.il API hosts only
//     (the SW is CORS-exempt for host_permissions; content scripts are not)
//   - forward finished blob downloads to chrome.downloads
//   - keep a small history in chrome.storage.local
//
// SECURITY MODEL (see CWS_SUBMISSION_PLAN.md, findings 1/3/4):
//   - Every message is accepted only from THIS extension's own content scripts
//     running on one of our matched gov hosts (validateSender).
//   - proxy-fetch / proxy-fetch-bytes refuse any URL whose host isn't on
//     PROXY_HOST_ALLOWLIST, and never forward the user's cookies cross-origin
//     (credentials forced to 'omit'). This prevents the extension from being
//     used as an open relay/DDoS amplifier against arbitrary servers
//     (including over.org.il) from a hostile/injected script on a gov page.
//   - downloads accept only blob: URLs minted by our own content script.

// Cross-browser shim: Firefox exposes promise-based APIs under `browser`; alias
// chrome→browser so our `await chrome.*` code runs unchanged. No-op on Chrome.
if (typeof browser !== 'undefined' && browser !== globalThis.chrome) {
  try { globalThis.chrome = browser; } catch {}
}

const HISTORY_KEY = 'history';
const HISTORY_MAX = 50;

// Hosts the SW is allowed to fetch on behalf of a content script. These are
// exactly the gov.il API endpoints the scrapers legitimately call. Note that
// over.org.il is deliberately NOT here — the (flagged-off) dispatch client
// calls it directly from the content script, never through this proxy.
const PROXY_HOST_ALLOWLIST = new Set([
  'api.nadlan.gov.il',
  'www.govmap.gov.il',
  'openapi-gc.digital.gov.il',
  'www.gov.il',
  'idf.il',
  'www.idf.il',
  'data.gov.il', // geo.mot.gov.il (חצב) layer files live on data.gov.il (open CKAN)
  'fs.knesset.gov.il', // Knesset legislation protocol/document files (anonymous, no ACAO)
]);

// Whole families of official gov.il open-data API gateways. Many gov.il
// DynamicCollectors point at a per-ministry host under *.openapi.gov.il (e.g.
// pub-justice.openapi.gov.il for the appraiser-decisions collector), so we
// allow the suffix rather than enumerating every ministry subdomain.
// Jerusalem municipality building-licensing (ykpubdata): the data API
// (jerbasicserviceapi) is fetched directly (ACAO:*), but each document's bytes
// (urlDoc, on a jerusalem.muni.il doc server) are downloaded through the SW
// proxy. Suffix-allow the whole muni domain rather than guessing the doc host.
const PROXY_HOST_SUFFIX_ALLOWLIST = ['.openapi.gov.il', '.jerusalem.muni.il'];

// Hosts whose pages may legitimately host our content scripts (mirrors
// manifest.content_scripts.matches). A message is only honored if it comes
// from a tab on one of these.
const SENDER_HOST_ALLOWLIST = new Set([
  'www.gov.il',
  'www.nadlan.gov.il',
  'www.govmap.gov.il',
  'www.idf.il',
  'idf.il',
  'mavat.iplan.gov.il',
  'geo.mot.gov.il',
  'ykpubdata.jerusalem.muni.il',
  'main.knesset.gov.il',
]);

function validateSender(sender) {
  // Must be this very extension (not another extension / external page).
  if (!sender || sender.id !== chrome.runtime.id) return false;
  // Must originate from one of our content-script tabs.
  const url = sender.tab && sender.tab.url;
  if (!url) return false;
  try {
    return SENDER_HOST_ALLOWLIST.has(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
}

function hostAllowed(url) {
  try {
    const h = new URL(url).hostname.toLowerCase();
    if (PROXY_HOST_ALLOWLIST.has(h)) return true;
    return PROXY_HOST_SUFFIX_ALLOWLIST.some((suf) => h.endsWith(suf));
  } catch {
    return false;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return;

  // Reject anything not from our own content scripts on our own hosts.
  if (!validateSender(sender)) {
    sendResponse({ ok: false, error: 'unauthorized sender' });
    return false;
  }

  if (msg.type === 'package-and-download') {
    handleDownload(msg.payload)
      .then(r => sendResponse({ ok: true, ...r }))
      .catch(e => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }

  if (msg.type === 'log-history') {
    handleLogHistory(msg.payload)
      .then(() => sendResponse({ ok: true }))
      .catch(e => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }

  if (msg.type === 'get-history') {
    chrome.storage.local.get(HISTORY_KEY).then(v => {
      sendResponse({ ok: true, history: v[HISTORY_KEY] || [] });
    });
    return true;
  }

  if (msg.type === 'clear-history') {
    chrome.storage.local.set({ [HISTORY_KEY]: [] }).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg.type === 'proxy-fetch') {
    handleProxyFetch(msg.payload)
      .then(r => sendResponse({ ok: true, ...r }))
      .catch(e => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }

  if (msg.type === 'proxy-fetch-bytes') {
    handleProxyFetchBytes(msg.payload)
      .then(r => sendResponse({ ok: true, ...r }))
      .catch(e => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }
});

// Hosts where we DO send the user's cookies: data.gov.il gates downloads behind
// an anti-bot WAF whose clearance is cookie-based, so a cookieless fetch always
// gets the challenge page. These are the user's own cookies, to an allowlisted
// gov open-data host, for public files they're entitled to.
const COOKIE_HOSTS = new Set(['data.gov.il']);

async function handleProxyFetchBytes({ url }) {
  if (!hostAllowed(url)) throw new Error('host not allowed');
  let cookieHost = false;
  try { cookieHost = COOKIE_HOSTS.has(new URL(url).hostname.toLowerCase()); } catch {}
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 45000);
  try {
    const resp = await fetch(url, { credentials: cookieHost ? 'include' : 'omit', signal: ctrl.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    // Anti-bot WAF challenge: an HTML page served in place of the file. The real
    // assets are zip/csv/xlsx — never text/html — so treat HTML as a failure
    // instead of saving the challenge page as a bogus "file".
    const ct = (resp.headers.get('content-type') || '').toLowerCase();
    if (ct.includes('text/html')) throw new Error('data.gov.il חוסם הורדה אוטומטית (הגנת-בוטים). פתח/י את data.gov.il בלשונית אחת (פעם אחת) כדי לפתור את האתגר, ואז נסה/י שוב.');
    const buf = new Uint8Array(await resp.arrayBuffer());
    // base64 chunked to avoid argument-count overflow on big files
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < buf.length; i += CHUNK) bin += String.fromCharCode.apply(null, buf.subarray(i, i + CHUNK));
    return { bodyBase64: btoa(bin), size: buf.length, status: resp.status, contentType: ct, disposition: resp.headers.get('content-disposition') || '' };
  } finally {
    clearTimeout(timer);
  }
}

async function handleProxyFetch({ url, method, headers, body }) {
  if (!hostAllowed(url)) throw new Error('host not allowed');
  // SW is CORS-exempt for host_permissions hosts. We forward the configured
  // headers (incl. x-client-id) but NEVER the user's cookies cross-origin —
  // credentials are hard-forced to 'omit' regardless of what the caller asked.
  const init = { method: method || 'GET', credentials: 'omit' };
  if (headers && Object.keys(headers).length) init.headers = headers;
  if (body !== null && body !== undefined) init.body = body;
  // Hard timeout: a stalled upstream would otherwise hang the content-script's
  // await forever, leaving the overlay's scrapeInProgress flag stuck true so the
  // download button silently ignores every later click.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 45000);
  try {
    const resp = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await resp.text();
    const respHeaders = {};
    for (const [k, v] of resp.headers.entries()) respHeaders[k.toLowerCase()] = v;
    return { status: resp.status, body: text, headers: respHeaders };
  } finally {
    clearTimeout(timer);
  }
}

async function handleDownload({ filename, url }) {
  if (!url || !filename) throw new Error('missing url/filename');
  // Only accept blob: URLs minted by our own content script — never an
  // arbitrary http(s)/data URL that a hostile page could use to trigger a
  // silent drive-by download.
  if (!/^blob:/i.test(url)) throw new Error('download url must be a blob: URL');
  const downloadId = await chrome.downloads.download({
    url,
    filename,
    saveAs: false,
  });
  return { downloadId, filename };
}

async function handleLogHistory(entry) {
  const { [HISTORY_KEY]: existing = [] } = await chrome.storage.local.get(HISTORY_KEY);
  const next = [entry, ...existing].slice(0, HISTORY_MAX);
  await chrome.storage.local.set({ [HISTORY_KEY]: next });
}
