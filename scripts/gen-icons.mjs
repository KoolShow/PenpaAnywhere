import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const iconsDir = path.join(rootDir, 'src-tauri', 'icons');
const publicDir = path.join(rootDir, 'public');
const androidMipmapDir = path.join(
  rootDir,
  'android',
  'app',
  'src',
  'main',
  'res',
  'mipmap-xxxhdpi',
);

fs.mkdirSync(iconsDir, { recursive: true });
fs.mkdirSync(publicDir, { recursive: true });
fs.mkdirSync(androidMipmapDir, { recursive: true });

// Unified SVG matching Android Adaptive Icon (ic_launcher_background + ic_launcher_foreground)
const UNIFIED_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 108 108" width="256" height="256">
  <defs>
    <clipPath id="r">
      <rect x="4" y="4" width="100" height="100" rx="24" ry="24"/>
    </clipPath>
  </defs>
  <g clip-path="url(#r)">
    <rect x="0" y="0" width="108" height="108" fill="#111820"/>
    <path d="M0,0 L108,0 L108,68 Q54,90 0,62 Z" fill="#182738"/>
    <path d="M34,32 L78,28 L74,78 L30,74 Z" fill="#84D7AA" fill-opacity="0.12" stroke="#A8C7FA" stroke-width="2.6" stroke-linejoin="round"/>
    <path d="M48.7,30.7 L44.7,75.3 M63.3,29.3 L59.3,76.7" stroke="#C2E7FF" stroke-opacity="0.55" stroke-width="1.8"/>
    <path d="M32.7,46 L76.7,44.7 M31.3,60 L75.3,61.3" stroke="#C2E7FF" stroke-opacity="0.55" stroke-width="1.8"/>
    <path d="M47.3,45.6 L62.0,45.1 L60.7,60.9 L46.0,60.4 Z" fill="#A8C7FA"/>
    <circle cx="34" cy="32" r="4.5" fill="#D3E3FD" stroke="#0842A0" stroke-width="1.8"/>
    <circle cx="78" cy="28" r="4.5" fill="#D3E3FD" stroke="#0842A0" stroke-width="1.8"/>
    <circle cx="74" cy="78" r="4.5" fill="#D3E3FD" stroke="#0842A0" stroke-width="1.8"/>
    <circle cx="30" cy="74" r="4.5" fill="#D3E3FD" stroke="#0842A0" stroke-width="1.8"/>
  </g>
</svg>
`;

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) {
      c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

function pointInPoly(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    const intersect = yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi + 1e-9) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function distToSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const l2 = vx * vx + vy * vy;
  let t = l2 > 1e-9 ? ((px - ax) * vx + (py - ay) * vy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}

function blend(dst, src) {
  const sa = src[3];
  if (sa <= 0) return dst;
  const da = dst[3];
  const outA = sa + da * (1 - sa);
  if (outA <= 1e-6) return [0, 0, 0, 0];
  return [
    (src[0] * sa + dst[0] * da * (1 - sa)) / outA,
    (src[1] * sa + dst[1] * da * (1 - sa)) / outA,
    (src[2] * sa + dst[2] * da * (1 - sa)) / outA,
    outA,
  ];
}

// Geometry matching ic_launcher_background.xml + ic_launcher_foreground.xml in 0..108 space
const QUAD = [
  [34, 32],
  [78, 28],
  [74, 78],
  [30, 74],
];
const CENTER_CELL = [
  [47.3, 45.6],
  [62.0, 45.1],
  [60.7, 60.9],
  [46.0, 60.4],
];
const INNER_LINES = [
  [48.7, 30.7, 44.7, 75.3],
  [63.3, 29.3, 59.3, 76.7],
  [32.7, 46.0, 76.7, 44.7],
  [31.3, 60.0, 75.3, 61.3],
];
const CORNERS = QUAD;

function sampleIcon(x, y, roundMask) {
  // Clip mask: squircle/rounded square (4..104, r=24) or circle (center 54, r=50)
  if (roundMask) {
    if (Math.hypot(x - 54, y - 54) > 50) return [0, 0, 0, 0];
  } else {
    const cx = Math.max(28, Math.min(80, x));
    const cy = Math.max(28, Math.min(80, y));
    if (Math.hypot(x - cx, y - cy) > 24) return [0, 0, 0, 0];
  }

  // Background base #111820
  let col = [0x11, 0x18, 0x20, 1];

  // Top curved highlight #182738: Q54,90 from (0,62) to (108,68)
  const t = x / 108;
  const waveY = (1 - t) * (1 - t) * 62 + 2 * (1 - t) * t * 90 + t * t * 68;
  if (y <= waveY) {
    col = [0x18, 0x27, 0x38, 1];
  }

  // Quad translucent fill #1A84D7AA
  if (pointInPoly(x, y, QUAD)) {
    col = blend(col, [0x84, 0xd7, 0xaa, 0.12]);
  }

  // Inner grid dividers #80C2E7FF, stroke-width 1.8
  for (const [ax, ay, bx, by] of INNER_LINES) {
    if (distToSegment(x, y, ax, ay, bx, by) <= 0.9) {
      col = blend(col, [0xc2, 0xe7, 0xff, 0.55]);
    }
  }

  // Filled center cell #A8C7FA
  if (pointInPoly(x, y, CENTER_CELL)) {
    col = blend(col, [0xa8, 0xc7, 0xfa, 1.0]);
  }

  // Outer quad border #A8C7FA, stroke-width 2.6
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = QUAD[i];
    const [bx, by] = QUAD[(i + 1) % 4];
    if (distToSegment(x, y, ax, ay, bx, by) <= 1.3) {
      col = blend(col, [0xa8, 0xc7, 0xfa, 1.0]);
    }
  }

  // 4 corner handles: fill #D3E3FD, r=4.5, stroke #0842A0 width 1.8
  for (const [hx, hy] of CORNERS) {
    const d = Math.hypot(x - hx, y - hy);
    if (d <= 5.4) {
      if (d <= 3.6) {
        col = blend(col, [0xd3, 0xe3, 0xfd, 1.0]);
      } else {
        col = blend(col, [0x08, 0x42, 0xa0, 1.0]);
      }
    }
  }

  return col;
}

function createPng(size, roundMask = false) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const ss = 3; // 3x3 supersampling anti-aliasing
  const invN = 1 / (ss * ss);

  for (let y = 0; y < size; y++) {
    const rowOff = y * (size * 4 + 1);
    raw[rowOff] = 0;
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const ux = ((x + (sx + 0.5) / ss) / size) * 108;
          const uy = ((y + (sy + 0.5) / ss) / size) * 108;
          const s = sampleIcon(ux, uy, roundMask);
          r += s[0] * s[3];
          g += s[1] * s[3];
          b += s[2] * s[3];
          a += s[3];
        }
      }
      const outA = a * invN;
      const px = rowOff + 1 + x * 4;
      if (outA <= 1e-4) {
        raw[px] = 0; raw[px + 1] = 0; raw[px + 2] = 0; raw[px + 3] = 0;
      } else {
        raw[px] = Math.round(Math.min(255, r / a));
        raw[px + 1] = Math.round(Math.min(255, g / a));
        raw[px + 2] = Math.round(Math.min(255, b / a));
        raw[px + 3] = Math.round(Math.min(255, outA * 255));
      }
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function createIcoFromPngs(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);

  let offset = 6 + entries.length * 16;
  const dirBuffers = [];
  const dataBuffers = [];

  for (const { size, buf } of entries) {
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size;
    entry[1] = size >= 256 ? 0 : size;
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(buf.length, 8);
    entry.writeUInt32LE(offset, 12);
    dirBuffers.push(entry);
    dataBuffers.push(buf);
    offset += buf.length;
  }

  return Buffer.concat([header, ...dirBuffers, ...dataBuffers]);
}

function createIcnsFromPng(pngBuf) {
  const chunkLen = 8 + pngBuf.length;
  const totalLen = 8 + chunkLen;
  const header = Buffer.alloc(8);
  header.write('icns', 0, 'ascii');
  header.writeUInt32BE(totalLen, 4);
  const chunkHeader = Buffer.alloc(8);
  chunkHeader.write('ic08', 0, 'ascii');
  chunkHeader.writeUInt32BE(chunkLen, 4);
  return Buffer.concat([header, chunkHeader, pngBuf]);
}

const png256 = createPng(256, false);
const png48 = createPng(48, false);
const png32 = createPng(32, false);
const icoAll = createIcoFromPngs([
  { size: 32, buf: png32 },
  { size: 48, buf: png48 },
  { size: 256, buf: png256 },
]);

// Desktop (Windows / macOS Tauri 2)
fs.writeFileSync(path.join(iconsDir, 'icon.png'), png256);
fs.writeFileSync(path.join(iconsDir, 'icon.ico'), icoAll);
fs.writeFileSync(path.join(iconsDir, 'icon.icns'), createIcnsFromPng(png256));

// Web favicon
fs.writeFileSync(path.join(publicDir, 'favicon.svg'), UNIFIED_SVG, 'utf8');
fs.writeFileSync(path.join(publicDir, 'favicon.ico'), icoAll);

// Android legacy fallback PNGs
fs.writeFileSync(path.join(androidMipmapDir, 'ic_launcher.png'), createPng(192, false));
fs.writeFileSync(path.join(androidMipmapDir, 'ic_launcher_round.png'), createPng(192, true));

console.log('Generated unified Android-style PenpaAnywhere icons for Web, Windows, macOS, and Android.');
