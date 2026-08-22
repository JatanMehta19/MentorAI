// scripts/generate-icons.mjs
//
// Generates the PWA icons into public/icons/.
//
// These are built rather than checked in as opaque binaries so the mark can be
// regenerated at any size and the design lives in source. Uses only node:zlib —
// adding sharp or canvas to devDependencies for four PNGs isn't worth it.
//
//   node scripts/generate-icons.mjs

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');

// ── Brand ─────────────────────────────────────────────────────────────────────
// Matches theme_color / background_color in the vite.config.ts PWA manifest.

const GRADIENT_TOP    = [0x7b, 0x73, 0xff];
const GRADIENT_BOTTOM = [0x55, 0x4c, 0xe0];
const GLYPH           = [0xff, 0xff, 0xff];

// Full-bleed background with the glyph at 52% of the canvas keeps the mark
// inside the 80% safe zone Android crops maskable icons to, so one file can
// serve `purpose: "any maskable"` without a second variant.
const GLYPH_SCALE  = 0.52;
const STROKE_RATIO = 0.155; // stroke half-width, relative to glyph box
const SAMPLES      = 4;     // NxN supersampling for antialiased edges

// ── Geometry ──────────────────────────────────────────────────────────────────

/** The "M" as four thick capsules. Rounded caps overlap, so the joins close cleanly. */
const STROKES = [
  [0.09, 1.0, 0.09, 0.0],  // left stem
  [0.09, 0.0, 0.5,  0.63], // down to the valley
  [0.5,  0.63, 0.91, 0.0], // back up
  [0.91, 0.0, 0.91, 1.0],  // right stem
];

/** Shortest distance from a point to a line segment. */
function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/** Glyph coverage at a point in icon space, 0..1, via supersampling. */
function coverage(x, y, size) {
  const box    = size * GLYPH_SCALE;
  const originX = (size - box) / 2;
  const originY = (size - box) / 2;
  const stroke = box * STROKE_RATIO;

  let hits = 0;
  for (let sy = 0; sy < SAMPLES; sy++) {
    for (let sx = 0; sx < SAMPLES; sx++) {
      // Sample at subpixel centres so edges land symmetrically.
      const gx = (x + (sx + 0.5) / SAMPLES - originX) / box;
      const gy = (y + (sy + 0.5) / SAMPLES - originY) / box;
      for (const [ax, ay, bx, by] of STROKES) {
        if (distToSegment(gx, gy, ax, ay, bx, by) * box <= stroke) { hits++; break; }
      }
    }
  }
  return hits / (SAMPLES * SAMPLES);
}

// ── PNG encoding ──────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len  = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc  = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8]  = 8; // bit depth
  ihdr[9]  = 6; // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  // One filter byte (0 = None) per scanline, as the PNG spec requires.
  const stride = width * 4;
  const raw    = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Render ────────────────────────────────────────────────────────────────────

function renderIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);

  for (let y = 0; y < size; y++) {
    const t = size === 1 ? 0 : y / (size - 1);
    const bg = [
      Math.round(GRADIENT_TOP[0] + (GRADIENT_BOTTOM[0] - GRADIENT_TOP[0]) * t),
      Math.round(GRADIENT_TOP[1] + (GRADIENT_BOTTOM[1] - GRADIENT_TOP[1]) * t),
      Math.round(GRADIENT_TOP[2] + (GRADIENT_BOTTOM[2] - GRADIENT_TOP[2]) * t),
    ];

    for (let x = 0; x < size; x++) {
      const a = coverage(x, y, size);
      const i = (y * size + x) * 4;
      rgba[i]     = Math.round(bg[0] + (GLYPH[0] - bg[0]) * a);
      rgba[i + 1] = Math.round(bg[1] + (GLYPH[1] - bg[1]) * a);
      rgba[i + 2] = Math.round(bg[2] + (GLYPH[2] - bg[2]) * a);
      rgba[i + 3] = 255;
    }
  }

  return encodePng(size, size, rgba);
}

mkdirSync(OUT_DIR, { recursive: true });

for (const size of [192, 512, 180, 32]) {
  const file = join(OUT_DIR, `icon-${size}.png`);
  const png  = renderIcon(size);
  writeFileSync(file, png);
  console.log(`  icon-${size}.png  ${String(png.length).padStart(6)} bytes`);
}

console.log(`\nWrote 4 icons to ${OUT_DIR}`);
