import { test } from 'node:test';
import assert from 'node:assert/strict';
import { penalty, qrMatrix, qrSvg, reedSolomon, versionFor } from './qr.js';

/*
 * Also checked outside the suite: every version 1–10 and every mask decoded by OpenCV's
 * QRCodeDetectorAruco (99 codes, all read back exactly).
 */

test('Reed–Solomon: the worked example for 1-M "HELLO WORLD"', () => {
  const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
  assert.deepEqual(reedSolomon(data, 10), [196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
});

test('versionFor: byte-mode capacities at level M', () => {
  const cap = [14, 26, 42, 62, 84, 106, 122, 152, 180, 213];
  cap.forEach((c, i) => {
    assert.equal(versionFor(c), i + 1, `${c} bytes`);
    if (i < 9) assert.equal(versionFor(c + 1), i + 2, `${c + 1} bytes`);
  });
  assert.equal(versionFor(214), undefined);
  assert.equal(qrMatrix('x'.repeat(214)), undefined);
});

/** The 15 format bits as written beside the top-left finder. */
function formatBits(m: boolean[][]): number {
  const pos: [number, number][] = [
    [0, 8],
    [1, 8],
    [2, 8],
    [3, 8],
    [4, 8],
    [5, 8],
    [7, 8],
    [8, 8],
    [8, 7],
    [8, 5],
    [8, 4],
    [8, 3],
    [8, 2],
    [8, 1],
    [8, 0],
  ];
  return pos.reduce((v, [r, c], i) => v | ((m[r]![c] ? 1 : 0) << i), 0);
}

test('structure: finders, timing, dark module, format bits for level M and the mask, both copies alike', () => {
  for (const text of ['http://192.168.1.20:54321/k7m2-p9qx-4hwn/', 'y'.repeat(120), 'z'.repeat(200)])
    for (let mk = 0; mk < 8; mk++) {
      const m = qrMatrix(text, mk)!;
      const n = m.length;
      assert.equal((n - 17) % 4, 0);
      for (const [r0, c0] of [
        [0, 0],
        [0, n - 7],
        [n - 7, 0],
      ] as const)
        for (let r = 0; r < 7; r++)
          for (let c = 0; c < 7; c++) {
            const ring = Math.max(Math.abs(r - 3), Math.abs(c - 3));
            assert.equal(m[r0 + r]![c0 + c], ring !== 2, `finder ${r0},${c0}`);
          }
      for (let i = 8; i < n - 8; i++) assert.equal(m[6]![i], i % 2 === 0, 'timing');
      assert.equal(m[n - 8]![8], true, 'dark module');
      const fmt = formatBits(m) ^ 0x5412;
      assert.equal(fmt >>> 13, 0b00, 'level M');
      assert.equal((fmt >>> 10) & 7, mk, 'mask');
      // The second copy reads the same.
      let second = 0;
      for (let i = 0; i < 8; i++) second |= (m[8]![n - 1 - i] ? 1 : 0) << i;
      for (let i = 8; i < 15; i++) second |= (m[n - 15 + i]![8] ? 1 : 0) << i;
      assert.equal(second ^ 0x5412, fmt);
    }
});

test('the chosen mask is the one with the lowest penalty; the SVG has a quiet zone', () => {
  const text = 'http://10.0.0.5:61000/abcd-efgh-jkmn/';
  const chosen = qrMatrix(text)!;
  const scores = Array.from({ length: 8 }, (_, mk) => penalty(qrMatrix(text, mk)!));
  assert.equal(penalty(chosen), Math.min(...scores));
  const svg = qrSvg(chosen, 3);
  const n = chosen.length + 8;
  assert.match(svg, new RegExp(`viewBox="0 0 ${n} ${n}" width="${n * 3}"`));
  assert.ok(!svg.includes('<script'));
  assert.equal(qrMatrix(text, 8), undefined);
});
