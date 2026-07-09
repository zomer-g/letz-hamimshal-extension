// Minimal in-browser ZIP writer (STORE method only, no compression).
//
// Why not bundle JSZip: it's ~95KB and CWS reviewers prefer to see no third-
// party code. We only ever bundle small CSV + GeoJSON text, where STORE
// compression is fine and adds zero dependencies. If we ever need real
// compression we'd swap in CompressionStream('deflate-raw').

const TEXT_ENCODER = new TextEncoder();

export async function buildZip(entries) {
  // entries: Array<{ name: string, data: string | Uint8Array | Blob }>
  const fileRecords = [];
  let offset = 0;
  const parts = [];

  for (const entry of entries) {
    const nameBytes = TEXT_ENCODER.encode(entry.name);
    const dataBytes = await toBytes(entry.data);
    const crc = crc32(dataBytes);
    const size = dataBytes.length;

    const localHeader = buildLocalHeader(nameBytes, crc, size);
    parts.push(localHeader, nameBytes, dataBytes);
    fileRecords.push({ nameBytes, crc, size, headerOffset: offset });
    offset += localHeader.length + nameBytes.length + dataBytes.length;
  }

  const centralStart = offset;
  for (const rec of fileRecords) {
    const central = buildCentralHeader(rec);
    parts.push(central, rec.nameBytes);
    offset += central.length + rec.nameBytes.length;
  }
  const centralSize = offset - centralStart;
  parts.push(buildEndRecord(fileRecords.length, centralSize, centralStart));

  return new Blob(parts, { type: 'application/zip' });
}

async function toBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
  if (typeof data === 'string') return TEXT_ENCODER.encode(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  throw new Error('zip: unsupported entry data type');
}

function buildLocalHeader(nameBytes, crc, size) {
  const buf = new ArrayBuffer(30);
  const dv = new DataView(buf);
  dv.setUint32(0, 0x04034b50, true);    // signature
  dv.setUint16(4, 20, true);             // version
  dv.setUint16(6, 0x0800, true);         // flags: bit 11 = filename is UTF-8
  dv.setUint16(8, 0, true);              // method = store
  dv.setUint16(10, 0, true);             // mod time
  dv.setUint16(12, 0, true);             // mod date
  dv.setUint32(14, crc, true);           // crc32
  dv.setUint32(18, size, true);          // compressed size
  dv.setUint32(22, size, true);          // uncompressed size
  dv.setUint16(26, nameBytes.length, true);
  dv.setUint16(28, 0, true);             // extra length
  return new Uint8Array(buf);
}

function buildCentralHeader(rec) {
  const buf = new ArrayBuffer(46);
  const dv = new DataView(buf);
  dv.setUint32(0, 0x02014b50, true);
  dv.setUint16(4, 20, true);             // version made by
  dv.setUint16(6, 20, true);             // version needed
  dv.setUint16(8, 0x0800, true);         // flags: bit 11 = filename is UTF-8
  dv.setUint16(10, 0, true);
  dv.setUint16(12, 0, true);
  dv.setUint16(14, 0, true);
  dv.setUint32(16, rec.crc, true);
  dv.setUint32(20, rec.size, true);
  dv.setUint32(24, rec.size, true);
  dv.setUint16(28, rec.nameBytes.length, true);
  dv.setUint16(30, 0, true);
  dv.setUint16(32, 0, true);
  dv.setUint16(34, 0, true);
  dv.setUint16(36, 0, true);
  dv.setUint32(38, 0, true);
  dv.setUint32(42, rec.headerOffset, true);
  return new Uint8Array(buf);
}

function buildEndRecord(fileCount, centralSize, centralStart) {
  const buf = new ArrayBuffer(22);
  const dv = new DataView(buf);
  dv.setUint32(0, 0x06054b50, true);
  dv.setUint16(4, 0, true);
  dv.setUint16(6, 0, true);
  dv.setUint16(8, fileCount, true);
  dv.setUint16(10, fileCount, true);
  dv.setUint32(12, centralSize, true);
  dv.setUint32(16, centralStart, true);
  dv.setUint16(20, 0, true);
  return new Uint8Array(buf);
}

// Standard CRC-32 (IEEE 802.3) table
let CRC_TABLE = null;
function makeCrcTable() {
  const tbl = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    tbl[n] = c >>> 0;
  }
  return tbl;
}
function crc32(bytes) {
  if (!CRC_TABLE) CRC_TABLE = makeCrcTable();
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------
// ZIP reader — used to unpack mavat's server-generated per-category ZIPs so we
// can fix their (legacy-Hebrew) filenames and merge everything into one ZIP.
//
// mavat encodes entry names in Windows-1255 (Hebrew) WITHOUT the UTF-8 flag, so
// a naive reader shows mojibake. We honour the UTF-8 flag when set, otherwise
// decode as Windows-1255. STORE + DEFLATE are supported (DEFLATE via the native
// DecompressionStream — no third-party inflate code).
// ---------------------------------------------------------------------------

export async function readZip(input) {
  const buf = input instanceof Uint8Array ? input
    : input instanceof ArrayBuffer ? new Uint8Array(input)
    : new Uint8Array(await input.arrayBuffer()); // Blob
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  // Locate the End Of Central Directory record (scan from the end; it has a
  // variable-length comment so we search for its signature).
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 0x10000; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('zip: EOCD not found');

  const count = dv.getUint16(eocd + 10, true);
  let ptr = dv.getUint32(eocd + 16, true); // central directory offset

  const utf8 = new TextDecoder('utf-8');
  const out = [];

  for (let n = 0; n < count; n++) {
    if (dv.getUint32(ptr, true) !== 0x02014b50) break; // central file header sig
    const flags = dv.getUint16(ptr + 8, true);
    const method = dv.getUint16(ptr + 10, true);
    const compSize = dv.getUint32(ptr + 20, true);
    const nameLen = dv.getUint16(ptr + 28, true);
    const extraLen = dv.getUint16(ptr + 30, true);
    const commentLen = dv.getUint16(ptr + 32, true);
    const localOff = dv.getUint32(ptr + 42, true);
    const nameBytes = buf.subarray(ptr + 46, ptr + 46 + nameLen);
    const name = (flags & 0x0800) ? utf8.decode(nameBytes) : decodeCp862(nameBytes);
    ptr += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) continue; // directory entry

    // Read the file data from its local header.
    if (dv.getUint32(localOff, true) !== 0x04034b50) continue;
    const lNameLen = dv.getUint16(localOff + 26, true);
    const lExtraLen = dv.getUint16(localOff + 28, true);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const comp = buf.subarray(dataStart, dataStart + compSize);

    let data;
    if (method === 0) data = comp.slice();
    else if (method === 8) data = await inflateRaw(comp);
    else throw new Error(`zip: unsupported method ${method}`);

    out.push({ name, data });
  }
  return out;
}

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// IBM862 (CP862 / DOS-Hebrew) decoder — mavat's ZIP entry names use it without
// the UTF-8 flag, and the Encoding API has no built-in label for it. Bytes
// 0x80–0x9A are the 27 Hebrew letters (א=0x80 … ת=0x9A); 0x9B–0xFF match CP437.
const CP437_HIGH =
  'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»' +
  '░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀' +
  'αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';
function decodeCp862(bytes) {
  let s = '';
  for (const b of bytes) {
    if (b < 0x80) s += String.fromCharCode(b);
    else if (b <= 0x9a) s += String.fromCharCode(0x05d0 + (b - 0x80)); // Hebrew א–ת
    else s += CP437_HIGH[b - 0x80];
  }
  return s;
}

// --- test-only exports ------------------------------------------------------
// Exposed for unit tests (tests/zip.test.mjs). No runtime effect.
export const __test__ = { decodeCp862, crc32 };
