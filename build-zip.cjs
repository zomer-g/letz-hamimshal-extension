#!/usr/bin/env node
// Builds the CWS submission ZIP. Run: node build-zip.cjs  (or: npm run build)
//
// CommonJS (.cjs) on purpose: package.json sets "type":"module" for the ESM
// source + tests, so this build script keeps the .cjs extension.
//
// The ZIP is written in Node with FORWARD-SLASH entry names. This is critical:
// Windows PowerShell 5.1's Compress-Archive stores entries with backslashes,
// which the Chrome Web Store's (Linux) unzipper treats as part of the filename
// — so `content\overlay.js` never matches the manifest's `content/overlay.js`
// and the upload is rejected. A self-contained writer avoids that entirely.
//
// Excludes everything that shouldn't ship to reviewers (docs, dev tooling,
// the site/ public pages — those live on the user's web host, not in the
// extension). Output: extension-v{version}.zip in repo root.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = __dirname;
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const version = manifest.version || '0.0.0';
const TARGET = (process.argv.find(a => a.startsWith('--target=')) || '').split('=')[1]
  || (process.argv.includes('--firefox') ? 'firefox' : 'chrome');
const outName = TARGET === 'firefox' ? `extension-firefox-v${version}.zip` : `extension-v${version}.zip`;

// Transform the Chrome manifest into a Firefox-compatible one:
//   - background service worker → event-page background script (FF MV3)
//   - add browser_specific_settings.gecko (required by AMO)
// Everything else (MV3, world:"MAIN" content scripts [FF 128+], DNR, WAR,
// permissions, _locales) is identical.
function toFirefoxManifest(mf) {
  const m = JSON.parse(JSON.stringify(mf));
  if (m.background && m.background.service_worker) {
    m.background = { scripts: [m.background.service_worker] };
  }
  m.browser_specific_settings = {
    gecko: { id: 'govscraper@z-g.co.il', strict_min_version: '128.0' },
  };
  return m;
}

const INCLUDE = [
  'manifest.json', 'rules.json', '_locales', 'icons',
  'background', 'content', 'scrapers', 'lib', 'popup',
];
const EXCLUDE_FILES = new Set(['.DS_Store', 'Thumbs.db']);
const EXCLUDE_EXT = new Set(['.md', '.log', '.zip', '.bak']);

// Collect { name (POSIX), data } for every shippable file.
function collect() {
  const files = [];
  const walk = (abs, rel) => {
    const st = fs.statSync(abs);
    if (st.isDirectory()) {
      for (const name of fs.readdirSync(abs).sort()) {
        if (EXCLUDE_FILES.has(name)) continue;
        walk(path.join(abs, name), rel ? `${rel}/${name}` : name);
      }
    } else {
      if (EXCLUDE_EXT.has(path.extname(abs).toLowerCase())) return;
      files.push({ name: rel, data: fs.readFileSync(abs) });
    }
  };
  for (const entry of INCLUDE) {
    const abs = path.join(ROOT, entry);
    if (!fs.existsSync(abs)) { console.warn(`build-zip: skip missing ${entry}`); continue; }
    walk(abs, entry);
  }
  return files;
}

// --- minimal spec-compliant ZIP writer (DEFLATE + STORE fallback) ---
let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); CRC_TABLE[n] = c >>> 0; }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function makeZip(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name.split(path.sep).join('/'), 'utf8'); // force POSIX
    const crc = crc32(f.data);
    const deflated = zlib.deflateRawSync(f.data, { level: 9 });
    const store = deflated.length >= f.data.length;
    const method = store ? 0 : 8;
    const body = store ? f.data : deflated;

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6);   // general purpose: bit 11 = UTF-8 names
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0x21, 12); // dummy time/date
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(f.data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, nameBuf, body);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0x21, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(f.data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32); ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36); ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);

    offset += lh.length + nameBuf.length + body.length;
  }
  const centralStart = offset;
  const centralSize = central.reduce((n, b) => n + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralStart, 16);
  return Buffer.concat([...locals, ...central, eocd]);
}

function main() {
  const files = collect();
  if (TARGET === 'firefox') {
    const entry = files.find(f => f.name === 'manifest.json');
    const ff = toFirefoxManifest(JSON.parse(entry.data.toString('utf8')));
    entry.data = Buffer.from(JSON.stringify(ff, null, 2) + '\n', 'utf8');
  }
  const buf = makeZip(files);
  const outPath = path.join(ROOT, outName);
  if (fs.existsSync(outPath)) fs.rmSync(outPath);
  fs.writeFileSync(outPath, buf);
  console.log(`\n✓ ${outName} (${(buf.length / 1024).toFixed(1)} KB, ${files.length} files)`);
  console.log(`  Entry names use POSIX "/" separators (CWS-safe).`);
  console.log(`  Load via chrome://extensions → Load unpacked after unzipping, or upload to the CWS dashboard.`);
}

main();
