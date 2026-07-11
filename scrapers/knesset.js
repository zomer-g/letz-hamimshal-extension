// מאגר החקיקה הלאומי (הכנסת) — main.knesset.gov.il/apps/legislation
// Bill / law pages, each with a collection of protocols (Sessions) plus draft
// laws, legal documents and background material. The user selects protocols /
// documents (or all) and downloads every file at once.
//
// DIRECT-FETCH (verified live 2026-07-11 — see memory knesset-legislation-api):
//   Bill API — anonymous, ACAO:*:
//     GET https://www.knesset.gov.il/WebSiteApi/knessetapi/LegislationItem/GetLegislationBillItem?ItemId=<id>
//   The HTML page sits behind an anti-bot challenge, but the API + the file host
//   are anonymous, so the content script fetches the API directly (cross-subdomain,
//   ACAO:*) and downloads file bytes through the SW proxy.
//   Files: `sessionAndDocs.Sessions[].ProtocolUrl` (protocols) and the other
//   collections' `FilePath`. URLs use Windows backslashes → normalize `\`→`/`.
//   Host fs.knesset.gov.il, anonymous, real extensions in the path.

import { smartFetchBytes } from '../lib/fetch-proxy.js';

const HOST = 'main.knesset.gov.il';
const BILL_API = 'https://www.knesset.gov.il/WebSiteApi/knessetapi/LegislationItem/GetLegislationBillItem?ItemId=';

// sessionAndDocs collections → Hebrew category labels (protocols first). Each
// collection's rows are either Session-shaped (ProtocolUrl/StepTitle/SessionDate)
// or file-shaped (FilePath/FileText/FileDate); fileOf/nameOf/dateOf handle both.
const COLLECTIONS = [
  ['Sessions', 'פרוטוקולים'],
  ['DraftLaws', 'הצעות חוק'],
  ['LegalDocuments', 'מסמכים משפטיים'],
  ['GovernmentDocuments', 'מסמכי ממשלה'],
  ['DocumentsAccompanyingBills', 'מסמכים נלווים להצעת החוק'],
  ['GeneralBackgroundMaterial', 'חומר רקע כללי'],
  ['SessionslBackgroundMaterial', 'חומר רקע לישיבות'],
  ['DiscussionsOfProcedureToCorrectAnError', 'דיוני נוהל לתיקון טעות'],
  ['FollowUpDiscussions', 'דיוני מעקב'],
];

export const knessetScraper = {
  id: 'knesset',
  label: 'מאגר החקיקה הלאומי (הכנסת)',

  parseUrl(href) {
    let u;
    try { u = new URL(href); } catch { return null; }
    if ((u.hostname || '').toLowerCase() !== HOST) return null;
    // /apps/legislation/main/bills/<id>  (path or hash-routed)
    const path = `${u.pathname}${u.hash || ''}`;
    const m = /\/legislation\/[^?#]*\/bills\/(\d+)/i.exec(path);
    if (!m) return null;
    const itemId = m[1];
    return {
      scraperId: 'knesset',
      kind: 'knesset_bill',
      itemId,
      originalUrl: href,
      label: `הצעת חוק — ${itemId}`,
      collectorName: `knesset_bill_${itemId}`,
    };
  },

  async fetch(parsed, { onProgress } = {}) {
    onProgress?.({ phase: 'scrape', current: 0, total: 0, message: 'טוען את נתוני הצעת החוק…' });
    const data = await fetchJson(BILL_API + encodeURIComponent(parsed.itemId));
    const model = buildBillModel(data);

    // Flat rows for a catalog CSV (all files across categories).
    const rows = [];
    const attachments = [];
    for (const cat of model.categories) {
      for (const d of cat.docs) {
        rows.push({ category: cat.label, name: d.descr, date: d.date, extension: d.ext, url: d.url });
        attachments.push({ url: d.url, filename: `${cat.label}/${d.descr}${d.ext ? '.' + d.ext : ''}` });
      }
    }
    onProgress?.({ phase: 'scrape', current: rows.length, total: rows.length, message: `נמצאו ${rows.length} קבצים` });

    return {
      ...model, // { bill, categories, billInfoRows, billInfoFields }
      rows,
      fields: ['category', 'name', 'date', 'extension', 'url'],
      attachments,
      sourceUrl: parsed.originalUrl,
      collectorName: parsed.collectorName,
      kind: parsed.kind,
      total: rows.length,
      warning: rows.length ? null : 'לא נמצאו קבצים בהצעת חוק זו.',
    };
  },
};

// Download a file's bytes (cross-origin fs.knesset.gov.il → SW proxy).
export function fetchDocBytes(url) {
  return smartFetchBytes(url);
}

// Build the category model from the bill JSON.
export function buildBillModel(data) {
  const g = (data && data.general) || {};
  const sd = (data && data.sessionAndDocs) || {};

  const categories = [];
  for (const [srcKey, label] of COLLECTIONS) {
    const arr = Array.isArray(sd[srcKey]) ? sd[srcKey] : [];
    const docs = [];
    arr.forEach((r, i) => {
      const url = fileOf(r);
      if (!url) return; // rows without a file (e.g. a session with no protocol yet)
      const base = nameOf(r) || `פריט_${i + 1}`;
      const date = dateOf(r);
      docs.push({ descr: date ? `${base} (${date})` : base, url, ext: extFromUrl(url), date });
    });
    if (docs.length) categories.push({ key: srcKey, label, docs, count: docs.length });
  }

  // Bill-info CSV (one row of the headline metadata).
  const billInfoRows = [{
    Id: g.Id, Name: g.Name, Status: g.Status, SubType: g.SubType,
    PrivateNumber: g.PrivateNumber, Knesset: g.Knesset, CommitteeName: g.CommitteeName,
    Initiators: g.Initiators, SummaryLaw: stripHtml(g.SummaryLaw),
  }];
  const billInfoFields = Object.keys(billInfoRows[0]);

  return {
    bill: { id: g.Id, name: g.Name || '', status: g.Status || '' },
    categories, billInfoRows, billInfoFields,
  };
}

// --- helpers ---------------------------------------------------------------

async function fetchJson(url) {
  const resp = await fetch(url, { method: 'GET', credentials: 'omit', headers: { Accept: 'application/json' } });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

function normUrl(u) { return String(u || '').replace(/\\/g, '/').trim(); }
function fileOf(r) { return normUrl(r.ProtocolUrl || r.FilePath || ''); }
function nameOf(r) { return String(r.StepTitle || r.FileText || r.Location || '').trim(); }
function dateOf(r) {
  const s = String(r.SessionDate || r.FileDate || '').trim();
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s); // ISO → keep date part; DD/MM/YYYY kept as-is
  return m ? m[1] : s;
}
function extFromUrl(url) {
  const s = String(url || '').split(/[?#]/)[0];
  const m = /\.([a-z0-9]{1,5})$/i.exec(s);
  return m ? m[1].toLowerCase() : '';
}
function stripHtml(s) {
  return String(s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim();
}
