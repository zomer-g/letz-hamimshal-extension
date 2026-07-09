// Icon generator for "לץ הממשל" — the jester-cap logo, sibling to "לץ המשפט".
// Reuses that extension's exact hat geometry (8 harlequin stripes, 9 bells, a
// pom-pom), recolored to the teal/gold government palette on a teal rounded
// square, with a white download-arrow badge bottom-right.
//
// Pure Node (no deps): rasterize at 4–8× supersampling for anti-aliasing, then
// encode PNG via zlib. Writes ../icons/icon-{16,48,128}.png.
//
// Run: node tools/gen-icon.cjs
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const ICONS_DIR = path.join(__dirname, '..', 'icons');

function hex(h) { h = h.replace('#', ''); return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]; }
function lerp(a, b, t) { return a + (b - a) * t; }
function over(d, sr, sg, sb, sa) { const da = d[3]; const oa = sa + da * (1 - sa); if (oa <= 0) { d[0] = d[1] = d[2] = d[3] = 0; return; } d[0] = (sr * sa + d[0] * da * (1 - sa)) / oa; d[1] = (sg * sa + d[1] * da * (1 - sa)) / oa; d[2] = (sb * sa + d[2] * da * (1 - sa)) / oa; d[3] = oa; }
function ptInTri(px, py, ax, ay, bx, by, cx, cy) { const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by); const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy); const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay); const neg = (d1 < 0) || (d2 < 0) || (d3 < 0); const pos = (d1 > 0) || (d2 > 0) || (d3 > 0); return !(neg && pos); }

// Variant B palette (teal/gold) chosen by the user.
const STRIPES = ['#0E8FA6', '#F2B705', '#F5F0E6', '#0B5566'].map(hex);
const GOLD = hex('#F2B705'), GOLDH = hex('#fff4cc');
const bgTop = hex('#06607C'), bgBot = hex('#033748');
const TEAL = hex('#044E66'), WHITE = [255, 255, 255];

function renderHiRes(C, SS) {
  const R = C * SS;
  const buf = new Array(R * R);
  const k = C / 128, sc = 0.8 * k, ox = 24 * k, oy = 14 * k, cr = C * 0.22;
  const bcx = 100 * k, bcy = 100 * k, br = 20 * k; // download badge
  for (let py = 0; py < R; py++) {
    const iy = (py + 0.5) / SS;
    for (let px = 0; px < R; px++) {
      const ix = (px + 0.5) / SS;
      const d = [0, 0, 0, 0];
      // background: teal rounded square (vertical gradient)
      const dxC = Math.max(cr - ix, ix - (C - cr), 0), dyC = Math.max(cr - iy, iy - (C - cr), 0);
      if (dxC * dxC + dyC * dyC <= cr * cr) { const t = iy / C; over(d, lerp(bgTop[0], bgBot[0], t), lerp(bgTop[1], bgBot[1], t), lerp(bgTop[2], bgBot[2], t), 1); }
      // icon space -> hat space (matches the approved SVG: translate(24,14) scale(0.8) at 128)
      const hx = (ix - ox) / sc, hy = (iy - oy) / sc;
      // 8 harlequin stripes (wedges apex (50,16) -> base y=100, x 14..86)
      for (let i = 0; i < 8; i++) { const xa = 14 + 72 * i / 8, xb = 14 + 72 * (i + 1) / 8; if (ptInTri(hx, hy, 50, 16, xa, 100, xb, 100)) { const c = STRIPES[i % 4]; over(d, c[0], c[1], c[2], 1); break; } }
      // left sheen
      if (ptInTri(hx, hy, 50, 16, 14, 100, 14 + 72 * 0.30, 100)) over(d, 255, 255, 255, 0.12);
      // 9 gold bells along the brim (y=102)
      for (let kk = 0; kk < 9; kk++) { const bx = 14 + 9 * kk; if ((hx - bx) * (hx - bx) + (hy - 102) * (hy - 102) <= 25) { over(d, GOLD[0], GOLD[1], GOLD[2], 1); break; } }
      // gold pom-pom at the apex (radial) + highlight
      const pd = Math.hypot(hx - 50, hy - 16);
      if (pd <= 11.5) { const t = Math.max(0, Math.min(1, (Math.hypot(hx - 47, hy - 13) - 1.5) / 10)); over(d, lerp(255, GOLD[0], t), lerp(244, GOLD[1], t), lerp(150, GOLD[2], t), 1); }
      if (Math.hypot(hx - 46.5, hy - 12.5) <= 3) over(d, GOLDH[0], GOLDH[1], GOLDH[2], 0.85);
      // download badge (icon space) — white disc + teal arrow, on top
      if (Math.hypot(ix - bcx, iy - bcy) <= br) {
        over(d, WHITE[0], WHITE[1], WHITE[2], 1);
        let inArrow = false;
        if (Math.abs(ix - bcx) <= 4.5 * k && iy >= bcy - 13 * k && iy <= bcy + 1 * k) inArrow = true;       // stem
        if (ptInTri(ix, iy, bcx, bcy + 14 * k, bcx - 11 * k, bcy - 1 * k, bcx + 11 * k, bcy - 1 * k)) inArrow = true; // head
        if (inArrow) over(d, TEAL[0], TEAL[1], TEAL[2], 1);
      }
      buf[py * R + px] = d;
    }
  }
  return { buf, R };
}

function downsample(buf, R, C, SS) {
  const out = Buffer.alloc(C * C * 4);
  for (let y = 0; y < C; y++) for (let x = 0; x < C; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let j = 0; j < SS; j++) for (let i = 0; i < SS; i++) { const p = buf[(y * SS + j) * R + (x * SS + i)]; r += p[0] * p[3]; g += p[1] * p[3]; b += p[2] * p[3]; a += p[3]; }
    const o = (y * C + x) * 4;
    if (a > 0) { out[o] = Math.max(0, Math.min(255, Math.round(r / a))); out[o + 1] = Math.max(0, Math.min(255, Math.round(g / a))); out[o + 2] = Math.max(0, Math.min(255, Math.round(b / a))); }
    out[o + 3] = Math.max(0, Math.min(255, Math.round(a / (SS * SS) * 255)));
  }
  return out;
}

const crcTable = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let kk = 0; kk < 8; kk++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0); const t = Buffer.from(type, 'ascii'); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0); return Buffer.concat([len, t, data, crc]); }
function encodePNG(rgba, C) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(C, 0); ihdr.writeUInt32BE(C, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = C * 4 + 1;
  const raw = Buffer.alloc(stride * C);
  for (let y = 0; y < C; y++) { raw[y * stride] = 0; rgba.copy(raw, y * stride + 1, y * C * 4, y * C * 4 + C * 4); }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

fs.mkdirSync(ICONS_DIR, { recursive: true });
for (const C of [16, 48, 128]) {
  const SS = C <= 16 ? 8 : 4;
  const { buf, R } = renderHiRes(C, SS);
  const png = encodePNG(downsample(buf, R, C, SS), C);
  fs.writeFileSync(path.join(ICONS_DIR, `icon-${C}.png`), png);
  console.log(`✓ icon-${C}.png (${png.length} bytes)`);
}
