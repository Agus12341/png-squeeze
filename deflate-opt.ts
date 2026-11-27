// A zopfli-style DEFLATE encoder: hash-chain longest-match search, optimal-parse
// (shortest-path) dynamic programming with exact bit costs, then per-block dynamic
// Huffman coding. Deterministic: fixed work per input, no clock, no randomness.
// Used as an extra candidate beside node:zlib; the caller keeps whichever stream
// is smaller, so a bug here can only cost bytes, never correctness (every stream
// this module returns is verified by inflation before use).
import { inflateSync } from 'node:zlib';

// DEFLATE length codes: base length and extra bits for codes 257..285.
const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
// DEFLATE distance codes: base distance and extra bits for codes 0..29.
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
// Lengths where the length code (or its extra-bit count) changes, plus 258.
const LEN_STEPS = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];

const MAX_MATCH = 258;
const MIN_MATCH = 3;
const WINDOW = 32768;
const HASH_BITS = 15;
const HASH_SIZE = 1 << HASH_BITS;
const CHAIN_MAX = 256;
const CHAIN_DP = 32;
const NICE_LEN = 128;
const NICE_DP = 64;
const BLOCK_BYTES = 131072;

function lenCodeOf(len: number): number {
  let lo = 0;
  let hi = 28;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (LEN_BASE[mid] <= len) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
function distCodeOf(dist: number): number {
  let lo = 0;
  let hi = 29;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (DIST_BASE[mid] <= dist) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function hash3(d: Uint8Array, i: number): number {
  return (((d[i] << 10) ^ (d[i + 1] << 5) ^ d[i + 2]) & (HASH_SIZE - 1)) >>> 0;
}

/** Longest match of d[i..] against d[p..], capped at maxLen. */
function matchLen(d: Uint8Array, i: number, p: number, maxLen: number): number {
  let n = 0;
  const end = i + maxLen;
  while (i + n < end && d[i + n] === d[p + n]) n++;
  return n;
}

// --- Huffman: length-limited code lengths from frequencies, via a heap plus a
// frequency floor that is raised until no code exceeds maxLen. Deterministic.
function codeLengths(freq: Uint32Array | number[], maxLen: number): Uint8Array {
  const n = freq.length;
  const total = freq.reduce((a, b) => a + b, 0);
  let floor = 1;
  for (;;) {
    const f = new Float64Array(n);
    // Floor only symbols actually used: an unused symbol must keep length 0,
    // or the header bloats and the RLE loses its zero runs.
    for (let s = 0; s < n; s++) f[s] = freq[s] > 0 ? Math.max(freq[s], floor) : 0;
    const lens = huffmanLengths(f, maxLen);
    let mx = 0;
    for (let s = 0; s < n; s++) if (freq[s] > 0 && lens[s] > mx) mx = lens[s];
    if (mx <= maxLen) return lens;
    floor = Math.max(floor * 2, Math.ceil(total / (1 << (maxLen - 1))));
    if (floor > total) floor = total;
  }
}

function huffmanLengths(freq: Float64Array, maxLen: number): Uint8Array {
  const n = freq.length;
  // Heap of nodes, ordered by (weight, order) for determinism. Internal node
  // weights live in a plain array: a typed array would silently drop writes
  // past its length.
  const weights: number[] = Array.from(freq);
  const heapW: number[] = [];
  const heapO: number[] = [];
  const heapN: number[] = [];
  let order = 0;
  const push = (w: number, node: number) => {
    heapW.push(w);
    heapO.push(order++);
    heapN.push(node);
    let i = heapW.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heapW[p] < heapW[i] || (heapW[p] === heapW[i] && heapO[p] <= heapO[i])) break;
      [heapW[p], heapW[i]] = [heapW[i], heapW[p]];
      [heapO[p], heapO[i]] = [heapO[i], heapO[p]];
      [heapN[p], heapN[i]] = [heapN[i], heapN[p]];
      i = p;
    }
  };
  const pop = (): number => {
    const top = heapN[0];
    const lw = heapW.pop()!;
    const lo = heapO.pop()!;
    const ln = heapN.pop()!;
    if (heapW.length > 0) {
      heapW[0] = lw;
      heapO[0] = lo;
      heapN[0] = ln;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < heapW.length && (heapW[l] < heapW[m] || (heapW[l] === heapW[m] && heapO[l] < heapO[m]))) m = l;
        if (r < heapW.length && (heapW[r] < heapW[m] || (heapW[r] === heapW[m] && heapO[r] < heapO[m]))) m = r;
        if (m === i) break;
        [heapW[m], heapW[i]] = [heapW[i], heapW[m]];
        [heapO[m], heapO[i]] = [heapO[i], heapO[m]];
        [heapN[m], heapN[i]] = [heapN[i], heapN[m]];
        i = m;
      }
    }
    return top;
  };
  // Tree nodes: leaves 0..n-1, internal nodes n..; children stored per node.
  const left: number[] = [];
  const right: number[] = [];
  const depth = new Uint8Array(n);
  let alive = 0;
  for (let s = 0; s < n; s++) if (freq[s] > 0) {
    push(freq[s], s);
    alive++;
  }
  if (alive === 0) return new Uint8Array(n);
  if (alive === 1) {
    const lens = new Uint8Array(n);
    for (let s = 0; s < n; s++) if (freq[s] > 0) lens[s] = 1;
    return lens;
  }
  let next = n;
  while (heapW.length > 1) {
    const a = pop();
    const b = pop();
    left[next] = a;
    right[next] = b;
    weights[next] = weights[a] + weights[b];
    push(weights[next], next);
    next++;
  }
  const root = pop();
  // Depths by stack walk.
  const stack: [number, number][] = [[root, 0]];
  const lens = new Uint8Array(n);
  while (stack.length > 0) {
    const [node, d] = stack.pop()!;
    if (node < n) {
      lens[node] = d;
    } else {
      stack.push([left[node], d + 1]);
      stack.push([right[node], d + 1]);
    }
  }
  return lens;
}

function canonicalCodes(lens: Uint8Array): { codes: Uint32Array; lens: Uint8Array } {
  const n = lens.length;
  const blCount = new Uint16Array(16);
  for (let s = 0; s < n; s++) if (lens[s] > 0) blCount[lens[s]]++;
  const nextCode = new Uint32Array(16);
  let code = 0;
  for (let b = 1; b <= 15; b++) {
    code = (code + blCount[b - 1]) << 1;
    nextCode[b] = code;
  }
  const codes = new Uint32Array(n);
  for (let s = 0; s < n; s++) {
    const l = lens[s];
    if (l > 0) codes[s] = nextCode[l]++;
  }
  return { codes, lens };
}

// DEFLATE writes a Huffman code starting with its most significant bit, while
// the bit writer packs integers least-significant-bit first: reverse a code's
// bits before writing it. (Header fields and extra bits are plain integers
// and are written as they are.)
function revBits(code: number, len: number): number {
  let r = 0;
  for (let i = 0; i < len; i++) r = (r << 1) | ((code >> i) & 1);
  return r;
}

// --- Bit writer (LSB-first). ---
class BitWriter {
  bytes: number[] = [];
  bitbuf = 0;
  bitcnt = 0;
  write(code: number, len: number): void {
    this.bitbuf |= code << this.bitcnt;
    this.bitcnt += len;
    while (this.bitcnt >= 8) {
      this.bytes.push(this.bitbuf & 0xff);
      this.bitbuf >>>= 8;
      this.bitcnt -= 8;
    }
  }
  align(): void {
    if (this.bitcnt > 0) {
      this.bytes.push(this.bitbuf & 0xff);
      this.bitbuf = 0;
      this.bitcnt = 0;
    }
  }
  result(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

interface Token {
  lit: number; // literal byte, or -1 for a match
  len: number; // match length
  dist: number; // match distance
}

/** Best match at position i from the hash chains (positions < i already inserted). */
function findMatch(d: Uint8Array, i: number, head: Int32Array, prev: Int32Array, chainMax: number, niceLen: number = NICE_LEN): { len: number; dist: number } {
  let bestLen = 0;
  let bestDist = 0;
  const maxLen = Math.min(MAX_MATCH, d.length - i);
  let p = head[hash3(d, i)];
  let tried = 0;
  while (p !== -1 && tried++ < chainMax) {
    const dist = i - p;
    if (dist > WINDOW) break;
    const l = matchLen(d, i, p, maxLen);
    if (l > bestLen) {
      bestLen = l;
      bestDist = dist;
      if (l >= niceLen) break;
    }
    p = prev[p];
  }
  return { len: bestLen, dist: bestDist };
}

function insertPos(d: Uint8Array, i: number, head: Int32Array, prev: Int32Array): void {
  const h = hash3(d, i);
  prev[i] = head[h];
  head[h] = i;
}

/** Lazy parse: at each position, take the match only when the next position
 *  does not start a longer one. Chains hold every position before i. */
function greedyParse(d: Uint8Array, head: Int32Array, prev: Int32Array): Token[] {
  const n = d.length;
  const tokens: Token[] = [];
  head.fill(-1);
  let i = 0;
  while (i < n) {
    let cur = { len: 0, dist: 0 };
    if (i + MIN_MATCH <= n) cur = findMatch(d, i, head, prev, CHAIN_MAX);
    if (i + MIN_MATCH <= n) insertPos(d, i, head, prev);
    let next = { len: 0, dist: 0 };
    if (i + 1 + MIN_MATCH <= n) next = findMatch(d, i + 1, head, prev, CHAIN_MAX);
    if (next.len > cur.len && next.len >= MIN_MATCH) {
      tokens.push({ lit: d[i], len: 0, dist: 0 });
      i++;
      continue;
    }
    if (cur.len >= MIN_MATCH) {
      tokens.push({ lit: -1, len: cur.len, dist: cur.dist });
      for (let j = 1; j < cur.len; j++) {
        if (i + j + MIN_MATCH <= n) insertPos(d, i + j, head, prev);
      }
      i += cur.len;
    } else {
      tokens.push({ lit: d[i], len: 0, dist: 0 });
      i++;
    }
  }
  return tokens;
}

/**
 * Optimal-parse DP over `d` with the given per-symbol bit costs. Returns tokens.
 * litCost[s] is the bit cost of literal s; lenCost[len] and distCost[dist] are
 * the bit costs of a match of that length/distance (length code + extra bits,
 * distance code + extra bits).
 */
function optimalParse(
  d: Uint8Array,
  litCost: Float64Array,
  lenCost: Float64Array,
  distCost: Float64Array,
): Token[] {
  const n = d.length;
  const costs = new Float64Array(n + 1);
  costs.fill(Infinity);
  costs[0] = 0;
  const backLen = new Uint16Array(n + 1);
  const backDist = new Int32Array(n + 1);
  const head = new Int32Array(HASH_SIZE);
  head.fill(-1);
  const prev = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const ci = costs[i];
    if (ci === Infinity) continue;
    // Literal.
    const lc = ci + litCost[d[i]];
    if (lc < costs[i + 1]) {
      costs[i + 1] = lc;
      backLen[i + 1] = 1;
      backDist[i + 1] = 0;
    }
    if (i + MIN_MATCH > n) continue;
    const h = hash3(d, i);
    // Insert position i before searching, so the chain holds earlier positions.
    prev[i] = head[h];
    head[h] = i;
    const maxLen = Math.min(MAX_MATCH, n - i);
    let p = prev[i];
    let tried = 0;
    let bestLen = 0;
    // Each chain entry is one distance; consider its longest length at the
    // code-step lengths, plus the longest length itself.
    while (p !== -1 && tried++ < CHAIN_DP) {
      const dist = i - p;
      if (dist > WINDOW) break;
      const l = matchLen(d, i, p, maxLen);
      if (l >= MIN_MATCH) {
        const dc = distCost[dist];
        let last = 0;
        for (const step of LEN_STEPS) {
          if (step > l) break;
          const nc = ci + lenCost[step] + dc;
          if (nc < costs[i + step]) {
            costs[i + step] = nc;
            backLen[i + step] = step;
            backDist[i + step] = dist;
          }
          last = step;
        }
        if (l !== last) {
          const nc = ci + lenCost[l] + dc;
          if (nc < costs[i + l]) {
            costs[i + l] = nc;
            backLen[i + l] = l;
            backDist[i + l] = dist;
          }
        }
        if (l > bestLen) {
          bestLen = l;
          if (l >= NICE_DP) break;
        }
      }
      p = prev[p];
    }
  }
  // Backtrack.
  const tokens: Token[] = [];
  let j = n;
  while (j > 0) {
    const len = backLen[j];
    const dist = backDist[j];
    if (len === 0) throw new Error('optimal parse left a gap');
    if (dist === 0) tokens.push({ lit: d[j - 1], len: 0, dist: 0 });
    else tokens.push({ lit: -1, len, dist });
    j -= len;
  }
  tokens.reverse();
  return tokens;
}

/** Frequencies of literal/length and distance symbols over tokens. */
function frequencies(tokens: Token[]): { litFreq: Uint32Array; distFreq: Uint32Array } {
  const litFreq = new Uint32Array(286);
  const distFreq = new Uint32Array(30);
  for (const t of tokens) {
    if (t.lit >= 0) litFreq[t.lit]++;
    else {
      litFreq[257 + lenCodeOf(t.len)]++;
      distFreq[distCodeOf(t.dist)]++;
    }
  }
  litFreq[256] = 1; // end of block
  return { litFreq, distFreq };
}

/** Encode one dynamic-Huffman block of tokens starting at input position `from`. */
function writeBlock(w: BitWriter, tokens: Token[], isFinal: boolean): void {
  const { litFreq, distFreq } = frequencies(tokens);
  // Trim trailing unused codes.
  let hlit = 286;
  while (hlit > 257 && litFreq[hlit - 1] === 0) hlit--;
  let hdist = 30;
  while (hdist > 1 && distFreq[hdist - 1] === 0) hdist--;
  const litLens = codeLengths(litFreq.subarray(0, hlit), 15);
  const distLens = codeLengths(distFreq.subarray(0, hdist), 15);
  // RLE the code lengths: emit (symbol, count) runs.
  const all = new Uint8Array(hlit + hdist);
  all.set(litLens, 0);
  all.set(distLens, hlit);
  const cl: number[] = []; // code-length-code symbols
  const clExtra: number[] = [];
  let k = 0;
  while (k < all.length) {
    const v = all[k];
    let run = 1;
    while (k + run < all.length && all[k + run] === v) run++;
    if (v === 0) {
      let left = run;
      while (left >= 11) {
        const take = Math.min(left, 138);
        cl.push(18);
        clExtra.push(take - 11);
        left -= take;
      }
      if (left >= 3) {
        cl.push(17);
        clExtra.push(left - 3);
        left = 0;
      }
      while (left-- > 0) {
        cl.push(0);
        clExtra.push(0);
      }
    } else {
      cl.push(v);
      clExtra.push(0);
      let left = run - 1;
      while (left >= 3) {
        const take = Math.min(left, 6);
        cl.push(16);
        clExtra.push(take - 3);
        left -= take;
      }
      while (left-- > 0) {
        cl.push(v);
        clExtra.push(0);
      }
    }
    k += run;
  }
  const clFreq = new Uint32Array(19);
  for (const s of cl) clFreq[s]++;
  const clLensFull = codeLengths(clFreq, 7);
  const ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
  let hclen = 19;
  while (hclen > 4 && clLensFull[ORDER[hclen - 1]] === 0) hclen--;
  const clCodes = canonicalCodes(clLensFull);
  const litCodes = canonicalCodes(litLens);
  const distCodes = canonicalCodes(distLens);
  w.write(isFinal ? 1 : 0, 1); // BFINAL
  w.write(2, 2); // BTYPE = dynamic
  w.write(hlit - 257, 5);
  w.write(hdist - 1, 5);
  w.write(hclen - 4, 4);
  for (let t = 0; t < hclen; t++) w.write(clLensFull[ORDER[t]], 3);
  const CL_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 3, 7];
  for (let t = 0; t < cl.length; t++) {
    w.write(revBits(clCodes.codes[cl[t]], clLensFull[cl[t]]), clLensFull[cl[t]]);
    const e = CL_EXTRA[cl[t]];
    if (e > 0) w.write(clExtra[t], e);
  }
  for (const t of tokens) {
    if (t.lit >= 0) {
      w.write(revBits(litCodes.codes[t.lit], litLens[t.lit]), litLens[t.lit]);
    } else {
      const lc = lenCodeOf(t.len);
      w.write(revBits(litCodes.codes[257 + lc], litLens[257 + lc]), litLens[257 + lc]);
      const le = LEN_EXTRA[lc];
      if (le > 0) w.write(t.len - LEN_BASE[lc], le);
      const dc = distCodeOf(t.dist);
      w.write(revBits(distCodes.codes[dc], distLens[dc]), distLens[dc]);
      const de = DIST_EXTRA[dc];
      if (de > 0) w.write(t.dist - DIST_BASE[dc], de);
    }
  }
  w.write(revBits(litCodes.codes[256], litLens[256]), litLens[256]); // end of block
}

/** Adler-32 of data. */
function adler32(d: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < d.length; ) {
    const end = Math.min(d.length, i + 5552);
    for (; i < end; i++) {
      a += d[i];
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** Encode tokens into a raw DEFLATE stream, splitting into blocks by input position. */
function encodeTokens(tokens: Token[], n: number): Uint8Array {
  const w = new BitWriter();
  let block: Token[] = [];
  let blockStart = 0;
  let pos = 0;
  for (let t = 0; t <= tokens.length; t++) {
    const atEnd = t === tokens.length;
    const nextPos = atEnd ? n : pos + (tokens[t].lit >= 0 ? 1 : tokens[t].len);
    if (!atEnd && nextPos - blockStart < BLOCK_BYTES) {
      block.push(tokens[t]);
      pos = nextPos;
      continue;
    }
    if (!atEnd) block.push(tokens[t]);
    writeBlock(w, block, atEnd);
    block = [];
    blockStart = nextPos;
    pos = nextPos;
  }
  w.align();
  return w.result();
}

/**
 * Compress `data` with the optimal-parse deflate and return the raw DEFLATE
 * stream (no zlib wrapper). Throws on any internal inconsistency.
 */
export function deflateOptimal(data: Uint8Array, useDP = true): Uint8Array {
  const n = data.length;
  if (n === 0) {
    // One empty fixed block.
    const w = new BitWriter();
    w.write(1, 1);
    w.write(1, 2);
    w.write(0, 7);
    w.align();
    return w.result();
  }
  const head = new Int32Array(HASH_SIZE);
  const prev = new Int32Array(n);
  // Seed the cost model from a greedy parse.
  const greedy = greedyParse(data, head, prev);
  if (!useDP) return encodeTokens(greedy, n);
  const { litFreq, distFreq } = frequencies(greedy);
  const litLens = codeLengths(litFreq, 15);
  const distLens = codeLengths(distFreq, 15);
  const litCost = new Float64Array(286);
  for (let s = 0; s < 286; s++) litCost[s] = litLens[s] > 0 ? litLens[s] : 15;
  const lenCost = new Float64Array(MAX_MATCH + 1);
  for (let l = MIN_MATCH; l <= MAX_MATCH; l++) {
    const lc = lenCodeOf(l);
    lenCost[l] = litLens[257 + lc] + LEN_EXTRA[lc];
  }
  const distCost = new Float64Array(WINDOW + 1);
  for (let dist = 1; dist <= WINDOW; dist++) {
    const dc = distCodeOf(dist);
    distCost[dist] = distLens[dc] + DIST_EXTRA[dc];
  }
  const tokens = optimalParse(data, litCost, lenCost, distCost);
  return encodeTokens(tokens, n);
}

/** The zlib stream (header + raw deflate + Adler-32) of `data`. */
export function zlibOptimal(data: Uint8Array): Uint8Array {
  const raw = deflateOptimal(data);
  const out = new Uint8Array(2 + raw.length + 4);
  out[0] = 0x78;
  out[1] = 0x9c;
  out.set(raw, 2);
  const ad = adler32(data);
  out[2 + raw.length] = (ad >>> 24) & 0xff;
  out[3 + raw.length] = (ad >>> 16) & 0xff;
  out[4 + raw.length] = (ad >>> 8) & 0xff;
  out[5 + raw.length] = ad & 0xff;
  // Verify by inflation; a corrupt stream must never be shipped.
  const back = inflateSync(out);
  if (back.length !== data.length || !back.every((v, i) => v === data[i])) {
    throw new Error('deflateOptimal produced a stream that does not round-trip');
  }
  return out;
}
