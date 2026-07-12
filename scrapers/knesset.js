// מאגר החקיקה הלאומי (הכנסת) — main.knesset.gov.il/apps/legislation
// TWO page kinds:
//   • Bill  (/bills/<id>)  — a single legislative process: protocols (Sessions)
//     plus draft laws, legal documents and background material.
//   • Law   (/laws/<id>)   — a consolidated law (e.g. חוק התכנון והבנייה) whose
//     `corrections.listCorrections` are the published amendments, each a PDF.
// The user selects items (or all) and downloads every file at once.
//
// DIRECT-FETCH (verified live 2026-07-11/12 — see memory knesset-legislation-api):
//   APIs — anonymous, ACAO:*:
//     GET …/knessetapi/LegislationItem/GetLegislationBillItem?ItemId=<id>
//     GET …/knessetapi/LegislationItem/GetLegislationLawItem?ItemId=<id>
//   The HTML page sits behind an anti-bot challenge, but the API + the file host
//   are anonymous, so the content script fetches the API directly (cross-subdomain,
//   ACAO:*) and downloads file bytes through the SW proxy.
//   Bill files: `sessionAndDocs.Sessions[].ProtocolUrl` (protocols) and the other
//   collections' `FilePath`. Law files: `corrections.listCorrections[].filePath`.
//   URLs use Windows backslashes → normalize `\`→`/`. Host fs.knesset.gov.il,
//   anonymous, real extensions in the path.

import { smartFetchBytes } from '../lib/fetch-proxy.js';

const HOST = 'main.knesset.gov.il';
const BILL_API = 'https://www.knesset.gov.il/WebSiteApi/knessetapi/LegislationItem/GetLegislationBillItem?ItemId=';
const LAW_API = 'https://www.knesset.gov.il/WebSiteApi/knessetapi/LegislationItem/GetLegislationLawItem?ItemId=';

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
    // /apps/legislation/main/{bills|laws}/<id>  (path or hash-routed)
    const path = `${u.pathname}${u.hash || ''}`;
    const law = /\/legislation\/[^?#]*\/laws\/(\d+)/i.exec(path);
    if (law) {
      const itemId = law[1];
      return {
        scraperId: 'knesset',
        kind: 'knesset_law',
        itemId,
        originalUrl: href,
        label: `חוק — ${itemId}`,
        collectorName: `knesset_law_${itemId}`,
      };
    }
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
    const isLaw = parsed.kind === 'knesset_law';
    onProgress?.({ phase: 'scrape', current: 0, total: 0, message: isLaw ? 'טוען את נתוני החוק…' : 'טוען את נתוני הצעת החוק…' });
    const data = await fetchJson((isLaw ? LAW_API : BILL_API) + encodeURIComponent(parsed.itemId));
    const model = isLaw ? buildLawModel(data) : buildBillModel(data);

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

// Build the model for a consolidated-law page. The downloadable batch is the
// published amendments (`corrections.listCorrections`, each a PDF); the other
// collections (secondary legislation, related bills/laws) have no direct file,
// so they ride along as catalog CSVs (`dataCsvs`) for reference.
export function buildLawModel(data) {
  const g = (data && data.general) || {};
  const c = (data && data.corrections) || {};
  const listCorr = Array.isArray(c.listCorrections) ? c.listCorrections : [];

  // Files category: corrections that carry a PDF, deduped by URL (a single
  // publication can cover several consecutive correction numbers).
  const seenUrl = new Set();
  const docs = [];
  for (const r of listCorr) {
    const url = normUrl(r.filePath);
    if (!url || seenUrl.has(url)) continue;
    seenUrl.add(url);
    const num = String(r.correctionNumber || '').trim();
    const nm = String(r.name || '').trim();
    const base = [num ? `תיקון ${num}` : '', nm].filter(Boolean).join(' — ') || `תיקון_${docs.length + 1}`;
    const date = isoDate(r.publicationDate);
    docs.push({ descr: date ? `${base} (${date})` : base, url, ext: (r.fileType || extFromUrl(url) || '').toLowerCase(), date });
  }
  const categories = docs.length ? [{ key: 'corrections', label: 'תיקוני חוק', docs, count: docs.length }] : [];

  // Law-info CSV (one headline row).
  const billInfoRows = [{
    ItemId: g.itemId || '', Subject: g.hebSubject || '', Validity: g.lawValidity || '',
    PublicationDate: isoDate(g.publicationDate), LatestPublicationDate: isoDate(g.latestPublicationDate),
    Knesset: g.knsName || '', Subjects: (g.lawSubjectsName || '').trim(),
    Ministries: (g.ministriesName || '').trim(), Committees: (g.committeeNames || '').trim(),
    OpenBookUrl: g.openBookUrl || '', KolZchutUrl: g.kolZchutUrl || '',
  }];
  const billInfoFields = Object.keys(billInfoRows[0]);

  // Catalog CSVs for the file-less collections.
  const dataCsvs = [];
  if (listCorr.length) {
    dataCsvs.push({
      key: 'corrections', label: `רשימת תיקונים (CSV) · ${listCorr.length}`, filename: 'תיקוני-חוק.csv',
      fields: ['correctionNumber', 'name', 'correctionType', 'publicationSeries', 'magazineNumber', 'pageNumber', 'publicationDate', 'fileType', 'url', 'summary'],
      rows: listCorr.map(r => ({
        correctionNumber: r.correctionNumber, name: r.name, correctionType: r.correctionType,
        publicationSeries: r.publicationSeries, magazineNumber: r.magazineNumber, pageNumber: r.pageNumber,
        publicationDate: isoDate(r.publicationDate), fileType: r.fileType, url: normUrl(r.filePath),
        summary: stripHtml(r.summaryLaw),
      })),
    });
  }
  const secInstalled = Array.isArray(data.secondaryLawInstalled) ? data.secondaryLawInstalled : [];
  const secProcess = Array.isArray(data.secondaryLawInProcess) ? data.secondaryLawInProcess : [];
  if (secInstalled.length || secProcess.length) {
    const secRow = (r, state) => ({
      state, itemId: r.itemId, name: r.name, statusDesc: r.statusDesc, knessetId: r.knessetId,
      sessionDate: isoDate(r.sessionDate), publicationDate: isoDate(r.PublicationDate),
      committeeName: (r.committeeName || '').trim(), informers: (r.informers || '').trim(), clause: (r.clouse || '').trim(),
    });
    dataCsvs.push({
      key: 'secondary', label: `חקיקת משנה (CSV) · ${secInstalled.length + secProcess.length}`, filename: 'חקיקת-משנה.csv',
      fields: ['state', 'itemId', 'name', 'statusDesc', 'knessetId', 'sessionDate', 'publicationDate', 'committeeName', 'informers', 'clause'],
      rows: [...secInstalled.map(r => secRow(r, 'מותקנת')), ...secProcess.map(r => secRow(r, 'בהליך'))],
    });
  }
  const bills = Array.isArray(c.listLegislationBills) ? c.listLegislationBills : [];
  if (bills.length) {
    dataCsvs.push({
      key: 'bills', label: `הצעות חוק קשורות (CSV) · ${bills.length}`, filename: 'הצעות-חוק.csv',
      fields: ['itemId', 'name', 'description', 'subTypeName', 'currentStep', 'committeeName', 'latestSessionDate'],
      rows: bills.map(r => ({
        itemId: r.itemId, name: r.name, description: (r.description || '').trim(), subTypeName: r.subTypeName,
        currentStep: r.currentStep, committeeName: (r.committeeName || '').trim(), latestSessionDate: isoDate(r.latestSessionDate),
      })),
    });
  }
  const related = [
    ...(Array.isArray(c.listRelatedsReplaceAnother) ? c.listRelatedsReplaceAnother.map(r => ({ ...r, _rel: 'מחליף חוק אחר' })) : []),
    ...(Array.isArray(c.listRelatedsReplacedBy) ? c.listRelatedsReplacedBy.map(r => ({ ...r, _rel: 'הוחלף על-ידי' })) : []),
  ];
  if (related.length) {
    dataCsvs.push({
      key: 'related', label: `חוקים קשורים (CSV) · ${related.length}`, filename: 'חוקים-קשורים.csv',
      fields: ['relation', 'itemId', 'name', 'displayPublicationDate', 'validityFinishDate'],
      rows: related.map(r => ({
        relation: r._rel, itemId: r.itemId, name: r.name,
        displayPublicationDate: isoDate(r.displayPublicationDate), validityFinishDate: isoDate(r.ValidityFinishDate),
      })),
    });
  }

  return {
    bill: { id: g.itemId || '', name: g.hebSubject || '', status: g.lawValidity || '' },
    categories, billInfoRows, billInfoFields, dataCsvs,
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
function isoDate(s) {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(s || '').trim()); // ISO datetime → date part
  return m ? m[1] : '';
}
function extFromUrl(url) {
  const s = String(url || '').split(/[?#]/)[0];
  const m = /\.([a-z0-9]{1,5})$/i.exec(s);
  return m ? m[1].toLowerCase() : '';
}
function stripHtml(s) {
  return String(s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim();
}
