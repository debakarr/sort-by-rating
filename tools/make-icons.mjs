#!/usr/bin/env node
/**
 * Generates the extension icons as PNGs (no external image tooling needed).
 *
 * The icon is a rounded blue square with three descending white bars, i.e. a
 * "sort descending" glyph.
 */
import zlib from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const outDir = join(root, '..', 'src', 'icons');
const SIZES = [16, 32, 48, 128];

/* ------------------------------------------------------------ PNG encoding */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

function encodePNG(width, height, rgba) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0; // filter type: None
    rgba.copy(raw, y * stride + 1, y * width * 4, (y + 1) * width * 4);
  }

  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* --------------------------------------------------------------- rendering */

const BG = [37, 99, 235];      // blue-600
const FG = [255, 255, 255];    // white
const RADIUS = 0.22;
const BARS = [
  { y0: 0.25, y1: 0.37, w: 0.52 },
  { y0: 0.44, y1: 0.56, w: 0.38 },
  { y0: 0.63, y1: 0.75, w: 0.24 }
];
const BAR_X = 0.24;

function insideRoundedRect(x, y) {
  if (x < 0 || x > 1 || y < 0 || y > 1) return false;
  const cx = Math.min(Math.max(x, RADIUS), 1 - RADIUS);
  const cy = Math.min(Math.max(y, RADIUS), 1 - RADIUS);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= RADIUS * RADIUS + 1e-9;
}

function sample(x, y) {
  if (!insideRoundedRect(x, y)) return [0, 0, 0, 0];
  const onBar = BARS.some((b) => x >= BAR_X && x <= BAR_X + b.w && y >= b.y0 && y <= b.y1);
  const c = onBar ? FG : BG;
  return [c[0], c[1], c[2], 255];
}

function render(size) {
  const SS = 4; // supersampling factor for anti-aliasing
  const buf = Buffer.alloc(size * size * 4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let pr = 0, pg = 0, pb = 0, pa = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (x + (sx + 0.5) / SS) / size;
          const v = (y + (sy + 0.5) / SS) / size;
          const c = sample(u, v);
          const a = c[3] / 255;
          pr += c[0] * a;
          pg += c[1] * a;
          pb += c[2] * a;
          pa += a;
        }
      }
      const n = SS * SS;
      const alpha = pa / n;
      const i = (y * size + x) * 4;
      buf[i] = alpha > 0 ? Math.round(pr / n / alpha) : 0;
      buf[i + 1] = alpha > 0 ? Math.round(pg / n / alpha) : 0;
      buf[i + 2] = alpha > 0 ? Math.round(pb / n / alpha) : 0;
      buf[i + 3] = Math.round(alpha * 255);
    }
  }

  return buf;
}

/* -------------------------------------------------------------------- main */

mkdirSync(outDir, { recursive: true });
for (const size of SIZES) {
  const file = join(outDir, `icon-${size}.png`);
  writeFileSync(file, encodePNG(size, size, render(size)));
  console.log(`wrote src/icons/icon-${size}.png`);
}
