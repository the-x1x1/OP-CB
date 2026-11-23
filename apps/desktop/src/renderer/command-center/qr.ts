/**
 * A QR code for the share address (2026-11-22), so a phone's camera opens it without typing.
 * Byte mode, error correction level M, versions 1–10 (up to 213 bytes: a share address is about
 * 45), the mask with the lowest penalty (ISO/IEC 18004). Written here rather than taken from a
 * package; checked against OpenCV's decoder for every version and every mask.
 */

/** Data codewords per block for level M, by version: [count, size] groups. */
const BLOCKS_M: readonly (readonly [number, number][])[] = [
  [],
  [[1, 16]],
  [[1, 28]],
  [[1, 44]],
  [[2, 32]],
  [[2, 43]],
  [[4, 27]],
  [[4, 31]],
  [
    [2, 38],
    [2, 39],
  ],
  [
    [3, 36],
    [2, 37],
  ],
  [
    [4, 43],
    [1, 44],
  ],
];
const EC_PER_BLOCK_M = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const ALIGN = [[], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
const REMAINDER_BITS = [0, 0, 7, 7, 7, 7, 7, 0, 0, 0, 0];

// ---- Reed–Solomon over GF(256), polynomial 0x11d ------------------------------------------------

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!;
}
const mul = (a: number, b: number) => (a && b ? EXP[LOG[a]! + LOG[b]!]! : 0);

function generator(degree: number): number[] {
  let g = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array<number>(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      next[j] = next[j]! ^ g[j]!;
      next[j + 1] = next[j + 1]! ^ mul(g[j]!, EXP[i]!);
    }
    g = next;
  }
  return g;
}

export function reedSolomon(data: readonly number[], ecLen: number): number[] {
  const g = generator(ecLen);
  const rem = new Array<number>(ecLen).fill(0);
  for (const d of data) {
    const factor = d ^ rem[0]!;
    rem.shift();
    rem.push(0);
    for (let i = 0; i < ecLen; i++) rem[i] = rem[i]! ^ mul(g[i + 1]!, factor);
  }
  return rem;
}

// ---- the code ------------------------------------------------------------------------------------

/** The smallest version (1–10) that holds `bytes` bytes at level M, or undefined. */
export function versionFor(bytes: number): number | undefined {
  for (let v = 1; v <= 10; v++) {
    const capacity = BLOCKS_M[v]!.reduce((n, [c, s]) => n + c * s, 0);
    const bits = 4 + (v < 10 ? 8 : 16) + 8 * bytes;
    if (bits <= capacity * 8) return v;
  }
  return undefined;
}

function codewords(text: string, version: number): number[] {
  const bytes = [...new TextEncoder().encode(text)];
  const capacity = BLOCKS_M[version]!.reduce((n, [c, s]) => n + c * s, 0);
  const bits: number[] = [];
  const put = (v: number, n: number) => {
    for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1);
  };
  put(0b0100, 4);
  put(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  put(0, Math.min(4, capacity * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  for (let pad = 0xec; data.length < capacity; pad ^= 0xec ^ 0x11) data.push(pad);
  // Blocks, their error correction, then interleaved.
  const blocks: number[][] = [];
  let at = 0;
  for (const [count, size] of BLOCKS_M[version]!)
    for (let i = 0; i < count; i++) {
      blocks.push(data.slice(at, at + size));
      at += size;
    }
  const ec = blocks.map((b) => reedSolomon(b, EC_PER_BLOCK_M[version]!));
  const out: number[] = [];
  const longest = Math.max(...blocks.map((b) => b.length));
  for (let i = 0; i < longest; i++) for (const b of blocks) if (i < b.length) out.push(b[i]!);
  for (let i = 0; i < EC_PER_BLOCK_M[version]!; i++) for (const e of ec) out.push(e[i]!);
  return out;
}

function bch(value: number, poly: number, polyBits: number): number {
  let v = value << (polyBits - 1);
  for (let i = 31; i >= polyBits - 1; i--) if ((v >>> i) & 1) v ^= poly << (i - (polyBits - 1));
  return v;
}

const MASKS: ((r: number, c: number) => boolean)[] = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

/**
 * The modules of a QR code for `text`: `true` is dark. Undefined when the text does not fit
 * version 10 at level M. `mask` forces a mask (for tests); otherwise the best is chosen.
 */
export function qrMatrix(text: string, mask?: number): boolean[][] | undefined {
  const version = versionFor(new TextEncoder().encode(text).length);
  if (!version) return undefined;
  const n = 17 + 4 * version;
  const m: boolean[][] = Array.from({ length: n }, () => new Array<boolean>(n).fill(false));
  const fixed: boolean[][] = Array.from({ length: n }, () => new Array<boolean>(n).fill(false));
  const set = (r: number, c: number, dark: boolean) => {
    m[r]![c] = dark;
    fixed[r]![c] = true;
  };
  // Finders with separators.
  for (const [r0, c0] of [
    [0, 0],
    [0, n - 7],
    [n - 7, 0],
  ] as const)
    for (let r = -1; r <= 7; r++)
      for (let c = -1; c <= 7; c++) {
        const rr = r0 + r;
        const cc = c0 + c;
        if (rr < 0 || cc < 0 || rr >= n || cc >= n) continue;
        const ring = Math.max(Math.abs(r - 3), Math.abs(c - 3));
        set(rr, cc, r >= 0 && r <= 6 && c >= 0 && c <= 6 && ring !== 2);
      }
  // Timing.
  for (let i = 8; i < n - 8; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  // Alignment.
  const pos = ALIGN[version]!;
  for (const r of pos)
    for (const c of pos) {
      // Not where a finder is; over the timing lines is where they belong.
      if ((r < 9 && c < 9) || (r < 9 && c > n - 10) || (r > n - 10 && c < 9)) continue;
      for (let dr = -2; dr <= 2; dr++)
        for (let dc = -2; dc <= 2; dc++) set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
    }
  // Reserve format areas (written later) and the dark module.
  for (let i = 0; i < 9; i++) {
    if (!fixed[8]![i]) set(8, i, false);
    if (!fixed[i]![8]) set(i, 8, false);
  }
  for (let i = 0; i < 8; i++) {
    set(8, n - 1 - i, false);
    set(n - 1 - i, 8, false);
  }
  set(n - 8, 8, true);
  // Version information (7 and up).
  if (version >= 7) {
    const bits = (version << 12) | bch(version, 0x1f25, 13);
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) === 1;
      const a = Math.floor(i / 3);
      const b = (i % 3) + n - 11;
      set(a, b, dark);
      set(b, a, dark);
    }
  }
  // Data, in the zigzag.
  const data = codewords(text, version);
  const bits: number[] = [];
  for (const d of data) for (let i = 7; i >= 0; i--) bits.push((d >>> i) & 1);
  for (let i = 0; i < REMAINDER_BITS[version]!; i++) bits.push(0);
  let k = 0;
  let upward = true;
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let step = 0; step < n; step++) {
      const r = upward ? n - 1 - step : step;
      for (const c of [right, right - 1]) {
        if (fixed[r]![c]) continue;
        m[r]![c] = (bits[k++] ?? 0) === 1;
      }
    }
    upward = !upward;
  }
  const apply = (mk: number): boolean[][] => {
    const out = m.map((row) => [...row]);
    for (let r = 0; r < n; r++)
      for (let c = 0; c < n; c++) if (!fixed[r]![c] && MASKS[mk]!(r, c)) out[r]![c] = !out[r]![c];
    // Format: level M (00) and the mask.
    const fmt = ((((0b00 << 3) | mk) << 10) | bch((0b00 << 3) | mk, 0x537, 11)) ^ 0x5412;
    for (let i = 0; i < 15; i++) {
      const dark = ((fmt >>> i) & 1) === 1;
      // Around the top-left finder.
      if (i < 6) out[i]![8] = dark;
      else if (i < 8) out[i + 1]![8] = dark;
      else if (i === 8) out[8]![7] = dark;
      else out[8]![14 - i] = dark;
      // The second copy.
      if (i < 8) out[8]![n - 1 - i] = dark;
      else out[n - 15 + i]![8] = dark;
    }
    out[n - 8]![8] = true;
    return out;
  };
  if (mask !== undefined) return mask >= 0 && mask < 8 ? apply(mask) : undefined;
  let best: boolean[][] | undefined;
  let bestScore = Infinity;
  for (let mk = 0; mk < 8; mk++) {
    const cand = apply(mk);
    const s = penalty(cand);
    if (s < bestScore) {
      bestScore = s;
      best = cand;
    }
  }
  return best;
}

/** The standard's penalty score (N1–N4). */
export function penalty(m: boolean[][]): number {
  const n = m.length;
  let score = 0;
  const line = (get: (i: number) => boolean) => {
    let run = 1;
    for (let i = 1; i <= n; i++) {
      if (i < n && get(i) === get(i - 1)) run++;
      else {
        if (run >= 5) score += 3 + (run - 5);
        run = 1;
      }
    }
    // Finder-like 1:1:3:1:1 with four light modules on either side.
    for (let i = 0; i + 11 <= n; i++) {
      const p = Array.from({ length: 11 }, (_, k) => get(i + k));
      const core = p[4] && !p[5] && p[6] && p[7] && p[8] && !p[9] && p[10];
      const a = !p[0] && !p[1] && !p[2] && !p[3] && core;
      const core2 = p[0] && !p[1] && p[2] && p[3] && p[4] && !p[5] && p[6];
      const b = core2 && !p[7] && !p[8] && !p[9] && !p[10];
      if (a || b) score += 40;
    }
  };
  for (let r = 0; r < n; r++) line((i) => m[r]![i]!);
  for (let c = 0; c < n; c++) line((i) => m[i]![c]!);
  for (let r = 0; r + 1 < n; r++)
    for (let c = 0; c + 1 < n; c++) {
      const v = m[r]![c];
      if (v === m[r]![c + 1] && v === m[r + 1]![c] && v === m[r + 1]![c + 1]) score += 3;
    }
  let dark = 0;
  for (const row of m) for (const x of row) if (x) dark++;
  score += Math.floor(Math.abs((dark * 100) / (n * n) - 50) / 5) * 10;
  return score;
}

/** The dark modules as one SVG path, offset by the four-module quiet zone. */
export function qrPath(m: boolean[][]): string {
  let path = '';
  m.forEach((row, r) =>
    row.forEach((dark, c) => {
      if (dark) path += `M${c + 4} ${r + 4}h1v1h-1z`;
    }),
  );
  return path;
}

/** An SVG of the code with a four-module quiet zone, dark on light. */
export function qrSvg(m: boolean[][], px = 4): string {
  const n = m.length + 8;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" width="${n * px}" height="${n * px}" shape-rendering="crispEdges"><rect width="${n}" height="${n}" fill="#fff"/><path d="${qrPath(m)}" fill="#000"/></svg>`;
}
