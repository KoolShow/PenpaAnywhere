import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const iconsDir = path.resolve(__dirname, '..', 'src-tauri', 'icons');
fs.mkdirSync(iconsDir, { recursive: true });

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

function createPng(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    const rowOff = y * (size * 4 + 1);
    raw[rowOff] = 0;
    for (let x = 0; x < size; x++) {
      const px = rowOff + 1 + x * 4;
      const nx = x / (size - 1);
      const ny = y / (size - 1);
      // Rounded dark MD3 surface with primary perspective grid icon
      const dx = Math.abs(nx - 0.5);
      const dy = Math.abs(ny - 0.5);
      const inside = dx < 0.44 && dy < 0.44;
      if (!inside) {
        raw[px] = 0; raw[px + 1] = 0; raw[px + 2] = 0; raw[px + 3] = 0;
        continue;
      }
      // Subtle grid lines
      const gx = Math.abs(((nx - 0.14) / 0.72) * 3 - Math.round(((nx - 0.14) / 0.72) * 3));
      const gy = Math.abs(((ny - 0.14) / 0.72) * 3 - Math.round(((ny - 0.14) / 0.72) * 3));
      const inGrid = nx > 0.14 && nx < 0.86 && ny > 0.14 && ny < 0.86;
      const isLine = inGrid && (gx < 0.08 || gy < 0.08);
      const isCorner =
        (Math.hypot(nx - 0.14, ny - 0.14) < 0.065) ||
        (Math.hypot(nx - 0.86, ny - 0.14) < 0.065) ||
        (Math.hypot(nx - 0.86, ny - 0.86) < 0.065) ||
        (Math.hypot(nx - 0.14, ny - 0.86) < 0.065);

      if (isCorner) {
        // #a8c7fa
        raw[px] = 0xa8; raw[px + 1] = 0xc7; raw[px + 2] = 0xfa; raw[px + 3] = 0xff;
      } else if (isLine) {
        // #c2e7ff
        raw[px] = 0xc2; raw[px + 1] = 0xe7; raw[px + 2] = 0xff; raw[px + 3] = 0xe0;
      } else {
        // #1d2024
        raw[px] = 0x1d; raw[px + 1] = 0x20; raw[px + 2] = 0x24; raw[px + 3] = 0xff;
      }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const idat = zlib.deflateSync(raw);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function createIcoFromPng(pngBuf, size) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // ICO
  header.writeUInt16LE(1, 4); // 1 image

  const entry = Buffer.alloc(16);
  entry[0] = size >= 256 ? 0 : size;
  entry[1] = size >= 256 ? 0 : size;
  entry[2] = 0;
  entry[3] = 0;
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(pngBuf.length, 8);
  entry.writeUInt32LE(6 + 16, 12);

  return Buffer.concat([header, entry, pngBuf]);
}

function createIcnsFromPng(pngBuf) {
  // Apple ICNS container with ic08 (256x256 PNG) chunk
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

const png256 = createPng(256);
fs.writeFileSync(path.join(iconsDir, 'icon.png'), png256);
fs.writeFileSync(path.join(iconsDir, 'icon.ico'), createIcoFromPng(png256, 256));
fs.writeFileSync(path.join(iconsDir, 'icon.icns'), createIcnsFromPng(png256));
console.log('Generated src-tauri/icons/icon.png, icon.ico, and icon.icns');
