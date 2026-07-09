// CSV builder tests — RFC 4180 escaping, utf-8-sig BOM, value formatting,
// field selection/ordering, missing cells. Mirrors expectations of the Main
// scraper's csv.py so files open identically in Excel-Hebrew.
//
// Run: node tests/csv.test.mjs

import { rowsToCsv, rowsToCsvParts } from '../lib/csv.js';
import { test, run, assert, assertEqual } from './_assert.mjs';

const BOM = '﻿';

test('starts with UTF-8 BOM', () => {
  const out = rowsToCsv([{ a: 1 }], ['a']);
  assert(out.startsWith(BOM), 'missing BOM');
});

test('rowsToCsvParts joins back to the exact same CSV (chunked = whole)', () => {
  // The chunked builder (used for huge layers, to dodge the ~512 MB string cap)
  // must be byte-identical to the single-string builder when concatenated.
  const rows = [];
  for (let i = 0; i < 4500; i++) rows.push({ a: i, b: `v,${i}`, c: `line\n${i}` }); // spans 3 batches (BATCH=2000)
  const fields = ['a', 'b', 'c'];
  assertEqual(rowsToCsvParts(rows, fields).join(''), rowsToCsv(rows, fields));
});

test('rowsToCsvParts on empty rows = header only', () => {
  assertEqual(rowsToCsvParts([], ['a', 'b']).join(''), rowsToCsv([], ['a', 'b']));
});

test('header + single row, CRLF line endings', () => {
  const out = rowsToCsv([{ a: '1', b: '2' }], ['a', 'b']);
  assertEqual(out, `${BOM}a,b\r\n1,2\r\n`);
});

test('field order is honoured (not insertion order)', () => {
  const out = rowsToCsv([{ b: 'B', a: 'A' }], ['a', 'b']);
  assertEqual(out, `${BOM}a,b\r\nA,B\r\n`);
});

test('missing field → empty cell', () => {
  const out = rowsToCsv([{ a: 'A' }], ['a', 'b']);
  assertEqual(out, `${BOM}a,b\r\nA,\r\n`);
});

test('value with comma is quoted', () => {
  const out = rowsToCsv([{ a: 'x,y' }], ['a']);
  assertEqual(out, `${BOM}a\r\n"x,y"\r\n`);
});

test('double-quote is doubled and quoted', () => {
  const out = rowsToCsv([{ a: 'say "hi"' }], ['a']);
  assertEqual(out, `${BOM}a\r\n"say ""hi"""\r\n`);
});

test('newline inside value is quoted', () => {
  const out = rowsToCsv([{ a: 'line1\nline2' }], ['a']);
  assertEqual(out, `${BOM}a\r\n"line1\nline2"\r\n`);
});

test('leading/trailing space is quoted', () => {
  const out = rowsToCsv([{ a: ' padded ' }], ['a']);
  assertEqual(out, `${BOM}a\r\n" padded "\r\n`);
});

test('Hebrew passes through unescaped', () => {
  const out = rowsToCsv([{ a: 'שלום' }], ['a']);
  assertEqual(out, `${BOM}a\r\nשלום\r\n`);
});

test('null / undefined → empty', () => {
  const out = rowsToCsv([{ a: null, b: undefined }], ['a', 'b']);
  assertEqual(out, `${BOM}a,b\r\n,\r\n`);
});

test('boolean → true/false', () => {
  const out = rowsToCsv([{ a: true, b: false }], ['a', 'b']);
  assertEqual(out, `${BOM}a,b\r\ntrue,false\r\n`);
});

test('object value → JSON string (quoted)', () => {
  const out = rowsToCsv([{ a: { x: 1 } }], ['a']);
  assertEqual(out, `${BOM}a\r\n"{""x"":1}"\r\n`);
});

test('numbers stringified', () => {
  const out = rowsToCsv([{ a: 0, b: 3.14 }], ['a', 'b']);
  assertEqual(out, `${BOM}a,b\r\n0,3.14\r\n`);
});

test('empty rows → header only', () => {
  const out = rowsToCsv([], ['a', 'b']);
  assertEqual(out, `${BOM}a,b\r\n`);
});

test('fields auto-collected from rows when not given', () => {
  const out = rowsToCsv([{ a: 1, b: 2 }, { a: 3, c: 4 }]);
  // union of keys, first-seen order: a, b, c
  assertEqual(out, `${BOM}a,b,c\r\n1,2,\r\n3,,4\r\n`);
});

run('csv');
