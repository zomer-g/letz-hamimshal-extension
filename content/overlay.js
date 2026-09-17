// Floating overlay UI. Injected by detector.js when a scrapeable page is
// detected. RTL, themed to over.org.il (teal/cream).
//
// All actual scraping runs inside this script (same-origin context). We post
// the finished result to the service worker, which triggers chrome.downloads.

(function () {
  if (window.GovScraperOverlay) return;

  let overlayEl = null;
  let scrapeInProgress = false;
  let cancelRequested = false;

  // Corner placement — driven by the user's setting (overlay.position). Cached
  // synchronously so show() can apply it without awaiting; kept live via
  // storage.onChanged so changing it in the popup repositions immediately.
  let overlayPosition = 'bottom-right';
  const POS_CLASS = { 'bottom-right': 'gs-pos-br', 'bottom-left': 'gs-pos-bl', 'top-right': 'gs-pos-tr', 'top-left': 'gs-pos-tl' };
  function applyPositionClass(rootEl) {
    if (!rootEl) return;
    rootEl.classList.remove('gs-pos-br', 'gs-pos-bl', 'gs-pos-tr', 'gs-pos-tl');
    rootEl.classList.add(POS_CLASS[overlayPosition] || 'gs-pos-br');
  }
  // "days since Government Decision 1933" counter — mirrors the popup option,
  // shown at the top of the floating window when enabled (off by default).
  const DECISION_1933_ISO = '2016-08-30';
  const RATIONALE_URL = 'https://over.org.il/rationale';
  let counterEnabled = false;
  function daysSince1933() {
    const t = Date.parse(`${DECISION_1933_ISO}T00:00:00`);
    return Number.isNaN(t) ? null : Math.max(0, Math.floor((Date.now() - t) / 86400000));
  }
  function applyCounter(rootEl) {
    const b = rootEl && rootEl.querySelector('.gs-counter');
    if (b) b.style.display = counterEnabled ? '' : 'none';
  }
  try {
    chrome.storage.local.get(['overlay.position', 'counter1933']).then((v) => {
      if (v['overlay.position']) { overlayPosition = v['overlay.position']; applyPositionClass(overlayEl); }
      counterEnabled = v['counter1933'] === true; applyCounter(overlayEl);
    });
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== 'local') return;
      if (ch['overlay.position']) {
        overlayPosition = ch['overlay.position'].newValue || 'bottom-right';
        applyPositionClass(overlayEl);
      }
      if (ch['counter1933']) { counterEnabled = ch['counter1933'].newValue === true; applyCounter(overlayEl); }
    });
  } catch {}

  const SUPPORTS_DEEP_SCRAPE = new Set(['traditional_collector', 'dynamic_collector', 'idf_section']);

  function el(tag, attrs = {}, children = []) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'className') e.className = v;
      else if (k === 'onClick') e.addEventListener('click', v);
      else e.setAttribute(k, v);
      // Note: no innerHTML path — all text is set via createTextNode below,
      // so the overlay never parses HTML strings (no XSS surface).
    }
    for (const c of [].concat(children)) {
      if (c == null) continue;
      e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return e;
  }

  // Feedback / contact address shown in the overlay.
  const CONTACT_EMAIL = 'guy@z-g.co.il';

  async function copyContact(btn) {
    const restore = (txt) => { btn.textContent = 'הועתק ✓'; setTimeout(() => { btn.textContent = txt; }, 1500); };
    try {
      await navigator.clipboard.writeText(CONTACT_EMAIL);
      restore('העתק');
    } catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = CONTACT_EMAIL;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        restore('העתק');
      } catch {}
    }
  }

  function buildContactRow() {
    const version = (chrome.runtime.getManifest && chrome.runtime.getManifest().version) || '';
    const subject = encodeURIComponent('לץ הממשל — משוב');
    const body = encodeURIComponent(`\n\n—\nגרסה: ${version}\nעמוד: ${location.href}`);
    const mailHref = `mailto:${CONTACT_EMAIL}?subject=${subject}&body=${body}`;
    const copyBtn = el('button', { className: 'gs-contact-btn', title: 'העתק כתובת' }, ['העתק']);
    copyBtn.addEventListener('click', () => copyContact(copyBtn));
    return el('div', { className: 'gs-contact' }, [
      el('span', { className: 'gs-contact-label' }, ['משוב ויצירת קשר:']),
      el('a', { className: 'gs-contact-email', href: mailHref, title: 'שלח מייל' }, [CONTACT_EMAIL]),
      copyBtn,
      el('a', { className: 'gs-contact-btn gs-contact-send', href: mailHref, title: `שלח מייל ל-${CONTACT_EMAIL}` }, ['שלח מייל']),
    ]);
  }

  function buildOverlay({ match, onDownload, onDeepDownload, onFallback, onClose, onCancel, onMavatDownload }) {
    const { scraper, parsed } = match;
    const supportsDeep = SUPPORTS_DEEP_SCRAPE.has(parsed.kind);

    const version = (chrome.runtime.getManifest && chrome.runtime.getManifest().version) || '?';
    const titleEl = el('div', { className: 'gs-title' }, [
      el('span', { className: 'gs-title-tag' }, ['מאגר זוהה']),
      el('span', { className: 'gs-title-text' }, [parsed.label || parsed.collectorName || 'מאגר']),
      el('span', { className: 'gs-title-version', title: `לץ הממשל v${version}` }, [`v${version}`]),
    ]);

    const metaEl = el('div', { className: 'gs-meta' }, [
      el('span', {}, [`מקור: ${scraper.label}`]),
      el('span', { className: 'gs-meta-sep' }, ['•']),
      el('span', {}, [`סוג: ${kindLabel(parsed.kind)}`]),
    ]);

    // Kind-specific hint shown before any scrape kicks off. For nadlan deal
    // views the user MUST scroll to the deals table first — the SPA only
    // fires /deal-data when its IntersectionObserver mounts the table, and
    // synthesized scroll events from the extension don't always trigger that.
    const NADLAN_HINT_KINDS = new Set(['neighborhood_deals', 'settlement_deals', 'street_deals']);
    const hint = NADLAN_HINT_KINDS.has(parsed.kind)
      ? el('div', { className: 'gs-hint' }, [
          'גלול בדף עד שטבלת העסקאות מופיעה, ואז לחץ ',
          el('strong', {}, ['הורד עסקאות']),
          '. ',
          el('strong', {}, ['שים לב:']),
          ' אתר נדל"ן מגביל כל היקף ל-~500–1000 עסקאות (חסימת קצב). לאזור גדול — מקד לרחוב בודד או לפרצל (גוש/חלקה) לכיסוי מלא.',
        ])
      : null;

    const progress = el('div', { className: 'gs-progress', style: 'display:none' }, [
      el('div', { className: 'gs-progress-bar' }, [el('div', { className: 'gs-progress-fill' })]),
      el('div', { className: 'gs-progress-text' }, ['']),
      el('div', { className: 'gs-progress-sub' }, ['']),
    ]);

    const isMavat = parsed.kind === 'mavat_plan';

    // mavat: a category picker (checkboxes) populated after the plan loads.
    const mavatBox = isMavat
      ? el('div', { className: 'gs-mavat', style: 'display:none' }, [])
      : null;

    // govmap: choose which output formats to download (both by default), and
    // whether to sweep only the current map view (extent) instead of the whole layer.
    const isWfs = parsed.kind === 'wfs_layer';
    let formatCsvCb = null, formatGeojsonCb = null, formatBox = null, extentViewCb = null, govmapWarn = null;
    if (isWfs) {
      formatCsvCb = el('input', { type: 'checkbox', class: 'gs-mavat-cb' });
      formatGeojsonCb = el('input', { type: 'checkbox', class: 'gs-mavat-cb' });
      formatCsvCb.checked = true;
      formatGeojsonCb.checked = true;
      extentViewCb = el('input', { type: 'checkbox', class: 'gs-mavat-cb' });
      extentViewCb.checked = false;
      formatBox = el('div', { className: 'gs-format gs-format-col' }, [
        el('div', { className: 'gs-format-row' }, [
          el('span', { className: 'gs-format-label' }, ['פורמט:']),
          el('label', { className: 'gs-format-opt' }, [formatCsvCb, el('span', {}, ['CSV'])]),
          el('label', { className: 'gs-format-opt' }, [formatGeojsonCb, el('span', {}, ['GeoJSON'])]),
        ]),
        el('label', { className: 'gs-format-opt gs-extent-opt', title: 'סורק רק את השטח הנראה כרגע במפה, לא את כל השכבה' },
          [extentViewCb, el('span', {}, ['הורד רק את תחום התצוגה (מה שרואים במסך)'])]),
      ]);
      // GovMap's 2026 rebuild killed both geometry paths (WFS + the per-feature
      // entities-geometry backfill both serve the SPA HTML shell now), so the
      // extension can only save each feature's centroid Point — no full
      // polygons/lines — and big layers are slow/partial (100-row identify cap
      // + 100k safety cap). This is a real hole in what the download gives you,
      // so it gets a full warning block ABOVE the options rather than a footnote
      // under them — and it sends the user to OVER, which archives many govmap
      // layers in full and can be asked to archive one it doesn't have.
      govmapWarn = buildUnsupportedWarn({
        title: 'שכבה זו אינה נתמכת במלואה',
        lines: [
          'GovMap חסם את הגישה החופשית לגאומטריה המלאה. ההורדה מכאן תשמור לכל רשומה נקודת מרכז בלבד — בלי פוליגונים ובלי קווים — ושכבות גדולות עלולות לצאת איטיות או חלקיות.',
        ],
        pageUrl: location.href,
        ctaLabel: 'בדקו את השכבה ב"גרסאות לעם" ↗',
      });
      // Secondary route: if the address-based lookup misses, search OVER by the
      // layer's catalog name.
      Promise.all([
        import(chrome.runtime.getURL('scrapers/govmap.js')).then(m => m.resolveLayerCaption?.(parsed.layerId)),
        import(chrome.runtime.getURL('lib/over-link.js')),
      ]).then(([caption, over]) => {
        if (!caption) return;
        govmapWarn.appendChild(el('a', {
          className: 'gs-warn-alt',
          href: over.overSearchUrl(caption),
          target: '_blank', rel: 'noreferrer',
        }, [`או חפשו לפי שם השכבה: "${caption}" ↗`]));
      }).catch(() => {});
    }

    // A loud "we can't fully collect this" block: what's missing, then a CTA to
    // OVER's address-based lookup (over.org.il/direct/<page url>) — which either
    // opens the archived dataset or offers to archive it. The external-site
    // disclosure is part of the block, never optional: OVER is a separate site,
    // not the extension.
    function buildUnsupportedWarn({ title, lines, pageUrl, ctaLabel }) {
      const cta = el('a', {
        className: 'gs-warn-cta',
        href: 'https://www.over.org.il/', // upgraded to /direct/<url> below
        target: '_blank', rel: 'noreferrer',
        title: 'גרסאות לעם — מעקב גרסאות והורדה מלאה של מאגרים ממשלתיים',
      }, [ctaLabel]);
      import(chrome.runtime.getURL('lib/over-link.js'))
        .then(over => { cta.href = over.overDirectUrl(pageUrl); })
        .catch(() => {});
      return el('div', { className: 'gs-warn', role: 'alert' }, [
        el('div', { className: 'gs-warn-title' }, ['⚠ ', title]),
        ...lines.map(t => el('div', { className: 'gs-warn-body' }, [t])),
        cta,
        el('div', { className: 'gs-warn-ext' }, [
          el('strong', {}, ['הקישור מוביל לאתר חיצוני']),
          ' — over.org.il ("גרסאות לעם"), אתר עצמאי שאינו חלק מהתוסף. אם המאגר כבר מאורכב שם אפשר להוריד אותו במלואו; אם לא — אפשר לבקש שם שיאורכב.',
        ]),
      ]);
    }

    // geo.mot (חצב): a dynamic box, populated by initMot after reading which
    // layers are displayed and what formats actually exist for them — so it
    // offers ONLY what's available, and refreshes as the user toggles layers.
    const isMot = parsed.kind === 'mot_catalog';
    const motBox = isMot ? el('div', { className: 'gs-mavat', style: 'display:none' }, []) : null;

    // עיריית ירושלים (רישוי בנייה): a favorites block on every ykpubdata page;
    // a file's details page adds a documents download; the address list page
    // renders a per-file download/favorite picker inside the box.
    const isJlm = parsed.kind === 'jlm_tik' || parsed.kind === 'jlm_list' || parsed.kind === 'jlm_home';
    const isKnesset = parsed.kind === 'knesset_bill' || parsed.kind === 'knesset_law';
    const isLand = parsed.kind === 'land_plans';
    const jlmBox = (isJlm || isKnesset || isLand) ? el('div', { className: 'gs-jlm' }, []) : null;
    // These sites drive downloads from buttons inside the box (category tree /
    // per-file / per-tik / per-search), so there is no single primary button.
    const jlmNoPrimary = isJlm || isKnesset || isLand;

    const labels = downloadLabelsForKind(parsed.kind);
    const downloadBtn = el('button', {
      className: 'gs-btn gs-btn-primary',
      onClick: onDownload,
      title: labels.primaryTooltip,
      // No single primary button on the search/home or address-list page.
      style: (isMavat || jlmNoPrimary) ? 'display:none' : '',
    }, [labels.primary]);
    const deepBtn = el('button', {
      className: 'gs-btn gs-btn-primary gs-btn-deep',
      onClick: onDeepDownload,
      title: labels.deepTooltip,
      style: (supportsDeep && !isMavat) ? '' : 'display:none',
    }, [labels.deep]);
    // mavat buttons (hidden until the picker is populated).
    // Single download button: the picker is pre-seeded from the default
    // categories + default search terms, so the checkboxes already show exactly
    // what will download. This button downloads whatever is currently checked.
    const mavatDownloadBtn = el('button', {
      className: 'gs-btn gs-btn-primary', onClick: onMavatDownload,
      title: 'מוריד את הקבצים המסומנים, מאורגנים בתיקיות לפי שם התוכנית',
      style: 'display:none',
    }, ['הורד']);
    const cancelBtn = el('button', {
      className: 'gs-btn gs-btn-secondary gs-btn-cancel',
      onClick: onCancel,
      style: 'display:none',
    }, ['בטל']);
    const fallbackBtn = el('button', { className: 'gs-btn gs-btn-secondary', onClick: onFallback, style: 'display:none' }, [
      'שלח לעיבוד חיצוני',
    ]);
    const closeBtn = el('button', { className: 'gs-close', onClick: onClose, title: 'סגור' }, ['×']);

    const _d = daysSince1933();
    const counterBanner = el('a', {
      className: 'gs-counter',
      href: RATIONALE_URL, target: '_blank', rel: 'noreferrer',
      title: 'החלטת ממשלה 1933 — רציונל: פתיחת מאגרי המידע של המדינה לציבור',
      style: counterEnabled ? '' : 'display:none',
    }, [
      el('span', { className: 'gs-counter-num' }, [_d == null ? '—' : _d.toLocaleString('he-IL')]),
      el('span', { className: 'gs-counter-txt' }, ['ימים מאז שהממשלה החליטה שמאגרי המידע של המדינה ייפתחו לציבור ויהיו נגישים · רציונל ↗']),
    ]);

    const buttons = el('div', { className: 'gs-buttons' }, [downloadBtn, deepBtn, mavatDownloadBtn, cancelBtn, fallbackBtn]);

    // govmap: keep the download button label in sync with the format choice.
    if (isWfs && formatCsvCb && formatGeojsonCb) {
      const syncFormatLabel = () => {
        const c = formatCsvCb.checked, g = formatGeojsonCb.checked;
        downloadBtn.textContent = (c && g) ? 'הורד GeoJSON + CSV' : g ? 'הורד GeoJSON' : c ? 'הורד CSV' : 'בחר פורמט';
        downloadBtn.disabled = !c && !g;
      };
      formatCsvCb.addEventListener('change', syncFormatLabel);
      formatGeojsonCb.addEventListener('change', syncFormatLabel);
      syncFormatLabel();
    }

    const root = el('div', { id: 'govscraper-overlay', className: 'gs-overlay', dir: 'rtl', lang: 'he' }, [
      counterBanner,
      closeBtn,
      titleEl,
      metaEl,
      hint,
      govmapWarn,
      mavatBox,
      formatBox,
      motBox,
      jlmBox,
      progress,
      buttons,
      buildContactRow(),
    ]);

    // "שלח לעיבוד חיצוני" is hidden for now — the external processing API is not
    // usable at the moment (and may not ship). The button + runFallback path are
    // kept intact so re-enabling is a one-line change here.
    const SHOW_FALLBACK = false;
    if (SHOW_FALLBACK) {
      import(chrome.runtime.getURL('lib/over-org-client.js')).then(m => m.isFallbackEnabled()).then(enabled => {
        if (enabled) fallbackBtn.style.display = '';
      }).catch(() => {});
    }

    return { root, progress, downloadBtn, deepBtn, cancelBtn, fallbackBtn, mavatBox, mavatDownloadBtn, formatCsvCb, formatGeojsonCb, extentViewCb, motBox, jlmBox };
  }

  function downloadLabelsForKind(kind) {
    switch (kind) {
      case 'wfs_layer':
        return {
          primary: 'הורד GeoJSON + CSV',
          primaryTooltip: 'מוריד ZIP שמכיל את כל ה-features כ-GeoJSON ו-CSV עם lon/lat',
          deep: '+ קבצים מצורפים',
          deepTooltip: 'מוריד גם קבצים מצורפים (לא רלוונטי לרוב השכבות)',
        };
      case 'parcel':
      case 'neighborhood_deals':
      case 'settlement_deals':
      case 'street_deals':
        return {
          primary: 'הורד עסקאות (CSV)',
          primaryTooltip: 'מוריד את כל העסקאות שנטענו לעמוד. אם רוצים יותר — לחץ "טען עוד" ואז נסה שוב.',
          deep: '+ קבצים מצורפים',
          deepTooltip: 'לא רלוונטי לעסקאות נדל"ן',
        };
      case 'idf_section':
        return {
          primary: 'הורד רשימה (CSV)',
          primaryTooltip: 'מוריד CSV של כותרת + URL לכל מסמך שזוהה',
          deep: 'הורד את כל המסמכים',
          deepTooltip: 'מוריד את כל ה-PDF/DOC ואורז אותם ב-ZIP עם CSV מסכם',
        };
      case 'content_page':
        return {
          primary: 'הורד CSV',
          primaryTooltip: 'מוריד את כל הקישורים בדף כקובץ CSV',
          deep: '+ קבצים מצורפים',
          deepTooltip: '',
        };
      case 'mot_catalog':
        return {
          primary: 'הורד שכבות מוצגות',
          primaryTooltip: 'מוריד את הקבצים הגאוגרפיים (לפי הפורמט שנבחר) של השכבות שסימנת במפה, מ-data.gov.il, ב-ZIP מסודר לפי שכבה + CSV קטלוג. לא מגרד את כל הקטלוג.',
          deep: '+ קבצים',
          deepTooltip: '',
        };
      case 'jlm_tik':
        return {
          primary: 'הורד את כל המסמכים (ZIP)',
          primaryTooltip: 'מוריד את כל מסמכי התיק, בשמות אינפורמטיביים לפי המקור, ואורז אותם ב-ZIP אחד עם קובץ קטלוג CSV',
          deep: '+ קבצים',
          deepTooltip: '',
        };
      case 'traditional_collector':
      case 'dynamic_collector':
      default:
        return {
          primary: 'הורד CSV',
          primaryTooltip: 'הורדה מהירה של רשימת הפריטים כקובץ CSV',
          deep: '+ קבצים מצורפים',
          deepTooltip: 'מוריד גם את הקבצים המצורפים (PDF/DOC) של כל פריט. איטי יותר.',
        };
    }
  }

  function kindLabel(kind) {
    switch (kind) {
      case 'dynamic_collector': return 'DynamicCollector';
      case 'traditional_collector': return 'Collector';
      case 'content_page': return 'דף תוכן';
      case 'parcel': return 'פרצל נדל"ן';
      case 'neighborhood_deals': return 'עסקאות בשכונה';
      case 'settlement_deals': return 'עסקאות ביישוב';
      case 'street_deals': return 'עסקאות ברחוב';
      case 'wfs_layer': return 'שכבת GovMap';
      case 'idf_section': return 'מסמכי IDF';
      case 'mavat_plan': return 'תוכנית מנהל התכנון';
      case 'mot_catalog': return 'קטלוג שכבות (חצב)';
      case 'jlm_tik': return 'תיק רישוי בנייה (ירושלים)';
      case 'jlm_list': return 'רשימת תיקים (ירושלים)';
      case 'jlm_home': return 'עיריית ירושלים';
      case 'knesset_bill': return 'הצעת חוק (הכנסת)';
      case 'knesset_law': return 'חוק (הכנסת)';
      case 'land_plans': return 'איתור תוכניות (רמ"י)';
      default: return kind;
    }
  }

  function setProgress(progressEl, { current, total, message, sub }) {
    progressEl.style.display = '';
    const fill = progressEl.querySelector('.gs-progress-fill');
    const text = progressEl.querySelector('.gs-progress-text');
    const subEl = progressEl.querySelector('.gs-progress-sub');
    const pct = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 0;
    fill.style.width = `${pct}%`;
    text.textContent = message || (total ? `${current} / ${total}` : `${current}`);
    if (subEl) subEl.textContent = sub || '';
  }

  function setStatus(progressEl, message, kind = 'info', sub = '') {
    progressEl.style.display = '';
    progressEl.classList.toggle('gs-progress-error', kind === 'error');
    progressEl.classList.toggle('gs-progress-done', kind === 'done');
    progressEl.querySelector('.gs-progress-text').textContent = message;
    const subEl = progressEl.querySelector('.gs-progress-sub');
    if (subEl) subEl.textContent = sub;
  }

  // Map raw errors to a user-facing message. The most common confusing one is
  // "Extension context invalidated" — it means the extension was reloaded while
  // this page's content script was still live, so its chrome.* link is dead.
  function errMsg(e) {
    const m = String(e?.message || e || '');
    if (/context invalidated|Extension context|message port closed|receiving end does not exist/i.test(m)) {
      return 'התוסף עודכן — רענן את הדף (F5) ונסה שוב.';
    }
    if (/invalid string length|maximum call stack|out of memory|allocation failed/i.test(m)) {
      return 'השכבה גדולה מדי להורדה מלאה. סמן "הורד רק את תחום התצוגה (מה שרואים במסך)", התמקד באזור, ונסה שוב.';
    }
    return m;
  }

  function showActionButtons(ui, busy) {
    ui.downloadBtn.disabled = busy;
    ui.deepBtn.disabled = busy;
    ui.fallbackBtn.disabled = busy;
    ui.cancelBtn.style.display = busy ? '' : 'none';
  }

  async function runScrape({ match, ui }) {
    // Never leave a click feeling dead: if a download is genuinely running, say
    // so instead of silently ignoring the click.
    if (scrapeInProgress) { try { setStatus(ui.progress, 'הורדה כבר פועלת — המתן/י לסיום או לחצ/י בטל.', 'info'); } catch {} return; }
    // geo.mot: the primary download fetches the displayed layers' geographic
    // files (data.gov.il) per the format picker — its own flow.
    if (match.parsed.kind === 'mot_catalog') return runMotDownload({ match, ui });
    // Jerusalem pages drive downloads from buttons inside the box (see initJlm).
    scrapeInProgress = true;
    cancelRequested = false;
    const { scraper, parsed } = match;
    showActionButtons(ui, true);
    try {
      const result = await scraper.fetch(parsed, {
        onProgress: (p) => setProgress(ui.progress, p),
        isCancelled: () => cancelRequested,
        extentMode: (parsed.kind === 'wfs_layer' && ui.extentViewCb?.checked) ? 'view' : 'full',
      });
      if (cancelRequested) throw new Error('בוטל על-ידי המשתמש');
      if (!result.rows || result.rows.length === 0) {
        throw new Error(result.warning || 'הסקרייפר רץ אבל לא קיבל שום שורה מה-API.');
      }
      // govmap: honor the CSV / GeoJSON format choice (both by default).
      let formats = null;
      if (parsed.kind === 'wfs_layer' && ui.formatCsvCb && ui.formatGeojsonCb) {
        formats = { csv: ui.formatCsvCb.checked, geojson: ui.formatGeojsonCb.checked };
        if (!formats.csv && !formats.geojson) throw new Error('בחר לפחות פורמט אחד להורדה (CSV או GeoJSON).');
      }
      setStatus(ui.progress, `נאספו ${result.rows.length} שורות — שולח להורדה…`, 'info');
      const transferable = await packageResult(result, parsed, { withAttachments: null, formats });
      const resp = await chrome.runtime.sendMessage({ type: 'package-and-download', payload: transferable });
      if (!resp?.ok) throw new Error(resp?.error || 'ההורדה נכשלה');
      // govmap: when full geometry wasn't available (entities-geometry serves
      // the SPA shell since ~2026-07), tell the user how many rows carry only
      // a centroid Point and point them at OVER for the full layer.
      const centroidNote = result.centroidOnly > 0
        ? `. שימו לב: עבור ${result.centroidOnly} רשומות נשמרה נקודת מרכז בלבד (ללא פוליגון/קו מלא) — בדקו אם השכבה זמינה במלואה ב-over.org.il`
        : '';
      setStatus(ui.progress,
        `${'ההורדה הושלמה'} — ${result.rows.length} שורות${centroidNote}`,
        'done');
      await logHistory({ scraper, parsed, result, filename: resp.filename, mode: 'csv' });
    } catch (e) {
      console.error('[GovScraper] scrape failed:', e);
      setStatus(ui.progress, `${'הגירוד נכשל'}: ${errMsg(e)}`, 'error');
    } finally {
      scrapeInProgress = false;
      showActionButtons(ui, false);
    }
  }

  // geo.mot (חצב): render the picker for the CURRENTLY DISPLAYED layers — only
  // the formats that actually exist for them (with counts), refreshed as the
  // user toggles layers. Offers nothing for layers/formats that don't exist.
  async function initMot({ match, ui }) {
    const box = ui.motBox;
    if (!box) return;
    const FORMATS = [['csv', 'CSV'], ['kml', 'KML'], ['shp', 'SHP'], ['metadata', 'מטא-דאטה']];
    let lastKey = null;
    let motMod;
    try { motMod = await import(chrome.runtime.getURL('scrapers/mot.js')); }
    catch (e) { setStatus(ui.progress, `טעינת הסקרייפר נכשלה: ${errMsg(e)}`, 'error'); return; }

    const render = async () => {
      let preview;
      try { preview = await motMod.previewDisplayed(); }
      catch (e) { setStatus(ui.progress, `טעינת הקטלוג נכשלה: ${errMsg(e)}`, 'error'); return; }

      const key = `${preview.layers.map(l => l.code + (l.downloadable ? '1' : '0')).join(',')}`;
      if (key === lastKey) return; // displayed set unchanged → keep the user's format choices
      lastKey = key;

      ui.progress.style.display = 'none';
      box.replaceChildren();
      box.style.display = '';
      ui.motFormatCbs = [];

      const appendLayer = (l) => {
        box.appendChild(el('div', { className: 'gs-mavat-row gs-mavat-leaf' }, [
          el('span', { className: 'gs-mavat-label' }, [l.name]),
          el('span', { className: 'gs-mavat-count' }, [l.downloadable ? `(${l.formats.length} פורמטים)` : '(אין קובץ ב-data.gov.il)']),
        ]));
      };

      // "Download the geometry straight from the map" — calls the page's own
      // GovMap API (via content/mot-inject.js) for the EXACT displayed layers and
      // builds GeoJSON+CSV. Works for every displayed layer, including ones with
      // no data.gov.il file (e.g. רכבת כבדה - מסילות).
      const addGeoButton = () => {
        const codes = preview.layers.map((l) => l.code);
        const btn = el('button', { className: 'gs-mot-geo-btn', title: 'שולף את הגיאומטריה המדויקת של השכבות המוצגות ישירות משירות המפה של חצב' },
          [`⬇ הורד גיאומטריה מהמפה (GeoJSON + CSV) — ${codes.length} שכבות`]);
        btn.addEventListener('click', () => runMotGeometry({ match, ui, codes }));
        box.appendChild(btn);
      };

      if (!preview.displayedCount) {
        box.appendChild(el('div', { className: 'gs-mavat-note' }, ['לא מוצגות שכבות. סמן שכבות בעץ השכבות (☑) — התוסף יוריד רק את השכבות המוצגות.']));
        ui.downloadBtn.disabled = true;
        return;
      }
      if (!preview.downloadableCount) {
        box.appendChild(el('div', { className: 'gs-mavat-note' }, [`מוצגות ${preview.displayedCount} שכבות, אך לאף אחת אין קובץ מוכן ב-data.gov.il. ניתן לשלוף את הגיאומטריה ישירות מהמפה:`]));
        for (const l of preview.layers) appendLayer(l);
        addGeoButton();
        ui.downloadBtn.disabled = true; // the primary button drives the data.gov.il files; none here
        return;
      }

      box.appendChild(el('div', { className: 'gs-mavat-head' }, [`${preview.downloadableCount} שכבות מוצגות להורדה — בחר פורמט:`]));
      const fmtRow = el('div', { className: 'gs-format' }, [el('span', { className: 'gs-format-label' }, ['פורמט:'])]);
      for (const [kind, label] of FORMATS) {
        const n = preview.counts[kind] || 0;
        if (!n) continue; // offer only formats that actually exist
        const cb = el('input', { type: 'checkbox', class: 'gs-mavat-cb' });
        cb.checked = kind !== 'metadata';
        cb.dataset.kind = kind;
        fmtRow.appendChild(el('label', { className: 'gs-format-opt' }, [cb, el('span', {}, [`${label} (${n})`])]));
        ui.motFormatCbs.push(cb);
      }
      box.appendChild(fmtRow);
      for (const l of preview.layers) appendLayer(l);
      addGeoButton();
      ui.downloadBtn.disabled = false;
    };

    await render();
    // The layer tree has no URL signal, so poll for toggles and refresh.
    const iv = setInterval(() => {
      if (!document.getElementById('govscraper-overlay')) { clearInterval(iv); return; }
      if (!scrapeInProgress) render();
    }, 1500);
  }

  // geo.mot (חצב): download the DISPLAYED layers' geographic files from
  // data.gov.il, in the chosen formats, packaged in a ZIP organized per layer
  // (+ a catalog CSV). Batched + retried like the deep scrape, but driven by the
  // primary button and the format picker.
  async function runMotDownload({ match, ui }) {
    if (scrapeInProgress) return;
    scrapeInProgress = true;
    cancelRequested = false;
    const { scraper, parsed } = match;
    showActionButtons(ui, true);
    try {
      const kinds = new Set((ui.motFormatCbs || []).filter(cb => cb.checked).map(cb => cb.dataset.kind));
      if (!kinds.size) throw new Error('בחר לפחות פורמט אחד (CSV / KML / SHP / מטא-דאטה).');

      setProgress(ui.progress, { current: 0, total: 0, message: 'אוסף את השכבות המוצגות…' });
      const result = await scraper.fetch(parsed, {
        onProgress: (p) => setProgress(ui.progress, p),
        isCancelled: () => cancelRequested,
      });
      if (cancelRequested) throw new Error('בוטל על-ידי המשתמש');

      const files = (result.attachments || []).filter(a => kinds.has(a.kind));
      if (!files.length) throw new Error('לא נמצאו קבצים בפורמטים שנבחרו לשכבות המוצגות.');

      const fetchProxy = await import(chrome.runtime.getURL('lib/fetch-proxy.js'));
      const csvMod = await import(chrome.runtime.getURL('lib/csv.js'));
      const zipMod = await import(chrome.runtime.getURL('lib/zip.js'));
      const baseName = sanitizeFilename(result.collectorName || parsed.collectorName || 'mot');
      const csvText = csvMod.rowsToCsv(result.rows, result.fields);
      const date = new Date().toISOString().slice(0, 10);
      const seg = (s) => String(s || '').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim() || 'שכבה';

      async function fetchBytesRetry(url) {
        let lastErr;
        for (let n = 0; n < 3; n++) {
          if (cancelRequested) throw new Error('cancelled');
          try { return await fetchProxy.smartFetchBytes(url); }
          catch (e) { lastErr = e; await new Promise(r => setTimeout(r, 600 * (n + 1) + Math.floor(Math.random() * 400))); }
        }
        throw lastErr;
      }

      const MAX_PER_PART = 250;
      const multiPart = files.length > MAX_PER_PART;
      let fileIdx = 0, fileFails = 0, okCount = 0, part = 0, prevUrl = null;

      setProgress(ui.progress, { current: 0, total: files.length, message: 'מוריד קבצי שכבות…' });
      for (let start = 0; start < files.length && !cancelRequested; start += MAX_PER_PART) {
        const chunk = files.slice(start, start + MAX_PER_PART);
        const batch = [];
        const takenPerFolder = {};
        await pool(chunk, 4, async (att) => {
          if (cancelRequested) return;
          try {
            const bytes = await fetchBytesRetry(att.url);
            const folder = seg(att.layer);
            takenPerFolder[folder] = takenPerFolder[folder] || [];
            const name = uniqueNameIn(takenPerFolder[folder], safeFile(att.filename));
            batch.push({ name: `${folder}/${name}`, data: bytes });
            okCount++;
          } catch { fileFails++; }
          finally {
            fileIdx++;
            setProgress(ui.progress, { current: fileIdx, total: files.length, message: 'מוריד קבצי שכבות', sub: `${fileIdx}/${files.length}${fileFails ? ` • ${fileFails} כשלים` : ''}` });
          }
        }, () => cancelRequested);
        if (!batch.length) continue;
        part++;
        const entries = part === 1 ? [{ name: `${baseName}_קטלוג.csv`, data: csvText }, ...batch] : batch;
        setStatus(ui.progress, multiPart ? `אורז ZIP — חלק ${part}…` : `אורז ZIP (${batch.length} קבצים)…`, 'info');
        const blob = await zipMod.buildZip(entries);
        const filename = multiPart ? `mot_${baseName}_${date}_part${String(part).padStart(2, '0')}.zip` : `mot_${baseName}_${date}.zip`;
        const url = URL.createObjectURL(blob);
        const resp = await chrome.runtime.sendMessage({ type: 'package-and-download', payload: { kind: 'blob-url', filename, url, sizeBytes: blob.size } });
        if (!resp?.ok) throw new Error(resp?.error || 'אריזת ה-ZIP נכשלה');
        if (prevUrl) URL.revokeObjectURL(prevUrl);
        prevUrl = url;
      }
      if (prevUrl) setTimeout(() => URL.revokeObjectURL(prevUrl), 8000);
      if (cancelRequested) throw new Error('בוטל על-ידי המשתמש');
      if (!part) throw new Error('לא הורד אף קובץ (ייתכן שכל ההורדות נכשלו).');

      setStatus(ui.progress,
        fileFails ? `הסתיים — ${okCount} קבצים (${fileFails} נכשלו)` : `הסתיים — ${okCount} קבצים מ-${result.rows.length} שכבות`,
        fileFails ? 'error' : 'done');
      await logHistory({ scraper, parsed, result, filename: `mot_${baseName}`, mode: 'mot', attachmentCount: okCount });
    } catch (e) {
      console.error('[GovScraper] mot download failed:', e);
      setStatus(ui.progress, `${'ההורדה נכשלה'}: ${errMsg(e)}`, 'error');
    } finally {
      scrapeInProgress = false;
      showActionButtons(ui, false);
    }
  }

  // Ask content/mot-inject.js (MAIN world) to sweep the displayed layers via the
  // page's own GovMap API and return their features. postMessage bridge with a
  // nonce; resolves with the raw layers array.
  function requestMotGeometry(codes, onProg) {
    return new Promise((resolve, reject) => {
      const nonce = 'mot' + Date.now() + '_' + Math.random().toString(36).slice(2);
      const TIMEOUT = 12 * 60 * 1000;
      const to = setTimeout(() => { cleanup(); reject(new Error('שירות המפה לא הגיב בזמן (ייתכן שהמפה לא נטענה במלואה).')); }, TIMEOUT);
      function onMsg(e) {
        if (e.source !== window || e.origin !== location.origin) return;
        const d = e.data;
        if (!d || !d.__gsMot || d.nonce !== nonce) return;
        if (d.type === 'progress') { if (onProg) onProg(d); }
        else if (d.type === 'result') { cleanup(); resolve(Array.isArray(d.layers) ? d.layers : []); }
        else if (d.type === 'error') { cleanup(); reject(new Error(d.error || 'extract failed')); }
      }
      function cleanup() { clearTimeout(to); window.removeEventListener('message', onMsg); }
      window.addEventListener('message', onMsg);
      if (!document.documentElement.getAttribute('data-gs-mot-inject')) {
        cleanup();
        reject(new Error('רכיב המפה לא נטען. רענן/י את הדף (F5) ונסה/י שוב.'));
        return;
      }
      window.postMessage({ __gsMotCmd: 'extract', nonce, codes }, location.origin);
    });
  }

  // geo.mot (חצב): download the EXACT displayed layers' geometry straight from
  // the map (the page's GovMap API), as GeoJSON (WGS84) + CSV (geometry_wkt in
  // ITM/EPSG:6991), one pair per layer, packaged in a ZIP.
  async function runMotGeometry({ match, ui, codes }) {
    if (scrapeInProgress) return;
    scrapeInProgress = true;
    cancelRequested = false;
    const { scraper, parsed } = match;
    showActionButtons(ui, true);
    try {
      if (!codes || !codes.length) throw new Error('לא נבחרו שכבות. סמן/י שכבות במפה ונסה/י שוב.');
      setProgress(ui.progress, { current: 0, total: codes.length, message: 'מבקש גיאומטריה מהמפה…' });
      const layers = await requestMotGeometry(codes, (p) => setProgress(ui.progress, { current: p.count || 0, total: 0, message: p.message }));
      if (cancelRequested) throw new Error('בוטל על-ידי המשתמש');

      const geoMod = await import(chrome.runtime.getURL('scrapers/mot-geometry.js'));
      const csvMod = await import(chrome.runtime.getURL('lib/csv.js'));
      const zipMod = await import(chrome.runtime.getURL('lib/zip.js'));

      const entries = [];
      const skipped = [];
      let totalFeats = 0, layerCount = 0, anyCapped = false;
      const seg = (s) => String(s || 'layer').replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, '_').trim() || 'layer';
      const takenNames = [];
      for (const L of layers) {
        const out = geoMod.buildLayerOutputs(L);
        if (!out.count) { skipped.push(`${L.code}${L.error ? ' (' + L.error + ')' : ' (אין גיאומטריה)'}`); continue; }
        let base = seg(L.code);
        let n = base, i = 2;
        while (takenNames.includes(n)) n = `${base}_${i++}`;
        takenNames.push(n);
        entries.push({ name: `${n}.geojson`, data: JSON.stringify(out.geojson) });
        entries.push({ name: `${n}.csv`, data: csvMod.rowsToCsv(out.rows, out.fieldOrder) });
        totalFeats += out.count;
        layerCount++;
        if (out.capped) anyCapped = true;
      }
      if (!entries.length) throw new Error('לא הוחזרה גיאומטריה' + (skipped.length ? ': ' + skipped.join(' | ') : '.'));

      setStatus(ui.progress, `אורז ZIP (${layerCount} שכבות, ${totalFeats} עצמים)…`, 'info');
      const blob = await zipMod.buildZip(entries);
      const date = new Date().toISOString().slice(0, 10);
      const filename = `mot_geometry_${date}.zip`;
      const url = URL.createObjectURL(blob);
      const resp = await chrome.runtime.sendMessage({ type: 'package-and-download', payload: { kind: 'blob-url', filename, url, sizeBytes: blob.size } });
      if (!resp?.ok) throw new Error(resp?.error || 'אריזת ה-ZIP נכשלה');
      setTimeout(() => URL.revokeObjectURL(url), 8000);

      const notes = [];
      if (skipped.length) notes.push(`${skipped.length} שכבות ללא גיאומטריה`);
      if (anyCapped) notes.push('חלק מהשכבות נקטעו במגבלת השרת — ייתכן חוסר');
      setStatus(ui.progress, `הסתיים — ${totalFeats} עצמים ב-${layerCount} שכבות${notes.length ? ' (' + notes.join('; ') + ')' : ''}`, skipped.length || anyCapped ? 'error' : 'done');
      try { await logHistory({ scraper, parsed, result: { rows: [], fields: [] }, filename: 'mot_geometry', mode: 'mot_geometry', attachmentCount: totalFeats }); } catch {}
    } catch (e) {
      console.error('[GovScraper] mot geometry failed:', e);
      setStatus(ui.progress, `הורדת הגיאומטריה נכשלה: ${errMsg(e)}`, 'error');
    } finally {
      scrapeInProgress = false;
      showActionButtons(ui, false);
    }
  }

  async function runDeepScrape({ match, ui }) {
    if (scrapeInProgress) return;
    scrapeInProgress = true;
    cancelRequested = false;
    const { scraper, parsed } = match;
    showActionButtons(ui, true);
    try {
      // Phase 1 — listing
      setProgress(ui.progress, { current: 0, total: 0, message: 'שלב 1/3 — אוסף רשומות…' });
      const result = await scraper.fetch(parsed, {
        onProgress: (p) => setProgress(ui.progress, { ...p, message: `שלב 1/3 — ${p.message || 'אוסף רשומות'}` }),
        isCancelled: () => cancelRequested,
      });
      if (cancelRequested) throw new Error('בוטל על-ידי המשתמש');
      if (!result.rows || result.rows.length === 0) {
        throw new Error(result.warning || 'הסקרייפר רץ אבל לא קיבל שום שורה מה-API.');
      }

      // Phase 2 — collect the attachment list. Two sources, used together:
      //   (a) attachments the scraper extracted straight from the listing data
      //       — idf rows, and collectors whose items carry file URLs directly
      //       (e.g. the justice appraiser API's Data.Document[]).
      //   (b) content-page discovery for collectors that link PDFs from
      //       /he/pages/ content pages.
      const allAttachments = Array.isArray(result.attachments) ? result.attachments.slice() : [];
      const seenUrls = new Set(allAttachments.map(a => a.url));

      const rowsWithUrl = parsed.kind === 'idf_section'
        ? []
        : result.rows.filter(r => typeof r.url === 'string' && r.url.includes('/he/pages/'));

      if (rowsWithUrl.length) {
        const govilMod = await import(chrome.runtime.getURL('scrapers/govil.js'));
        const attachMod = await import(chrome.runtime.getURL('scrapers/_content-attachments.js'));
        const runtime = await govilMod.loadRuntimeConfig();
        setProgress(ui.progress, { current: 0, total: rowsWithUrl.length, message: `שלב 2/3 — מאתר קבצים מצורפים…` });

        let pageIdx = 0;
        let pageFails = 0;
        const processOnePage = async (row) => {
          try {
            const found = await attachMod.discoverContentPageAttachments(row.url, runtime);
            for (const a of found) {
              if (seenUrls.has(a.url)) continue;
              seenUrls.add(a.url);
              allAttachments.push({ ...a, rowTitle: row.title || row.Description || '' });
            }
          } catch {
            pageFails++;
          } finally {
            pageIdx++;
            setProgress(ui.progress, {
              current: pageIdx,
              total: rowsWithUrl.length,
              message: `שלב 2/3 — מאתר קבצים מצורפים`,
              sub: `${pageIdx}/${rowsWithUrl.length} עמודים נסרקו • ${allAttachments.length} קבצים נמצאו${pageFails ? ` • ${pageFails} כשלים` : ''}`,
            });
          }
        };
        await pool(rowsWithUrl, 6, processOnePage, () => cancelRequested);
      } else {
        setProgress(ui.progress, {
          current: allAttachments.length,
          total: allAttachments.length,
          message: `שלב 2/3 — זוהו ${allAttachments.length} קבצים מהרשימה`,
        });
      }
      if (cancelRequested) throw new Error('בוטל על-ידי המשתמש');
      if (!allAttachments.length) throw new Error('לא נמצאו קבצים מצורפים. נסה את "הורד CSV" עבור הרשימה בלבד.');

      // Phase 3 — download attachments, packaged into ZIP part(s). Accumulating
      // thousands of files in one in-memory ZIP exhausts the tab's memory and
      // crashes it, so we flush a ZIP every MAX_FILES_PER_PART files and revoke
      // the previous part's blob URL — bounding peak memory regardless of how
      // many attachments the collector has.
      setProgress(ui.progress, { current: 0, total: allAttachments.length, message: `שלב 3/3 — מוריד קבצים מצורפים…` });
      const fetchProxy = await import(chrome.runtime.getURL('lib/fetch-proxy.js'));
      const csvMod = await import(chrome.runtime.getURL('lib/csv.js'));
      const zipMod = await import(chrome.runtime.getURL('lib/zip.js'));

      const MAX_FILES_PER_PART = 300; // bounds peak memory per ZIP part
      const baseName = safeFile(result.collectorName || parsed.collectorName || 'gov').replace(/\.[a-z0-9]+$/i, '');
      const csvText = csvMod.rowsToCsv(result.rows, result.fields);
      const multiPart = allAttachments.length > MAX_FILES_PER_PART;

      // Retry transient failures (gateway throttling, hung requests, SW restarts)
      // with jittered backoff — essential over a long run of tens of thousands of
      // files. The backoff also naturally throttles us when the server pushes back.
      async function fetchBytesRetry(url) {
        let lastErr;
        for (let attemptN = 0; attemptN < 3; attemptN++) {
          if (cancelRequested) throw new Error('cancelled');
          try { return await fetchProxy.smartFetchBytes(url); }
          catch (e) {
            lastErr = e;
            await new Promise(r => setTimeout(r, 600 * (attemptN + 1) + Math.floor(Math.random() * 500)));
          }
        }
        throw lastErr;
      }

      let fileIdx = 0, fileFails = 0, okCount = 0, part = 0;
      let prevUrl = null;

      for (let start = 0; start < allAttachments.length && !cancelRequested; start += MAX_FILES_PER_PART) {
        const chunk = allAttachments.slice(start, start + MAX_FILES_PER_PART);
        const batch = [];
        const taken = [];
        await pool(chunk, 4, async (att) => {
          if (cancelRequested) return;
          try {
            const bytes = await fetchBytesRetry(att.url);
            batch.push({ name: `attachments/${uniqueNameIn(taken, safeFile(att.filename))}`, data: bytes });
            okCount++;
          } catch {
            fileFails++;
          } finally {
            fileIdx++;
            setProgress(ui.progress, {
              current: fileIdx,
              total: allAttachments.length,
              message: `שלב 3/3 — מוריד קבצים מצורפים`,
              sub: `${fileIdx}/${allAttachments.length}${multiPart ? ` • חלק ${part + 1}` : ''}${fileFails ? ` • ${fileFails} כשלים` : ''}`,
            });
          }
        }, () => cancelRequested);
        if (!batch.length) continue;

        // Flush this chunk as one ZIP part (CSV rides along in the first part).
        part++;
        const entries = part === 1 ? [{ name: `${baseName}.csv`, data: csvText }, ...batch] : batch;
        setStatus(ui.progress, multiPart ? `אורז ZIP — חלק ${part} (${batch.length} קבצים)…` : `אורז ZIP (${batch.length} קבצים)…`, 'info');
        const blob = await zipMod.buildZip(entries);
        const date = new Date().toISOString().slice(0, 10);
        const filename = multiPart
          ? `${baseName}_${date}_part${String(part).padStart(2, '0')}.zip`
          : `${baseName}_${date}.zip`;
        const url = URL.createObjectURL(blob);
        const resp = await chrome.runtime.sendMessage({ type: 'package-and-download', payload: { kind: 'blob-url', filename, url, sizeBytes: blob.size } });
        if (!resp?.ok) throw new Error(resp?.error || 'אריזת ה-ZIP נכשלה');
        if (prevUrl) URL.revokeObjectURL(prevUrl); // earlier part is long since saved
        prevUrl = url;
        // `batch` drops out of scope on the next iteration → its bytes are GC'd.
      }
      if (prevUrl) setTimeout(() => URL.revokeObjectURL(prevUrl), 8000);
      if (cancelRequested) throw new Error('בוטל על-ידי המשתמש');
      if (!part) throw new Error('לא הורד אף קובץ (ייתכן שכל ההורדות נכשלו).');

      setStatus(ui.progress,
        `הסתיים — ${result.rows.length} שורות, ${okCount} קבצים${multiPart ? ` ב-${part} קבצי ZIP` : ''}${fileFails ? ` (${fileFails} נכשלו)` : ''}`,
        'done');
      await logHistory({ scraper, parsed, result, filename: `${baseName} (${part} ZIP)`, mode: 'deep', attachmentCount: okCount });
    } catch (e) {
      console.error('[GovScraper] deep scrape failed:', e);
      setStatus(ui.progress, `${'הגירוד נכשל'}: ${errMsg(e)}`, 'error');
    } finally {
      scrapeInProgress = false;
      showActionButtons(ui, false);
    }
  }

  async function pool(items, concurrency, fn, cancelCheck) {
    let next = 0;
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) {
        if (cancelCheck && cancelCheck()) return;
        const i = next++;
        await fn(items[i]);
      }
    });
    await Promise.all(workers);
  }

  // Serialize a GeoJSON FeatureCollection to a Blob one feature at a time, so a
  // huge layer never forms a single JS string (which throws "Invalid string
  // length" past ~512 MB). Each JSON.stringify(feature) stays small; the Blob
  // stitches the chunks up to memory limits.
  function geojsonToBlob(fc) {
    const meta = {};
    for (const k of Object.keys(fc || {})) if (k !== 'features') meta[k] = fc[k];
    const metaStr = JSON.stringify(meta);
    const open = metaStr === '{}' ? '{' : metaStr.slice(0, -1) + ',';
    const parts = [open + '"features":['];
    const feats = (fc && fc.features) || [];
    const BATCH = 1000;
    for (let i = 0; i < feats.length; i += BATCH) {
      const end = Math.min(i + BATCH, feats.length);
      let chunk = '';
      for (let j = i; j < end; j++) chunk += (j === 0 ? '' : ',') + JSON.stringify(feats[j]);
      parts.push(chunk);
    }
    parts.push(']}');
    return new Blob(parts, { type: 'application/geo+json' });
  }

  async function packageResult(result, parsed, { withAttachments, formats } = {}) {
    const csvMod = await import(chrome.runtime.getURL('lib/csv.js'));
    const baseName = sanitizeFilename(result.collectorName || parsed.collectorName || `${parsed.scraperId}_export`);
    const date = new Date().toISOString().slice(0, 10);

    // `formats` (govmap only) selects CSV / GeoJSON. Default: include both
    // available outputs — preserves prior behavior for every other scraper.
    const fmt = formats || { csv: true, geojson: true };
    const includeCsv = fmt.csv !== false;
    const includeGeojson = !!result.geojson && fmt.geojson !== false;
    const hasAttach = !!(withAttachments && withAttachments.length);

    // Build CSV/GeoJSON as Blobs assembled from chunks (never one giant JS
    // string) so large layers don't hit the ~512 MB "Invalid string length" cap.
    const entries = [];
    if (includeCsv) entries.push({ name: `${baseName}.csv`, data: csvMod.rowsToCsvBlob(result.rows, result.fields) });
    if (includeGeojson) entries.push({ name: `${baseName}.geojson`, data: geojsonToBlob(result.geojson) });
    if (hasAttach) for (const att of withAttachments) entries.push({ name: `attachments/${att.name}`, data: att.data });
    if (!entries.length) throw new Error('לא נבחר פורמט להורדה.');

    let blob, filename;
    if (entries.length === 1 && !hasAttach) {
      // Single output → download it directly, no ZIP wrapper.
      const e = entries[0];
      const ext = e.name.endsWith('.geojson') ? 'geojson' : 'csv';
      const type = ext === 'geojson' ? 'application/geo+json' : 'text/csv;charset=utf-8';
      blob = e.data instanceof Blob ? e.data : new Blob([e.data], { type });
      filename = `${parsed.scraperId}_${baseName}_${date}.${ext}`;
    } else {
      const zipMod = await import(chrome.runtime.getURL('lib/zip.js'));
      blob = await zipMod.buildZip(entries);
      filename = `${parsed.scraperId}_${baseName}_${date}.zip`;
    }
    const url = URL.createObjectURL(blob);
    return { kind: 'blob-url', filename, url, sizeBytes: blob.size };
  }

  function sanitizeFilename(s) {
    return (s || 'export').replace(/[\\\/:*?"<>|]+/g, '_').replace(/\s+/g, '_').slice(0, 80) || 'export';
  }

  async function logHistory({ scraper, parsed, result, filename, mode, attachmentCount }) {
    try {
      await chrome.runtime.sendMessage({
        type: 'log-history',
        payload: {
          scraperId: scraper.id,
          sourceUrl: parsed.originalUrl,
          collectorName: result.collectorName || parsed.collectorName,
          rowCount: result.rows.length,
          attachmentCount: attachmentCount || 0,
          mode,
          filename,
          at: Date.now(),
        },
      });
    } catch {}
  }

  async function runFallback({ match, ui }) {
    const mod = await import(chrome.runtime.getURL('lib/over-org-client.js'));
    setStatus(ui.progress, 'שולח בקשה ל-over.org.il…', 'info');
    try {
      const res = await mod.dispatchToOverOrg({
        sourceUrl: match.parsed.originalUrl,
        scraperHint: match.scraper.id,
      });
      const link = res.statusUrl ? `התוצאה תופיע ב: ${res.statusUrl}` : 'הבקשה התקבלה';
      setStatus(ui.progress, link, 'done');
    } catch (e) {
      setStatus(ui.progress, `שליחה נכשלה: ${errMsg(e)}`, 'error');
    }
  }

  function show({ match, autoRun }) {
    if (overlayEl) overlayEl.remove();
    let ui;
    const onDownload = () => runScrape({ match, ui });
    const onDeepDownload = () => runDeepScrape({ match, ui });
    const onFallback = () => runFallback({ match, ui });
    const onCancel = () => {
      cancelRequested = true;
      try { setStatus(ui.progress, 'מבטל… (ייעצר תוך כמה שניות)', 'info'); } catch {}
    };
    const onMavatDownload = () => runMavatDownload({ match, ui });
    const onClose = () => remove();
    ui = buildOverlay({ match, onDownload, onDeepDownload, onFallback, onClose, onCancel, onMavatDownload });
    overlayEl = ui.root;
    applyPositionClass(overlayEl);
    document.body.appendChild(overlayEl);

    // mavat: auto-load the plan and render the category picker.
    if (match.parsed.kind === 'mavat_plan') {
      initMavat({ match, ui });
    }
    // geo.mot: render the displayed-layers / format picker (offers only what exists).
    if (match.parsed.kind === 'mot_catalog') {
      initMot({ match, ui });
    }
    // עיריית ירושלים: render the favorites block (+ file downloads on tik/list pages).
    if (match.parsed.kind === 'jlm_tik' || match.parsed.kind === 'jlm_list' || match.parsed.kind === 'jlm_home') {
      initJlm({ match, ui });
    }
    // מאגר החקיקה (הכנסת): render the protocols/documents (bill) or amendments (law) tree.
    if (match.parsed.kind === 'knesset_bill' || match.parsed.kind === 'knesset_law') {
      initKnesset({ match, ui });
    }
    // רשות מקרקעי ישראל — איתור תוכניות: watch for a search, then offer
    // CSV-index / full-ZIP over ALL its results (subdivided past the 150 cap).
    if (match.parsed.kind === 'land_plans') {
      initLand({ match, ui });
    }

    // Triggered from the popup ("download without the floating window"): for
    // simple one-click datasets, run the primary download immediately. Pickers
    // (mavat categories, geo.mot formats) need a choice, so we just reveal them.
    if (autoRun) {
      const AUTO = new Set(['dynamic_collector', 'traditional_collector', 'idf_section', 'wfs_layer']);
      if (AUTO.has(match.parsed.kind)) setTimeout(() => { try { ui.downloadBtn.click(); } catch {} }, 200);
    }
  }

  // --- mavat plan flow ------------------------------------------------------

  async function initMavat({ match, ui }) {
    const { scraper, parsed } = match;
    setProgress(ui.progress, { current: 0, total: 0, message: 'טוען את נתוני התוכנית…' });
    try {
      const result = await scraper.fetch(parsed, { onProgress: (p) => setProgress(ui.progress, p) });
      ui.mavatResult = result;
      ui.progress.style.display = 'none';
      const mavatMod = await import(chrome.runtime.getURL('scrapers/mavat.js'));

      // default selection from settings, applied to the checkboxes up front so
      // the picker shows exactly what will download by default:
      //   • default categories (all on if unset)
      //   • default search terms — within a checked category, only files whose
      //     name matches a term stay checked (comma-separated, substring match)
      const cfg = await chrome.storage.local.get(['mavat.defaultCategories', 'mavat.defaultSearchTerms', 'mavat.searchInCategories']);
      const stored = cfg['mavat.defaultCategories'];
      const defaults = Array.isArray(stored) ? new Set(stored) : null; // null = all
      const terms = String(cfg['mavat.defaultSearchTerms'] || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
      // When on, a term also matches against a file's category / sub-category
      // titles (its chain), not only its own name.
      const searchInCats = cfg['mavat.searchInCategories'] === true;
      const termHit = (text) => { const n = String(text || '').toLowerCase(); return terms.some(t => n.includes(t)); };
      const chainHit = (chain) => Array.isArray(chain) && chain.some(seg => termHit(seg));
      const docMatches = terms.length ? (d) => termHit(d.name) || (searchInCats && chainHit(d.chain)) : null;

      const box = ui.mavatBox;
      box.replaceChildren();
      box.style.display = '';
      const head = el('div', { className: 'gs-mavat-head' }, [`נמצאו ${result.documents.length} מסמכים — בחר קטגוריות:`]);
      box.appendChild(head);

      ui.mavatChecks = [];
      ui.mavatFileCbs = {}; // cat.key → [per-file checkbox], index-aligned to docsForChain
      // Build a nested tree from each section's full hierarchy chain
      // (chain = [CAT_A, CAT_B, …, leaf]); plans nest 1–4 levels. Ancestors
      // render as group rows with a tri-state checkbox that toggles their whole
      // subtree; the leaf is the actual downloadable section.
      const root = { children: new Map(), leaves: [] };
      for (const cat of result.categories) {
        let node = root;
        for (const g of cat.chain.slice(0, -1)) {
          if (!node.children.has(g)) node.children.set(g, { name: g, children: new Map(), leaves: [] });
          node = node.children.get(g);
        }
        node.leaves.push(cat);
      }
      // Render a node; returns every leaf checkbox beneath it so each ancestor
      // group can reflect (tri-state) and toggle its entire subtree.
      const renderNode = (node, depth) => {
        const subCbs = [];
        for (const child of node.children.values()) {
          const gcb = el('input', { type: 'checkbox', class: 'gs-mavat-cb' });
          box.appendChild(el('label', { className: 'gs-mavat-group', style: `padding-right:${depth * 16}px` }, [
            gcb, el('span', { className: 'gs-mavat-group-label' }, [child.name]),
          ]));
          const childCbs = renderNode(child, depth + 1);
          const refresh = () => {
            const on = childCbs.filter(c => c.checked).length;
            gcb.checked = on === childCbs.length && on > 0;
            gcb.indeterminate = on > 0 && on < childCbs.length;
          };
          childCbs.forEach(c => c.addEventListener('change', refresh));
          gcb.addEventListener('change', () => {
            for (const c of childCbs) c.checked = gcb.checked;
            childCbs.forEach(c => c.dispatchEvent(new Event('change')));
          });
          refresh();
          subCbs.push(...childCbs);
        }
        for (const cat of node.leaves) {
          const cb = el('input', { type: 'checkbox', class: 'gs-mavat-cb' });
          const defOn = defaults ? defaults.has(cat.slug) : true;
          cb.checked = defOn;
          cb.dataset.slug = cat.slug;
          cb.dataset.key = cat.key;
          cb.dataset.native = cat.native ? '1' : '';

          // Per-file drill-down: for native sections, list the individual docs so
          // the user can pick specific files. mavat only serves a whole-category
          // ZIP (reCAPTCHA-safe), so we download the category and keep only the
          // selected files (matched to ZIP entries by order — same as the rename).
          const catDocs = cat.native ? mavatMod.docsForChain(result.documents, cat.chain || [cat.label]) : [];
          const caret = catDocs.length ? el('button', { className: 'gs-jlm-caret', title: 'הצג/הסתר קבצים' }, ['▸']) : null;
          box.appendChild(el('label', { className: 'gs-mavat-row gs-mavat-leaf', style: `padding-right:${depth * 16}px` }, [
            cb,
            el('span', { className: 'gs-mavat-label' }, [cat.label]),
            el('span', { className: 'gs-mavat-count' }, [cat.count ? `(${cat.count})` : '']),
            caret,
          ]));

          if (catDocs.length) {
            const sub = el('div', { className: 'gs-jlm-sub', style: `display:none; margin-right:${depth * 16 + 18}px` }, []);
            const fileCbs = [];
            for (const d of catDocs) {
              const fcb = el('input', { type: 'checkbox', class: 'gs-mavat-cb' });
              // Pre-seed: checked only if the category is on by default AND (no
              // search terms, or this file matches — by name, and optionally by
              // its category titles). The user sees it immediately and can toggle.
              fcb.checked = defOn && (docMatches ? docMatches(d) : true);
              fileCbs.push(fcb);
              sub.appendChild(el('label', { className: 'gs-jlm-leaf' }, [fcb, el('span', {}, [d.name || 'קובץ'])]));
            }
            box.appendChild(sub);
            ui.mavatFileCbs[cat.key] = fileCbs;

            let syncing = false;
            const refreshMaster = () => {
              const on = fileCbs.filter(c => c.checked).length;
              cb.checked = on === fileCbs.length && on > 0;
              cb.indeterminate = on > 0 && on < fileCbs.length;
            };
            fileCbs.forEach(c => c.addEventListener('change', () => {
              if (syncing) return;
              refreshMaster();
              syncing = true; cb.dispatchEvent(new Event('change')); syncing = false; // notify ancestor groups
            }));
            cb.addEventListener('change', () => {
              if (syncing) return; // originated from a file toggle → don't re-sync
              syncing = true;
              for (const c of fileCbs) c.checked = cb.checked;
              syncing = false;
            });
            caret.addEventListener('click', (e) => {
              e.preventDefault();
              const open = sub.style.display === 'none';
              sub.style.display = open ? '' : 'none';
              caret.textContent = open ? '▾' : '▸';
            });
            refreshMaster();
          } else if (docMatches && searchInCats && cat.native) {
            // No per-file drill-down for this category — when category matching is
            // enabled, decide by its own category / sub-category titles.
            cb.checked = defOn && chainHit(cat.chain || [cat.label]);
          }

          ui.mavatChecks.push(cb);
          subCbs.push(cb);
        }
        return subCbs;
      };
      renderNode(root, 0);
      // Explain how mavat downloads work (its own reCAPTCHA-gated ZIP per category).
      const note = el('div', { className: 'gs-mavat-note' }, [
        'הסימון מוצג לפי ברירת המחדל שהגדרת (קטגוריות + מילות חיפוש). אפשר לשנות ידנית — לחצ/י ▸ ליד קטגוריה כדי לבחור קבצים ספציפיים. "הורד" מוריד את המסומן בלבד: הקבצים נאספים דרך מנגנון ההורדה של mavat עצמו ונארזים ל-ZIP אחד, מסודר לפי קטגוריות (תיקייה לכל קטגוריה).',
      ]);
      box.appendChild(note);
      ui.mavatDownloadBtn.style.display = '';
    } catch (e) {
      console.error('[GovScraper] mavat init failed:', e);
      setStatus(ui.progress, `טעינת התוכנית נכשלה: ${errMsg(e)}`, 'error');
    }
  }

  // mavat downloads: we click mavat's OWN per-category ZIP control (so the site
  // generates the reCAPTCHA token and fetches the bytes — we never forge a
  // token). content/mavat-inject.js captures each resulting ZIP blob and
  // suppresses the page's loose per-file save. Here we unpack each category ZIP,
  // fix its legacy-Hebrew filenames, and merge everything into ONE clean ZIP
  // ({planNumber}/{category}/{file}) plus an optional catalog CSV.
  async function runMavatDownload({ match, ui }) {
    if (scrapeInProgress) return;
    const result = ui.mavatResult;
    if (!result) return;
    scrapeInProgress = true;
    cancelRequested = false;
    showActionButtons(ui, true);
    ui.mavatDownloadBtn.disabled = true;

    const nonce = (crypto.randomUUID && crypto.randomUUID()) || String(Date.now()) + Math.random();
    const zipQueue = [];
    let zipWaiter = null;
    const onZipMsg = (e) => {
      if (e.source !== window) return;
      const d = e.data;
      if (!d || d.__gsMavat !== 'zip' || d.nonce !== nonce) return;
      if (zipWaiter) { const w = zipWaiter; zipWaiter = null; w(d.blob); }
      else zipQueue.push(d.blob);
    };
    const nextZip = (timeoutMs) => {
      if (zipQueue.length) return Promise.resolve(zipQueue.shift());
      return new Promise((res, rej) => {
        zipWaiter = res;
        setTimeout(() => { if (zipWaiter === res) { zipWaiter = null; rej(new Error('timeout')); } }, timeoutMs);
      });
    };
    window.addEventListener('message', onZipMsg);

    try {
      const { parsed } = match;
      const mavatMod = await import(chrome.runtime.getURL('scrapers/mavat.js'));
      const csvMod = await import(chrome.runtime.getURL('lib/csv.js'));
      const zipMod = await import(chrome.runtime.getURL('lib/zip.js'));

      // Download whatever is currently selected in the picker. The picker was
      // pre-seeded from the default categories + default search terms at load, so
      // "checked" already reflects the default unless the user changed it. Include
      // a category if its master is checked OR indeterminate (some of its files
      // selected via the drill-down); per-file selection is applied below by key.
      const keys = new Set(ui.mavatChecks.filter(cb => cb.checked || cb.indeterminate).map(cb => cb.dataset.key));
      const chosen = result.categories.filter(c => keys.has(c.key));
      if (!chosen.length) throw new Error('לא נבחרה אף קטגוריה.');

      const nativeCats = chosen.filter(c => c.native);
      const wantCsv = chosen.some(c => !c.native);
      const planFolder = mavatMod.sanitizePlan(result.planNumber);
      const entries = [];
      const takenPerFolder = {};
      let fails = 0;
      const total = nativeCats.length;

      // Drive mavat's own per-category ZIP downloads, capturing each blob.
      window.postMessage({ __gsMavatCmd: 'capture-on', nonce }, location.origin);
      let idx = 0;
      for (const cat of nativeCats) {
        if (cancelRequested) break;
        idx++;
        setProgress(ui.progress, { current: idx - 1, total, message: `מוריד: ${cat.label}`, sub: `${idx}/${total} • אורז בצד mavat (קטגוריה גדולה עשויה לקחת עד 2-3 דקות)…` });
        zipQueue.length = 0; // discard any straggler from a previous (slow) category
        const ok = await mavatMod.clickNativeSection(cat.key);
        if (!ok) { fails++; continue; }
        let blob;
        // Generous timeout — mavat zips large sections (50+ docs) server-side and
        // that can take well over a minute. Too short a wait both loses the
        // category AND lets its late native save leak as a separate download.
        try { blob = await nextZip(180000); }
        catch { fails++; console.warn('[GovScraper] mavat zip capture timed out:', cat.key); continue; }
        try {
          // Nest by the site's full hierarchy chain (CAT_A/CAT_B/…/section).
          // The ZIP file itself is already named per plan. Sanitize each segment.
          const seg = (s) => String(s).replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim();
          const folder = (cat.chain || [cat.label]).map(seg).filter(Boolean).join('/');
          takenPerFolder[folder] = takenPerFolder[folder] || [];
          // mavat's ZIP entry filenames are non-informative (plan-number +
          // placeholders). Rename each file to its real DOC_NAME from the plan
          // JSON, matched to this section's docs by order; keep mavat's actual
          // file extension so the file still opens correctly.
          const zipFiles = await zipMod.readZip(blob);
          const catDocs = mavatMod.docsForChain(result.documents, cat.chain || [cat.label]);
          // Per-file selection: keep just the checked files, matched to ZIP entries
          // by order. A category with no drill-down (docsForChain empty) has no
          // per-file checkboxes → selSet null → keep every file in it.
          const fileCbs = ui.mavatFileCbs ? ui.mavatFileCbs[cat.key] : null;
          const selSet = fileCbs ? new Set(fileCbs.map((c, i) => (c.checked ? i : -1)).filter(i => i >= 0)) : null;
          zipFiles.forEach((f, i) => {
            if (selSet && !selSet.has(i)) return; // unselected file → skip
            const ext = extOf(f.name);
            const doc = catDocs[i];
            const base = (doc && doc.name) ? doc.name : (stripExt(f.name) || cat.label || 'קובץ');
            const name = uniqueNameIn(takenPerFolder[folder], safeFile(base) + ext);
            entries.push({ name: `${folder}/${name}`, data: f.data });
          });
        } catch (e) { fails++; console.error('[GovScraper] mavat unzip failed:', cat.key, e); }
        setProgress(ui.progress, { current: idx, total, message: `מוריד: ${cat.label}`, sub: `${idx}/${total}${fails ? ` • ${fails} כשלים` : ''}` });
      }
      // Keep suppression on a moment longer so a straggler save (from a section
      // that finished right at the timeout) is blocked rather than leaking to disk.
      await new Promise(r => setTimeout(r, 3000));
      window.postMessage({ __gsMavatCmd: 'capture-off', nonce }, location.origin);

      if (cancelRequested) throw new Error('בוטל על-ידי המשתמש');

      // Catalog CSV (local).
      if (wantCsv) {
        entries.push({ name: 'קטלוג.csv', data: csvMod.rowsToCsv(result.rows, result.fields) });
      }
      if (!entries.length) throw new Error('לא נאספו קבצים (ייתכן שכל הקטגוריות נכשלו).');

      setStatus(ui.progress, `אורז ZIP אחד (${entries.length} קבצים)…`, 'info');
      const blob = await zipMod.buildZip(entries);
      const date = new Date().toISOString().slice(0, 10);
      const filename = `mavat_${planFolder}_${date}.zip`;
      const url = URL.createObjectURL(blob);
      const resp = await chrome.runtime.sendMessage({ type: 'package-and-download', payload: { kind: 'blob-url', filename, url, sizeBytes: blob.size } });
      if (!resp?.ok) throw new Error(resp?.error || 'אריזת ה-ZIP נכשלה');

      const fileCount = entries.length - (wantCsv ? 1 : 0);
      setStatus(ui.progress,
        fails ? `הסתיים — ${fileCount} קבצים ב-ZIP אחד (${fails} קטגוריות נכשלו)` : `הסתיים — ${fileCount} קבצים ב-ZIP אחד`,
        fails ? 'error' : 'done');
      await logHistory({ scraper: match.scraper, parsed, result, filename: resp.filename, mode: 'mavat', attachmentCount: fileCount });
    } catch (e) {
      console.error('[GovScraper] mavat download failed:', e);
      setStatus(ui.progress, `ההורדה נכשלה: ${errMsg(e)}`, 'error');
    } finally {
      window.postMessage({ __gsMavatCmd: 'capture-off', nonce }, location.origin);
      window.removeEventListener('message', onZipMsg);
      scrapeInProgress = false;
      showActionButtons(ui, false);
      ui.mavatDownloadBtn.disabled = false;
    }
  }

  // --- עיריית ירושלים (רישוי בנייה) -----------------------------------------

  const JLM_FAVS_KEY = 'jlm.favorites';
  const favKey = (systemCode, tikNum) => `${systemCode || ''}|${tikNum || ''}`;
  async function getFavs() {
    try {
      const v = (await chrome.storage.local.get(JLM_FAVS_KEY))[JLM_FAVS_KEY];
      return Array.isArray(v) ? v : [];
    } catch { return []; }
  }
  async function setFavs(arr) {
    try { await chrome.storage.local.set({ [JLM_FAVS_KEY]: arr }); } catch {}
  }

  // Details URL for a file number — used both to jump into a saved favorite and
  // to save a favorite from the address-list page.
  function jlmDetailsUrl(systemCode, tikNum) {
    return `${location.origin}/#/Details?TikNum=${encodeURIComponent(tikNum)}&SystemCode=${encodeURIComponent(systemCode)}&Page=BakashalInfo`;
  }

  // Scrape the file numbers (e.g. "1992/0699.03") off the address-list grid.
  // Leaf elements whose whole text is exactly a file number = the clickable cells.
  function collectJlmTiksFromDom() {
    const RE = /^\d{3,4}\/\d{3,4}\.\d{1,2}$/;
    const overlay = document.getElementById('govscraper-overlay');
    const out = [];
    const seen = new Set();
    for (const e of document.querySelectorAll('div, td, span, a')) {
      if (overlay && overlay.contains(e)) continue;
      if (e.children && e.children.length) continue; // leaf only
      const t = (e.textContent || '').trim();
      if (!RE.test(t) || seen.has(t)) continue;
      seen.add(t); out.push(t);
    }
    return out;
  }

  const jlmSysLabel = (sc) => (sc === '26400056' ? 'תיק פיקוח' : 'תיק רישוי בנייה');

  async function jlmToggleFav(fav) {
    const cur = await getFavs();
    if (cur.some(f => f.key === fav.key)) await setFavs(cur.filter(f => f.key !== fav.key));
    else await setFavs([fav, ...cur].slice(0, 100));
  }

  // Two clearly separated sections: DOWNLOADS (top) and FAVORITES (bottom).
  async function initJlm({ match, ui }) {
    const box = ui.jlmBox;
    if (!box) return;
    const { parsed } = match;
    const kind = parsed.kind;

    const dlBox = el('div', { className: 'gs-jlm-sec' }, []);
    const favBox = el('div', { className: 'gs-jlm-sec gs-jlm-sec-fav' }, []);
    box.replaceChildren();
    if (kind !== 'jlm_home') box.appendChild(dlBox);
    box.appendChild(favBox);

    const renderFavs = async () => {
      const favs = await getFavs();
      favBox.replaceChildren();
      favBox.appendChild(el('div', { className: 'gs-jlm-sec-title' }, ['⭐ תיקים מועדפים']));
      if (!favs.length) {
        favBox.appendChild(el('div', { className: 'gs-jlm-note' }, ['עדיין אין מועדפים. לחצ/י ☆ ליד תיק כדי לשמור אותו לכניסה מהירה.']));
        return;
      }
      const list = el('div', { className: 'gs-jlm-list' }, []);
      for (const f of favs) {
        const open = el('button', { className: 'gs-jlm-fav', title: 'כניסה לתיק' }, [f.label || f.tikNum]);
        open.addEventListener('click', () => { try { location.assign(f.url); } catch { location.href = f.url; } });
        const del = el('button', { className: 'gs-jlm-del', title: 'הסר מהמועדפים' }, ['✕']);
        del.addEventListener('click', async () => { const cur = await getFavs(); await setFavs(cur.filter(x => x.key !== f.key)); renderFavs(); });
        list.appendChild(el('div', { className: 'gs-jlm-fav-row' }, [open, del]));
      }
      favBox.appendChild(list);
    };

    if (kind === 'jlm_tik') await renderTikDownloads({ parsed, ui, dlBox, renderFavs });
    else if (kind === 'jlm_list') await renderListDownloads({ parsed, ui, dlBox, renderFavs });
    await renderFavs();
  }

  // Address file-list page: a "⬇ download all docs" + "☆ save" per file number.
  async function renderListDownloads({ parsed, ui, dlBox, renderFavs }) {
    const render = async () => {
      const favs = await getFavs();
      const favSet = new Set(favs.map(f => f.key));
      const tiks = collectJlmTiksFromDom();
      dlBox.replaceChildren();
      dlBox.appendChild(el('div', { className: 'gs-jlm-sec-title' }, ['⬇ הורדת תיקים בכתובת זו']));
      if (!tiks.length) {
        dlBox.appendChild(el('div', { className: 'gs-jlm-note' }, ['לא זוהו מספרי תיק בעמוד עדיין. אם הטבלה עוד נטענת — נסה/י שוב בעוד רגע, או פתח/י תיק בלחיצה על מספרו.']));
        return;
      }
      dlBox.appendChild(el('div', { className: 'gs-jlm-note' }, ['לחצ/י על מספר תיק כדי לפתוח אותו (מסמכים + טבלאות), או ⬇ להורדת כל מסמכיו מיד.']));
      const list = el('div', { className: 'gs-jlm-list' }, []);
      for (const tik of tiks) {
        const key = favKey(parsed.systemCode, tik);
        const open = el('button', { className: 'gs-jlm-fav', title: 'פתח/י את התיק' }, [tik]);
        open.addEventListener('click', () => { const u = jlmDetailsUrl(parsed.systemCode, tik); try { location.assign(u); } catch { location.href = u; } });
        const dl = el('button', { className: 'gs-jlm-del', title: `הורד את כל מסמכי תיק ${tik}` }, ['⬇']);
        dl.addEventListener('click', () => runJlmDownloadTik({ ui, systemCode: parsed.systemCode, tikNum: tik, label: `${jlmSysLabel(parsed.systemCode)} ${tik}` }));
        const star = el('button', { className: 'gs-jlm-del' + (favSet.has(key) ? ' gs-jlm-star-on' : ''), title: favSet.has(key) ? 'הסר מהמועדפים' : 'שמור למועדפים' }, [favSet.has(key) ? '★' : '☆']);
        star.addEventListener('click', async () => {
          await jlmToggleFav({ key, tikNum: tik, systemCode: parsed.systemCode, label: `${jlmSysLabel(parsed.systemCode)} ${tik}`, url: jlmDetailsUrl(parsed.systemCode, tik), at: Date.now() });
          render(); renderFavs();
        });
        list.appendChild(el('div', { className: 'gs-jlm-fav-row' }, [open, dl, star]));
      }
      dlBox.appendChild(list);
    };
    await render();
    // The grid can render after the overlay — poll briefly, then re-render.
    let tries = 0;
    const iv = setInterval(() => {
      if (!document.getElementById('govscraper-overlay') || tries++ > 10) { clearInterval(iv); return; }
      if (!scrapeInProgress && collectJlmTiksFromDom().length) { clearInterval(iv); render(); }
    }, 1200);
  }

  // A single file's page: the canonical category tree (document categories +
  // data tables) with counts, per-file drill-down, and download selected / all.
  async function renderTikDownloads({ parsed, ui, dlBox, renderFavs }) {
    dlBox.replaceChildren();
    dlBox.appendChild(el('div', { className: 'gs-jlm-sec-title' }, [`⬇ הורדה — ${parsed.label || 'תיק'}`]));
    const status = el('div', { className: 'gs-jlm-note' }, ['טוען את מבנה התיק…']);
    dlBox.appendChild(status);

    let model;
    try {
      const jlmMod = await import(chrome.runtime.getURL('scrapers/jlm.js'));
      model = await jlmMod.fetchTikFull(parsed.systemCode, parsed.tikNum, {
        onProgress: (p) => { status.textContent = p.total ? `טוען את מבנה התיק… ${p.current}/${p.total}` : 'טוען את מבנה התיק…'; },
      });
    } catch (e) {
      status.textContent = `טעינת התיק נכשלה: ${errMsg(e)}`;
      return;
    }
    ui.jlmModel = model;

    const totalDocs = model.documentCategories.reduce((n, c) => n + c.count, 0);
    if (!totalDocs && !model.dataTables.some(t => t.count)) {
      status.textContent = 'לא נמצאו מסמכים או נתונים לתיק זה.';
      // still allow saving to favorites via the row below
    } else {
      status.remove();
    }

    // default category selection from settings (all on if unset)
    const stored = (await chrome.storage.local.get('jlm.defaultCategories'))['jlm.defaultCategories'];
    const defaults = Array.isArray(stored) ? new Set(stored) : null; // null = all on

    ui.jlmFileCbs = [];   // {catKey, cb, doc}
    ui.jlmTableCbs = [];  // {tableKey, cb}

    // save-to-favorites row (part of downloads block header area)
    const favs = await getFavs();
    const favKeyStr = favKey(parsed.systemCode, parsed.tikNum);
    const saved = favs.some(f => f.key === favKeyStr);
    const star = el('button', { className: 'gs-jlm-add' + (saved ? ' gs-jlm-add-on' : '') },
      [saved ? '★ שמור במועדפים — הסר' : '☆ הוסף למועדפים']);
    star.addEventListener('click', async () => {
      await jlmToggleFav({ key: favKeyStr, tikNum: parsed.tikNum, systemCode: parsed.systemCode, label: parsed.label || parsed.tikNum, url: parsed.originalUrl, at: Date.now() });
      const now = (await getFavs()).some(f => f.key === favKeyStr);
      star.className = 'gs-jlm-add' + (now ? ' gs-jlm-add-on' : '');
      star.textContent = now ? '★ שמור במועדפים — הסר' : '☆ הוסף למועדפים';
      renderFavs();
    });
    dlBox.appendChild(star);

    const tree = el('div', { className: 'gs-jlm-tree' }, []);

    // Documents group — each category is a master checkbox + expandable file list.
    const docCats = model.documentCategories.filter(c => c.count > 0);
    if (docCats.length) {
      tree.appendChild(el('div', { className: 'gs-jlm-group' }, ['מסמכים']));
      for (const cat of docCats) {
        const master = el('input', { type: 'checkbox', class: 'gs-jlm-cb' });
        const fileCbs = [];
        const sub = el('div', { className: 'gs-jlm-sub', style: 'display:none' }, []);
        for (const doc of cat.docs) {
          const fcb = el('input', { type: 'checkbox', class: 'gs-jlm-cb' });
          fcb.checked = defaults ? defaults.has(cat.key) : true;
          ui.jlmFileCbs.push({ catKey: cat.key, catLabel: cat.label, cb: fcb, doc });
          fileCbs.push(fcb);
          const dateTxt = doc.dateIn ? ` · ${doc.dateIn}` : '';
          sub.appendChild(el('label', { className: 'gs-jlm-leaf' }, [fcb, el('span', {}, [doc.descr]), el('span', { className: 'gs-jlm-count' }, [dateTxt])]));
        }
        const refreshMaster = () => {
          const on = fileCbs.filter(c => c.checked).length;
          master.checked = on === fileCbs.length && on > 0;
          master.indeterminate = on > 0 && on < fileCbs.length;
        };
        fileCbs.forEach(c => c.addEventListener('change', refreshMaster));
        master.addEventListener('change', () => { for (const c of fileCbs) c.checked = master.checked; });
        refreshMaster();
        const caret = el('button', { className: 'gs-jlm-caret', title: 'הצג/הסתר קבצים' }, ['▸']);
        caret.addEventListener('click', () => {
          const open = sub.style.display === 'none';
          sub.style.display = open ? '' : 'none';
          caret.textContent = open ? '▾' : '▸';
        });
        tree.appendChild(el('label', { className: 'gs-jlm-cat' }, [
          master, el('span', { className: 'gs-jlm-cat-label' }, [cat.label]),
          el('span', { className: 'gs-jlm-count' }, [`(${cat.count})`]), caret,
        ]));
        tree.appendChild(sub);
      }
    }

    // Data tables group — one CSV per tab.
    const tables = model.dataTables.filter(t => t.count > 0);
    if (tables.length) {
      tree.appendChild(el('div', { className: 'gs-jlm-group' }, ['טבלאות נתונים (CSV)']));
      for (const tbl of tables) {
        const cb = el('input', { type: 'checkbox', class: 'gs-jlm-cb' });
        cb.checked = defaults ? defaults.has(tbl.key) : true;
        ui.jlmTableCbs.push({ tableKey: tbl.key, cb });
        tree.appendChild(el('label', { className: 'gs-jlm-cat' }, [
          cb, el('span', { className: 'gs-jlm-cat-label' }, [tbl.label]),
          el('span', { className: 'gs-jlm-count' }, [`(${tbl.count})`]),
        ]));
      }
    }
    dlBox.appendChild(tree);

    if (docCats.length || tables.length) {
      const selBtn = el('button', { className: 'gs-jlm-add', title: 'מוריד את הפריטים המסומנים' }, ['⬇ הורד נבחרים']);
      selBtn.addEventListener('click', () => runJlmDownloadSelected({ ui, parsed, all: false }));
      const allBtn = el('button', { className: 'gs-jlm-add gs-jlm-add-on', title: 'מוריד את כל המסמכים והטבלאות' }, ['⬇ הורד הכל']);
      allBtn.addEventListener('click', () => runJlmDownloadSelected({ ui, parsed, all: true }));
      dlBox.appendChild(el('div', { className: 'gs-jlm-btns' }, [selBtn, allBtn]));
    }
  }

  // Download all of one file's documents as a single ZIP with informative Hebrew
  // names (documentDescr) + a catalog CSV. Direct-fetch: doc list from the
  // anonymous DB gateway; each file's bytes through the SW proxy (which sets the
  // archive's required Referer + strips Origin via the DNR rule). The real
  // extension isn't in the URL, so we derive it from the response Content-Type.
  async function runJlmDownloadTik({ ui, systemCode, tikNum, label }) {
    if (scrapeInProgress) { try { setStatus(ui.progress, 'הורדה כבר פועלת — המתן/י לסיום או לחצ/י בטל.', 'info'); } catch {} return; }
    scrapeInProgress = true;
    cancelRequested = false;
    showActionButtons(ui, true);
    try {
      const jlmMod = await import(chrome.runtime.getURL('scrapers/jlm.js'));
      const csvMod = await import(chrome.runtime.getURL('lib/csv.js'));
      const zipMod = await import(chrome.runtime.getURL('lib/zip.js'));

      setProgress(ui.progress, { current: 0, total: 0, message: `טוען מסמכים לתיק ${tikNum}…` });
      const result = await jlmMod.fetchTikDocuments(systemCode, tikNum, { onProgress: (p) => setProgress(ui.progress, p) });
      if (cancelRequested) throw new Error('בוטל על-ידי המשתמש');
      const files = (result.attachments || []).filter(a => a.url);
      if (!files.length) throw new Error(result.warning || 'לא נמצאו מסמכים להורדה בתיק זה.');

      async function fetchFileRetry(url) {
        let lastErr;
        for (let n = 0; n < 3; n++) {
          if (cancelRequested) throw new Error('cancelled');
          try { return await jlmMod.fetchDocFile(url); }
          catch (e) { lastErr = e; await new Promise(r => setTimeout(r, 600 * (n + 1) + Math.floor(Math.random() * 400))); }
        }
        throw lastErr;
      }

      setProgress(ui.progress, { current: 0, total: files.length, message: 'מוריד מסמכים…' });
      const batch = [];
      const taken = [];
      let fileIdx = 0, fileFails = 0, okCount = 0;
      await pool(files, 4, async (att) => {
        if (cancelRequested) return;
        try {
          const meta = await fetchFileRetry(att.url);
          const ext = jlmPickExt(att, meta);
          const base = safeFile(att.descr || 'מסמך');
          const name = uniqueNameIn(taken, base + (ext ? `.${ext}` : ''));
          batch.push({ name, data: meta.bytes });
          okCount++;
        } catch { fileFails++; }
        finally {
          fileIdx++;
          setProgress(ui.progress, { current: fileIdx, total: files.length, message: 'מוריד מסמכים', sub: `${fileIdx}/${files.length}${fileFails ? ` • ${fileFails} כשלים` : ''}` });
        }
      }, () => cancelRequested);
      if (cancelRequested) throw new Error('בוטל על-ידי המשתמש');
      if (!batch.length) throw new Error('לא הורד אף מסמך (ייתכן שכל ההורדות נכשלו).');

      const tikSafe = safeFile(tikNum).replace(/[\\/]+/g, '-');
      const entries = [{ name: 'קטלוג.csv', data: csvMod.rowsToCsv(result.rows, result.fields) }, ...batch];
      setStatus(ui.progress, `אורז ZIP (${batch.length} מסמכים)…`, 'info');
      const blob = await zipMod.buildZip(entries);
      const date = new Date().toISOString().slice(0, 10);
      const filename = `jlm_${tikSafe}_${date}.zip`;
      const url = URL.createObjectURL(blob);
      const resp = await chrome.runtime.sendMessage({ type: 'package-and-download', payload: { kind: 'blob-url', filename, url, sizeBytes: blob.size } });
      if (!resp?.ok) throw new Error(resp?.error || 'אריזת ה-ZIP נכשלה');
      setTimeout(() => URL.revokeObjectURL(url), 8000);

      setStatus(ui.progress,
        fileFails ? `הסתיים — ${okCount} מסמכים (${fileFails} נכשלו)` : `הסתיים — ${okCount} מסמכים ב-ZIP אחד`,
        fileFails ? 'error' : 'done');
      try {
        await logHistory({ scraper: { id: 'jlm' }, parsed: { originalUrl: location.href, collectorName: `jlm_${tikSafe}` }, result, filename: resp.filename, mode: 'jlm', attachmentCount: okCount });
      } catch {}
    } catch (e) {
      console.error('[GovScraper] jlm download failed:', e);
      setStatus(ui.progress, `${'ההורדה נכשלה'}: ${errMsg(e)}`, 'error');
    } finally {
      scrapeInProgress = false;
      showActionButtons(ui, false);
    }
  }

  // Download the SELECTED documents (grouped in folders by category) + a CSV per
  // selected data table + a documents catalog, all in one ZIP. `all` overrides
  // the checkboxes (the "download everything" button).
  async function runJlmDownloadSelected({ ui, parsed, all }) {
    if (scrapeInProgress) { try { setStatus(ui.progress, 'הורדה כבר פועלת — המתן/י לסיום או לחצ/י בטל.', 'info'); } catch {} return; }
    const model = ui.jlmModel;
    if (!model) return;
    scrapeInProgress = true;
    cancelRequested = false;
    showActionButtons(ui, true);
    try {
      const selDocs = (ui.jlmFileCbs || []).filter(x => all || x.cb.checked).map(x => ({ ...x.doc, catLabel: x.catLabel }));
      const selTables = (model.dataTables || []).filter(t => t.count > 0 && (all || (ui.jlmTableCbs || []).some(x => x.tableKey === t.key && x.cb.checked)));
      if (!selDocs.length && !selTables.length) throw new Error('לא נבחר דבר להורדה. סמנ/י מסמכים או טבלאות.');

      const jlmMod = await import(chrome.runtime.getURL('scrapers/jlm.js'));
      const csvMod = await import(chrome.runtime.getURL('lib/csv.js'));
      const zipMod = await import(chrome.runtime.getURL('lib/zip.js'));
      const seg = (s) => String(s || '').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim() || 'קטגוריה';

      async function fetchFileRetry(url) {
        let lastErr;
        for (let n = 0; n < 3; n++) {
          if (cancelRequested) throw new Error('cancelled');
          try { return await jlmMod.fetchDocFile(url); }
          catch (e) { lastErr = e; await new Promise(r => setTimeout(r, 600 * (n + 1) + Math.floor(Math.random() * 400))); }
        }
        throw lastErr;
      }

      const entries = [];
      const takenPerFolder = {};
      let fileIdx = 0, fileFails = 0, okCount = 0;
      if (selDocs.length) {
        setProgress(ui.progress, { current: 0, total: selDocs.length, message: 'מוריד מסמכים…' });
        await pool(selDocs, 4, async (doc) => {
          if (cancelRequested) return;
          try {
            const meta = await fetchFileRetry(doc.url);
            const ext = jlmPickExt({ docExtension: doc.docExtension }, meta);
            const folder = `מסמכים/${seg(doc.catLabel)}`;
            takenPerFolder[folder] = takenPerFolder[folder] || [];
            const name = uniqueNameIn(takenPerFolder[folder], safeFile(doc.descr || 'מסמך') + (ext ? `.${ext}` : ''));
            entries.push({ name: `${folder}/${name}`, data: meta.bytes });
            okCount++;
          } catch { fileFails++; }
          finally {
            fileIdx++;
            setProgress(ui.progress, { current: fileIdx, total: selDocs.length, message: 'מוריד מסמכים', sub: `${fileIdx}/${selDocs.length}${fileFails ? ` • ${fileFails} כשלים` : ''}` });
          }
        }, () => cancelRequested);
        if (cancelRequested) throw new Error('בוטל על-ידי המשתמש');
      }

      // One CSV per selected data table (all fields).
      for (const t of selTables) {
        entries.push({ name: `טבלאות/${seg(t.label)}.csv`, data: csvMod.rowsToCsv(t.rows, t.fields) });
      }
      // Documents catalog.
      if (selDocs.length) {
        const catRows = selDocs.map(d => ({ category: d.catLabel, documentDescr: d.descr, dateIn: d.dateIn, docExtension: d.docExtension, urlDoc: d.url }));
        entries.push({ name: 'קטלוג-מסמכים.csv', data: csvMod.rowsToCsv(catRows, ['category', 'documentDescr', 'dateIn', 'docExtension', 'urlDoc']) });
      }
      if (!entries.length) throw new Error('לא נוצר תוכן להורדה (ייתכן שכל ההורדות נכשלו).');

      const tikSafe = safeFile(parsed.tikNum).replace(/[\\/]+/g, '-');
      setStatus(ui.progress, `אורז ZIP (${entries.length} פריטים)…`, 'info');
      const blob = await zipMod.buildZip(entries);
      const date = new Date().toISOString().slice(0, 10);
      const filename = `jlm_${tikSafe}_${date}.zip`;
      const url = URL.createObjectURL(blob);
      const resp = await chrome.runtime.sendMessage({ type: 'package-and-download', payload: { kind: 'blob-url', filename, url, sizeBytes: blob.size } });
      if (!resp?.ok) throw new Error(resp?.error || 'אריזת ה-ZIP נכשלה');
      setTimeout(() => URL.revokeObjectURL(url), 8000);

      const parts = [];
      if (selDocs.length) parts.push(`${okCount} מסמכים${fileFails ? ` (${fileFails} נכשלו)` : ''}`);
      if (selTables.length) parts.push(`${selTables.length} טבלאות`);
      setStatus(ui.progress, `הסתיים — ${parts.join(' + ')}`, fileFails ? 'error' : 'done');
      try {
        await logHistory({ scraper: { id: 'jlm' }, parsed: { originalUrl: location.href, collectorName: `jlm_${tikSafe}` }, result: { rows: selDocs, collectorName: `jlm_${tikSafe}` }, filename: resp.filename, mode: 'jlm', attachmentCount: okCount });
      } catch {}
    } catch (e) {
      console.error('[GovScraper] jlm selected download failed:', e);
      setStatus(ui.progress, `ההורדה נכשלה: ${errMsg(e)}`, 'error');
    } finally {
      scrapeInProgress = false;
      showActionButtons(ui, false);
    }
  }

  // Derive a file extension when it isn't in the doc metadata/URL (the archive
  // serves /api/items/<GUID>). Prefer any explicit ext, then Content-Type, then
  // the disposition filename, then magic bytes.
  function jlmPickExt(att, meta) {
    return (att.docExtension || '').replace(/^\./, '').toLowerCase()
      || extFromContentType(meta.contentType)
      || extFromDisposition(meta.disposition)
      || extFromMagic(meta.bytes)
      || '';
  }
  function extFromContentType(ct) {
    const t = String(ct || '').toLowerCase().split(';')[0].trim();
    const map = {
      'application/pdf': 'pdf', 'image/tiff': 'tif', 'image/jpeg': 'jpg', 'image/jpg': 'jpg',
      'image/png': 'png', 'image/gif': 'gif', 'text/plain': 'txt', 'application/zip': 'zip',
      'application/msword': 'doc', 'application/vnd.ms-excel': 'xls', 'application/vnd.ms-powerpoint': 'ppt',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
    };
    return map[t] || '';
  }
  function extFromDisposition(cd) {
    const m = /filename\*?=(?:UTF-8'')?["']?([^"';]+)/i.exec(String(cd || ''));
    if (!m) return '';
    try { return (extOf(decodeURIComponent(m[1])) || '').replace(/^\./, ''); } catch { return (extOf(m[1]) || '').replace(/^\./, ''); }
  }
  function extFromMagic(bytes) {
    const b = bytes;
    if (!b || b.length < 4) return '';
    const is = (...a) => a.every((v, i) => b[i] === v);
    if (is(0x25, 0x50, 0x44, 0x46)) return 'pdf';            // %PDF
    if (is(0xFF, 0xD8, 0xFF)) return 'jpg';
    if (is(0x89, 0x50, 0x4E, 0x47)) return 'png';
    if (is(0x47, 0x49, 0x46, 0x38)) return 'gif';
    if (is(0x49, 0x49, 0x2A, 0x00) || is(0x4D, 0x4D, 0x00, 0x2A)) return 'tif';
    if (is(0x50, 0x4B, 0x03, 0x04)) return 'zip';            // also docx/xlsx
    if (is(0xD0, 0xCF, 0x11, 0xE0)) return 'doc';            // OLE (doc/xls/ppt)
    if (is(0x7B, 0x5C, 0x72, 0x74, 0x66)) return 'rtf';      // {\rtf
    return '';
  }

  // --- מאגר החקיקה הלאומי (הכנסת) --------------------------------------------

  // A bill's protocols + documents as a category tree: master checkbox + count +
  // expandable per-file selection, "select all" via the download-all button.
  async function initKnesset({ match, ui }) {
    const box = ui.jlmBox;
    if (!box) return;
    const { scraper, parsed } = match;
    const isLaw = parsed.kind === 'knesset_law';
    box.replaceChildren();
    box.appendChild(el('div', { className: 'gs-jlm-sec-title' }, [isLaw ? '⬇ תיקוני חוק ומסמכים' : '⬇ פרוטוקולים ומסמכים']));
    const status = el('div', { className: 'gs-jlm-note' }, [isLaw ? 'טוען את נתוני החוק…' : 'טוען את נתוני הצעת החוק…']);
    box.appendChild(status);

    let result;
    try { result = await scraper.fetch(parsed, { onProgress: (p) => { status.textContent = p.message || 'טוען…'; } }); }
    catch (e) { status.textContent = `טעינה נכשלה: ${errMsg(e)}`; return; }
    ui.knModel = result;

    const cats = result.categories || [];
    if (!cats.length && !(result.dataCsvs || []).length) { status.textContent = result.warning || 'לא נמצאו קבצים להורדה.'; return; }
    status.remove();
    if (result.bill && result.bill.name) box.appendChild(el('div', { className: 'gs-jlm-note' }, [`${result.bill.name}${result.bill.status ? ' · ' + result.bill.status : ''}`]));

    ui.knFileCbs = []; // {catLabel, cb, doc}
    const tree = el('div', { className: 'gs-jlm-tree' }, []);
    for (const cat of cats) {
      const master = el('input', { type: 'checkbox', class: 'gs-jlm-cb' });
      const fileCbs = [];
      const sub = el('div', { className: 'gs-jlm-sub', style: 'display:none' }, []);
      for (const doc of cat.docs) {
        const fcb = el('input', { type: 'checkbox', class: 'gs-jlm-cb' });
        fcb.checked = true;
        ui.knFileCbs.push({ catLabel: cat.label, cb: fcb, doc });
        fileCbs.push(fcb);
        sub.appendChild(el('label', { className: 'gs-jlm-leaf' }, [fcb, el('span', {}, [doc.descr]), el('span', { className: 'gs-jlm-count' }, [doc.ext ? `.${doc.ext}` : ''])]));
      }
      const refreshMaster = () => {
        const on = fileCbs.filter(c => c.checked).length;
        master.checked = on === fileCbs.length && on > 0;
        master.indeterminate = on > 0 && on < fileCbs.length;
      };
      fileCbs.forEach(c => c.addEventListener('change', refreshMaster));
      master.addEventListener('change', () => { for (const c of fileCbs) c.checked = master.checked; });
      refreshMaster();
      const caret = el('button', { className: 'gs-jlm-caret', title: 'הצג/הסתר קבצים' }, ['▸']);
      caret.addEventListener('click', () => { const open = sub.style.display === 'none'; sub.style.display = open ? '' : 'none'; caret.textContent = open ? '▾' : '▸'; });
      tree.appendChild(el('label', { className: 'gs-jlm-cat' }, [master, el('span', { className: 'gs-jlm-cat-label' }, [cat.label]), el('span', { className: 'gs-jlm-count' }, [`(${cat.count})`]), caret]));
      tree.appendChild(sub);
    }

    // Info / data CSV toggles.
    tree.appendChild(el('div', { className: 'gs-jlm-group' }, ['נתונים']));
    const infoCb = el('input', { type: 'checkbox', class: 'gs-jlm-cb' });
    infoCb.checked = true;
    ui.knInfoCb = infoCb;
    tree.appendChild(el('label', { className: 'gs-jlm-cat' }, [infoCb, el('span', { className: 'gs-jlm-cat-label' }, [isLaw ? 'מידע על החוק (CSV)' : 'מידע על הצעת החוק (CSV)'])]));

    // Law pages carry extra catalog CSVs (corrections list, secondary legislation,
    // related bills/laws) for the collections that have no downloadable file.
    ui.knDataCbs = []; // {csv, cb}
    for (const csv of (result.dataCsvs || [])) {
      const dcb = el('input', { type: 'checkbox', class: 'gs-jlm-cb' });
      dcb.checked = true;
      ui.knDataCbs.push({ csv, cb: dcb });
      tree.appendChild(el('label', { className: 'gs-jlm-cat' }, [dcb, el('span', { className: 'gs-jlm-cat-label' }, [csv.label])]));
    }
    box.appendChild(tree);

    const selBtn = el('button', { className: 'gs-jlm-add', title: 'מוריד את הפריטים המסומנים' }, ['⬇ הורד נבחרים']);
    selBtn.addEventListener('click', () => runKnessetDownload({ ui, parsed, all: false }));
    const allBtn = el('button', { className: 'gs-jlm-add gs-jlm-add-on', title: 'מוריד את כל הקבצים' }, ['⬇ הורד הכל']);
    allBtn.addEventListener('click', () => runKnessetDownload({ ui, parsed, all: true }));
    box.appendChild(el('div', { className: 'gs-jlm-btns' }, [selBtn, allBtn]));
  }

  async function runKnessetDownload({ ui, parsed, all }) {
    if (scrapeInProgress) { try { setStatus(ui.progress, 'הורדה כבר פועלת — המתן/י לסיום או לחצ/י בטל.', 'info'); } catch {} return; }
    const model = ui.knModel;
    if (!model) return;
    scrapeInProgress = true;
    cancelRequested = false;
    showActionButtons(ui, true);
    const isLaw = parsed.kind === 'knesset_law';
    try {
      const selDocs = (ui.knFileCbs || []).filter(x => all || x.cb.checked).map(x => ({ ...x.doc, catLabel: x.catLabel }));
      const wantInfo = all || (ui.knInfoCb && ui.knInfoCb.checked);
      const selCsvs = (ui.knDataCbs || []).filter(x => all || x.cb.checked).map(x => x.csv);
      if (!selDocs.length && !wantInfo && !selCsvs.length) throw new Error('לא נבחר דבר להורדה.');

      const knMod = await import(chrome.runtime.getURL('scrapers/knesset.js'));
      const csvMod = await import(chrome.runtime.getURL('lib/csv.js'));
      const zipMod = await import(chrome.runtime.getURL('lib/zip.js'));
      const seg = (s) => String(s || '').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim() || 'קטגוריה';

      async function fetchBytesRetry(url) {
        let lastErr;
        for (let n = 0; n < 3; n++) {
          if (cancelRequested) throw new Error('cancelled');
          try { return await knMod.fetchDocBytes(url); }
          catch (e) { lastErr = e; await new Promise(r => setTimeout(r, 600 * (n + 1) + Math.floor(Math.random() * 400))); }
        }
        throw lastErr;
      }

      const entries = [];
      const takenPerFolder = {};
      let fileIdx = 0, fileFails = 0, okCount = 0;
      if (selDocs.length) {
        setProgress(ui.progress, { current: 0, total: selDocs.length, message: 'מוריד קבצים…' });
        await pool(selDocs, 4, async (doc) => {
          if (cancelRequested) return;
          try {
            const bytes = await fetchBytesRetry(doc.url);
            const folder = seg(doc.catLabel);
            takenPerFolder[folder] = takenPerFolder[folder] || [];
            const name = uniqueNameIn(takenPerFolder[folder], safeFile(doc.descr) + (doc.ext ? `.${doc.ext}` : ''));
            entries.push({ name: `${folder}/${name}`, data: bytes });
            okCount++;
          } catch { fileFails++; }
          finally {
            fileIdx++;
            setProgress(ui.progress, { current: fileIdx, total: selDocs.length, message: 'מוריד קבצים', sub: `${fileIdx}/${selDocs.length}${fileFails ? ` • ${fileFails} כשלים` : ''}` });
          }
        }, () => cancelRequested);
        if (cancelRequested) throw new Error('בוטל על-ידי המשתמש');
      }

      if (wantInfo && model.billInfoRows) entries.push({ name: isLaw ? 'מידע-חוק.csv' : 'מידע-הצעת-חוק.csv', data: csvMod.rowsToCsv(model.billInfoRows, model.billInfoFields) });
      // Extra catalog CSVs (law pages: corrections list, secondary legislation, related bills/laws).
      const takenCsv = [];
      for (const csv of selCsvs) {
        if (!csv || !Array.isArray(csv.rows) || !csv.rows.length) continue;
        const name = uniqueNameIn(takenCsv, safeFile(csv.filename || `${csv.key || 'data'}.csv`));
        entries.push({ name, data: csvMod.rowsToCsv(csv.rows, csv.fields) });
      }
      if (selDocs.length) {
        const catRows = selDocs.map(d => ({ category: d.catLabel, name: d.descr, date: d.date, extension: d.ext, url: d.url }));
        entries.push({ name: 'קטלוג.csv', data: csvMod.rowsToCsv(catRows, ['category', 'name', 'date', 'extension', 'url']) });
      }
      if (!entries.length) throw new Error('לא נוצר תוכן להורדה (ייתכן שכל ההורדות נכשלו).');

      const base = safeFile((model.bill && model.bill.name) || parsed.itemId).slice(0, 60);
      setStatus(ui.progress, `אורז ZIP (${entries.length} פריטים)…`, 'info');
      const blob = await zipMod.buildZip(entries);
      const date = new Date().toISOString().slice(0, 10);
      const filename = `knesset_${base}_${date}.zip`;
      const url = URL.createObjectURL(blob);
      const resp = await chrome.runtime.sendMessage({ type: 'package-and-download', payload: { kind: 'blob-url', filename, url, sizeBytes: blob.size } });
      if (!resp?.ok) throw new Error(resp?.error || 'אריזת ה-ZIP נכשלה');
      setTimeout(() => URL.revokeObjectURL(url), 8000);

      setStatus(ui.progress, `הסתיים — ${okCount} קבצים${fileFails ? ` (${fileFails} נכשלו)` : ''}`, fileFails ? 'error' : 'done');
      try { await logHistory({ scraper: { id: 'knesset' }, parsed: { originalUrl: location.href, collectorName: parsed.collectorName }, result: { rows: selDocs, collectorName: parsed.collectorName }, filename: resp.filename, mode: 'knesset', attachmentCount: okCount }); } catch {}
    } catch (e) {
      console.error('[GovScraper] knesset download failed:', e);
      setStatus(ui.progress, `ההורדה נכשלה: ${errMsg(e)}`, 'error');
    } finally {
      scrapeInProgress = false;
      showActionButtons(ui, false);
    }
  }

  // --- רשות מקרקעי ישראל — איתור תוכניות (תב"ע) ------------------------------

  // The search lives only in the Angular form (content/land-inject.js captures
  // its request body to a DOM bridge). We poll that bridge; once a search
  // exists, we show a quick preview + document-type picker and two outputs:
  // a lightweight CSV index, or the full file ZIP. Both cover EVERY result —
  // collectAllPlans subdivides past the site's 150-row cap.
  async function initLand({ match, ui }) {
    const box = ui.jlmBox;
    if (!box) return;
    let landMod;
    try { landMod = await import(chrome.runtime.getURL('scrapers/land.js')); }
    catch (e) { box.appendChild(el('div', { className: 'gs-jlm-note' }, [`טעינת הסקרייפר נכשלה: ${errMsg(e)}`])); return; }

    box.replaceChildren();
    box.appendChild(el('div', { className: 'gs-jlm-sec-title' }, ['⬇ הורדת תוצאות חיפוש — איתור תוכניות (רמ"י)']));
    const status = el('div', { className: 'gs-jlm-note' }, ['בצע/י חיפוש בעמוד (יישוב / גוש־חלקה / מספר תוכנית) — כאן תופיע אפשרות להציג את התוכניות ולבחור אילו להוריד.']);
    box.appendChild(status);
    const body = el('div', {}, []);
    box.appendChild(body);

    ui.landTypeCbs = [];
    ui.landPlans = null;
    ui.landPlanCbs = [];
    let lastKey = null;

    const render = async () => {
      const criteria = landMod.readSearchCriteria();
      if (!criteria) { body.replaceChildren(); return; } // no search yet — keep the hint
      const key = JSON.stringify(criteria);
      if (key === lastKey) return; // unchanged search → keep the user's picker/selection
      lastKey = key;
      ui.landPlans = null; ui.landPlanCbs = []; // new search → drop any loaded list

      status.textContent = 'טוען תצוגה מקדימה של החיפוש…';
      body.replaceChildren();
      let preview;
      try { preview = await landMod.previewSearch(criteria); }
      catch (e) { status.textContent = `טעינת החיפוש נכשלה: ${errMsg(e)}`; return; }

      const sample = preview.plans || [];
      const total = preview.totalRecords;
      if (!sample.length && !total) { status.textContent = 'לא נמצאו תוצאות לחיפוש הנוכחי.'; return; }

      const totalGuess = total != null ? total : sample.length;
      const capped = (total != null && total > sample.length) || sample.length >= 150;
      status.textContent = total != null
        ? `נמצאו כ-${total.toLocaleString('he-IL')} תוכניות בחיפוש הנוכחי.`
        : `נמצאו ${sample.length} תוכניות בחיפוש הנוכחי.`;

      if (capped) {
        body.appendChild(el('div', { className: 'gs-jlm-note' }, [
          'האתר מציג עד 150 תוצאות בלבד — "הצג רשימת תוכניות" יאסוף את כולן (חלוקת שאילתות לפי סיווג/תאריך) כדי שתוכל/י לבחור.',
        ]));
      }

      // Document-type picker (counts are from the 150-plan sample, as a hint).
      const sampleCount = (key2, single) => sample.reduce((n, p) => {
        const v = p.documentsSet && p.documentsSet[key2];
        return n + (single ? (v && v.path ? 1 : 0) : (Array.isArray(v) ? v.length : 0));
      }, 0);
      body.appendChild(el('div', { className: 'gs-jlm-group' }, ['סוגי מסמכים להורדה']));
      ui.landTypeCbs = [];
      for (const t of landMod.DOC_TYPES) {
        const single = t.key === 'takanon' || t.key === 'mmg';
        const cb = el('input', { type: 'checkbox', class: 'gs-jlm-cb' });
        cb.checked = true;
        cb.dataset.key = t.key;
        ui.landTypeCbs.push(cb);
        const n = sampleCount(t.key, single);
        body.appendChild(el('label', { className: 'gs-jlm-cat' }, [
          cb, el('span', { className: 'gs-jlm-cat-label' }, [t.label]),
          el('span', { className: 'gs-jlm-count' }, [n ? `(מדגם: ${n})` : '(אין במדגם)']),
        ]));
      }
      body.appendChild(el('div', { className: 'gs-jlm-note' }, ['מפת התוכנית (קישור לאתר המפות הממשלתי) נשמרת באינדקס ה-CSV; היא אינה קובץ ולכן אינה נכללת ב-ZIP.']));

      // Render the plan list IMMEDIATELY from the sample the search already
      // returned (one reliable query). If the search is capped at 150, the list
      // offers an opt-in "collect all" that subdivides past the cap — kept
      // optional because that burst of queries can strain the site's server.
      const listWrap = el('div', {}, []);
      body.appendChild(listWrap);
      renderLandPlanList({ match, ui, listWrap, plans: sample, landMod, capped, total: totalGuess, criteria });
    };

    await render();
    const iv = setInterval(() => {
      if (!document.getElementById('govscraper-overlay')) { clearInterval(iv); return; }
      if (!scrapeInProgress) render();
    }, 1500);
  }

  // Collect EVERY plan for the current search (subdivides past the 150 cap),
  // then re-render the list with the full set. Opt-in from the list, because the
  // burst of subdivision queries can strain the site's server; on failure it
  // degrades to whatever it managed to gather + a clear warning.
  async function runLandCollectAll({ match, ui, listWrap, criteria }) {
    if (scrapeInProgress) { try { setStatus(ui.progress, 'פעולה כבר פועלת — המתן/י לסיום או לחצ/י בטל.', 'info'); } catch {} return; }
    scrapeInProgress = true;
    cancelRequested = false;
    showActionButtons(ui, true);
    try {
      const landMod = await import(chrome.runtime.getURL('scrapers/land.js'));
      setProgress(ui.progress, { current: 0, total: 0, message: 'אוסף את כל התוכניות…' });
      const plans = await landMod.collectAllPlans(criteria, {
        onProgress: (p) => setProgress(ui.progress, p),
        isCancelled: () => cancelRequested,
      });
      if (cancelRequested) throw new Error('בוטל על-ידי המשתמש');
      if (!plans.length) throw new Error('לא נאספו תוכניות — ייתכן שהשרת עמוס כרגע. המתן/י מעט ונסה/י שוב.');
      if (plans.serverOverloaded) {
        setStatus(ui.progress, `נאספו ${plans.length} תוכניות בלבד — השרת החל להחזיר שגיאות והעצירה יזומה כדי לא להעמיס עליו. המתן/י מעט ונסה/י שוב לכיסוי מלא.`, 'error');
      } else if (plans.incompleteQueries) {
        setStatus(ui.progress, `נאספו ${plans.length} תוכניות — חלק מהשאילתות נכשלו, ייתכן חוסר. אפשר לנסות שוב.`, 'error');
      } else {
        ui.progress.style.display = 'none';
      }
      renderLandPlanList({ match, ui, listWrap, plans, landMod, capped: false, total: plans.length, criteria });
    } catch (e) {
      console.error('[GovScraper] land collect-all failed:', e);
      setStatus(ui.progress, `איסוף כל התוכניות נכשל: ${errMsg(e)}`, 'error');
    } finally {
      scrapeInProgress = false;
      showActionButtons(ui, false);
    }
  }

  // Render plans as a scrollable, filterable checkbox list with a select-all
  // master + live count, plus the CSV-index / full-ZIP buttons that act on the
  // CHECKED plans. When `capped`, prepends an opt-in "collect all N" button.
  function renderLandPlanList({ match, ui, listWrap, plans, landMod, capped, total, criteria }) {
    listWrap.replaceChildren();
    ui.landPlans = plans;
    const allKeys = landMod.DOC_TYPES.map(t => t.key);

    if (capped) {
      listWrap.appendChild(el('div', { className: 'gs-jlm-note' }, [
        `מוצגות ${plans.length} מתוך כ-${(total || plans.length).toLocaleString('he-IL')} תוכניות (מגבלת האתר). אפשר להוריד את המוצגות, או לאסוף את כולן:`,
      ]));
      const allBtn = el('button', { className: 'gs-jlm-add', title: 'אוסף את כל התוכניות בחיפוש (עוקף את מגבלת 150 — עשוי לקחת זמן, ולעיתים חלקי אם השרת עמוס)' }, [`⤓ אסוף את כל ${(total || plans.length).toLocaleString('he-IL')} התוכניות`]);
      allBtn.addEventListener('click', () => runLandCollectAll({ match, ui, listWrap, criteria }));
      listWrap.appendChild(allBtn);
    }

    // Controls: select-all master + live count.
    const selAll = el('input', { type: 'checkbox', class: 'gs-jlm-cb' });
    selAll.checked = true;
    const countLbl = el('span', { className: 'gs-jlm-count' }, ['']);
    listWrap.appendChild(el('label', { className: 'gs-jlm-cat' }, [
      selAll, el('span', { className: 'gs-jlm-cat-label' }, ['בחר/נקה הכל']), countLbl,
    ]));

    // Free-text filter (plan number / locality / essence).
    const filter = el('input', { type: 'text', class: 'gs-land-filter', placeholder: 'סינון לפי מספר תוכנית / יישוב / מהות…' });
    filter.style.cssText = 'width:100%;box-sizing:border-box;margin:2px 0 6px;padding:4px 6px;font-size:12px;';
    listWrap.appendChild(filter);

    const listEl = el('div', { className: 'gs-jlm-tree' }, []);
    listEl.style.cssText = 'max-height:260px;overflow-y:auto';
    ui.landPlanCbs = [];
    const rows = [];
    for (const p of plans) {
      const cb = el('input', { type: 'checkbox', class: 'gs-jlm-cb' });
      cb.checked = true;
      const nFiles = landMod.planFiles(p, allKeys).filter(f => landMod.isDownloadableUrl(f.url)).length;
      const label = [p.planNumber || '—', p.cityText || '', p.mahut || ''].filter(Boolean).join(' · ');
      const titleTxt = `${label}${p.status ? '\n' + p.status : ''}${p.statusDate ? ' · ' + String(p.statusDate).trim() : ''}`;
      const row = el('label', { className: 'gs-jlm-leaf', title: titleTxt }, [
        cb, el('span', {}, [label]), el('span', { className: 'gs-jlm-count' }, [`(${nFiles})`]),
      ]);
      cb.addEventListener('change', updateCount);
      listEl.appendChild(row);
      ui.landPlanCbs.push({ planId: p.planId, cb, plan: p });
      rows.push({ row, cb, text: label.toLowerCase() });
    }
    listWrap.appendChild(listEl);

    function updateCount() {
      const on = ui.landPlanCbs.filter(x => x.cb.checked).length;
      countLbl.textContent = `נבחרו ${on} מתוך ${plans.length}`;
      selAll.checked = on === plans.length;
      selAll.indeterminate = on > 0 && on < plans.length;
    }
    selAll.addEventListener('change', () => {
      for (const x of ui.landPlanCbs) x.cb.checked = selAll.checked;
      updateCount();
    });
    filter.addEventListener('input', () => {
      const term = filter.value.trim().toLowerCase();
      for (const r of rows) r.row.style.display = (!term || r.text.includes(term)) ? '' : 'none';
    });
    updateCount();

    const csvBtn = el('button', { className: 'gs-jlm-add', title: 'מוריד CSV עם התוכניות שנבחרו והקבצים שלהן (כולל קישורים ישירים) — מהיר, בלי להוריד את הקבצים עצמם' }, ['⬇ אינדקס CSV (נבחרים)']);
    csvBtn.addEventListener('click', () => runLandDownload({ match, ui, mode: 'csv' }));
    const zipBtn = el('button', { className: 'gs-jlm-add gs-jlm-add-on', title: 'מוריד את כל הקבצים של התוכניות שנבחרו, בתיקייה לכל תוכנית, + אינדקס CSV' }, ['⬇ הורד קבצים (ZIP, נבחרים)']);
    zipBtn.addEventListener('click', () => runLandDownload({ match, ui, mode: 'zip' }));
    listWrap.appendChild(el('div', { className: 'gs-jlm-btns' }, [csvBtn, zipBtn]));
  }

  async function runLandDownload({ match, ui, mode }) {
    if (scrapeInProgress) { try { setStatus(ui.progress, 'הורדה כבר פועלת — המתן/י לסיום או לחצ/י בטל.', 'info'); } catch {} return; }
    scrapeInProgress = true;
    cancelRequested = false;
    const { scraper, parsed } = match;
    showActionButtons(ui, true);
    try {
      const landMod = await import(chrome.runtime.getURL('scrapers/land.js'));
      const csvMod = await import(chrome.runtime.getURL('lib/csv.js'));
      const zipMod = await import(chrome.runtime.getURL('lib/zip.js'));

      const criteria = landMod.readSearchCriteria();
      if (!criteria) throw new Error('לא זוהה חיפוש פעיל. בצע/י חיפוש בעמוד ונסה/י שוב.');
      const types = (ui.landTypeCbs || []).filter(cb => cb.checked).map(cb => cb.dataset.key);
      if (!types.length) throw new Error('בחר/י לפחות סוג מסמך אחד.');

      // Use the plans the user selected from the loaded list. If the list wasn't
      // loaded (shouldn't happen — buttons live inside it), fall back to
      // collecting everything.
      let plans;
      if (Array.isArray(ui.landPlans)) {
        plans = (ui.landPlanCbs || []).filter(x => x.cb.checked).map(x => x.plan);
        if (!plans.length) throw new Error('לא נבחרה אף תוכנית. סמנ/י תוכניות ברשימה.');
      } else {
        setProgress(ui.progress, { current: 0, total: 0, message: 'אוסף את כל התוכניות…' });
        plans = await landMod.collectAllPlans(criteria, { onProgress: (p) => setProgress(ui.progress, p), isCancelled: () => cancelRequested });
        if (cancelRequested) throw new Error('בוטל על-ידי המשתמש');
        if (!plans.length) throw new Error('לא נמצאו תוכניות עבור החיפוש הנוכחי.');
      }

      const date = new Date().toISOString().slice(0, 10);
      const base = sanitizeFilename(`land_${[criteria.planNumber, criteria.city != null && criteria.city !== '' ? 'city' + criteria.city : '', criteria.gush ? 'gush' + criteria.gush : ''].filter(Boolean).join('_') || 'plans'}`);
      const indexCsv = csvMod.rowsToCsv(landMod.plansToRows(plans), landMod.indexFields());
      const fileRows = landMod.plansToFileRows(plans, types);
      const filesCsv = csvMod.rowsToCsv(fileRows, landMod.fileIndexFields());

      // --- CSV index mode: just the two catalogs, no file bytes. ---
      if (mode === 'csv') {
        setStatus(ui.progress, `אורז אינדקס (${plans.length} תוכניות, ${fileRows.length} קבצים)…`, 'info');
        const entries = [
          { name: 'תוכניות.csv', data: indexCsv },
          { name: 'קבצים.csv', data: filesCsv },
        ];
        const blob = await zipMod.buildZip(entries);
        const filename = `${base}_index_${date}.zip`;
        const url = URL.createObjectURL(blob);
        const resp = await chrome.runtime.sendMessage({ type: 'package-and-download', payload: { kind: 'blob-url', filename, url, sizeBytes: blob.size } });
        if (!resp?.ok) throw new Error(resp?.error || 'ההורדה נכשלה');
        setTimeout(() => URL.revokeObjectURL(url), 8000);
        setStatus(ui.progress, `הסתיים — ${plans.length} תוכניות, ${fileRows.length} קבצים באינדקס`, 'done');
        await logHistory({ scraper, parsed, result: { rows: plans, collectorName: parsed.collectorName }, filename, mode: 'land_index', attachmentCount: fileRows.length });
        return;
      }

      // --- Full ZIP mode: download every file, folder per plan. ---
      const attachments = landMod.plansToAttachments(plans, types);
      if (!attachments.length) throw new Error('לא נמצאו קבצים בסוגים שנבחרו. נסה/י "אינדקס CSV" או סמן/י סוגי מסמכים אחרים.');

      async function fetchBytesRetry(url) {
        let lastErr;
        for (let n = 0; n < 3; n++) {
          if (cancelRequested) throw new Error('cancelled');
          try { return await landMod.fetchFileBytes(url, { isCancelled: () => cancelRequested }); }
          catch (e) { lastErr = e; await new Promise(r => setTimeout(r, 600 * (n + 1) + Math.floor(Math.random() * 500))); }
        }
        throw lastErr;
      }

      const MAX_FILES_PER_PART = 250; // bounds peak memory per ZIP part
      const multiPart = attachments.length > MAX_FILES_PER_PART;
      let fileIdx = 0, fileFails = 0, okCount = 0, part = 0, prevUrl = null;

      setProgress(ui.progress, { current: 0, total: attachments.length, message: 'מוריד קבצים…' });
      for (let start = 0; start < attachments.length && !cancelRequested; start += MAX_FILES_PER_PART) {
        const chunk = attachments.slice(start, start + MAX_FILES_PER_PART);
        const batch = [];
        const taken = [];
        await pool(chunk, 4, async (att) => {
          if (cancelRequested) return;
          try {
            const bytes = await fetchBytesRetry(att.url);
            batch.push({ name: uniqueNameIn(taken, att.filename), data: bytes });
            okCount++;
          } catch { fileFails++; }
          finally {
            fileIdx++;
            setProgress(ui.progress, { current: fileIdx, total: attachments.length, message: 'מוריד קבצים', sub: `${fileIdx}/${attachments.length}${multiPart ? ` • חלק ${part + 1}` : ''}${fileFails ? ` • ${fileFails} כשלים` : ''}` });
          }
        }, () => cancelRequested);
        if (!batch.length) continue;
        part++;
        const entries = part === 1
          ? [{ name: 'תוכניות.csv', data: indexCsv }, { name: 'קבצים.csv', data: filesCsv }, ...batch]
          : batch;
        setStatus(ui.progress, multiPart ? `אורז ZIP — חלק ${part} (${batch.length} קבצים)…` : `אורז ZIP (${batch.length} קבצים)…`, 'info');
        const blob = await zipMod.buildZip(entries);
        const filename = multiPart ? `${base}_${date}_part${String(part).padStart(2, '0')}.zip` : `${base}_${date}.zip`;
        const url = URL.createObjectURL(blob);
        const resp = await chrome.runtime.sendMessage({ type: 'package-and-download', payload: { kind: 'blob-url', filename, url, sizeBytes: blob.size } });
        if (!resp?.ok) throw new Error(resp?.error || 'אריזת ה-ZIP נכשלה');
        if (prevUrl) URL.revokeObjectURL(prevUrl);
        prevUrl = url;
      }
      if (prevUrl) setTimeout(() => URL.revokeObjectURL(prevUrl), 8000);
      if (cancelRequested) throw new Error('בוטל על-ידי המשתמש');
      if (!part) throw new Error('לא הורד אף קובץ (ייתכן שכל ההורדות נכשלו).');

      setStatus(ui.progress,
        `הסתיים — ${plans.length} תוכניות, ${okCount} קבצים${multiPart ? ` ב-${part} קבצי ZIP` : ''}${fileFails ? ` (${fileFails} נכשלו)` : ''}`,
        fileFails ? 'error' : 'done');
      await logHistory({ scraper, parsed, result: { rows: plans, collectorName: parsed.collectorName }, filename: `${base} (${part} ZIP)`, mode: 'land', attachmentCount: okCount });
    } catch (e) {
      console.error('[GovScraper] land download failed:', e);
      setStatus(ui.progress, `${'ההורדה נכשלה'}: ${errMsg(e)}`, 'error');
    } finally {
      scrapeInProgress = false;
      showActionButtons(ui, false);
    }
  }

  function safeFile(s) {
    const clean = String(s || 'file').replace(/[\\\/:*?"<>|\r\n\t]+/g, '_');
    if (clean.length <= 150) return clean || 'file';
    // Truncate the stem, not the extension — "…long name.docx" must stay a .docx.
    const ext = extOf(clean);
    return clean.slice(0, 150 - ext.length) + ext;
  }
  function extOf(n) { const m = /\.[a-z0-9]{1,5}$/i.exec(String(n || '')); return m ? m[0].toLowerCase() : ''; }
  function stripExt(n) { const s = String(n || ''); const e = extOf(s); return e ? s.slice(0, -e.length) : s; }
  function uniqueNameIn(taken, name) {
    if (!taken.includes(name)) { taken.push(name); return name; }
    const dot = name.lastIndexOf('.');
    const base = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    for (let i = 2; ; i++) {
      const c = `${base}_${i}${ext}`;
      if (!taken.includes(c)) { taken.push(c); return c; }
    }
  }

  function remove() {
    if (overlayEl) { overlayEl.remove(); overlayEl = null; }
  }

  window.GovScraperOverlay = { show, remove };
})();
