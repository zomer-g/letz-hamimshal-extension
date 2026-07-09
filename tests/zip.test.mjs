// ZIP writer/reader tests — STORE round-trip integrity (text + binary), UTF-8
// Hebrew filenames, multi-entry, CRC-32 correctness, and the CP862 (DOS-Hebrew)
// filename decode used to fix mavat's legacy ZIP entry names.
//
// Run: node tests/zip.test.mjs

import { buildZip, readZip, __test__ } from '../lib/zip.js';
import { test, run, assert, assertEqual } from './_assert.mjs';

const { decodeCp862, crc32 } = __test__;
const enc = new TextEncoder();
const dec = new TextDecoder('utf-8');

async function roundTrip(entries) {
  const blob = await buildZip(entries);
  return readZip(blob);
}

test('single text entry round-trips name + content', async () => {
  const out = await roundTrip([{ name: 'hello.txt', data: 'Hello, world' }]);
  assertEqual(out.length, 1);
  assertEqual(out[0].name, 'hello.txt');
  assertEqual(dec.decode(out[0].data), 'Hello, world');
});

test('multiple entries preserved in order', async () => {
  const out = await roundTrip([
    { name: 'a.txt', data: 'AAA' },
    { name: 'b.txt', data: 'BBB' },
    { name: 'c.txt', data: 'CCC' },
  ]);
  assertEqual(out.map(e => e.name), ['a.txt', 'b.txt', 'c.txt']);
  assertEqual(out.map(e => dec.decode(e.data)), ['AAA', 'BBB', 'CCC']);
});

test('binary Uint8Array round-trips byte-exact', async () => {
  const bytes = new Uint8Array([0, 1, 2, 254, 255, 128, 0, 7]);
  const out = await roundTrip([{ name: 'blob.bin', data: bytes }]);
  assertEqual([...out[0].data], [...bytes]);
});

test('Hebrew UTF-8 filename round-trips', async () => {
  const out = await roundTrip([{ name: 'תשריט.pdf', data: 'x' }]);
  assertEqual(out[0].name, 'תשריט.pdf');
});

test('nested path entry preserved', async () => {
  const out = await roundTrip([{ name: 'attachments/דוח.pdf', data: 'x' }]);
  assertEqual(out[0].name, 'attachments/דוח.pdf');
});

test('empty file entry', async () => {
  const out = await roundTrip([{ name: 'empty.txt', data: '' }]);
  assertEqual(out[0].name, 'empty.txt');
  assertEqual(out[0].data.length, 0);
});

test('CRC-32 of "123456789" is 0xCBF43926 (IEEE reference)', () => {
  assertEqual(crc32(enc.encode('123456789')), 0xCBF43926);
});

test('CRC-32 of empty input is 0', () => {
  assertEqual(crc32(new Uint8Array(0)), 0);
});

// --- CP862 (DOS-Hebrew) filename decode -------------------------------------

test('CP862 decodes Hebrew letters 0x80..0x9A → א..ת', () => {
  // 0x80 = א, 0x81 = ב, 0x9A = ת
  assertEqual(decodeCp862(new Uint8Array([0x80, 0x81, 0x9a])), 'אבת');
});

test('CP862 full alef-bet maps to the 27 Hebrew letters', () => {
  const bytes = new Uint8Array(27);
  for (let i = 0; i < 27; i++) bytes[i] = 0x80 + i;
  const got = decodeCp862(bytes);
  assertEqual(got, 'אבגדהוזחטיךכלםמןנסעףפץצקרשת');
});

test('CP862 ASCII bytes pass through', () => {
  assertEqual(decodeCp862(enc.encode('report.pdf')), 'report.pdf');
});

test('CP862 mixed Hebrew + ASCII (e.g. "א.pdf")', () => {
  assertEqual(decodeCp862(new Uint8Array([0x80, 0x2e, 0x70, 0x64, 0x66])), 'א.pdf');
});

run('zip');
