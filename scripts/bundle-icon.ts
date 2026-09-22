/**
 * A minimal PNG icon for the bundle, generated at build time (`bundle/` is gitignored, so
 * nothing binary needs to live in the repository) rather than hand-drawn and committed. A plain
 * RGBA raster, one filter-type-0 scanline per row, deflated with `node:zlib` — no image library,
 * just the PNG chunk format (signature, IHDR, IDAT, IEND) and a table-based CRC-32, both small
 * enough to keep inline and verify by eye.
 *
 * The mark: a flat graphite square (matching this project's plain, text-first tone — no gradient,
 * no photographic detail that would need a real design tool) with a lighter rounded "note" card
 * left-aligned on it and two short pale strokes standing in for text lines — a vault note, which
 * is what this server reads and writes.
 */
import { createHash } from 'node:crypto';
import zlib from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buf) crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

interface Rgb {
  r: number;
  g: number;
  b: number;
}

const BACKGROUND: Rgb = { r: 39, g: 42, b: 51 }; // graphite
const CARD: Rgb = { r: 232, g: 231, b: 226 }; // warm off-white, like paper
const CARD_SHADOW: Rgb = { r: 27, g: 29, b: 35 };
const STROKE: Rgb = { r: 130, g: 150, b: 160 }; // muted teal-grey text lines

/** True inside a rounded-rectangle outline (corner radius `r`), false outside — the one bit of
 *  geometry this needs beyond plain rectangles. */
function inRoundedRect(
  x: number,
  y: number,
  left: number,
  top: number,
  right: number,
  bottom: number,
  r: number,
): boolean {
  if (x < left || x >= right || y < top || y >= bottom) return false;
  const nearLeft = x < left + r;
  const nearRight = x >= right - r;
  const nearTop = y < top + r;
  const nearBottom = y >= bottom - r;
  if ((nearLeft || nearRight) && (nearTop || nearBottom)) {
    const cx = nearLeft ? left + r : right - r;
    const cy = nearTop ? top + r : bottom - r;
    const dx = x - cx + 0.5;
    const dy = y - cy + 0.5;
    return dx * dx + dy * dy <= r * r;
  }
  return true;
}

export function renderIconPng(size: number): Buffer {
  const pixels = Buffer.alloc(size * size * 4);
  const s = size;
  const cardLeft = Math.round(s * 0.24);
  const cardTop = Math.round(s * 0.18);
  const cardRight = Math.round(s * 0.78);
  const cardBottom = Math.round(s * 0.82);
  const cardRadius = Math.round(s * 0.06);
  const shadowOffset = Math.max(2, Math.round(s * 0.035));

  const setPixel = (x: number, y: number, c: Rgb, alpha = 255): void => {
    const i = (y * s + x) * 4;
    pixels[i] = c.r;
    pixels[i + 1] = c.g;
    pixels[i + 2] = c.b;
    pixels[i + 3] = alpha;
  };

  for (let y = 0; y < s; y += 1) {
    for (let x = 0; x < s; x += 1) {
      setPixel(x, y, BACKGROUND);
      if (
        inRoundedRect(
          x,
          y,
          cardLeft + shadowOffset,
          cardTop + shadowOffset,
          cardRight + shadowOffset,
          cardBottom + shadowOffset,
          cardRadius,
        )
      ) {
        setPixel(x, y, CARD_SHADOW);
      }
    }
  }
  for (let y = 0; y < s; y += 1) {
    for (let x = 0; x < s; x += 1) {
      if (inRoundedRect(x, y, cardLeft, cardTop, cardRight, cardBottom, cardRadius)) {
        setPixel(x, y, CARD);
      }
    }
  }
  // Two short "text" strokes near the top of the card, left-aligned, and one shorter third line —
  // reads as a note without needing an actual font.
  const lineLeft = cardLeft + Math.round(s * 0.08);
  const lineHeight = Math.max(2, Math.round(s * 0.035));
  const lineGap = Math.round(s * 0.1);
  const lineWidths = [
    cardRight - lineLeft - Math.round(s * 0.06),
    Math.round((cardRight - lineLeft) * 0.66),
  ];
  let lineTop = cardTop + Math.round(s * 0.14);
  for (const width of lineWidths) {
    for (let y = lineTop; y < lineTop + lineHeight; y += 1) {
      for (let x = lineLeft; x < lineLeft + width && x < cardRight - Math.round(s * 0.06); x += 1) {
        setPixel(x, y, STROKE);
      }
    }
    lineTop += lineGap;
  }

  const rawScanlines = Buffer.alloc((s * 4 + 1) * s);
  for (let y = 0; y < s; y += 1) {
    const rowStart = y * (s * 4 + 1);
    rawScanlines[rowStart] = 0; // filter type 0 (none)
    pixels.copy(rawScanlines, rowStart + 1, y * s * 4, (y + 1) * s * 4);
  }
  const idatData = zlib.deflateSync(rawScanlines, { level: 9 });

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(s, 0);
  ihdr.writeUInt32BE(s, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', idatData),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** For a quick sanity check without opening the file — never used by the build itself. */
export function pngSha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}
