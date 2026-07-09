#!/usr/bin/env node
// Generates the extension PNG icons at 16/48/128 px using only Node built-ins
// (zlib for PNG IDAT compression) — no ImageMagick / browser dependency.
//
// Design: a rounded teal square (over.org.il brand gradient) with a white
// "download to tray" glyph (downward arrow + baseline). Rendered with 4×
// supersampling and box-downsampled for smooth anti-aliased edges at every
// size — legible even at 16px on the toolbar.
//
// Run: node tools/generate-icons.js

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZES = [16, 48, 128];
const ICON_DIR = path.join(__dirname, '..', 'icons');
const SS = 4; // supersampling factor

// over.org.il brand gradient stops (diagonal): #06607C → #044E66 → #003647
const STOPS = [
  { t: 0.0, c: [6, 96, 124] },
  { t: 0.55, c: [4, 78, 102] },
  { t: 1.0, c: [0, 54, 71] },
];
const WHITE = [255, 255, 255];

function lerp(a, b, t) { return a + (b - a) * t; }
function gradientColor(t) {
  t = Math.max(0, Math.min(1, t));
  for (let i = 1; i < STOPS.length; i++) {
    if (t <= STOPS[i].t) {
      const p = STOPS[i - 1], q = STOPS[i];
      const f = (t - p.t) / (q.t - p.t);
      return [lerp(p.c[0], q.c[0], f), lerp(p.c[1], q.c[1], f), lerp(p.c[2], q.c[2], f)];
    }
  }
  return STOPS[STOPS.length - 1].c;
}

// Is normalized point (nx,ny in 0..1) inside the rounded square?
function insideRoundedRect(nx, ny, radius) {
  const r = radius;
  // corners
  if (nx < r && ny < r) return (r - nx) ** 2 + (r - ny) ** 2 <= r * r;
  if (nx > 1 - r && ny < r) return (nx - (1 - r)) ** 2 + (r - ny) ** 2 <= r * r;
  if (nx < r && ny > 1 - r) return (r - nx) ** 2 + (ny - (1 - r)) ** 2 <= r * r;
  if (nx > 1 - r && ny > 1 - r) return (nx - (1 - r)) ** 2 + (ny - (1 - r)) ** 2 <= r * r;
  return true;
}

// Is normalized point inside the white "download" glyph?
function insideGlyph(nx, ny) {
  const cx = 0.5;
  // Arrow stem (vertical bar)
  if (Math.abs(nx - cx) <= 0.085 && ny >= 0.28 && ny <= 0.55) return true;
  // Arrow head (downward triangle): widest at ny=0.50, apex at ny=0.68
  if (ny >= 0.50 && ny <= 0.68) {
    const frac = (0.68 - ny) / (0.68 - 0.50); // 1 at top, 0 at apex
    const halfw = 0.20 * frac;
    if (Math.abs(nx - cx) <= halfw) return true;
  }
  // Tray / baseline bar
  if (nx >= 0.30 && nx <= 0.70 && ny >= 0.74 && ny <= 0.80) return true;
  return false;
}

function paintIcon(size) {
  const S = size * SS;
  const radius = 0.22; // normalized corner radius
  // Hi-res RGBA, premultiplied-ish (we store straight RGBA; edges come from
  // averaging coverage during downsample since outside-rect alpha is 0).
  const hi = new Float32Array(S * S * 4);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const nx = (x + 0.5) / S, ny = (y + 0.5) / S;
      const idx = (y * S + x) * 4;
      if (!insideRoundedRect(nx, ny, radius)) {
        hi[idx + 3] = 0; // transparent outside the square
        continue;
      }
      if (insideGlyph(nx, ny)) {
        hi[idx] = WHITE[0]; hi[idx + 1] = WHITE[1]; hi[idx + 2] = WHITE[2]; hi[idx + 3] = 255;
      } else {
        const c = gradientColor((nx + ny) / 2);
        hi[idx] = c[0]; hi[idx + 1] = c[1]; hi[idx + 2] = c[2]; hi[idx + 3] = 255;
      }
    }
  }
  // Box-downsample SS×SS → size, averaging in premultiplied alpha for correct
  // edge color blending.
  const img = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const hx = x * SS + sx, hy = y * SS + sy;
          const i = (hy * S + hx) * 4;
          const al = hi[i + 3] / 255;
          r += hi[i] * al; g += hi[i + 1] * al; b += hi[i + 2] * al; a += hi[i + 3];
        }
      }
      const n = SS * SS;
      const alpha = a / n;
      const idx = (y * size + x) * 4;
      if (alpha < 0.5) {
        img[idx] = 0; img[idx + 1] = 0; img[idx + 2] = 0; img[idx + 3] = Math.round(alpha);
      } else {
        const af = a / 255; // sum of alphas (0..n)
        img[idx] = Math.round(r / af);
        img[idx + 1] = Math.round(g / af);
        img[idx + 2] = Math.round(b / af);
        img[idx + 3] = Math.round(alpha);
      }
    }
  }
  return img;
}

function encodePng(rgba, size) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = chunk('IHDR', (() => {
    const b = Buffer.alloc(13);
    b.writeUInt32BE(size, 0);
    b.writeUInt32BE(size, 4);
    b[8] = 8;       // bit depth
    b[9] = 6;       // RGBA
    b[10] = 0; b[11] = 0; b[12] = 0;
    return b;
  })());
  // PNG scanlines: filter byte (0) + row pixels
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = chunk('IDAT', zlib.deflateSync(raw, { level: 9 }));
  const iend = chunk('IEND', Buffer.alloc(0));
  return Buffer.concat([sig, ihdr, idat, iend]);
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

fs.mkdirSync(ICON_DIR, { recursive: true });
for (const size of SIZES) {
  const png = encodePng(paintIcon(size), size);
  const out = path.join(ICON_DIR, `icon-${size}.png`);
  fs.writeFileSync(out, png);
  console.log(`✓ ${out} (${png.length} bytes)`);
}
