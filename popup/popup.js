// Cross-browser shim (Firefox: chrome→browser). No-op on Chrome.
if (typeof browser !== 'undefined' && browser !== globalThis.chrome) {
  try { globalThis.chrome = browser; } catch {}
}

try {
  const v = chrome.runtime.getManifest?.().version;
  if (v) document.getElementById('version').textContent = `v${v}`;
} catch {}

// --- tabs ------------------------------------------------------------------
document.getElementById('tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (!btn) return;
  for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t === btn);
  for (const p of document.querySelectorAll('.panel')) p.hidden = (p.id !== `panel-${btn.dataset.tab}`);
});

// --- "days since Government Decision 1933" counter (opt-in) -----------------
// Decision 1933 = the "פתוח כברירת מחדל" (open-by-default) government decision,
// adopted 30 Aug 2016.
const DECISION_1933_ISO = '2016-08-30';
const RATIONALE_URL = 'https://over.org.il/rationale';

function daysSince(iso) {
  const t = Date.parse(`${iso}T00:00:00`);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 86400000));
}

async function renderCounter() {
  const banner = document.getElementById('counter1933');
  if (!banner) return;
  const on = (await chrome.storage.local.get('counter1933'))['counter1933'] === true;
  if (!on) { banner.hidden = true; return; }
  const n = daysSince(DECISION_1933_ISO);
  document.getElementById('counterNum').textContent = n == null ? '—' : n.toLocaleString('he-IL');
  banner.href = RATIONALE_URL;
  banner.hidden = false;
}

// --- "not fully supported" warning -----------------------------------------
// Per-scraper limitations that leave the download incomplete. Users who turned
// the floating window off drive everything from this popup, so the warning has
// to live HERE too — not only in the overlay.
const SITE_LIMITS = {
  govmap: {
    title: 'שכבה זו אינה נתמכת במלואה',
    body: 'GovMap חסם את הגישה החופשית לגאומטריה המלאה. ההורדה מכאן תשמור לכל רשומה נקודת מרכז בלבד — בלי פוליגונים ובלי קווים — ושכבות גדולות עלולות לצאת איטיות או חלקיות.',
    cta: 'בדקו את השכבה ב"גרסאות לעם" ↗',
  },
};

// A loud block: what's missing, then OVER's address-based lookup
// (over.org.il/direct/<page url>) — which either opens the archived dataset or
// offers to archive it. The external-site disclosure is never optional.
async function buildLimitWarn({ title, body, cta, pageUrl }) {
  const box = document.createElement('div');
  box.className = 'limit-warn';
  box.setAttribute('role', 'alert');

  const t = document.createElement('div');
  t.className = 'lw-title';
  t.textContent = `⚠ ${title}`;

  const b = document.createElement('div');
  b.className = 'lw-body';
  b.textContent = body;

  const a = document.createElement('a');
  a.className = 'lw-cta';
  a.target = '_blank';
  a.rel = 'noreferrer';
  a.textContent = cta;
  a.title = 'גרסאות לעם — מעקב גרסאות והורדה מלאה של מאגרים ממשלתיים';
  try {
    const over = await import('../lib/over-link.js');
    a.href = over.overDirectUrl(pageUrl);
  } catch { a.href = 'https://www.over.org.il/'; }

  const ext = document.createElement('div');
  ext.className = 'lw-ext';
  const strong = document.createElement('strong');
  strong.textContent = 'הקישור מוביל לאתר חיצוני';
  ext.append(strong, ' — over.org.il ("גרסאות לעם"), אתר עצמאי שאינו חלק מהתוסף. אם המאגר כבר מאורכב שם אפשר להוריד אותו במלואו; אם לא — אפשר לבקש שם שיאורכב.');

  box.append(t, b, a, ext);
  return box;
}

// --- current page: download straight from the popup ------------------------
async function initPageCard() {
  const status = document.getElementById('pcStatus');
  const card = document.getElementById('pageCard');
  let tab;
  try { [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); } catch {}
  if (!tab || !tab.id) { card.classList.add('idle'); status.textContent = 'אין דף פעיל.'; return; }

  let res;
  try { res = await chrome.tabs.sendMessage(tab.id, { type: 'gs-popup-detect' }); } catch {}
  if (!res || !res.detected) {
    card.classList.add('idle');
    card.replaceChildren();
    const t = document.createElement('div');
    t.className = 'pc-status';
    t.textContent = 'בדף זה אין מאגר שהתוסף יודע להוריד. גלוש לאתר ממשלתי נתמך (gov.il, נדל"ן, GovMap, מנהל התכנון, צה"ל, חצב, עיריית ירושלים, הכנסת, רמ"י).';
    card.appendChild(t);
    // On a host with no content script there is no page URL to look up — the
    // extension has no "tabs" permission, so tab.url is unreadable. Then the CTA
    // is a plain link to OVER's home page, and says so rather than promising an
    // address lookup it can't perform.
    const byAddress = !!(res && res.pageUrl);
    card.appendChild(await buildLimitWarn({
      title: 'הדף הזה לא נתמך בתוסף',
      body: byAddress
        ? 'ייתכן שהמאגר שבכתובת הזו כבר מאורכב ב"גרסאות לעם" וזמין שם להורדה מלאה, כולל היסטוריית גרסאות.'
        : 'ייתכן שהמאגר שאתם מחפשים כבר מאורכב ב"גרסאות לעם" וזמין שם להורדה מלאה, כולל היסטוריית גרסאות.',
      cta: byAddress ? 'בדקו את הכתובת ב"גרסאות לעם" ↗' : 'חפשו את המאגר ב"גרסאות לעם" ↗',
      pageUrl: res && res.pageUrl,
    }));
    return;
  }

  // The extension was turned off for this site (Settings → supported sites).
  if (res.disabled) {
    card.classList.add('idle');
    card.replaceChildren();
    const t = document.createElement('div'); t.className = 'pc-status'; t.textContent = `התוסף מושבת באתר זה (${res.source}).`;
    const btn = document.createElement('button'); btn.className = 'pc-btn'; btn.textContent = 'הפעל את התוסף כאן';
    btn.style.marginTop = '10px';
    btn.addEventListener('click', async () => { await setSiteDisabled(res.scraperId, false); await renderSites(); initPageCard(); });
    card.append(t, btn);
    return;
  }

  card.classList.add('ready');
  card.replaceChildren();
  const t = document.createElement('div'); t.className = 'pc-title'; t.textContent = res.label;
  const m = document.createElement('div'); m.className = 'pc-meta'; m.textContent = `מקור: ${res.source}`;
  const btn = document.createElement('button'); btn.className = 'pc-btn';
  btn.textContent = res.oneClick ? '⬇ הורד עכשיו' : 'פתח אפשרויות הורדה';
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = res.oneClick ? 'מוריד…' : 'נפתח…';
    try { await chrome.tabs.sendMessage(tab.id, { type: 'gs-popup-download' }); } catch {}
    setTimeout(() => window.close(), 250); // hand off to the page (overlay shows progress)
  });
  const hint = document.createElement('div'); hint.className = 'pc-hint';
  hint.textContent = res.oneClick ? 'ההורדה תתחיל בדף, גם אם החלון הצף מוסתר.' : 'ייפתח חלון בחירה בדף (קטגוריות / פורמט).';
  card.append(t, m);
  // Warn BEFORE the download button when the site can't be collected in full —
  // the point is to be seen before the click, not after it.
  const limit = SITE_LIMITS[res.scraperId];
  if (limit) card.appendChild(await buildLimitWarn({ ...limit, pageUrl: res.pageUrl }));
  card.append(btn, hint);
}

// --- recent downloads ------------------------------------------------------
async function renderHistory() {
  const { history = [] } = (await chrome.runtime.sendMessage({ type: 'get-history' })) || {};
  const list = document.getElementById('history');
  list.replaceChildren();
  if (!history.length) {
    const li = document.createElement('li');
    li.textContent = 'אין הורדות אחרונות.';
    li.style.color = 'var(--gs-text-muted)';
    list.appendChild(li);
    return;
  }
  for (const entry of history) {
    const li = document.createElement('li');
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = entry.collectorName || entry.filename || 'מאגר';
    if (entry.mode === 'deep') {
      const badge = document.createElement('span');
      badge.className = 'mode-badge deep';
      badge.textContent = '+ קבצים';
      title.appendChild(badge);
    }
    const meta = document.createElement('span');
    meta.className = 'meta';
    const when = new Date(entry.at).toLocaleString('he-IL');
    const parts = [`${entry.rowCount || 0} שורות`];
    if (entry.attachmentCount) parts.push(`${entry.attachmentCount} קבצים`);
    parts.push(entry.scraperId, when);
    meta.textContent = parts.join(' • ');
    li.append(title, meta);
    list.appendChild(li);
  }
}

document.getElementById('clearHistory').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'clear-history' });
  renderHistory();
});

// --- settings: floating window ---------------------------------------------
async function initSettings() {
  const get = await chrome.storage.local.get(['overlay.enabled', 'overlay.position', 'overlay.jesterHat', 'counter1933', 'featureFlag.overOrgFallback']);

  // show/hide the floating window (default ON)
  const enabledCb = document.getElementById('overlayEnabled');
  enabledCb.checked = get['overlay.enabled'] !== false;
  enabledCb.addEventListener('change', () => chrome.storage.local.set({ 'overlay.enabled': enabledCb.checked }));

  // position (default bottom-right)
  const pos = get['overlay.position'] || 'bottom-right';
  const grid = document.getElementById('posGrid');
  const mark = (p) => { for (const b of grid.querySelectorAll('button')) b.classList.toggle('sel', b.dataset.pos === p); };
  mark(pos);
  grid.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-pos]');
    if (!b) return;
    mark(b.dataset.pos);
    chrome.storage.local.set({ 'overlay.position': b.dataset.pos });
  });

  // jester hat on the site logo (fun, off by default)
  const jh = document.getElementById('jesterHat');
  jh.checked = get['overlay.jesterHat'] === true;
  jh.addEventListener('change', () => chrome.storage.local.set({ 'overlay.jesterHat': jh.checked }));

  // "days since Decision 1933" counter (off by default)
  const ct = document.getElementById('counterToggle');
  ct.checked = get['counter1933'] === true;
  ct.addEventListener('change', async () => { await chrome.storage.local.set({ 'counter1933': ct.checked }); renderCounter(); });

  // over.org.il fallback
  const fb = document.getElementById('overOrgFallback');
  fb.checked = !!get['featureFlag.overOrgFallback'];
  fb.addEventListener('change', () => chrome.storage.local.set({ 'featureFlag.overOrgFallback': fb.checked }));
}


// --- mavat default categories ----------------------------------------------
// Keep in sync with MAVAT_CATEGORIES in scrapers/mavat.js (excluding "other").
const MAVAT_CATS = [
  { slug: 'regulations', label: 'הוראות / תקנון' },
  { slug: 'blueprint', label: 'תשריט' },
  { slug: 'appendices', label: 'נספחים' },
  { slug: 'digital', label: 'קבצים דיגיטליים' },
  { slug: 'admin', label: 'מידע מנהלי' },
  { slug: 'publication', label: 'נוסחי פרסום' },
  { slug: 'summary', label: 'קטלוג + מידע התוכנית (CSV)' },
];

async function renderMavatCats() {
  const wrap = document.getElementById('mavatCats');
  if (!wrap) return;
  const stored = (await chrome.storage.local.get('mavat.defaultCategories'))['mavat.defaultCategories'];
  const on = Array.isArray(stored) ? new Set(stored) : null; // null = all on
  wrap.replaceChildren();
  for (const c of MAVAT_CATS) {
    const label = document.createElement('label');
    label.className = 'row';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = on ? on.has(c.slug) : true;
    cb.dataset.slug = c.slug;
    cb.addEventListener('change', saveMavatCats);
    const span = document.createElement('span');
    span.textContent = c.label;
    label.append(cb, span);
    wrap.appendChild(label);
  }
}

async function saveMavatCats() {
  const slugs = [...document.querySelectorAll('#mavatCats input[type=checkbox]')]
    .filter(cb => cb.checked).map(cb => cb.dataset.slug);
  await chrome.storage.local.set({ 'mavat.defaultCategories': slugs });
}

// Default-download search terms (comma-separated). When set, the mavat default
// download keeps only files whose name contains at least one term. Read in
// content/overlay.js → runMavatDownload (useDefault path).
async function initMavatSearch() {
  const input = document.getElementById('mavatSearchTerms');
  if (!input) return;
  const cfg = await chrome.storage.local.get(['mavat.defaultSearchTerms', 'mavat.searchInCategories']);
  input.value = typeof cfg['mavat.defaultSearchTerms'] === 'string' ? cfg['mavat.defaultSearchTerms'] : '';
  input.addEventListener('input', () => {
    chrome.storage.local.set({ 'mavat.defaultSearchTerms': input.value });
  });

  // Whether the search filter also matches category / sub-category titles.
  const inCats = document.getElementById('mavatSearchInCats');
  if (inCats) {
    inCats.checked = cfg['mavat.searchInCategories'] === true;
    inCats.addEventListener('change', () => {
      chrome.storage.local.set({ 'mavat.searchInCategories': inCats.checked });
    });
  }
}

// --- Jerusalem (jlm) default download categories ---------------------------
// Keys MUST match DOC_SOURCES/BUILDING_TABLES in scrapers/jlm.js.
const JLM_CATS = [
  { key: 'archiv', label: 'מסמכי ארכיון' },
  { key: 'heiter', label: 'מסמכי היתר' },
  { key: 'teur', label: 'תיאור הבקשה (CSV)' },
  { key: 'processes', label: 'תהליכים (CSV)' },
  { key: 'hahlatot', label: 'החלטות (CSV)' },
  { key: 'tnaim', label: 'תנאים (CSV)' },
  { key: 'ktovet', label: 'כתובת (CSV)' },
  { key: 'gushim', label: 'גושים וחלקות (CSV)' },
  { key: 'sqr', label: 'סקר (CSV)' },
];

async function renderJlmCats() {
  const wrap = document.getElementById('jlmCats');
  if (!wrap) return;
  const stored = (await chrome.storage.local.get('jlm.defaultCategories'))['jlm.defaultCategories'];
  const on = Array.isArray(stored) ? new Set(stored) : null; // null = all on
  wrap.replaceChildren();
  for (const c of JLM_CATS) {
    const label = document.createElement('label');
    label.className = 'row';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = on ? on.has(c.key) : true;
    cb.dataset.key = c.key;
    cb.addEventListener('change', saveJlmCats);
    const span = document.createElement('span');
    span.textContent = c.label;
    label.append(cb, span);
    wrap.appendChild(label);
  }
}

async function saveJlmCats() {
  const keys = [...document.querySelectorAll('#jlmCats input[type=checkbox]')]
    .filter(cb => cb.checked).map(cb => cb.dataset.key);
  await chrome.storage.local.set({ 'jlm.defaultCategories': keys });
}

// --- supported sites: per-site enable/disable ------------------------------
// Keys are scraper ids (see scrapers/*.js) — the same id the detector gates on.
const SITES = [
  { id: 'govil', name: 'gov.il — מאגרי מידע ואספנים' },
  { id: 'nadlan', name: 'נדל"ן — עסקאות (רשות המסים)' },
  {
    id: 'govmap', name: 'GovMap — שכבות GIS',
    // GovMap's 2026 rebuild removed the anonymous full-geometry endpoints, so
    // the extension currently saves centroid points only (no full polygons/
    // lines) and big layers are slow/partial. OVER tracks many layers fully.
    note: '⚠ אינו נתמך במלואו: ההורדה שומרת נקודות מרכז בלבד (ללא פוליגונים/קווים) ושכבות גדולות עלולות לצאת חלקיות. כדאי לבדוק אם השכבה זמינה במלואה באתר החיצוני',
    noteLink: { href: 'https://www.over.org.il/', label: 'over.org.il ↗' },
  },
  { id: 'mavat', name: 'מנהל התכנון (mavat)' },
  { id: 'idf', name: 'צה"ל' },
  { id: 'mot', name: 'חצב — משרד התחבורה' },
  { id: 'jlm', name: 'עיריית ירושלים — רישוי בנייה' },
  { id: 'knesset', name: 'מאגר החקיקה הלאומי — הכנסת' },
  { id: 'land', name: 'רשות מקרקעי ישראל — איתור תוכניות (תב"ע)' },
];

async function getDisabledSites() {
  const v = (await chrome.storage.local.get('sites.disabled'))['sites.disabled'];
  return new Set(Array.isArray(v) ? v : []);
}

async function setSiteDisabled(id, disabled) {
  const set = await getDisabledSites();
  if (disabled) set.add(id); else set.delete(id);
  await chrome.storage.local.set({ 'sites.disabled': [...set] });
}

async function renderSites() {
  const wrap = document.getElementById('sitesList');
  if (!wrap) return;
  const disabled = await getDisabledSites();
  wrap.replaceChildren();
  for (const s of SITES) {
    const label = document.createElement('label');
    label.className = 'row';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !disabled.has(s.id); // checked = enabled
    cb.addEventListener('change', () => setSiteDisabled(s.id, !cb.checked));
    const span = document.createElement('span');
    span.textContent = s.name;
    label.append(cb, span);
    wrap.appendChild(label);
    if (s.note) {
      const note = document.createElement('div');
      note.className = 'tag site-note';
      note.textContent = s.note + ' ';
      if (s.noteLink) {
        const a = document.createElement('a');
        a.href = s.noteLink.href;
        a.target = '_blank';
        a.rel = 'noreferrer';
        a.textContent = s.noteLink.label;
        note.appendChild(a);
      }
      wrap.appendChild(note);
    }
  }
}

initPageCard();
renderHistory();
initSettings();
renderMavatCats();
initMavatSearch();
renderJlmCats();
renderSites();
renderCounter();
