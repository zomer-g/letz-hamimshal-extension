# לץ הממשל — GovScraper (Chrome/Edge extension)

A Manifest-V3 browser extension that detects open-data pages on Israeli
government sites and lets you download the underlying dataset **entirely in your
own browser** — no server, no account, nothing leaves your machine except the
same requests the site already makes.

When you open a supported page, a small floating window appears offering to
download the dataset as **CSV / GeoJSON / ZIP**.

## Supported sites

| Site | What you get |
|------|--------------|
| `www.gov.il` | DynamicCollector / Traditional Collector / content-page datasets → CSV (+ attached files) |
| `www.nadlan.gov.il` | Real-estate deal history (parcel / street / neighborhood / settlement) → CSV |
| `www.govmap.gov.il` | GIS layers → GeoJSON (WGS84) + CSV (WGS84 `geometry_wkt`), packaged in a ZIP |
| `mavat.iplan.gov.il` | Planning-authority plans → all documents, organized by the plan's category tree, with per-file selection |
| `www.idf.il` | Allowlisted unit-site document sections → the PDFs/DOCs + a CSV index |
| `geo.mot.gov.il` (חצב) | Displayed map layers → geometry (GeoJSON + CSV) and/or the data.gov.il layer files |
| `ykpubdata.jerusalem.muni.il` | Jerusalem building-licensing files (תיק רישוי בנייה) → documents by category + a CSV per data tab |
| `main.knesset.gov.il` (מאגר החקיקה) | Bill/law pages → session protocols, draft laws & background documents, with per-file selection |

## Why it needs no server

The user's browser has already cleared each site's anti-bot / auth layer (e.g.
Cloudflare on gov.il) by the time they reach the page. A content script's
same-origin `fetch()` reuses those cookies, so the extension can call the site's
own data API directly. Cross-origin calls to allowlisted government API hosts are
proxied through the service worker, which **never** forwards the user's cookies
cross-origin.

### Security posture

- **No CAPTCHA / bot-detection bypass.** Where a site gates data or downloads
  behind reCAPTCHA (e.g. mavat, nadlan), the extension does **not** forge tokens.
  It passively captures the responses the page itself produces, or drives the
  site's own buttons so the site runs its own reCAPTCHA.
- The service worker only talks to an **allowlist** of government API hosts, only
  accepts messages from content scripts running on the supported hosts, and only
  triggers downloads for `blob:` URLs it minted itself.
- No analytics, no tracking, no remote code. All processing is local.

## Geospatial output (GovMap / חצב)

Geometry is published as a **WGS84** GeoJSON sidecar plus a CSV whose
`geometry_wkt` column holds the full geometry as WKT in **ITM (EPSG:6991)** — the
current authoritative Survey-of-Israel datum. Load the CSV in QGIS via
*Add Delimited Text Layer → WKT column → CRS EPSG:6991*.

## Development

```bash
# Load unpacked: chrome://extensions → Developer mode → Load unpacked → this dir
node build-zip.cjs                 # build the CWS upload zip
node build-zip.cjs --target=firefox  # Firefox/AMO variant
npm test                           # zero-dependency Node test suite
```

No `npm install` — the build and tests use only Node built-ins.

## Tests

Zero-dependency Node tests (`node tests/run-all.mjs`). Coverage includes URL →
scraper routing, RFC-4180 CSV escaping, ZIP round-trip + Hebrew filename
encodings, gov.il response transforms, and ITM↔WGS84 projection parity.

## Architecture

```
content/detector.js   → matches the URL, decides if the page is scrapeable
content/overlay.js    → the floating UI; drives the scrape/download
content/*-inject.js   → MAIN-world hooks that capture a page's own API responses
scrapers/<source>.js  → per-site parseUrl + fetch + flatten
lib/csv.js, zip.js    → build CSV/ZIP in-page
background/service-worker.js → allowlisted proxy fetch + chrome.downloads
```

## Privacy

The extension stores only local settings and a short download history in
`chrome.storage.local`. See [PRIVACY_POLICY.md](PRIVACY_POLICY.md).

## License

[MIT](LICENSE).
