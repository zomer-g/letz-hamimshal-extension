// CSV builder with utf-8-sig BOM (Excel-Hebrew compatible). RFC 4180 escaping.
// Mirrors govscraper/io/csv.py behavior.

const BOM = '﻿';

export function rowsToCsv(rows, fields) {
  if (!rows || !rows.length) return BOM + (fields || []).map(escapeCell).join(',') + '\r\n';
  const cols = fields && fields.length ? fields : collectFields(rows);
  const head = cols.map(escapeCell).join(',');
  const body = rows.map(r => cols.map(c => escapeCell(formatValue(r[c]))).join(','));
  return BOM + [head, ...body].join('\r\n') + '\r\n';
}

// Build the CSV as an ARRAY of string chunks (a header + batches of rows) so a
// very large table never has to exist as one JS string — a single string caps
// at ~512 MB and throws "Invalid string length". A Blob assembled from the parts
// raises the ceiling to available memory, so much bigger layers download.
export function rowsToCsvParts(rows, fields) {
  const list = rows || [];
  const cols = fields && fields.length ? fields : collectFields(list);
  const parts = [BOM + cols.map(escapeCell).join(',') + '\r\n'];
  const BATCH = 2000;
  for (let i = 0; i < list.length; i += BATCH) {
    let chunk = '';
    const end = Math.min(i + BATCH, list.length);
    for (let j = i; j < end; j++) {
      chunk += cols.map(c => escapeCell(formatValue(list[j][c]))).join(',') + '\r\n';
    }
    parts.push(chunk);
  }
  return parts;
}

export function rowsToCsvBlob(rows, fields) {
  return new Blob(rowsToCsvParts(rows, fields), { type: 'text/csv;charset=utf-8' });
}

function escapeCell(value) {
  const s = value == null ? '' : String(value);
  if (s === '') return '';
  // RFC 4180: quote if contains comma, quote, CR, LF, or leading/trailing space
  const needsQuote = /[",\r\n]/.test(s) || /^\s|\s$/.test(s);
  if (!needsQuote) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

function formatValue(v) {
  if (v == null) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v);
}

function collectFields(rows) {
  const seen = new Set();
  const out = [];
  for (const r of rows) for (const k of Object.keys(r || {})) if (!seen.has(k)) { seen.add(k); out.push(k); }
  return out;
}
