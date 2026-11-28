/**
 * A QR Code of a short text (a link), as an SVG, for the printed and PDF
 * copies of a controlled document (docs/specs/document-pdf.md). A port to
 * TypeScript, in byte mode only, of the QR Code generator library by
 * Project Nayuki (https://www.nayuki.io/page/qr-code-generator-library),
 * MIT licence:
 *
 *   Copyright (c) Project Nayuki. (MIT License)
 *   Permission is hereby granted, free of charge, to any person obtaining a
 *   copy of this software and associated documentation files (the
 *   "Software"), to deal in the Software without restriction, including
 *   without limitation the rights to use, copy, modify, merge, publish,
 *   distribute, sublicense, and/or sell copies of the Software, and to
 *   permit persons to whom the Software is furnished to do so, subject to
 *   the following conditions: the above copyright notice and this permission
 *   notice shall be included in all copies or substantial portions of the
 *   Software. The Software is provided "as is", without warranty of any kind.
 *
 * `qr.spec.ts` checks it module for module against the original, as the web
 * app's `qrcode.react` ships it.
 */

type Ecc = { ordinal: 0 | 1 | 2 | 3; formatBits: number };
const ECC = {
  low: { ordinal: 0, formatBits: 1 },
  medium: { ordinal: 1, formatBits: 0 },
  quartile: { ordinal: 2, formatBits: 3 },
  high: { ordinal: 3, formatBits: 2 },
} as const satisfies Record<string, Ecc>;

const ECC_CODEWORDS_PER_BLOCK = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];
const NUM_ERROR_CORRECTION_BLOCKS = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

const PENALTY_N1 = 3;
const PENALTY_N2 = 3;
const PENALTY_N3 = 40;
const PENALTY_N4 = 10;

const getBit = (x: number, i: number) => ((x >>> i) & 1) !== 0;

function appendBits(value: number, length: number, bb: number[]) {
  for (let i = length - 1; i >= 0; i--) bb.push((value >>> i) & 1);
}

function numRawDataModules(ver: number) {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (ver >= 7) result -= 36;
  }
  return result;
}

const numDataCodewords = (ver: number, ecl: Ecc) =>
  Math.floor(numRawDataModules(ver) / 8) - ECC_CODEWORDS_PER_BLOCK[ecl.ordinal][ver] * NUM_ERROR_CORRECTION_BLOCKS[ecl.ordinal][ver];

function rsMultiply(x: number, y: number) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function rsDivisor(degree: number) {
  const result: number[] = [];
  for (let i = 0; i < degree - 1; i++) result.push(0);
  result.push(1);
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = rsMultiply(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = rsMultiply(root, 0x02);
  }
  return result;
}

function rsRemainder(data: number[], divisor: number[]) {
  const result = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ result.shift()!;
    result.push(0);
    divisor.forEach((coef, i) => (result[i] ^= rsMultiply(coef, factor)));
  }
  return result;
}

class Matrix {
  readonly size: number;
  readonly modules: boolean[][] = [];
  private isFunction: boolean[][] = [];

  constructor(
    readonly version: number,
    readonly ecl: Ecc,
    data: number[],
  ) {
    this.size = version * 4 + 17;
    for (let i = 0; i < this.size; i++) {
      this.modules.push(Array.from({ length: this.size }, () => false));
      this.isFunction.push(Array.from({ length: this.size }, () => false));
    }
    this.drawFunctionPatterns();
    this.drawCodewords(this.addEccAndInterleave(data));
    let mask = 0;
    let minPenalty = Infinity;
    for (let i = 0; i < 8; i++) {
      this.applyMask(i);
      this.drawFormatBits(i);
      const penalty = this.penalty();
      if (penalty < minPenalty) {
        mask = i;
        minPenalty = penalty;
      }
      this.applyMask(i);
    }
    this.applyMask(mask);
    this.drawFormatBits(mask);
    this.isFunction = [];
  }

  private set(x: number, y: number, dark: boolean) {
    this.modules[y][x] = dark;
    this.isFunction[y][x] = true;
  }

  private drawFunctionPatterns() {
    for (let i = 0; i < this.size; i++) {
      this.set(6, i, i % 2 === 0);
      this.set(i, 6, i % 2 === 0);
    }
    this.drawFinder(3, 3);
    this.drawFinder(this.size - 4, 3);
    this.drawFinder(3, this.size - 4);
    const pos = this.alignmentPositions();
    const n = pos.length;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (!((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0))) this.drawAlignment(pos[i], pos[j]);
      }
    }
    this.drawFormatBits(0);
    this.drawVersion();
  }

  private drawFormatBits(mask: number) {
    const data = (this.ecl.formatBits << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    for (let i = 0; i <= 5; i++) this.set(8, i, getBit(bits, i));
    this.set(8, 7, getBit(bits, 6));
    this.set(8, 8, getBit(bits, 7));
    this.set(7, 8, getBit(bits, 8));
    for (let i = 9; i < 15; i++) this.set(14 - i, 8, getBit(bits, i));
    for (let i = 0; i < 8; i++) this.set(this.size - 1 - i, 8, getBit(bits, i));
    for (let i = 8; i < 15; i++) this.set(8, this.size - 15 + i, getBit(bits, i));
    this.set(8, this.size - 8, true);
  }

  private drawVersion() {
    if (this.version < 7) return;
    let rem = this.version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (this.version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = getBit(bits, i);
      const a = this.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.set(a, b, dark);
      this.set(b, a, dark);
    }
  }

  private drawFinder(x: number, y: number) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const xx = x + dx;
        const yy = y + dy;
        if (xx >= 0 && xx < this.size && yy >= 0 && yy < this.size) this.set(xx, yy, dist !== 2 && dist !== 4);
      }
    }
  }

  private drawAlignment(x: number, y: number) {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) this.set(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }

  private alignmentPositions() {
    if (this.version === 1) return [];
    const numAlign = Math.floor(this.version / 7) + 2;
    const step = this.version === 32 ? 26 : Math.ceil((this.version * 4 + 4) / (numAlign * 2 - 2)) * 2;
    const result = [6];
    for (let pos = this.size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
    return result;
  }

  private addEccAndInterleave(data: number[]) {
    const ver = this.version;
    const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[this.ecl.ordinal][ver];
    const blockEccLen = ECC_CODEWORDS_PER_BLOCK[this.ecl.ordinal][ver];
    const rawCodewords = Math.floor(numRawDataModules(ver) / 8);
    const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
    const shortBlockLen = Math.floor(rawCodewords / numBlocks);
    const blocks: number[][] = [];
    const divisor = rsDivisor(blockEccLen);
    for (let i = 0, k = 0; i < numBlocks; i++) {
      const dat = data.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1));
      k += dat.length;
      const ecc = rsRemainder(dat, divisor);
      if (i < numShortBlocks) dat.push(0);
      blocks.push(dat.concat(ecc));
    }
    const result: number[] = [];
    for (let i = 0; i < blocks[0].length; i++) {
      blocks.forEach((block, j) => {
        if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(block[i]);
      });
    }
    return result;
  }

  private drawCodewords(data: number[]) {
    let i = 0;
    for (let right = this.size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < this.size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? this.size - 1 - vert : vert;
          if (!this.isFunction[y][x] && i < data.length * 8) {
            this.modules[y][x] = getBit(data[i >>> 3], 7 - (i & 7));
            i++;
          }
        }
      }
    }
  }

  private applyMask(mask: number) {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        let invert: boolean;
        switch (mask) {
          case 0: invert = (x + y) % 2 === 0; break;
          case 1: invert = y % 2 === 0; break;
          case 2: invert = x % 3 === 0; break;
          case 3: invert = (x + y) % 3 === 0; break;
          case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break;
          case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
          default: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
        }
        if (!this.isFunction[y][x] && invert) this.modules[y][x] = !this.modules[y][x];
      }
    }
  }

  private penalty() {
    let result = 0;
    const line = (get: (i: number) => boolean) => {
      let runColor = false;
      let run = 0;
      const history = [0, 0, 0, 0, 0, 0, 0];
      for (let i = 0; i < this.size; i++) {
        if (get(i) === runColor) {
          run++;
          if (run === 5) result += PENALTY_N1;
          else if (run > 5) result++;
        } else {
          this.addHistory(run, history);
          if (!runColor) result += this.countPatterns(history) * PENALTY_N3;
          runColor = get(i);
          run = 1;
        }
      }
      result += this.terminateAndCount(runColor, run, history) * PENALTY_N3;
    };
    for (let y = 0; y < this.size; y++) line((x) => this.modules[y][x]);
    for (let x = 0; x < this.size; x++) line((y) => this.modules[y][x]);
    for (let y = 0; y < this.size - 1; y++) {
      for (let x = 0; x < this.size - 1; x++) {
        const c = this.modules[y][x];
        if (c === this.modules[y][x + 1] && c === this.modules[y + 1][x] && c === this.modules[y + 1][x + 1]) result += PENALTY_N2;
      }
    }
    let dark = 0;
    for (const row of this.modules) dark = row.reduce((sum, c) => sum + (c ? 1 : 0), dark);
    const total = this.size * this.size;
    const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    result += k * PENALTY_N4;
    return result;
  }

  private countPatterns(history: number[]) {
    const n = history[1];
    const core = n > 0 && history[2] === n && history[3] === n * 3 && history[4] === n && history[5] === n;
    return (core && history[0] >= n * 4 && history[6] >= n ? 1 : 0) + (core && history[6] >= n * 4 && history[0] >= n ? 1 : 0);
  }

  private terminateAndCount(color: boolean, run: number, history: number[]) {
    if (color) {
      this.addHistory(run, history);
      run = 0;
    }
    run += this.size;
    this.addHistory(run, history);
    return this.countPatterns(history);
  }

  private addHistory(run: number, history: number[]) {
    if (history[0] === 0) run += this.size;
    history.pop();
    history.unshift(run);
  }
}

/** The modules of a QR Code of this text, in byte mode, at least at medium error correction. */
export function qrModules(text: string): boolean[][] {
  const bytes = [...Buffer.from(text, 'utf8')];
  let ecl: Ecc = ECC.medium;
  let version = 1;
  const countBits = (v: number) => (v <= 9 ? 8 : 16);
  for (; ; version++) {
    if (version > 40) throw new RangeError('Data too long');
    if (4 + countBits(version) + bytes.length * 8 <= numDataCodewords(version, ecl) * 8) break;
  }
  const used = 4 + countBits(version) + bytes.length * 8;
  for (const better of [ECC.quartile, ECC.high]) if (used <= numDataCodewords(version, better) * 8) ecl = better;
  const bb: number[] = [];
  appendBits(0x4, 4, bb);
  appendBits(bytes.length, countBits(version), bb);
  for (const b of bytes) appendBits(b, 8, bb);
  const capacity = numDataCodewords(version, ecl) * 8;
  appendBits(0, Math.min(4, capacity - bb.length), bb);
  appendBits(0, (8 - (bb.length % 8)) % 8, bb);
  for (let pad = 0xec; bb.length < capacity; pad ^= 0xec ^ 0x11) appendBits(pad, 8, bb);
  const data: number[] = Array.from({ length: bb.length / 8 }, () => 0);
  bb.forEach((b, i) => (data[i >>> 3] |= b << (7 - (i & 7))));
  return new Matrix(version, ecl, data).modules;
}

/** A QR Code of this text as an SVG, with a quiet zone of 4 modules. */
export function qrSvg(text: string, sizePx = 96): string {
  const modules = qrModules(text);
  const n = modules.length + 8;
  let path = '';
  modules.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (dark) path += `M${x + 4},${y + 4}h1v1h-1z`;
    }),
  );
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" width="${sizePx}" height="${sizePx}" shape-rendering="crispEdges" role="img"><rect width="${n}" height="${n}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}
