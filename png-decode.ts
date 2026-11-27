// PNG decoder written for the png-squeeze entry: reads the 8-bit, non-interlaced
// PNGs the contest accepts (colour types 0, 2, 3, 4, 6; chunks IHDR, PLTE, tRNS,
// IDAT, IEND only) and expands them to RGBA, honouring palette and tRNS so a
// fully transparent pixel's colour round-trips exactly.
import { inflateSync } from 'node:zlib';

export type Decoded =
  | { ok: true; width: number; height: number; rgba: Uint8Array }
  | { ok: false; why: string };

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

export function crc32(bytes: Uint8Array, start = 0, end = bytes.length): number {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** Undo one row's filter, in place, given the previous reconstructed row (or null). */
function unfilterRow(type: number, row: Uint8Array, prev: Uint8Array | null, bpp: number): void {
  const n = row.length;
  if (type === 0) return;
  if (type === 1) {
    for (let i = bpp; i < n; i++) row[i] = (row[i] + row[i - bpp]) & 0xff;
  } else if (type === 2) {
    if (prev) for (let i = 0; i < n; i++) row[i] = (row[i] + prev[i]) & 0xff;
  } else if (type === 3) {
    for (let i = 0; i < n; i++) {
      const left = i >= bpp ? row[i - bpp] : 0;
      const up = prev ? prev[i] : 0;
      row[i] = (row[i] + ((left + up) >> 1)) & 0xff;
    }
  } else if (type === 4) {
    for (let i = 0; i < n; i++) {
      const left = i >= bpp ? row[i - bpp] : 0;
      const up = prev ? prev[i] : 0;
      const upLeft = i >= bpp && prev ? prev[i - bpp] : 0;
      row[i] = (row[i] + paeth(left, up, upLeft)) & 0xff;
    }
  }
}

export function decodePng(bytes: Uint8Array): Decoded {
  const fail = (why: string): Decoded => ({ ok: false, why });
  if (bytes.length < 8) return fail('file too short for a PNG signature');
  for (let i = 0; i < 8; i++) if (bytes[i] !== SIGNATURE[i]) return fail('bad PNG signature');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let width = 0;
  let height = 0;
  let colourType = -1;
  let plte: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  let seenIhdr = false;
  let seenIdat = false;
  let seenIend = false;
  let seenTrns = false;
  while (at + 8 <= bytes.length) {
    const len = view.getUint32(at);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    const dataStart = at + 8;
    const dataEnd = dataStart + len;
    if (dataEnd + 4 > bytes.length) return fail(`chunk ${type} runs past the file end`);
    const crc = view.getUint32(dataEnd);
    if (crc32(bytes, at + 4, dataEnd) !== crc) return fail(`chunk ${type} has a bad CRC`);
    const data = bytes.subarray(dataStart, dataEnd);
    if (type === 'IHDR') {
      if (seenIhdr || at !== 8 || len !== 13) return fail('IHDR misplaced or wrong size');
      seenIhdr = true;
      width = view.getUint32(dataStart);
      height = view.getUint32(dataStart + 4);
      if (data[8] !== 8) return fail('bit depth is not 8');
      colourType = data[9];
      if (!(colourType in CHANNELS)) return fail(`colour type ${colourType} not accepted`);
      if (data[10] !== 0 || data[11] !== 0 || data[12] !== 0) return fail('unsupported compression, filter or interlace');
      if (width === 0 || height === 0) return fail('zero width or height');
    } else if (type === 'PLTE') {
      if (!seenIhdr || seenIdat || plte !== null) return fail('PLTE misplaced');
      if (colourType !== 3) return fail('PLTE with a non-palette colour type');
      if (len === 0 || len % 3 !== 0 || len / 3 > 256) return fail('PLTE has a bad entry count');
      plte = data.slice();
    } else if (type === 'tRNS') {
      if (!seenIhdr || seenIdat || seenTrns) return fail('tRNS misplaced or repeated');
      if (colourType === 4 || colourType === 6) return fail('tRNS with an alpha colour type');
      seenTrns = true;
      trns = data.slice();
    } else if (type === 'IDAT') {
      if (!seenIhdr) return fail('IDAT before IHDR');
      seenIdat = true;
      idat.push(data);
    } else if (type === 'IEND') {
      if (!seenIhdr || !seenIdat || len !== 0) return fail('IEND misplaced or non-empty');
      seenIend = true;
      if (dataEnd + 4 !== bytes.length) return fail('bytes after IEND');
      break;
    } else {
      return fail(`chunk ${type} is not one the contest reads`);
    }
    at = dataEnd + 4;
  }
  if (!seenIhdr || !seenIdat || !seenIend) return fail('missing IHDR, IDAT or IEND');
  if (colourType === 3 && plte === null) return fail('palette image without PLTE');
  const channels = CHANNELS[colourType];
  const stride = width * channels;
  const rawLen = height * (stride + 1);
  let raw: Uint8Array;
  try {
    const joined = new Uint8Array(idat.reduce((s, d) => s + d.length, 0));
    let off = 0;
    for (const d of idat) {
      joined.set(d, off);
      off += d.length;
    }
    raw = inflateSync(joined);
  } catch (e) {
    return fail(`IDAT does not inflate: ${(e as Error).message}`);
  }
  if (raw.length !== rawLen) return fail(`inflated data is ${raw.length} bytes, expected ${rawLen}`);
  const samples = new Uint8Array(height * stride);
  const bpp = channels;
  let prev: Uint8Array | null = null;
  for (let y = 0; y < height; y++) {
    const ftype = raw[y * (stride + 1)];
    if (ftype > 4) return fail(`row ${y} has filter type ${ftype}`);
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    unfilterRow(ftype, row, prev, bpp);
    samples.set(row, y * stride);
    prev = row;
  }
  const n = width * height;
  const rgba = new Uint8Array(n * 4);
  if (colourType === 6) {
    rgba.set(samples);
  } else if (colourType === 2) {
    const key = trns && trns.length >= 6 ? [trns[1], trns[3], trns[5]] : null;
    for (let i = 0, s = 0; i < n; i++, s += 3) {
      const d = i * 4;
      rgba[d] = samples[s];
      rgba[d + 1] = samples[s + 1];
      rgba[d + 2] = samples[s + 2];
      rgba[d + 3] = key && samples[s] === key[0] && samples[s + 1] === key[1] && samples[s + 2] === key[2] ? 0 : 255;
    }
  } else if (colourType === 0) {
    const key = trns && trns.length >= 2 ? trns[1] : -1;
    for (let i = 0; i < n; i++) {
      const d = i * 4;
      rgba[d] = rgba[d + 1] = rgba[d + 2] = samples[i];
      rgba[d + 3] = samples[i] === key ? 0 : 255;
    }
  } else if (colourType === 4) {
    for (let i = 0, s = 0; i < n; i++, s += 2) {
      const d = i * 4;
      rgba[d] = rgba[d + 1] = rgba[d + 2] = samples[s];
      rgba[d + 3] = samples[s + 1];
    }
  } else {
    // colour type 3: palette indices, tRNS alphas where present, opaque past it.
    const entries = plte!.length / 3;
    for (let i = 0; i < n; i++) {
      const idx = samples[i];
      if (idx >= entries) return fail(`palette index ${idx} past the palette`);
      const d = i * 4;
      rgba[d] = plte![idx * 3];
      rgba[d + 1] = plte![idx * 3 + 1];
      rgba[d + 2] = plte![idx * 3 + 2];
      rgba[d + 3] = trns && idx < trns.length ? trns[idx] : 255;
    }
  }
  return { ok: true, width, height, rgba };
}
