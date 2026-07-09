// Deep-scrape helper — for each row in a traditional/dynamic collector listing,
// fetch the linked /he/pages/<name> content page and extract its attached files
// (PDF, DOCX, XLSX, ...). Returns file URLs + metadata so the orchestrator can
// download them and bundle into the final ZIP.
//
// Canonical source for attachments is `contentSub.filesToDownload.filesGroupItems[].items[]`
// — a structured array gov.il populates per posting. Each item carries fileName,
// displayName, extension, fileSize, fileMime, and a fully-qualified URL on
// www.gov.il/BlobFolder/<path>. Anchor scraping inside `htmlContents` is kept
// as a secondary fallback for the rare page that links files inline.

import { smartFetch } from '../lib/fetch-proxy.js';

const BASE_URL = 'https://www.gov.il';
const FILE_EXT_RE = /\.(pdf|docx?|xlsx?|pptx?|csv|txt|zip|rtf|odt|ods|odp|jpg|jpeg|png)(\?|#|$)/i;

export async function discoverContentPageAttachments(itemUrl, runtime) {
  if (!itemUrl) return [];
  let path;
  try {
    const u = new URL(itemUrl, BASE_URL);
    path = u.pathname;
  } catch { return []; }

  const m = path.match(/\/he\/pages\/([^/?#]+)/i);
  if (!m) return [];
  const name = m[1];

  const apiBase = `${runtime.contentPageApiBase}/api/content-pages`;
  const url = `${apiBase}/${encodeURIComponent(name)}?culture=he`;
  const headers = {};
  if (runtime.clientId) headers['x-client-id'] = runtime.clientId;

  let data;
  try {
    const resp = await smartFetch(url, { headers });
    if (!resp.ok) return [];
    data = await resp.json();
  } catch { return []; }

  const out = [];
  const seen = new Set();

  // PRIMARY: structured filesToDownload list
  const groups = data?.contentSub?.filesToDownload?.filesGroupItems || [];
  for (const group of groups) {
    const groupTitle = (group?.title || '').trim();
    const items = Array.isArray(group?.items) ? group.items : [];
    for (const item of items) {
      const rawUrl = item?.url;
      if (typeof rawUrl !== 'string' || !rawUrl) continue;
      const norm = normalizeFileUrl(rawUrl);
      if (!norm || seen.has(norm)) continue;
      seen.add(norm);
      const ext = (item.extension || guessExt(rawUrl) || '').toLowerCase().replace(/^\./, '');
      const displayName = (item.displayName || item.fileName || '').trim();
      const filename = chooseFilename({
        displayName,
        fileName: item.fileName,
        url: rawUrl,
        ext,
      });
      out.push({
        url: norm,
        filename,
        displayName: displayName || filename,
        ext,
        fileSize: numericSize(item.fileSize),
        groupTitle,
        sourcePath: path,
      });
    }
  }

  // SECONDARY: anchor scan inside htmlContents (catches inline-embedded files)
  const blobs = data?.contentMain?.htmlContents || [];
  for (const blob of blobs) {
    const html = blob?.sectionData || '';
    const anchorRe = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let am;
    while ((am = anchorRe.exec(html))) {
      let href = am[1];
      if (!href || !looksLikeFile(href)) continue;
      if (href.startsWith('/')) href = `${BASE_URL}${href}`;
      else if (!/^https?:\/\//i.test(href)) continue;
      const norm = normalizeFileUrl(href);
      if (!norm || seen.has(norm)) continue;
      seen.add(norm);
      const text = am[2].replace(/<[^>]+>/g, '').trim();
      const ext = (guessExt(href) || '').toLowerCase();
      out.push({
        url: norm,
        filename: chooseFilename({ displayName: text, url: href, ext }),
        displayName: text || '',
        ext,
        fileSize: null,
        groupTitle: '',
        sourcePath: path,
      });
    }
  }

  return out;
}

function looksLikeFile(href) {
  const lower = href.split('?')[0].toLowerCase();
  if (FILE_EXT_RE.test(lower)) return true;
  return /\/blobfolder\//i.test(lower);
}

function normalizeFileUrl(rawUrl) {
  try {
    // BlobFolder URLs often arrive with spaces + Hebrew in the path. fetch()
    // tolerates Hebrew but trips on raw spaces; encodeURI normalizes both
    // without disturbing already-encoded segments.
    const trimmed = String(rawUrl).trim();
    if (!trimmed) return null;
    return encodeURI(decodeURI(trimmed));
  } catch {
    return rawUrl;
  }
}

function guessExt(url) {
  const m = String(url).split('?')[0].match(FILE_EXT_RE);
  return m ? m[1].toLowerCase() : '';
}

function chooseFilename({ displayName, fileName, url, ext }) {
  // Prefer fileName (already includes extension), then displayName + ext, then
  // URL's last path segment, finally a synthesized name.
  if (typeof fileName === 'string' && fileName.trim()) return sanitize(fileName.trim());
  if (typeof displayName === 'string' && displayName.trim()) {
    const dn = displayName.trim();
    return sanitize(ext && !dn.toLowerCase().endsWith(`.${ext}`) ? `${dn}.${ext}` : dn);
  }
  try {
    const last = new URL(url, BASE_URL).pathname.split('/').filter(Boolean).pop() || '';
    if (last) return sanitize(decodeURIComponent(last));
  } catch {}
  return `file.${ext || 'bin'}`;
}

function sanitize(name) {
  return String(name).replace(/[\\\/:*?"<>|\r\n\t]+/g, '_').slice(0, 180) || 'file';
}

function numericSize(v) {
  if (v == null) return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}
