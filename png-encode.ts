// PNG encoder for the png-squeeze entry: colour-type reduction (palette / grey /
// RGB / RGBA, with a tRNS key when one transparent value covers all non-opaque
// pixels), per-row filter choice (fixed filters, minimum-sum and fewest-pairs
// heuristics, and per-row brute force weighed by zlib), screened at zlib level 6
// and finally written at level 9 with the better of the default and filtered
// strategies. Lossless: every channel of every pixel, transparent colours included.
import { constants, deflateSync } from 'node:zlib';
import { crc32 } from './png-decode.ts';
import { zlibOptimal } from './deflate-opt.ts';

const SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
const SCREEN = { level: 6, memLevel: 8, strategy: constants.Z_DEFAULT_STRATEGY };
const BRUTE_CONTEXT = 32768;
const BRUTE_LEVEL = 4;

type FilterChoice = number | 'minsum' | 'pairs' | 'brute';

interface Colour {
  rgba: [number, number, number, number];
  word: number;
  count: number;
}
interface Form {
  colourType: number;
  bpp: number;
  samples: Uint8Array;
  plte: Uint8Array | null;
  trns: Uint8Array | null;
  filters: FilterChoice[];
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

/** Filter one row (type 0-4) from `cur` against `prev` (null on the first row). */
function filterRow(type: number, cur: Uint8Array, prev: Uint8Array | null, bpp: number, out: Uint8Array): void {
  const n = cur.length;
  if (type === 0) {
    out.set(cur);
  } else if (type === 1) {
    for (let i = 0; i < n; i++) out[i] = (cur[i] - (i >= bpp ? cur[i - bpp] : 0)) & 0xff;
  } else if (type === 2) {
    for (let i = 0; i < n; i++) out[i] = (cur[i] - (prev ? prev[i] : 0)) & 0xff;
  } else if (type === 3) {
    for (let i = 0; i < n; i++) {
      const left = i >= bpp ? cur[i - bpp] : 0;
      const up = prev ? prev[i] : 0;
      out[i] = (cur[i] - ((left + up) >> 1)) & 0xff;
    }
  } else {
    for (let i = 0; i < n; i++) {
      const left = i >= bpp ? cur[i - bpp] : 0;
      const up = prev ? prev[i] : 0;
      const upLeft = i >= bpp && prev ? prev[i - bpp] : 0;
      out[i] = (cur[i] - paeth(left, up, upLeft)) & 0xff;
    }
  }
}

/** Sum of absolute values of the row's bytes read as signed (-128..127). */
function signedSum(row: Uint8Array): number {
  let s = 0;
  for (let i = 0; i < row.length; i++) {
    const b = row[i];
    s += b < 128 ? b : 256 - b;
  }
  return s;
}

function pairsOf(row: Uint8Array, seen: Uint32Array, stamp: number): number {
  let n = 0;
  for (let i = 1; i < row.length; i++) {
    const pair = (row[i - 1] << 8) | row[i];
    if (seen[pair] !== stamp) {
      seen[pair] = stamp;
      n++;
    }
  }
  return n;
}

/** What the image holds: opaque/grey flags and its colours when at most 256. */
function analyse(rgba: Uint8Array): { opaque: boolean; grey: boolean; colours: Colour[] | null } {
  const n = rgba.length >>> 2;
  let opaque = true;
  let grey = true;
  const counts = new Map<number, number>();
  let many = false;
  const words = new Uint32Array(rgba.buffer, rgba.byteOffset, n);
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    if (rgba[d + 3] !== 255) opaque = false;
    if (rgba[d] !== rgba[d + 1] || rgba[d] !== rgba[d + 2]) grey = false;
    if (!many) {
      const c = words[i];
      const k = counts.get(c);
      if (k === undefined) {
        if (counts.size === 256) many = true;
        else counts.set(c, 1);
      } else counts.set(c, k + 1);
    }
  }
  if (many) return { opaque, grey, colours: null };
  const colours = [...counts.keys()].map((c) => {
    const b = new Uint8Array(Uint32Array.of(c).buffer);
    return { rgba: [b[0], b[1], b[2], b[3]] as [number, number, number, number], word: c, count: counts.get(c)! };
  });
  return { opaque, grey, colours };
}

/**
 * The one fully transparent value (grey sample or RGB triple) the image may key
 * by tRNS instead of an alpha channel: every non-opaque pixel is that exact
 * value at alpha 0, and no opaque pixel shares the value.
 */
function transparentKey(rgba: Uint8Array, grey: boolean): number | null {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return null;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v;
    else if (key !== v) return null;
  }
  if (key === -1) return null;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return null;
  }
  return key;
}

function samplesOf(rgba: Uint8Array, ct: number): Uint8Array {
  const n = rgba.length >>> 2;
  if (ct === 6) return rgba;
  const ch = ct === 0 ? 1 : ct === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (ct === 0) out[s] = rgba[d];
    else if (ct === 4) {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 3];
    } else {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 1];
      out[s + 2] = rgba[d + 2];
    }
  }
  return out;
}

function paletteForm(rgba: Uint8Array, colours: Colour[], order: 'count' | 'luminance'): Form {
  const lum = (c: Colour) => 299 * c.rgba[0] + 587 * c.rgba[1] + 114 * c.rgba[2];
  const entries = [...colours].sort((x, y) => {
    const ta = x.rgba[3] === 255 ? 1 : 0;
    const tb = y.rgba[3] === 255 ? 1 : 0;
    if (ta !== tb) return ta - tb;
    if (ta === 0 && x.rgba[3] !== y.rgba[3]) return x.rgba[3] - y.rgba[3];
    if (order === 'luminance') return lum(x) - lum(y) || x.word - y.word;
    return y.count - x.count || x.word - y.word;
  });
  const index = new Map(entries.map((c, i) => [c.word, i]));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.rgba[0];
    plte[i * 3 + 1] = c.rgba[1];
    plte[i * 3 + 2] = c.rgba[2];
    if (c.rgba[3] !== 255) transparent = i + 1;
  });
  const trns = transparent === 0 ? null : Uint8Array.from(entries.slice(0, transparent), (c) => c.rgba[3]);
  const n = rgba.length >>> 2;
  const words = new Uint32Array(rgba.buffer, rgba.byteOffset, n);
  const indices = new Uint8Array(n);
  for (let i = 0; i < n; i++) indices[i] = index.get(words[i])!;
  return {
    colourType: 3,
    bpp: 1,
    samples: indices,
    plte,
    trns,
    filters: order === 'count' ? [0] : [0, 'minsum', 'brute'],
  };
}

function formsOf(rgba: Uint8Array): Form[] {
  const { opaque, grey, colours } = analyse(rgba);
  const forms: Form[] = [];
  if (colours !== null) {
    forms.push(paletteForm(rgba, colours, 'count'));
    forms.push(paletteForm(rgba, colours, 'luminance'));
    if (!grey) return forms;
  }
  const key = opaque ? null : transparentKey(rgba, grey);
  let ct: number;
  let trns: Uint8Array | null = null;
  if (grey) {
    ct = opaque || key !== null ? 0 : 4;
    if (key !== null) trns = Uint8Array.of(0, key);
  } else {
    ct = opaque || key !== null ? 2 : 6;
    if (key !== null) trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff);
  }
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct]!;
  forms.push({
    colourType: ct,
    bpp,
    samples: samplesOf(rgba, ct),
    plte: null,
    trns,
    // Fixed filters and the pairs heuristic are screened out: per-row minsum
    // and brute force dominate them on this data, and each screened choice
    // costs a full level-6 deflate out of the 60-second wall.
    filters: [0, 'minsum', 'brute'],
  });
  return forms;
}

/** Filter every row of `samples` by `choice`, into a fresh buffer. */
function filtered(samples: Uint8Array, width: number, height: number, bpp: number, choice: FilterChoice): Uint8Array {
  const stride = width * bpp;
  const raw = new Uint8Array(height * (stride + 1));
  const trial: Uint8Array[] = [];
  for (let t = 0; t < 5; t++) {
    const row = new Uint8Array(stride + 1);
    row[0] = t;
    trial.push(row);
  }
  const seen = new Uint32Array(65536);
  let stamp = 0;
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    if (typeof choice === 'number') {
      raw[at] = choice;
      filterRow(choice, cur, prev, bpp, raw.subarray(at + 1, at + 1 + stride));
      continue;
    }
    const before = raw.subarray(Math.max(0, at - BRUTE_CONTEXT), at);
    let type = 0;
    let best = Infinity;
    for (let t = 0; t < 5; t++) {
      filterRow(t, cur, prev, bpp, trial[t].subarray(1));
      let cost: number;
      if (choice === 'minsum') cost = signedSum(trial[t].subarray(1));
      else if (choice === 'pairs') cost = pairsOf(trial[t].subarray(1), seen, ++stamp);
      else {
        cost = deflateSync(
          trial[t],
          before.length === 0
            ? { level: BRUTE_LEVEL, memLevel: 9 }
            : { level: BRUTE_LEVEL, memLevel: 9, dictionary: before },
        ).length;
      }
      if (cost < best) {
        best = cost;
        type = t;
      }
    }
    raw.set(trial[type], at);
  }
  return raw;
}

const chunkBytes = (form: Form) =>
  (form.plte === null ? 0 : 12 + form.plte.length) + (form.trns === null ? 0 : 12 + form.trns.length);

/** Screen every form and filter choice at zlib level 6; return the three best,
 *  each with the level-6 stream already computed, so the caller never re-runs it. */
function screen(
  rgba: Uint8Array,
  width: number,
  height: number,
): { form: Form; data: Uint8Array; bytes: number; zlib: Buffer }[] {
  const ranked: { form: Form; data: Uint8Array; bytes: number; zlib: Buffer }[] = [];
  for (const form of formsOf(rgba)) {
    const chunks = chunkBytes(form);
    for (const choice of form.filters) {
      const data = filtered(form.samples, width, height, form.bpp, choice);
      const zlib = deflateSync(data, SCREEN);
      const bytes = zlib.length + chunks;
      ranked.push({ form, data, bytes, zlib });
    }
  }
  ranked.sort((a, b) => a.bytes - b.bytes);
  return ranked.slice(0, 3);
}

function pngOf(chunks: [string, Uint8Array][]): Uint8Array {
  let size = SIGNATURE.length;
  for (const [, data] of chunks) size += 12 + data.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set(SIGNATURE, 0);
  let at = SIGNATURE.length;
  for (const [type, data] of chunks) {
    view.setUint32(at, data.length);
    for (let i = 0; i < 4; i++) out[at + 4 + i] = type.charCodeAt(i);
    out.set(data, at + 8);
    view.setUint32(at + 8 + data.length, crc32(out, at + 4, at + 8 + data.length));
    at += 12 + data.length;
  }
  return out;
}

function ihdrOf(width: number, height: number, colourType: number): Uint8Array {
  const d = new Uint8Array(13);
  const v = new DataView(d.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  d[8] = 8;
  d[9] = colourType;
  return d;
}


/** The smallest lossless PNG of the RGBA image: screen, then re-encode the best
 *  few candidates at level 6 and level 9 (default and filtered strategies), and
 *  the best candidate with the optimal-parse deflate; keep the smallest stream.
 *  The optimal-parse stream is verified by inflation before use, and any failure
 *  there falls back to the zlib streams. */
export function encodePng(rgba: Uint8Array, width: number, height: number): Uint8Array {
  let best: { form: Form; idat: Uint8Array; bytes: number } | null = null;
  const ranked = screen(rgba, width, height);
  for (let k = 0; k < ranked.length; k++) {
    const { form, data, zlib } = ranked[k];
    const tries: Uint8Array[] = [
      zlib,
      deflateSync(data, { level: 9, memLevel: 9 }),
      deflateSync(data, { level: 9, memLevel: 9, strategy: constants.Z_FILTERED }),
    ];
    if (k === 0) {
      try {
        tries.push(zlibOptimal(data));
      } catch {
        // The optimal-parse stream failed its own round-trip check: ignore it.
      }
    }
    for (const idat of tries) {
      const bytes = idat.length + chunkBytes(form);
      if (best === null || bytes < best.bytes) best = { form, idat, bytes };
    }
  }
  const { form, idat } = best!;
  const chunks: [string, Uint8Array][] = [['IHDR', ihdrOf(width, height, form.colourType)]];
  if (form.plte !== null) chunks.push(['PLTE', form.plte]);
  if (form.trns !== null) chunks.push(['tRNS', form.trns]);
  chunks.push(['IDAT', new Uint8Array(idat.buffer, idat.byteOffset, idat.length)]);
  chunks.push(['IEND', new Uint8Array(0)]);
  return pngOf(chunks);
}
